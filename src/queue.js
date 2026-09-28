import IORedis from "ioredis";
import { Queue } from "bullmq";

export const QUEUE_NAME = "sat-research";

export function createRedis() {
  if (!process.env.REDIS_URL) throw new Error("REDIS_URL is not configured");
  return new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
  });
}

export const queueConnection = createRedis();
export const queue = new Queue(QUEUE_NAME, { connection: queueConnection });
