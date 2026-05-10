import type { DataSource } from "typeorm";
import { getRequestContext, nextSequence } from "../context/request-context.js";
import { HttpBatchEmitter } from "../emitter/http-batch-emitter.js";
import { createId } from "../lib/ids.js";
import { buildRedactionSummary } from "../lib/redaction.js";
import { classifySqlQuery } from "../lib/sql.js";
import type { RuntimeEvent } from "../types.js";

interface TypeOrmInstrumentationOptions {
  dataSource: DataSource;
  emitter: HttpBatchEmitter;
  redactHeaders?: string[];
}

const PATCHED = Symbol("flowlens_typeorm_patched");

function buildDbEvent(
  query: string,
  durationMs: number,
  rowCount: number | undefined,
  redactHeaders?: string[],
): RuntimeEvent | null {
  const context = getRequestContext();

  if (!context?.sampled) {
    return null;
  }

  const sql = classifySqlQuery(query);

  return {
    id: createId("evt"),
    type: "db.query",
    observedAt: new Date().toISOString(),
    sequenceNo: nextSequence(),
    durationMs,
    request: {
      id: context.requestId,
      method: context.method,
      path: context.path,
      routePath: context.routePath,
    },
    observationType: "observed",
    confidence: 1,
    db: {
      driver: "postgresql",
      operation: sql.operation,
      tables: sql.tables,
      normalizedSql: sql.normalizedSql,
      rowCount,
      write: sql.write,
    },
    redaction: buildRedactionSummary(redactHeaders),
  };
}

export function instrumentTypeOrm(options: TypeOrmInstrumentationOptions): void {
  const { dataSource, emitter, redactHeaders } = options;
  const originalCreateQueryRunner = dataSource.createQueryRunner.bind(dataSource);

  dataSource.createQueryRunner = ((mode) => {
    const queryRunner = originalCreateQueryRunner(mode);
    const runner = queryRunner as typeof queryRunner & { [PATCHED]?: boolean };

    if (runner[PATCHED]) {
      return queryRunner;
    }

    runner[PATCHED] = true;
    const originalQuery = queryRunner.query.bind(queryRunner);

    queryRunner.query = (async (...args: Parameters<typeof originalQuery>) => {
      const startedAt = Date.now();
      const result = await originalQuery(...args);
      const durationMs = Date.now() - startedAt;
      const [query] = args;
      const rowCount =
        Array.isArray(result) ? result.length
        : result && typeof result === "object" && "affected" in result
          ? Number((result as { affected?: number }).affected ?? 0)
          : undefined;
      const event = buildDbEvent(String(query), durationMs, rowCount, redactHeaders);

      if (event) {
        emitter.enqueue(event);
      }

      return result;
    }) as typeof queryRunner.query;

    return queryRunner;
  }) as typeof dataSource.createQueryRunner;
}
