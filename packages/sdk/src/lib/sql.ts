export interface SqlClassification {
  operation: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "UNKNOWN";
  tables: string[];
  normalizedSql: string;
  write: boolean;
}

function normalizeWhitespace(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

function matchTables(query: string): string[] {
  const matches = [
    ...query.matchAll(/\bfrom\s+("?[\w.]+"?)/gi),
    ...query.matchAll(/\binto\s+("?[\w.]+"?)/gi),
    ...query.matchAll(/\bupdate\s+("?[\w.]+"?)/gi),
    ...query.matchAll(/\bjoin\s+("?[\w.]+"?)/gi),
  ];

  return [...new Set(matches.map((match) => match[1]?.replaceAll("\"", "")).filter(Boolean))];
}

export function classifySqlQuery(query: string): SqlClassification {
  const normalizedSql = normalizeWhitespace(query);
  const upper = normalizedSql.toUpperCase();
  const operation =
    upper.startsWith("SELECT") ? "SELECT"
    : upper.startsWith("INSERT") ? "INSERT"
    : upper.startsWith("UPDATE") ? "UPDATE"
    : upper.startsWith("DELETE") ? "DELETE"
    : "UNKNOWN";

  return {
    operation,
    tables: matchTables(normalizedSql),
    normalizedSql: normalizedSql.replace(/\$\d+/g, "?"),
    write: operation === "INSERT" || operation === "UPDATE" || operation === "DELETE",
  };
}

