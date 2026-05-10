import type {
  RuntimeEvent,
  RuntimeEventBatch,
  SdkDescriptor,
  ServiceDescriptor,
} from "../types.js";

interface BatchEmitterOptions {
  controlPlaneUrl: string;
  service: ServiceDescriptor;
  sdk: SdkDescriptor;
  emitIntervalMs: number;
}

function resolveIngestUrl(controlPlaneUrl: string): string {
  if (controlPlaneUrl.endsWith("/api/v1/events/batch")) {
    return controlPlaneUrl;
  }

  return `${controlPlaneUrl.replace(/\/$/, "")}/api/v1/events/batch`;
}

export class HttpBatchEmitter {
  private readonly ingestUrl: string;
  private readonly service: ServiceDescriptor;
  private readonly sdk: SdkDescriptor;
  private readonly emitIntervalMs: number;
  private readonly queue: RuntimeEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(options: BatchEmitterOptions) {
    this.ingestUrl = resolveIngestUrl(options.controlPlaneUrl);
    this.service = options.service;
    this.sdk = options.sdk;
    this.emitIntervalMs = options.emitIntervalMs;
    this.start();
  }

  enqueue(event: RuntimeEvent): void {
    this.queue.push(event);
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) {
      return;
    }

    this.flushing = true;
    const batchEvents = this.queue.splice(0, this.queue.length);

    const payload: RuntimeEventBatch = {
      schemaVersion: "1.0",
      sentAt: new Date().toISOString(),
      service: this.service,
      sdk: this.sdk,
      events: batchEvents,
    };

    try {
      await fetch(this.ingestUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      console.error("[flowlens-sdk] failed to flush events", error);
      this.queue.unshift(...batchEvents);
    } finally {
      this.flushing = false;
    }
  }

  flushSoon(): void {
    void this.flush();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private start(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.emitIntervalMs);

    this.timer.unref?.();
  }
}
