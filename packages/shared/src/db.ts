import { Pool, PoolClient, PoolConfig } from "pg";

export function createPool(connectionString: string, serviceName: string): Pool {
  const config: PoolConfig = {
    connectionString,
    max: Number.parseInt(process.env.DB_POOL_MAX ?? "10", 10),
    application_name: serviceName
  };
  return new Pool(config);
}

export async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function checkPostgres(pool: Pool): Promise<"ok" | "down"> {
  try {
    await pool.query("SELECT 1");
    return "ok";
  } catch {
    return "down";
  }
}
