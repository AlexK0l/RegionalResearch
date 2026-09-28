import { Worker } from "bullmq";
import { QUEUE_NAME, createRedis } from "./src/queue.js";
import { runResearchPipeline } from "./src/pipeline.js";

const connection = createRedis();
const resultRedis = createRedis();

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    try {
      return await runResearchPipeline({ job, redis: resultRedis });
    } catch (error) {
      if (error?.message === "JOB_CANCELLED") {
        await job.updateProgress({
          ...(typeof job.progress === "object" ? job.progress : {}),
          phase: "cancelled"
        });
        throw new Error("Остановлено пользователем");
      }
      throw error;
    }
  },
  {
    connection,
    concurrency: 1,
    lockDuration: 30 * 60 * 1000,
    stalledInterval: 60 * 1000,
    maxStalledCount: 1
  }
);

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id} failed:`, error);
});

async function shutdown() {
  await worker.close();
  await Promise.allSettled([connection.quit(), resultRedis.quit()]);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log("SAT research worker started");
