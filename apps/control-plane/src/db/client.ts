import { Pool } from "pg";
import type { EnvConfig } from "../config/env.js";

export function createDbPool(config: EnvConfig): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
  });
}

