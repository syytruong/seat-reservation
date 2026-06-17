export const EVENT_EXCHANGE = "seat.events";

export type EventName =
  | "auth.token_version_changed"
  | "seat.held"
  | "seat.hold_expired"
  | "seat.reserved"
  | "payment.completed"
  | "payment.failed";

export interface DomainEvent<TName extends EventName = EventName, TPayload = unknown> {
  eventId: string;
  name: TName;
  occurredAt: string;
  payload: TPayload;
}

export interface AuthTokenVersionChangedPayload {
  userId: string;
  tokenVersion: number;
  reason: "logout" | "logout_all" | "refresh_reuse";
}

export interface SeatHeldPayload {
  holdId: string;
  seatId: string;
  seatLabel: string;
  userId: string;
  priceCents: number;
  heldUntil: string;
}

export interface SeatReservedPayload {
  holdId: string;
  seatId: string;
  userId: string;
  paymentIntentId: string;
}

export interface PaymentCompletedPayload {
  paymentIntentId: string;
  holdId: string;
  userId: string;
  amountCents: number;
}

export interface PaymentFailedPayload {
  paymentIntentId: string;
  holdId: string;
  userId: string;
  reason: string;
}

export interface AccessTokenClaims {
  sub: string;
  email: string;
  tokenVersion: number;
  jti: string;
}
