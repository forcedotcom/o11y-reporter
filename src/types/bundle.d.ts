/*
 * Copyright 2026, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Type definitions for external dependencies
// Note: These modules are used at runtime but don't need TypeScript declarations here
// since they're external dependencies and the bundled code handles them

// Type definitions that should be available from o11y packages
interface Environment {
  appName: string;
  sdkVersion: string;
}

interface Instrumentation {
  log(schema: unknown, data: { message: string }): void;
}

interface InstrumentedAppMethods {
  registerLogCollector(collector: any, options: { retroactive: boolean }): void;
  registerMetricsCollector(collector: any): void;
  simpleCollector: any;
}

interface SimpleCollector {
  hasData: boolean;
  estimatedByteSize: number;
  getRawContentsOfCoreEnvelope(): unknown;
}

/** Re-exported from @salesforce/core so consumers can use one import. Requires @salesforce/core when using getConnection. */
import type { Connection } from "@salesforce/core";
export type { Connection };

/** Opt-in Falcon publishing configuration. See @salesforce/o11y-reporter docs. */
export interface FalconUploadOptions {
  /** Falcon API key value, sent as the `x-o11y-api-key` header. Minted per-environment via /manage-keys; valid only against the environment it was minted on. Never hardcode. */
  apiKey: string;
  /** Target Falcon environment. Defaults to "dev"; an invalid value is coerced to "dev". Must match the environment the apiKey was minted on. */
  environment?: "dev" | "prod";
  /** Per-environment Falcon base hosts; `environment` selects which is used. Takes precedence over `endpoint`. Supply only the base host — the library appends the fixed `/ui-telemetry` path (a URL already ending in it is not double-appended). */
  endpoints?: { dev?: string; prod?: string };
  /** Single-environment shorthand base host, used when `endpoints` has none for the selected environment. Same `/ui-telemetry` normalization as `endpoints`. */
  endpoint?: string;
}

/**
 * Structural contract for a local-headless log collector (e.g. @o11y/local-headless
 * LocalCollector), registered on the shared app as the fallback for the Falcon path.
 * The `collect`/`close` surface is typed structurally so o11y-reporter takes no runtime
 * dependency on @o11y/local-headless — the consumer owns the package and injects the instance.
 */
export interface LocalHeadlessCollector {
  collect(schema: unknown, data: unknown, logMeta: unknown): void;
  close(): void;
}

/** Options for O11yService.initialize. */
export interface InitializeOptions {
  /**
   * Optional PROCESS-level application name, encoded as the CoreEnvelope `appName` (the shared
   * SimpleCollector's `environment.appName`). First-writer-wins per process; a later init
   * supplying a different value is logged and ignored. Defaults to "o11y-reporter-extensions".
   * This is NOT `extensionName`: per-consumer identity rides on each event's `loggerName`.
   */
  appName?: string;
  /** Relative path from instance root for dynamic o11y upload. A default is used if omitted. */
  dynamicO11yUploadEndpointPath?: string;
  /** Opt-in Falcon publishing. When a valid key and endpoint resolve, telemetry publishes to Falcon instead of the existing path. */
  falcon?: FalconUploadOptions;
  /** Local-headless collector, registered as the Falcon fallback when Falcon is opted in but no endpoint resolves. Captured locally with no network egress. */
  headlessCollector?: LocalHeadlessCollector;
}

// Main O11yService class declaration
export declare class O11yService {
  O11Y_UPLOAD_THRESHOLD_BYTES: number;
  o11yUploadEndpoint: string | undefined;
  instrumentation: Instrumentation | undefined;
  a4dO11ySchema: unknown;
  readonly environment: Record<string, string>;

  private static instances: Map<string, O11yService>;
  private static readonly REGISTERED_APP_NAME: string;
  private static sharedAppName: string | null;
  private static sharedInstrApp: InstrumentedAppMethods | null;
  private static sharedO11yModules: any | null;
  private static sharedProtoEncoderFunc:
    | ((input: unknown) => Uint8Array)
    | null;
  private extensionName: string;

  private constructor();

  static getInstance(extensionId: string): O11yService;
  initialize(
    extensionName: string,
    o11yUploadEndpoint: string,
    getConnection?: () => Promise<Connection>,
    options?: InitializeOptions,
  ): Promise<void>;
  private initializeSharedResources(): Promise<void>;
  logEvent(properties?: { [key: string]: any }): void;
  logEventWithSchema(
    properties: { [key: string]: any },
    schema: unknown,
    rootId?: string,
  ): void;
  upload(): Promise<void>;
  initSimpleCollector(
    o11yApp: InstrumentedAppMethods,
    environment: Environment,
    o11yModules: any | null,
  ): Promise<SimpleCollector>;
  uploadAsNeededAsync(
    ignoreThreshold?: boolean,
  ): Promise<PromiseSettledResult<Response>[]>;
  /** @deprecated Renamed to uploadViaConnectionOrStaticAsync; retained as a forwarding alias for backward compatibility. */
  uploadToFalconAsync(binary: Uint8Array): Promise<Response>;
  uploadViaConnectionOrStaticAsync(binary: Uint8Array): Promise<Response>;
  postToFalconServiceAsync(binary: Uint8Array): Promise<Response>;
  postRequest(endpoint: string, body: any): Promise<any>;
  forceFlush(): Promise<void>;
  enableAutoBatching(options?: BatchingOptions): () => void;
  getBatchStatus(): BatchStatus;
}

export interface BatchingOptions {
  flushInterval?: number;
  thresholdBytes?: number;
  checkInterval?: number;
  enableShutdownHook?: boolean;
  enableBeforeExitHook?: boolean;
}

export interface BatchStatus {
  hasData: boolean;
  estimatedByteSize: number;
  thresholdBytes: number;
  isOverThreshold: boolean;
}
