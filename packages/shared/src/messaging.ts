import amqp, { Channel, Connection } from "amqplib";
import type { Pool } from "pg";
import { EVENT_EXCHANGE, type DomainEvent, type EventName } from "./contracts";
import type { Logger } from "./logger";

export interface Broker {
  connection: Connection;
  channel: Channel;
  publish: (event: DomainEvent) => Promise<void>;
  close: () => Promise<void>;
}

export async function createBroker(url: string, logger: Logger): Promise<Broker> {
  const connection = await amqp.connect(url);
  const channel = await connection.createChannel();
  await channel.assertExchange(EVENT_EXCHANGE, "topic", { durable: true });
  return {
    connection,
    channel,
    publish: async (event) => {
      const body = Buffer.from(JSON.stringify(event));
      const ok = channel.publish(EVENT_EXCHANGE, event.name, body, {
        contentType: "application/json",
        deliveryMode: 2,
        messageId: event.eventId,
        timestamp: Date.now()
      });
      if (!ok) logger.warn({ action: "broker_backpressure", eventName: event.name });
    },
    close: async () => {
      await channel.close();
      await connection.close();
    }
  };
}

export async function consumeEvents(
  broker: Broker,
  queueName: string,
  bindings: EventName[],
  handler: (event: DomainEvent) => Promise<void>,
  logger: Logger
) {
  const queue = await broker.channel.assertQueue(queueName, { durable: true });
  for (const binding of bindings) {
    await broker.channel.bindQueue(queue.queue, EVENT_EXCHANGE, binding);
  }
  await broker.channel.consume(queue.queue, async (message) => {
    if (!message) return;
    try {
      const event = JSON.parse(message.content.toString("utf8")) as DomainEvent;
      await handler(event);
      broker.channel.ack(message);
    } catch (error) {
      logger.error({ action: "event_consume_failed", queueName, error });
      broker.channel.nack(message, false, true);
    }
  });
}

export async function startOutboxPublisher(
  serviceName: string,
  pool: Pool,
  broker: Broker,
  logger: Logger,
  intervalMs = 1000
) {
  const timer = setInterval(async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT id, event_name, payload
           FROM outbox
          WHERE status = 'PENDING' AND next_attempt_at <= NOW()
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 25`
      );
      for (const row of rows) {
        const event: DomainEvent = {
          eventId: row.id,
          name: row.event_name,
          occurredAt: new Date().toISOString(),
          payload: row.payload
        };
        await broker.publish(event);
        await client.query("UPDATE outbox SET status = 'PUBLISHED', published_at = NOW() WHERE id = $1", [row.id]);
        logger.info({ action: "outbox_published", serviceName, eventName: event.name, eventId: event.eventId });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      logger.error({ action: "outbox_publish_failed", serviceName, error });
    } finally {
      client.release();
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
