# Engineering Decisions

## 1. Microservices over a faster monolith

The assessment checklist marks a monolith as an auto-fail, so the implementation uses three independently deployable services: auth, seat, and payment. The split also matches different scaling profiles: auth can become CPU-bound from Argon2id, seat is DB/contention-bound, and payment is I/O-bound around provider callbacks.

Trade-off: local setup is heavier because Docker Compose needs Postgres, Redis, RabbitMQ, nginx, and four app containers. For the assessment, that cost is acceptable because it makes service boundaries, health checks, and operational behavior visible.

## 2. RabbitMQ events plus transactional outbox

Inter-service state changes are published through RabbitMQ. Each service writes outbound events to an `outbox` table in the same transaction as the business update, then a lightweight publisher drains pending rows with `FOR UPDATE SKIP LOCKED`.

Trade-off: this adds eventual consistency. For example, payment checkout may briefly return `hold_projection_not_ready` until payment-service consumes `seat.held`. The client retries this specific 409 with a short backoff. In production I would expose a clearer hold status resource or use a durable projection lag metric.

## 3. Seat hold correctness uses row locking and DB constraints

The hold path locks the seat row with `SELECT ... FOR UPDATE`, checks availability, updates it, and writes the outbox event in one transaction. A partial unique index enforces one active held seat per user.

Failure mode: under high contention, requests queue behind the row lock and most return 409 after the winner commits. This is deliberate because the seat inventory is tiny and correctness matters more than optimistic UI speed. The response includes `Retry-After` to avoid blind retry storms.

## 4. Hold expiry sweeper is replica-safe

Expired holds are released in small batches using `FOR UPDATE SKIP LOCKED`. Multiple seat-service replicas can run the sweeper without coordinating through advisory locks.

Trade-off: the sweeper runs every 15 seconds, so the UI can briefly show a stale held seat. `GET /api/seats` also performs a small lazy cleanup to reduce visible staleness. TODO(prod): emit explicit `seat.hold_expired` events for downstream projections and dashboards.

## 5. Refresh tokens are opaque, hashed, rotated, and family-tracked

Refresh tokens are 48 random bytes, stored only as SHA-256 hashes, and sent in an httpOnly strict SameSite cookie scoped to `/api/auth`. Refresh rotates tokens and tracks token families so reuse outside the grace window revokes the family and bumps `token_version`.

Trade-off: seat/payment services learn token-version bumps asynchronously via RabbitMQ, so there is a short propagation window outside auth-service. TODO(prod): keep a Redis token-version cache updated by auth events and fail closed when the cache is unavailable for sensitive endpoints.

## 6. Access tokens are short-lived JWTs

Access tokens expire in 15 minutes by default and carry `tokenVersion`. Auth-service checks the DB version on `/me` and logout routes. Other services validate signature locally and compare against their replicated token-version projection.

Trade-off: this avoids synchronous auth-service calls from every service, preserving the async service boundary. The cost is eventual revocation outside auth-service.

## 7. Mock payment follows a real PSP boundary

Payment provider behavior sits behind a `PaymentProvider` interface. The mock completion path builds a webhook event and sends it through the same HMAC/timestamp/idempotency processor used by the public webhook endpoint.

Trade-off: this does not model all Stripe state transitions. It does demonstrate the important production invariants: amount is server-owned, provider events are verified, duplicate webhooks are no-ops, and failed payment releases the seat through compensation.

## 8. Webhook processing is synchronous after verification

The webhook handler verifies HMAC and timestamp, inserts the event id, updates the payment intent, writes an outbox event, and returns 200.

Production path: for higher webhook volume I would use an ack-fast inbox pattern: verify and persist the event, return 200, then process from a worker with dead-letter handling. The current path is simpler and keeps the assessment flow easy to run locally.

## 9. Redis is used where horizontal scale would break in-memory state

Rate limiting uses Redis counters, and seat SSE notifications fan out through Redis pub/sub. This avoids per-process-only state for user-visible update streams.

Trade-off: SSE is still a basic implementation. TODO(prod): add heartbeat comments, Redis reconnect backfill, and a `/seats?since=` polling fallback for clients that miss events during network changes.

## 10. Secrets fail startup when missing

`JWT_ACCESS_SECRET` and `WEBHOOK_SECRET` are validated at startup with no hardcoded defaults. `.env.example` documents required values, but the services will not boot with unsafe implicit secrets.
