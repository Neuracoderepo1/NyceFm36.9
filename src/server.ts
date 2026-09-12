import { createApp } from "./app.js";
import { startMediaProcessingWorker } from "./lib/queue/mediaProcessing.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Last-resort safety net. The real fix for a given bug is always to catch
// it at the source (asyncHandler on routes, try/catch in middleware) — see
// docs/PRODUCTION_READINESS.md for the incident this was added after. This
// exists only so a bug that slips past those still gets logged instead of
// silently killing the process and taking the whole broadcast down with it.
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL-CLASS] Unhandled promise rejection (should have been caught upstream):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[FATAL-CLASS] Uncaught exception (should have been caught upstream):", err);
});

createApp()
  .then((app) => {
    const worker = startMediaProcessingWorker();
    worker.on("failed", (job, err) => {
      console.error(`media-processing job ${job?.id} failed:`, err.message);
    });

    app.listen(PORT, () => {
      console.log(`NYCE FM API listening on :${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
