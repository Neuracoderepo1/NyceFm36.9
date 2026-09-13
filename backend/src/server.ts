import { createApp } from "./app.js";
import { stopBroadcastWorker } from "./services/broadcastWorker.js";
import { stopMediaProcessor } from "./services/mediaProcessor.js";
import { stopAiWorker } from "./services/aiWorker.js";
import { startWorkersSequenced } from "./services/workerOrchestrator.js";
import { pool } from "./db/pool.js";
import { closeRedisClient } from "./lib/redis.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

createApp()
  .then(async (app) => {
    const activation = await startWorkersSequenced();
    console.log("[startup] worker activation:", activation);
    const server = app.listen(PORT, () => {
      console.log(`NYCE FM API listening on :${PORT}`);
    });
    const shutdown = () => {
      stopBroadcastWorker();
      stopAiWorker();
      stopMediaProcessor();
      server.close(async () => {
        try {
          await closeRedisClient();
        } finally {
          try { await pool.end(); } finally { process.exit(0); }
        }
      });
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  })
  .catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
