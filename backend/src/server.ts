import { createApp } from "./app.js";
import { startBroadcastWorker } from "./services/broadcastWorker.js";
import { startMediaProcessor, stopMediaProcessor } from "./services/mediaProcessor.js";
import { stopBroadcastWorker } from "./services/broadcastWorker.js";
import { startAiWorker, stopAiWorker } from "./services/aiWorker.js";
import { pool } from "./db/pool.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

createApp()
  .then((app) => {
    startMediaProcessor();
    if (process.env.BROADCAST_WORKER_ENABLED === "true") startBroadcastWorker();
    startAiWorker();
    const server = app.listen(PORT, () => {
      console.log(`NYCE FM API listening on :${PORT}`);
    });
    const shutdown = () => {
      stopBroadcastWorker();
      stopAiWorker();
      stopMediaProcessor();
      server.close(async () => {
        try { await pool.end(); } finally { process.exit(0); }
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
