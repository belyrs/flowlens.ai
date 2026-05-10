import cors from "cors";
import express from "express";
import { loadEnv } from "./config/env.js";
import { createApiRouter } from "./api/routes.js";
import { createDbPool } from "./db/client.js";
import { ensureSchema } from "./db/schema.js";

async function bootstrap() {
  const env = loadEnv();
  const pool = createDbPool(env);

  await ensureSchema(pool, env.dbSchema);

  const app = express();
  app.use(cors({ origin: env.corsOrigin }));
  app.use(express.json({ limit: "1mb" }));
  app.use(createApiRouter({ pool, schema: env.dbSchema }));

  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("[control-plane] request failed", error);
      res.status(500).json({
        error: "Internal server error",
        message: error.message,
      });
    },
  );

  app.listen(env.port, () => {
    console.log(`[control-plane] listening on http://localhost:${env.port}`);
  });
}

bootstrap().catch((error) => {
  console.error("[control-plane] failed to start", error);
  process.exitCode = 1;
});
