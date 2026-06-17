import { describe, expect, it } from "vitest";

const base = process.env.TEST_BASE_URL ?? "http://localhost:8080";

async function register(email: string) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Password123!" })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body.accessToken as string;
}

describe("seat concurrency", () => {
  it("allows only one winner when two users hold the same seat", async () => {
    const [tokenA, tokenB] = await Promise.all([register(`a-${Date.now()}@example.com`), register(`b-${Date.now()}@example.com`)]);
    const seats = await fetch(`${base}/api/seats`).then((res) => res.json());
    const seat = seats.seats.find((candidate: { status: string }) => candidate.status === "AVAILABLE");
    expect(seat).toBeTruthy();

    const responses = await Promise.all([
      fetch(`${base}/api/seats/${seat.id}/hold`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
        body: "{}"
      }),
      fetch(`${base}/api/seats/${seat.id}/hold`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenB}` },
        body: "{}"
      })
    ]);

    const statuses = responses.map((res) => res.status).sort();
    expect(statuses).toEqual([201, 409]);
  });
});
