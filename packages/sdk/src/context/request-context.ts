import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  routePath?: string;
  startedAt: number;
  eventSequence: number;
  sampled: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  callback: () => T,
): T {
  return storage.run(context, callback);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function nextSequence(): number {
  const context = getRequestContext();

  if (!context) {
    return 0;
  }

  context.eventSequence += 1;
  return context.eventSequence;
}

