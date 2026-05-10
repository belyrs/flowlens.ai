import type { Request } from "express";

function trimTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }

  return path;
}

export function resolveRoutePath(req: Request): string | undefined {
  if (req.route?.path) {
    const routeSegment =
      typeof req.route.path === "string"
        ? req.route.path
        : Array.isArray(req.route.path)
          ? req.route.path.join("|")
          : String(req.route.path);

    if (routeSegment === "/") {
      return trimTrailingSlash(req.baseUrl || routeSegment);
    }

    return trimTrailingSlash(`${req.baseUrl ?? ""}${routeSegment}` || routeSegment);
  }

  return undefined;
}
