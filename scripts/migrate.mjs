import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const services = {
  auth: { dir: "apps/auth-service/migrations", url: process.env.AUTH_DATABASE_URL },
  seat: { dir: "apps/seat-service/migrations", url: process.env.SEAT_DATABASE_URL },
  payment: { dir: "apps/payment-service/migrations", url: process.env.PAYMENT_DATABASE_URL }
};

const target = process.argv[2] ?? "all";
const selected = target === "all" ? Object.entries(services) : [[target, services[target]]];

for (const [name, service] of selected) {
  if (!service?.url) throw new Error(`Missing database URL for ${name}`);
  const pool = new pg.Pool({ connectionString: service.url, max: 2, application_name: `${name}-migrate` });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const files = (await fs.readdir(path.join(root, service.dir))).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const already = await pool.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [file]);
      if (already.rowCount) continue;
      const sql = await fs.readFile(path.join(root, service.dir, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`[migrate] ${name}: applied ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}
