CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS seats (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('AVAILABLE', 'HELD', 'RESERVED')),
  price_cents INTEGER NOT NULL,
  current_holder_id UUID,
  hold_id UUID UNIQUE,
  held_until TIMESTAMPTZ,
  reserved_by UUID,
  reserved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO seats (id, label, status, price_cents)
VALUES
  ('seat-a1', 'A1', 'AVAILABLE', COALESCE(NULLIF(current_setting('app.seat_price_cents', true), '')::INTEGER, 2500)),
  ('seat-a2', 'A2', 'AVAILABLE', COALESCE(NULLIF(current_setting('app.seat_price_cents', true), '')::INTEGER, 2500)),
  ('seat-a3', 'A3', 'AVAILABLE', COALESCE(NULLIF(current_setting('app.seat_price_cents', true), '')::INTEGER, 2500))
ON CONFLICT (id) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_hold_per_user
  ON seats (current_holder_id)
  WHERE status = 'HELD';

CREATE INDEX IF NOT EXISTS idx_seats_held_expiry
  ON seats (held_until)
  WHERE status = 'HELD';

CREATE TABLE IF NOT EXISTS auth_token_versions (
  user_id UUID PRIMARY KEY,
  token_version INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id UUID NOT NULL,
  consumer_group TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, consumer_group)
);

CREATE TABLE IF NOT EXISTS outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox (created_at)
  WHERE status = 'PENDING';
