import type { Application } from "express";
import type { DataSource } from "typeorm";
import { instrumentCord } from "./cord/instrument.js";
import { HttpBatchEmitter } from "./emitter/http-batch-emitter.js";
import { instrumentExpress } from "./express/instrument.js";
import { instrumentFetch } from "./http/instrument.js";
import { instrumentRedis } from "./redis/instrument.js";
import { instrumentTypeOrm } from "./typeorm/instrument.js";
import type { RuntimeEvent, RuntimeEventBatch, ServiceDescriptor } from "./types.js";

export interface InitializeMapperOptions {
  serviceName: string;
  controlPlaneUrl: string;
  dataSource: DataSource;
  redisClient?: object;
  capturePayloads?: boolean;
  redactHeaders?: string[];
  emitIntervalMs?: number;
  sampleRate?: number;
  instrumentFetch?: boolean;
  serviceVersion?: string;
  environment?: string;
}

export interface MapperHandle {
  shutdown: () => Promise<void>;
}

const SDK_VERSION = "0.1.2";

export function initializeMapper(
  app: Application,
  options: InitializeMapperOptions,
): MapperHandle {
  const service: ServiceDescriptor = {
    name: options.serviceName,
    runtime: "node",
    framework: "express",
    version: options.serviceVersion,
    environment: options.environment ?? process.env.NODE_ENV ?? "local",
  };

  const emitter = new HttpBatchEmitter({
    controlPlaneUrl: options.controlPlaneUrl,
    service,
    sdk: {
      name: "backend-flow-mapper-sdk",
      version: SDK_VERSION,
    },
    emitIntervalMs: options.emitIntervalMs ?? 2000,
  });

  instrumentExpress({
    app,
    emitter,
    service,
    sampleRate: options.sampleRate ?? 1,
    redactHeaders: options.redactHeaders,
    capturePayloads: options.capturePayloads ?? (service.environment !== "production"),
  });

  instrumentTypeOrm({
    dataSource: options.dataSource,
    emitter,
    redactHeaders: options.redactHeaders,
  });

  if (options.redisClient) {
    instrumentRedis({
      redisClient: options.redisClient,
      emitter,
      redactHeaders: options.redactHeaders,
    });
  }

  if (options.instrumentFetch ?? true) {
    instrumentFetch({
      emitter,
      redactHeaders: options.redactHeaders,
    });
  }

  instrumentCord({
    emitter,
    redactHeaders: options.redactHeaders,
  });

  return {
    shutdown: async () => {
      await emitter.flush();
      emitter.stop();
    },
  };
}

export type { RuntimeEvent, RuntimeEventBatch } from "./types.js";
