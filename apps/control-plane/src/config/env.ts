export interface EnvConfig {
  port: number;
  databaseUrl: string;
  dbSchema: string;
  corsOrigin: string;
}

export function loadEnv(): EnvConfig {
  return {
    port: Number(process.env.PORT ?? "4000"),
    databaseUrl:
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/flowlens",
    dbSchema: process.env.DB_SCHEMA ?? "mapper",
    corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  };
}

