const base = process.env.SMOKE_BASE_URL ?? "http://localhost:8080";
const email = `smoke-${Date.now()}@example.com`;
const password = "Password123!";
let cookie = "";
let accessToken = "";

async function request(path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(options.headers ?? {})
    }
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${options.method ?? "GET"} ${path} failed: ${res.status} ${text}`);
  return body;
}

async function checkoutWithRetry(holdId) {
  const idempotencyKey = `smoke-${holdId}`;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const res = await fetch(`${base}/api/payments/checkout`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        cookie
      },
      body: JSON.stringify({ holdId, idempotencyKey })
    });
    const body = await res.json();
    if (res.ok) return body;
    if (res.status !== 409) throw new Error(`checkout failed: ${res.status} ${JSON.stringify(body)}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("checkout projection never became ready");
}

const registered = await request("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ email, password })
});
accessToken = registered.accessToken;

const seats = await request("/api/seats");
const first = seats.seats.find((seat) => seat.status === "AVAILABLE");
if (!first) throw new Error("no available seat");

const hold = await request(`/api/seats/${first.id}/hold`, { method: "POST", body: "{}" });
const checkout = await checkoutWithRetry(hold.holdId);
await request("/api/payments/mock/complete", {
  method: "POST",
  body: JSON.stringify({ paymentIntentId: checkout.paymentIntentId, outcome: "succeeded" })
});

await new Promise((resolve) => setTimeout(resolve, 1500));
const finalSeats = await request("/api/seats");
const reserved = finalSeats.seats.find((seat) => seat.id === first.id && seat.status === "RESERVED");
if (!reserved) throw new Error("seat was not reserved after payment completion");

console.log(`[smoke] reserved ${first.label} for ${email}`);
