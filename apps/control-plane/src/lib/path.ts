const TRACKED_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function isDynamicPathSegment(segment: string): boolean {
  return (
    /^\d+$/.test(segment) ||
    /^[0-9a-fA-F-]{24,}$/.test(segment) ||
    /^did:/.test(segment) ||
    /^did%3A/i.test(segment) ||
    /^[^/]{33,}$/.test(segment) ||
    (segment.length >= 16 && /[@:.]/.test(segment))
  );
}

export function normalizeRoutePath(routePath?: string, rawPath?: string): string {
  if (routePath && routePath.length > 0) {
    return routePath.length > 1 && routePath.endsWith("/")
      ? routePath.slice(0, -1)
      : routePath;
  }

  if (!rawPath) {
    return "/unknown";
  }

  const pathname = rawPath.split("?")[0] || rawPath;

  const segments = pathname.split("/").filter(Boolean).map((segment) => {
    if (isDynamicPathSegment(segment)) {
      return ":id";
    }

    return segment;
  });

  const normalized = `/${segments.join("/")}`;
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

export function isTrackedHttpMethod(method?: string): boolean {
  return TRACKED_HTTP_METHODS.has((method ?? "").toUpperCase());
}

export function isIgnoredRoutePath(routePath?: string, rawPath?: string): boolean {
  const path = normalizeRoutePath(routePath, rawPath);
  return path === "/favicon.ico" || path === "/unknown";
}
