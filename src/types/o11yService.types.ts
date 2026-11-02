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

/**
 * Type definitions for O11yService and related o11y integration.
 * Public API types (Connection, BatchingOptions, BatchStatus, MetricsTags) are exported for consumers.
 */

// ---------------------------------------------------------------------------
// O11y module / instrumentation (internal)
// ---------------------------------------------------------------------------

export interface Environment {
  appName: string;
  sdkVersion: string;
}

export interface InstrumentedAppOptions {
  isProduction: boolean;
  enableBuffering: boolean;
}

export interface SimpleCollector {
  hasData: boolean;
  estimatedByteSize: number;
  getRawContentsOfCoreEnvelope(): unknown;
}

export interface Instrumentation {
  log: (
    schema: unknown,
    data: Record<string, unknown> | { message: string },
    options?: {
      instrumentationContext?: {
        rootId?: string;
        parentId?: string;
        isRootActivitySampled?: boolean;
        isRootActivityExternalSampled?: boolean;
      };
    },
  ) => void;
  incrementCounter(
    operation: string,
    increment?: number,
    hasError?: boolean,
    tags?: MetricsTags,
  ): void;
  trackValue(
    operation: string,
    value: number,
    hasError?: boolean,
    tags?: MetricsTags,
  ): void;
  bucketValue(
    operation: string,
    value: number,
    buckets?: number[],
    hasError?: boolean,
    tags?: MetricsTags,
  ): void;
}

export interface InstrumentedAppMethods {
  simpleCollector?: SimpleCollector;
  registerLogCollector: (
    collector: SimpleCollector | LocalHeadlessCollector,
    options: { retroactive: boolean },
  ) => void;
  registerMetricsCollector: (collector: SimpleCollector) => void;
}

export type ConsoleCollector = Record<string, unknown>;

export type ProtoEncoderFuncType = (contents: unknown) => Uint8Array;

export interface O11yModules {
  o11yClientVersion: string;
  o11ySchemaVersion: string;
  getInstrumentation: (name?: string) => Instrumentation;
  registerInstrumentedApp: (
    name: string,
    options?: InstrumentedAppOptions,
  ) => InstrumentedAppMethods;
  ConsoleCollector: ConsoleCollector;
  a4d_instrumentation: unknown;
  simpleCollectorModule: {
    default?: {
      SimpleCollector: new (config: {
        environment: Environment;
      }) => SimpleCollector;
    };
    SimpleCollector: new (config: {
      environment: Environment;
    }) => SimpleCollector;
  };
  collectorsModule: {
    default?: {
      encodeCoreEnvelopeContentsRaw: ProtoEncoderFuncType;
    };
    encodeCoreEnvelopeContentsRaw: ProtoEncoderFuncType;
  };
}

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/** Re-export Connection from @salesforce/core so types stay aligned with consumers (Pack, AFV). */
export type { Connection } from "@salesforce/core";

/**
 * Opt-in configuration for publishing telemetry to the Falcon service
 * using API-key authentication.
 *
 * When a valid {@link FalconUploadOptions.apiKey} and a resolvable endpoint are
 * provided to {@link O11yService.initialize}, Falcon becomes the SELECTED upload
 * destination — telemetry publishes to the Falcon endpoint instead of Core
 * Connect/static transport (this is opt-in publishing, not a simultaneous
 * dual-write). Omit `falcon` entirely to preserve the existing behavior.
 *
 * The library hardcodes no Falcon URLs: the consumer supplies the pod base host(s)
 * and {@link FalconUploadOptions.environment} selects which one is used, so a
 * missing or invalid flag can never route to production. The consumer passes only
 * the base host — the library appends the fixed `/ui-telemetry` ingest path (see
 * {@link FalconUploadOptions.endpoints}).
 *
 * Key isolation: API keys are stored per-environment (per-FI), so a dev key works
 * only against the dev host and a prod key only against prod. Keep
 * {@link FalconUploadOptions.environment} consistent with the environment the key
 * was minted on, otherwise the ingest POST fails authentication.
 */
export interface FalconUploadOptions {
  /**
   * Falcon API key value (e.g. `o11y_pk_...`), sent as the `x-o11y-api-key`
   * request header. Minted via the Falcon `/manage-keys` UI for a specific
   * environment (dev or prod) and valid only against that environment. Never
   * hardcode this — pass it in from configuration at initialization.
   */
  apiKey: string;
  /**
   * Target Falcon environment. Defaults to `"dev"` so that a missing or invalid
   * flag can never route telemetry to production. Must match the environment the
   * {@link FalconUploadOptions.apiKey} was minted on (keys are per-environment).
   */
  environment?: "dev" | "prod";
  /**
   * Per-environment Falcon base hosts; {@link FalconUploadOptions.environment}
   * selects which one is used. Takes precedence over {@link FalconUploadOptions.endpoint}.
   * Supply only the pod base host — the library appends the fixed `/ui-telemetry`
   * ingest path. A URL that already ends in `/ui-telemetry` is accepted as-is (not
   * double-appended); any other explicit path is preserved as an override. Example:
   * `{ dev: "https://o11y.dev-pod.example.com" }`.
   */
  endpoints?: { dev?: string; prod?: string };
  /**
   * Shorthand base host for a single-environment consumer, used for the selected
   * `environment` when {@link FalconUploadOptions.endpoints} does not provide one.
   * Same normalization as `endpoints` (the `/ui-telemetry` path is appended). e.g.
   * `https://o11y.dev-pod.example.com` (dev).
   */
  endpoint?: string;
}

/**
 * Structural contract for a local-headless log collector registered on the shared
 * instrumented app. Used as the fallback for the Falcon path: when Falcon is opted in
 * (API key present) but no Falcon endpoint resolves, this collector captures telemetry
 * to a local file and o11y-reporter performs NO network upload (zero egress).
 *
 * This is the minimal `collect`/`close` surface of the first-party
 * `@o11y/local-headless` package's `LocalCollector`, which is intentionally
 * "structurally compatible with the framework's LogCollector.collect signature
 * without importing o11y". A compile-time check in o11yService.ts asserts the real
 * `LocalCollector` satisfies this type, so the shape stays honest without o11y-reporter
 * taking a runtime dependency on the package — the consumer owns the dependency and
 * injects the instance (e.g. `new LocalCollector({ filePath: "./o11y.jsonl" })`).
 *
 * Fields are typed structurally (not imported) so this stays decoupled from any
 * specific o11y client/schema version; the collector itself owns the file writing.
 */
export interface LocalHeadlessCollector {
  /**
   * Append one decoded telemetry record. Matches `@o11y/local-headless`'s
   * `LocalCollector.collect(schema, data, logMeta)`; parameters are typed loosely
   * because the framework hands the collector already-decoded values.
   */
  collect(schema: unknown, data: unknown, logMeta: unknown): void;
  /** Flush and release the underlying file/sink. Called by the consumer, not by o11y-reporter. */
  close(): void;
}

/**
 * Options for {@link O11yService.initialize}.
 */
export interface InitializeOptions {
  /**
   * Optional PROCESS-level application name, encoded as the CoreEnvelope `appName`
   * (the shared {@link SimpleCollector}'s `environment.appName`). Use it to label the
   * product/process this telemetry originates from (e.g. `"salesforce-cli"`,
   * `"salesforce-extension-pack"`, `"adk-agent"`).
   *
   * Identity model — DO NOT conflate these three surfaces:
   *  - Registered app / `loggerAppName`: process-global, registered exactly once via
   *    `registerInstrumentedApp`, and ALWAYS `"o11y-reporter-extensions"`. Never varies.
   *  - CoreEnvelope `appName` (THIS field): per PROCESS. The o11y client permits one
   *    registered app / one shared buffer per process, so this is first-writer-wins — the
   *    first `initialize()` sets it and a later call supplying a different value is logged
   *    and ignored. Sufficient for single-product processes (CLI, ADK, adk-mcp).
   *  - Per-event `loggerName`: per CONSUMER, sourced from `extensionName`, so co-hosted
   *    extensions in a shared process (e.g. the VS Code Extension Pack) stay distinguishable
   *    on every event even though they share one `appName`.
   *
   * When omitted, defaults to `"o11y-reporter-extensions"`, preserving existing behavior
   * exactly. This is NOT `extensionName`: `appName` is the shared process label; the
   * distinguishing per-consumer identity rides on `loggerName` (= `extensionName`). For a
   * single-product process it MAY equal `extensionName`; for a co-hosted process it can't
   * meaningfully vary per consumer (first-writer-wins), so rely on `loggerName` there.
   *
   * When provided, it must be a non-blank string: a blank/whitespace value is rejected and
   * telemetry is left uninitialized, because first-writer-wins would otherwise lock a blank
   * process identity into the shared buffer with no later recovery.
   */
  appName?: string;
  /**
   * Relative Core Connect proxy path from instance root for authenticated Core upload.
   * A default is used if omitted. See jsforce doc for request/requestPost (relative path from root).
   */
  dynamicO11yUploadEndpointPath?: string;
  /**
   * Opt-in Falcon publishing. When a valid API key and a resolvable endpoint are
   * present, telemetry publishes raw protobuf to the selected Falcon endpoint instead of
   * Core Connect/static transport. Omit to preserve current behavior exactly. See
   * {@link FalconUploadOptions}.
   */
  falcon?: FalconUploadOptions;
  /**
   * Local-headless collector, used as the fallback for the Falcon path: when
   * Falcon is opted in (API key present) but no endpoint resolves, this collector
   * is registered on the shared app and telemetry is captured locally with no
   * network egress instead of being uploaded. See {@link LocalHeadlessCollector}.
   */
  headlessCollector?: LocalHeadlessCollector;
}

/**
 * Tags for a metric series (see {@link O11yService.incrementCounter}). Each distinct set of tag
 * values is a separate series, so keep tags low-cardinality.
 */
export type MetricsTags = Record<string, string | number | boolean>;

/** Batching configuration options. */
export interface BatchingOptions {
  /** Periodic flush interval in milliseconds (default: 30000) */
  flushInterval?: number;
  /** Buffer size threshold in bytes before triggering upload (default: 50000 = 50KB) */
  thresholdBytes?: number;
  /** Threshold check interval in milliseconds (default: 2000 = 2s). Lower values catch threshold violations faster but use more CPU */
  checkInterval?: number;
  /** Enable shutdown hooks (default: true) */
  enableShutdownHook?: boolean;
  /** Enable beforeExit hook (default: true). Note: beforeExit won't fire for STDIO servers where stdin stays open */
  enableBeforeExitHook?: boolean;
}

/** Batch status information. */
export interface BatchStatus {
  hasData: boolean;
  /** Estimated size of the buffered upload in bytes, including the metrics recorded since the last upload. */
  estimatedByteSize: number;
  thresholdBytes: number;
  isOverThreshold: boolean;
}
