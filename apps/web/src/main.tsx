import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Seat = {
  id: string;
  label: string;
  status: "AVAILABLE" | "HELD" | "RESERVED";
  priceCents: number;
  heldUntil?: string | null;
};

type User = { id: string; email: string };

async function api<T>(path: string, options: RequestInit = {}, accessToken?: string): Promise<T> {
  const res = await fetch(path, {
    ...options,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(options.headers ?? {})
    }
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body as T;
}

function App() {
  const [email, setEmail] = useState("demo@example.com");
  const [password, setPassword] = useState("Password123!");
  const [accessToken, setAccessToken] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [held, setHeld] = useState<{ holdId: string; seatId: string; heldUntil: string } | null>(null);
  const [message, setMessage] = useState("Choose a seat to begin.");
  const authenticated = Boolean(accessToken && user);

  const heldSeat = useMemo(() => seats.find((seat) => seat.id === held?.seatId), [held, seats]);

  async function loadSeats() {
    const data = await api<{ seats: Seat[] }>("/api/seats");
    setSeats(data.seats);
  }

  useEffect(() => {
    loadSeats().catch((error) => setMessage(error.message));
    const events = new EventSource("/api/seats/stream");
    events.addEventListener("seat-update", () => loadSeats().catch(() => undefined));
    return () => events.close();
  }, []);

  useEffect(() => {
    api<{ accessToken: string; user: User }>("/api/auth/refresh", { method: "POST", body: "{}" })
      .then((data) => {
        setAccessToken(data.accessToken);
        setUser(data.user);
        setMessage("Session restored.");
      })
      .catch(() => undefined);
  }, []);

  async function login(mode: "login" | "register") {
    const data = await api<{ accessToken: string; user: User }>(`/api/auth/${mode}`, {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    setAccessToken(data.accessToken);
    setUser(data.user);
    setMessage(mode === "login" ? "Signed in." : "Account created.");
  }

  async function holdSeat(seatId: string) {
    const data = await api<{ holdId: string; seatId: string; heldUntil: string }>(
      `/api/seats/${seatId}/hold`,
      { method: "POST", body: "{}" },
      accessToken
    );
    setHeld(data);
    setMessage("Seat held. Complete payment before the hold expires.");
    await loadSeats();
  }

  async function checkoutWithRetry(holdId: string) {
    const idempotencyKey = `web-${holdId}`;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await api<{ paymentIntentId: string; amountCents: number; checkoutUrl: string }>(
          "/api/payments/checkout",
          { method: "POST", body: JSON.stringify({ holdId, idempotencyKey }) },
          accessToken
        );
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "hold_projection_not_ready") throw error;
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
    throw new Error("Payment service is still catching up. Try again shortly.");
  }

  async function pay() {
    if (!held) return;
    setMessage("Creating payment intent...");
    const checkout = await checkoutWithRetry(held.holdId);
    setMessage("Completing mock payment...");
    await api(
      "/api/payments/mock/complete",
      { method: "POST", body: JSON.stringify({ paymentIntentId: checkout.paymentIntentId, outcome: "succeeded" }) },
      accessToken
    );
    setMessage("Payment complete. Reservation is being finalized.");
    setHeld(null);
    setTimeout(() => loadSeats().catch(() => undefined), 1200);
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST", body: "{}" }, accessToken);
    setAccessToken("");
    setUser(null);
    setHeld(null);
    setMessage("Signed out.");
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <h1>Seat Reservation</h1>
          <p>Three public seats, authenticated checkout, mock payment completion.</p>
        </div>
        {authenticated ? (
          <button className="ghost" onClick={logout}>Sign out</button>
        ) : null}
      </section>

      {!authenticated ? (
        <section className="auth-panel" aria-label="Authentication">
          <label>
            Email
            <input value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            Password
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" />
          </label>
          <div className="actions">
            <button onClick={() => login("login")}>Log in</button>
            <button className="secondary" onClick={() => login("register")}>Create account</button>
          </div>
        </section>
      ) : (
        <section className="status-line">
          <span>{user?.email}</span>
          <strong>{message}</strong>
        </section>
      )}

      <section className="seat-grid" aria-label="Seats">
        {seats.map((seat) => (
          <article className={`seat ${seat.status.toLowerCase()}`} key={seat.id}>
            <div>
              <h2>{seat.label}</h2>
              <p>{seat.status}</p>
            </div>
            <span>${(seat.priceCents / 100).toFixed(2)}</span>
            <button disabled={!authenticated || seat.status !== "AVAILABLE"} onClick={() => holdSeat(seat.id)}>
              Select
            </button>
          </article>
        ))}
      </section>

      {held ? (
        <section className="checkout">
          <div>
            <h2>Checkout</h2>
            <p>{heldSeat?.label ?? held.seatId} is held until {new Date(held.heldUntil).toLocaleTimeString()}.</p>
          </div>
          <button onClick={pay}>Pay now</button>
        </section>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
