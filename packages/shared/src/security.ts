import crypto from "node:crypto";

export function sha256Base64Url(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function signWebhookPayload(secret: string, payload: Buffer, timestamp = Math.floor(Date.now() / 1000)): string {
  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`), payload]);
  const digest = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function verifyWebhookSignature(params: {
  secret: string;
  payload: Buffer;
  signatureHeader: string | undefined;
  toleranceSeconds: number;
}): boolean {
  if (!params.signatureHeader) return false;
  const parts = Object.fromEntries(params.signatureHeader.split(",").map((item) => item.split("=")));
  const timestamp = Number.parseInt(parts.t ?? "", 10);
  const received = parts.v1;
  if (!Number.isFinite(timestamp) || !received) return false;
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (ageSeconds > params.toleranceSeconds) return false;
  const expected = signWebhookPayload(params.secret, params.payload, timestamp).split("v1=")[1];
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(received, "hex");
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}
