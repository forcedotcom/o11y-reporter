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

import { createHash } from "node:crypto";
import type {
  BatchingOptions,
  BatchStatus,
  Connection,
  Environment,
  FalconUploadOptions,
  InitializeOptions,
  Instrumentation,
  InstrumentedAppMethods,
  LocalHeadlessCollector,
  O11yModules,
  ProtoEncoderFuncType,
  SimpleCollector,
} from "./types/o11yService.types";
import { loadO11yModules } from "./utils/o11yLoader";

export type {
  BatchingOptions,
  BatchStatus,
  Connection,
  FalconUploadOptions,
  InitializeOptions,
  LocalHeadlessCollector,
} from "./types/o11yService.types";

/**
 * Resolved Falcon publishing config. Opt-in is keyed on the API key; the endpoint
 * may be undefined when none resolves for the selected environment, in which case
 * telemetry routes to the local-headless sink (Falcon's fallback) instead.
 */
interface ResolvedFalconConfig {
  endpoint?: string;
  apiKey: string;
}

/**
 * Falcon binary-ingest path. The service exposes the API-key/octet-stream ingest route at
 * `/ui-telemetry`; the adjacent `/telemetry` route is SSO/Kerberos-gated (an API-key POST
 * there is bounced to a login page, i.e. HTTP 400). Consumers therefore supply only the pod
 * host (e.g. from the manage-keys UI) and the library appends this path — see
 * {@link normalizeFalconEndpoint}. Kept internal because it is a service protocol detail,
 * not a consumer choice.
 */
const FALCON_INGEST_PATH = "/ui-telemetry";

/**
 * Normalize a consumer-supplied Falcon base URL to the full ingest URL.
 *
 * The consumer configures only the base host (the environment-specific part they get from the
 * manage-keys UI); the library owns the fixed {@link FALCON_INGEST_PATH}. To stay tolerant of
 * consumers/tools that already pass a full URL (e.g. spike scripts, older docs, or the
 * CoreCollector convention), an endpoint whose path already ends in the ingest path is returned
 * unchanged rather than double-appended. Any other non-empty path is preserved as an explicit
 * override so a future route rename does not force a library release. A trailing slash on a
 * bare host is trimmed before appending, and any query string is preserved. Returns undefined
 * for undefined/blank input.
 */
function normalizeFalconEndpoint(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Not a parseable absolute URL; pass through unchanged and let the POST surface the error.
    return trimmed;
  }
  // Preserve any query string (e.g. a routing/version flag) across normalization.
  const path = url.pathname.replace(/\/+$/, "");
  // Already the ingest path (with or without a trailing slash) — do not double-append.
  if (path === FALCON_INGEST_PATH) {
    return `${url.origin}${FALCON_INGEST_PATH}${url.search}`;
  }
  // A bare host ("/" or empty path) → append the ingest path.
  if (path === "" || path === "/") {
    return `${url.origin}${FALCON_INGEST_PATH}${url.search}`;
  }
  // A different explicit path → treat as an intentional override and preserve it.
  return trimmed;
}

export class O11yService {
  O11Y_UPLOAD_THRESHOLD_BYTES = 50_000; // Default: 50KB (safe with 2s check interval)
  o11yUploadEndpoint: string | undefined;
  instrumentation: Instrumentation | undefined;
  a4dO11ySchema: unknown;
  readonly environment: Record<string, string> = {};

  // Connection method provided by extension for dynamic endpoint resolution
  private getConnectionMethod: (() => Promise<Connection>) | null = null;

  // Relative path for o11y upload when using connection.requestPost (see jsforce doc: relative path from root)
  private dynamicO11yUploadEndpointPath =
    "/services/data/v65.0/connect/proxy/ui-telemetry";

  // Opt-in Falcon publishing config (see FalconUploadOptions), resolved at initialize().
  // Opt-in is keyed on the API key; when a Falcon endpoint also resolves, Falcon is the
  // SELECTED upload destination instead of the existing org/static path. When the key is
  // present but no endpoint resolves, telemetry falls back to the local-headless collector
  // (see headlessMode). Null preserves current behavior exactly.
  private falconUpload: ResolvedFalconConfig | null = null;

  // Local-headless collector (e.g. @o11y/local-headless LocalCollector) injected by the
  // consumer. Registered on the shared app as the fallback for the Falcon path when Falcon
  // is opted in but no endpoint resolves. The collector persists telemetry locally itself.
  private headlessCollector: LocalHeadlessCollector | null = null;

  // True when Falcon is opted in (API key present) but no endpoint resolved AND a headless
  // collector was injected. In this mode telemetry is captured locally by the headless
  // collector and NO network upload is performed (zero egress).
  private headlessMode = false;

  // Map to store multiple instances per extension
  private static instances: Map<string, O11yService> = new Map();

  // Track headless collectors already registered on the shared app, so registering the same
  // collector instance from multiple O11yService instances does not duplicate its events.
  private static readonly registeredHeadlessCollectors = new WeakSet<object>();

  // Serialize shared-resource init so only one registerInstrumentedApp() runs when multiple extensions initialize concurrently (or when multiple copies of this library share one o11y client)
  private static sharedResourcesInitPromise: Promise<void> | null = null;

  // ---------------------------------------------------------------------------
  // Application identity — THREE distinct surfaces, deliberately kept separate.
  // Do NOT collapse them in future changes (see W-23947379).
  //
  //  1. Registered app / loggerAppName  ── process-global, registered EXACTLY ONCE
  //     via registerInstrumentedApp(REGISTERED_APP_NAME). Always "o11y-reporter-extensions".
  //     The o11y client permits only one registered app per process; this never varies.
  //  2. CoreEnvelope appName            ── per PROCESS. The shared SimpleCollector's
  //     environment.appName. Configurable via InitializeOptions.appName, first-writer-wins
  //     (the shared buffer is process-global, so the first initialize() sets it). Defaults
  //     to REGISTERED_APP_NAME to preserve existing behavior. See sharedAppName.
  //  3. Per-event loggerName            ── per CONSUMER. Sourced from extensionName via a
  //     per-instance getInstrumentation(extensionName), so co-hosted extensions in one
  //     process (e.g. the VS Code Extension Pack) stay distinguishable on every event.
  // ---------------------------------------------------------------------------

  // The process-global registered application name. This IS loggerAppName; it is registered
  // exactly once and must never change (the o11y client allows one registered app per process).
  private static readonly REGISTERED_APP_NAME = "o11y-reporter-extensions";

  // Max extensionName length. o11y's getInstrumentation() SILENTLY truncates names longer than
  // this (to 76 chars + "_CUT"), which would change the encoded loggerName out from under the
  // caller. We reject longer names up front so the identity invariant below stays honest.
  private static readonly MAX_EXTENSION_NAME_LENGTH = 80;

  // Instrumentation names the o11y client owns. It creates getInstrumentation("Network") and
  // getInstrumentation("IdleDetector") internally, and "WebVitals" names its web-vitals schema;
  // reusing any of them would alias o11y-owned instrumentation and cross-label our events with the
  // framework's. Kept in sync with the client (see o11y client.js). Case-sensitive, exact match.
  private static readonly RESERVED_INSTRUMENTATION_NAMES: readonly string[] = [
    "IdleDetector",
    "Network",
    "WebVitals",
  ];

  // The CoreEnvelope appName that won (first-writer-wins). Set once when the shared buffer is
  // created, from the FIRST initializer's resolved appName. A later initialize() supplying a
  // different appName is logged and ignored (the shared buffer is process-global). Null until
  // shared resources are initialized. Reset alongside sharedInstrApp.
  private static sharedAppName: string | null = null;

  // Shared app across all extensions. Per-event logging uses a PER-INSTANCE named
  // instrumentation (this.instrumentation = getInstrumentation(extensionName)), NOT a shared
  // one, so loggerName distinguishes consumers. Readiness is gated on the resources actually
  // consumed by logging/upload (sharedO11yModules, sharedInstrApp, sharedProtoEncoderFunc).
  private static sharedInstrApp: InstrumentedAppMethods | null = null;
  private static sharedO11yModules: O11yModules | null = null;
  private static sharedProtoEncoderFunc: ProtoEncoderFuncType | null = null;
  private static loggedProtoEncoderNotInitialized = false;

  // First-writer-wins owner of the shared buffer's upload destination.
  //
  // The buffer drained on flush is the STATIC shared SimpleCollector (one per process — the o11y
  // client permits only one registered app), but the upload destination (Falcon / headless /
  // connection-or-static) is resolved per instance. When multiple extensions share one process
  // (e.g. the Salesforce Extension Pack, all in one VS Code extension host), each has its own
  // batching timer; whichever fires first drains ALL pooled events. Routing by that instance's
  // own config would non-deterministically send every extension's events to whatever destination
  // happened to flush first. Instead, the FIRST instance to initialize claims ownership, and the
  // drain always routes via the owner's config — deterministic regardless of which timer fires.
  // A later initialize() that resolves a CONFLICTING destination is logged and ignored (its events
  // still follow the owner's route, since the buffer is shared). This mirrors the "first
  // initialization wins" model W-23947379 uses for the shared appName. Reset with sharedInstrApp.
  private static sharedUploadOwner: O11yService | null = null;

  // Extension-specific properties
  private extensionName?: string;

  // Consumer-requested PROCESS-level CoreEnvelope appName (InitializeOptions.appName). Only the
  // FIRST initializer's value takes effect (first-writer-wins, stored in static sharedAppName);
  // retained per instance so a later initialize() can be compared for a conflict log. Undefined
  // means "not supplied" -> resolvedAppName() falls back to REGISTERED_APP_NAME.
  private requestedAppName?: string;

  // Batching state
  private flushTimer: NodeJS.Timeout | null = null;
  private shutdownHandler: (() => Promise<void>) | null = null;
  private shutdownHandlers?: {
    beforeExit?: () => Promise<void>;
    SIGINT: () => Promise<void>;
    SIGTERM: () => Promise<void>;
  };
  private configuredThresholdBytes?: number; // Per-instance threshold override

  private constructor() {}

  public static getInstance(extensionId: string): O11yService {
    if (!O11yService.instances.has(extensionId)) {
      const instance = new O11yService();
      O11yService.instances.set(extensionId, instance);
    }
    return O11yService.instances.get(extensionId)!;
  }

  /**
   * Resolve opt-in Falcon config. Opt-in is keyed on the API key: with a valid key,
   * a config is always returned. The endpoint is taken from `endpoints[environment]`,
   * falling back to the singular `endpoint` shorthand, and may be undefined when none
   * resolves — in which case telemetry falls back to the local-headless collector.
   *
   * The dev/prod flag defaults to "dev", and an unknown flag value is coerced to
   * "dev", so a missing or invalid environment can never route to production.
   *
   * Returns null (Falcon disabled, existing path unchanged) only when the API key
   * is missing.
   */
  private static resolveFalconConfig(
    falcon: FalconUploadOptions,
  ): ResolvedFalconConfig | null {
    if (!falcon.apiKey) {
      console.error(
        "[O11yService] Falcon publishing requested but apiKey is missing; Falcon disabled.",
      );
      return null;
    }

    const environment = falcon.environment === "prod" ? "prod" : "dev";
    const rawEndpoint = falcon.endpoints?.[environment] ?? falcon.endpoint;
    // Consumers configure only the pod host; the library appends the fixed ingest path
    // (tolerating full URLs). See normalizeFalconEndpoint / FALCON_INGEST_PATH.
    const endpoint = normalizeFalconEndpoint(rawEndpoint);
    return { endpoint, apiKey: falcon.apiKey };
  }

  /**
   * Initialize the O11y service with extension name, upload endpoint, and optional connection for dynamic endpoint.
   *
   * @param extensionName - Per-consumer identifier (e.g. "salesforcedx-vscode-core"); becomes the
   *   per-event `loggerName`. Validated up front (see {@link validateExtensionName}): must be a
   *   non-blank string with no surrounding whitespace, no backtick, at most 80 characters, and must
   *   not be the registered app name or a reserved o11y instrumentation name. An invalid value
   *   leaves the service uninitialized (logged, non-throwing) without claiming any shared state.
   * @param o11yUploadEndpoint - Static fallback endpoint URL; used when getConnection is not provided or fails.
   * @param getConnection - Optional callback returning the current org's Connection (e.g. from workspace context). When provided and successful, uploads use the org endpoint via connection.requestPost.
   * @param options - Optional config; see {@link InitializeOptions}. A supplied `appName` must be
   *   non-blank (see {@link InitializeOptions.appName}).
   */
  async initialize(
    extensionName: string,
    o11yUploadEndpoint: string,
    getConnection?: () => Promise<Connection>,
    options?: InitializeOptions,
  ) {
    // Validate identity inputs FIRST — before touching any instance or process-global state — so an
    // invalid first caller cannot half-initialize itself while still determining shared state (the
    // registered app, sharedAppName, and the upload-destination owner are all first-writer-wins).
    // Best-effort telemetry: on an invalid value we log a clear error and leave the service
    // uninitialized (return) rather than throw, so a bad config never disrupts the host application.
    if (!O11yService.validateIdentityInputs(extensionName, options?.appName)) {
      return;
    }

    // Reuse guard: co-hosted extensions must each use their OWN getInstance(id). Per-event
    // loggerName is bound per instance (this.instrumentation = getInstrumentation(extensionName)),
    // so re-initializing ONE instance with a DIFFERENT extensionName silently re-binds it and
    // mislabels every subsequent event under the last name. Flag it; keep the last-writer behavior
    // (non-fatal) but make the footgun visible. Idempotent re-init with the same name stays silent.
    if (
      this.extensionName !== undefined &&
      this.extensionName !== extensionName
    ) {
      console.error(
        `[O11yService] initialize() called again on the same instance with a different ` +
          `extensionName ("${this.extensionName}" -> "${extensionName}"); its per-event loggerName ` +
          `will be re-bound and subsequent events labeled "${extensionName}". Co-hosted extensions ` +
          `should each use their own O11yService.getInstance(<unique id>) instead of sharing one instance.`,
      );
    }

    this.extensionName = extensionName;
    this.o11yUploadEndpoint = o11yUploadEndpoint;
    this.getConnectionMethod = getConnection || null;
    // PROCESS-level CoreEnvelope appName (surface #2). Retained for the first-writer-wins
    // resolution and later conflict check; undefined -> defaults to REGISTERED_APP_NAME.
    this.requestedAppName = options?.appName;
    if (options?.dynamicO11yUploadEndpointPath) {
      this.dynamicO11yUploadEndpointPath =
        options.dynamicO11yUploadEndpointPath.startsWith("/")
          ? options.dynamicO11yUploadEndpointPath
          : `/${options.dynamicO11yUploadEndpointPath}`;
    }

    // Opt-in Falcon publishing (keyed on the API key). With a valid key and a resolvable
    // endpoint, Falcon is the selected upload destination. With a valid key but no endpoint,
    // telemetry falls back to the injected local-headless collector (headlessMode). A missing
    // key disables Falcon and preserves the existing connection/static behavior exactly.
    this.falconUpload = options?.falcon
      ? O11yService.resolveFalconConfig(options.falcon)
      : null;

    // Local-headless collector (e.g. @o11y/local-headless LocalCollector) injected by the
    // consumer, registered as the Falcon fallback below when no endpoint resolves.
    this.headlessCollector = options?.headlessCollector ?? null;

    // Headless mode: Falcon opted in but no endpoint resolved, and a headless collector was
    // injected. Telemetry is captured locally by that collector; no network upload is done.
    this.headlessMode =
      !!this.falconUpload &&
      !this.falconUpload.endpoint &&
      !!this.headlessCollector;

    if (
      this.falconUpload &&
      !this.falconUpload.endpoint &&
      !this.headlessCollector
    ) {
      console.error(
        "[O11yService] Falcon opted in but no endpoint resolved and no headlessCollector provided; falling back to the existing upload path (org connection / static endpoint).",
      );
    }

    // Initialize shared resources if not already done (serialized so only one registerInstrumentedApp runs)
    if (!O11yService.sharedInstrApp) {
      if (!O11yService.sharedResourcesInitPromise) {
        O11yService.sharedResourcesInitPromise =
          this.runInitializeSharedResourcesOnce();
      }
      await O11yService.sharedResourcesInitPromise;
    }

    // Check if telemetry initialization was successful. Gated on the resources actually
    // consumed by logging/upload — they are set together on success and reset together on
    // failure (see initializeSharedResources). Per-event logging no longer uses a shared
    // instrumentation, so it is not part of this readiness signal.
    if (!O11yService.sharedO11yModules || !O11yService.sharedInstrApp) {
      // Telemetry failed to initialize, but don't throw - just continue without telemetry
      console.error(
        "O11yService: Telemetry initialization failed - continuing without telemetry",
      );
      return;
    }

    // Per-CONSUMER instrumentation: bind this instance's own named instrumentation so every event
    // carries loggerName = extensionName. Fails closed (uninitialized) if the client rejects the
    // name, rather than letting an exception escape into the host. See bindInstrumentation.
    if (!this.bindInstrumentation(O11yService.sharedO11yModules)) {
      return;
    }

    // Public read-only mirror of this instance's EFFECTIVE identity across the three surfaces.
    // This object no longer drives the CoreEnvelope appName (the shared collector does — see
    // sharedAppName); it is populated truthfully for consumers that inspect it: appName is the
    // process-level winner (NOT this instance's requested value unless it won), loggerName is this
    // consumer's per-event identity (= extensionName), and loggerAppName is the registered app.
    const { o11yClientVersion, o11ySchemaVersion } =
      O11yService.sharedO11yModules;
    Object.assign(this.environment, {
      appName: O11yService.sharedAppName ?? O11yService.REGISTERED_APP_NAME,
      loggerName: this.extensionName,
      loggerAppName: O11yService.REGISTERED_APP_NAME,
      o11ySchemaVersion,
      sdkVersion: `${o11yClientVersion}:${o11ySchemaVersion}`,
    });

    // Headless fallback: register the injected local-headless collector on the shared app so
    // it captures log events to a local file. Registered at most once per collector instance.
    if (this.headlessMode && this.headlessCollector) {
      this.registerHeadlessCollector(this.headlessCollector);
    }

    // First-writer-wins ownership of the shared buffer's upload destination. See
    // sharedUploadOwner. The first initialized instance claims it; a later instance that
    // resolves a CONFLICTING destination is logged and ignored (events still follow the owner's
    // route because the buffer is shared).
    this.claimOrCheckSharedUploadDestination();

    // First-writer-wins on the process-level CoreEnvelope appName (surface #2): if this instance
    // requested a different appName than the winning one, log and ignore it. Per-consumer identity
    // is unaffected — it rides on each event's loggerName (= extensionName), set above.
    this.checkAppNameConflict();
  }

  /**
   * Bind this instance's per-consumer named instrumentation (so every event carries
   * loggerName = extensionName). getInstrumentation is memoized by name in the o11y client, so
   * repeated getInstance()/initialize() for the same extension returns the same instrumentation and
   * this does NOT register an app (registerInstrumentedApp still runs exactly once).
   *
   * {@link validateExtensionName} already rules out the inputs the current client rejects, so this
   * should not throw. It is still wrapped defensively: a future client version could add new name
   * constraints, and telemetry must fail closed (leave this.instrumentation undefined and report
   * failure) rather than let an exception escape into the host application. Returns true when the
   * instrumentation was bound, false when it failed.
   */
  private bindInstrumentation(modules: O11yModules): boolean {
    try {
      this.instrumentation = modules.getInstrumentation(this.extensionName);
    } catch (error) {
      console.error(
        `[O11yService] getInstrumentation("${this.extensionName}") failed; continuing without telemetry.`,
        error instanceof Error ? error.message : error,
      );
      this.instrumentation = undefined;
      return false;
    }
    this.a4dO11ySchema = modules.a4d_instrumentation;
    return true;
  }

  /**
   * Describe this instance's resolved upload destination as a stable key, so two instances can be
   * compared for a routing conflict on the shared buffer. See {@link sharedUploadOwner}.
   *
   * For the Falcon destination the key includes BOTH the endpoint and a non-reversible fingerprint
   * of the API key: the shared buffer is uploaded under a single `x-o11y-api-key`, so two co-hosted
   * extensions hitting the SAME pod with DIFFERENT tenant keys must count as a conflict — otherwise
   * the later extension's events would be attributed to the first owner's tenant. The key is
   * fingerprinted (SHA-256, truncated) so the secret itself never lands in a key or an error log.
   */
  private uploadDestinationKey(): string {
    if (this.headlessMode) {
      return "headless";
    }
    if (this.falconUpload?.endpoint) {
      return `falcon:${this.falconUpload.endpoint}#${O11yService.fingerprintApiKey(this.falconUpload.apiKey)}`;
    }
    return "connection-or-static";
  }

  /**
   * Non-reversible, non-logging fingerprint of a Falcon API key, used only to compare two
   * instances' key identity in {@link uploadDestinationKey} without ever exposing the secret.
   */
  private static fingerprintApiKey(apiKey: string): string {
    return createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
  }

  /**
   * Claim first-writer-wins ownership of the shared buffer's upload destination, or, if an owner
   * already exists, log an error when this instance resolved a CONFLICTING destination. The owner
   * is what {@link uploadAsNeededAsync} routes by, so its route is authoritative for all pooled
   * events regardless of which instance's batching timer drains the buffer. See
   * {@link sharedUploadOwner}.
   */
  private claimOrCheckSharedUploadDestination(): void {
    const owner = O11yService.sharedUploadOwner;
    if (!owner || owner === this) {
      O11yService.sharedUploadOwner = this;
      return;
    }
    if (owner.uploadDestinationKey() !== this.uploadDestinationKey()) {
      console.error(
        `[O11yService] Conflicting telemetry upload destination: "${this.extensionName}" resolved ` +
          `"${this.uploadDestinationKey()}" but the shared buffer is already owned by ` +
          `"${owner.extensionName}" ("${owner.uploadDestinationKey()}"). The shared buffer is ` +
          `process-global (one registered o11y app), so all pooled events follow the first ` +
          `owner's destination; this instance's setting is ignored.`,
      );
    }
  }

  /**
   * Gate {@link initialize} on the identity inputs. Validates the required extensionName and, only
   * when explicitly supplied, the process-level appName. Logs a clear error and returns false on the
   * first invalid value so the caller can leave the service uninitialized WITHOUT mutating any
   * instance or process-global state. Returns true when both are acceptable.
   */
  private static validateIdentityInputs(
    extensionName: string,
    requestedAppName: string | undefined,
  ): boolean {
    const extensionNameError = O11yService.validateExtensionName(extensionName);
    if (extensionNameError) {
      console.error(
        `[O11yService] Invalid extensionName; telemetry not initialized. ${extensionNameError}`,
      );
      return false;
    }
    // Omitting appName is valid (defaults to the registered app name); only a supplied value is
    // checked, so a blank/whitespace appName cannot win first-writer-wins and lock a blank process
    // identity into the shared collector.
    if (requestedAppName !== undefined) {
      const appNameError =
        O11yService.validateRequestedAppName(requestedAppName);
      if (appNameError) {
        console.error(
          `[O11yService] Invalid appName; telemetry not initialized. ${appNameError}`,
        );
        return false;
      }
    }
    return true;
  }

  /**
   * Validate a consumer-supplied extensionName BEFORE it is used to derive per-event identity or
   * to touch any instance/shared state. The name must survive to the wire unchanged, because the
   * WI's invariant is:
   *
   *     extensionName === instrumentation name === encoded loggerName
   *
   * o11y's getInstrumentation() would otherwise accept problematic names in ways that quietly break
   * that invariant or alias framework-owned instrumentation:
   *  - empty/blank -> getInstrumentation throws (requireArgument);
   *  - names > {@link MAX_EXTENSION_NAME_LENGTH} -> SILENTLY truncated (76 + "_CUT"), so loggerName
   *    would differ from what the caller passed;
   *  - the reserved backtick -> rejected by the client (it is the field delimiter);
   *  - {@link REGISTERED_APP_NAME} -> collides with the app's own instrumentation (client throws
   *    "is being used by the app");
   *  - {@link RESERVED_INSTRUMENTATION_NAMES} -> aliases o11y-owned instrumentation (Network,
   *    IdleDetector, WebVitals), cross-labeling our events with the framework's.
   *
   * Returns an error message when invalid, or null when the name is acceptable. Names are preserved
   * EXACTLY — no trimming, prefixing, or hashing — so the invariant holds. Surrounding whitespace is
   * rejected (not trimmed) because a trimmed name would no longer equal the caller's string.
   */
  private static validateExtensionName(extensionName: string): string | null {
    if (typeof extensionName !== "string") {
      return `extensionName must be a string; received ${typeof extensionName}.`;
    }
    if (extensionName.length === 0) {
      return "extensionName must be a non-empty string.";
    }
    if (extensionName.trim().length === 0) {
      return "extensionName must not be blank/whitespace-only.";
    }
    if (extensionName !== extensionName.trim()) {
      return `extensionName must not have leading or trailing whitespace: "${extensionName}".`;
    }
    if (extensionName.includes("`")) {
      return `extensionName must not contain the reserved backtick character: "${extensionName}".`;
    }
    if (extensionName.length > O11yService.MAX_EXTENSION_NAME_LENGTH) {
      return (
        `extensionName must be at most ${O11yService.MAX_EXTENSION_NAME_LENGTH} characters ` +
        `(the o11y client silently truncates longer names, which would change loggerName); ` +
        `received ${extensionName.length}.`
      );
    }
    if (extensionName === O11yService.REGISTERED_APP_NAME) {
      return (
        `extensionName must not equal the registered app name "${O11yService.REGISTERED_APP_NAME}" ` +
        `(it collides with the shared app's own instrumentation).`
      );
    }
    if (O11yService.RESERVED_INSTRUMENTATION_NAMES.includes(extensionName)) {
      return (
        `extensionName must not be a reserved o11y instrumentation name ` +
        `(${O11yService.RESERVED_INSTRUMENTATION_NAMES.join(", ")}): "${extensionName}".`
      );
    }
    return null;
  }

  /**
   * Validate an EXPLICITLY supplied process-level appName ({@link InitializeOptions.appName}). Only
   * a provided value is checked; `undefined` means "not supplied" and is handled by
   * {@link resolvedAppName} (defaults to {@link REGISTERED_APP_NAME}). A blank/whitespace-only
   * appName must be rejected: SimpleCollector preserves it verbatim and first-writer-wins would lock
   * that blank value in as the process identity for every co-hosted consumer, with no later recovery.
   *
   * Returns an error message when invalid, or null when acceptable.
   */
  private static validateRequestedAppName(appName: string): string | null {
    if (typeof appName !== "string") {
      return `appName must be a string; received ${typeof appName}.`;
    }
    if (appName.trim().length === 0) {
      return "appName, when provided, must be a non-blank string.";
    }
    return null;
  }

  /**
   * Resolve this instance's requested PROCESS-level CoreEnvelope appName (identity surface #2).
   * Returns the explicit {@link InitializeOptions.appName} when supplied, otherwise the constant
   * {@link REGISTERED_APP_NAME} default — preserving prior behavior for callers that pass no
   * appName. This is NOT the per-event identity: co-hosted extensions are distinguished by
   * loggerName (= extensionName) on every event, regardless of the shared appName.
   */
  private resolvedAppName(): string {
    return this.requestedAppName ?? O11yService.REGISTERED_APP_NAME;
  }

  /**
   * First-writer-wins check for the process-level CoreEnvelope appName. The o11y client permits
   * one registered app / one shared buffer per process, so the FIRST instance to run shared-init
   * sets {@link sharedAppName} for the whole process. A later initialize() that requests a
   * DIFFERENT appName is logged and ignored (its events still ride the shared buffer under the
   * first owner's appName). A later instance that requests the SAME value — or none — is silent.
   */
  private checkAppNameConflict(): void {
    // Only an EXPLICITLY supplied appName can conflict. A later init that omits appName is not
    // "supplying a different value" — it accepts whatever the first writer set — so stay silent
    // (comparing the defaulted value would wrongly flag every default-omitting co-host).
    if (this.requestedAppName === undefined) {
      return;
    }
    if (
      O11yService.sharedAppName !== null &&
      this.requestedAppName !== O11yService.sharedAppName
    ) {
      console.error(
        `[O11yService] Conflicting telemetry appName: "${this.extensionName}" requested ` +
          `"${this.requestedAppName}" but the shared buffer's appName is already "${O11yService.sharedAppName}". ` +
          `The CoreEnvelope appName is process-global (one registered o11y app), so all pooled ` +
          `events keep the first owner's appName; this instance's setting is ignored. Per-consumer ` +
          `identity is preserved on each event's loggerName (= extensionName).`,
      );
    }
  }

  /**
   * Register a local-headless collector (e.g. @o11y/local-headless LocalCollector) on the
   * shared instrumented app so it captures log events to its local file. Registered at most
   * once per collector instance (registering the same collector twice would duplicate events).
   * Best-effort: a failure here never disrupts initialization.
   */
  private registerHeadlessCollector(collector: LocalHeadlessCollector): void {
    if (O11yService.registeredHeadlessCollectors.has(collector)) {
      return;
    }
    try {
      // registerLogCollector accepts the LocalHeadlessCollector contract directly
      // (see InstrumentedAppMethods); @o11y/local-headless's LocalCollector satisfies it
      // structurally, asserted at compile time in o11yService.test.ts.
      O11yService.sharedInstrApp?.registerLogCollector(collector, {
        retroactive: true,
      });
      O11yService.registeredHeadlessCollectors.add(collector);
    } catch (error) {
      console.error(
        "[O11yService] Failed to register local-headless collector:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Run shared resource initialization once; used to serialize concurrent inits so only one registerInstrumentedApp() runs (avoids "An app has already been registered with instrumentation" when multiple extensions or multiple copies of the library share one o11y client).
   */
  private runInitializeSharedResourcesOnce(): Promise<void> {
    return this.initializeSharedResources().finally(() => {
      // Allow retry on next initialize() if init failed (shared state was reset in catch)
      if (!O11yService.sharedInstrApp) {
        O11yService.sharedResourcesInitPromise = null;
      }
    });
  }

  private async initializeSharedResources() {
    try {
      // Ensure modules are loaded before using them
      O11yService.sharedO11yModules = await loadO11yModules();

      if (!O11yService.sharedO11yModules) {
        console.error("Failed to load O11y modules");
        return;
      }

      const { o11yClientVersion, o11ySchemaVersion, registerInstrumentedApp } =
        O11yService.sharedO11yModules!;

      // STEP 1: Register the shared app. The registered name IS loggerAppName — process-global
      // and registered EXACTLY ONCE (this method is serialized so only one call runs per
      // process). It must stay REGISTERED_APP_NAME and is independent of the configurable
      // CoreEnvelope appName below. Per-event identity comes from per-instance instrumentation
      // (getInstrumentation(extensionName)), NOT a shared instrumentation.
      O11yService.sharedInstrApp = registerInstrumentedApp(
        O11yService.REGISTERED_APP_NAME,
        {
          isProduction: false,
          enableBuffering: true,
        },
      );

      if (!O11yService.sharedInstrApp) {
        console.error(
          "Failed to register shared app:",
          O11yService.REGISTERED_APP_NAME,
        );
        return;
      }

      // Fresh shared buffer -> clear any prior owner so the first instance to finish
      // initialize() against this app claims the upload destination. See sharedUploadOwner.
      O11yService.sharedUploadOwner = null;

      // CoreEnvelope appName (surface #2): first-writer-wins. This method is serialized and
      // runs on the FIRST instance to initialize, so its resolved appName wins for the whole
      // process; a later initialize() supplying a different appName is logged and ignored
      // (see checkAppNameConflict). Defaults to REGISTERED_APP_NAME, preserving prior behavior.
      O11yService.sharedAppName = this.resolvedAppName();

      // STEP 2: Register a metrics collector on the shared app. environment.appName is the
      // process-level CoreEnvelope appName resolved above (NOT the registered app name).
      if (O11yService.sharedInstrApp) {
        O11yService.sharedInstrApp.simpleCollector = this.initSimpleCollector(
          O11yService.sharedInstrApp,
          {
            appName: O11yService.sharedAppName,
            sdkVersion: `${o11yClientVersion}:${o11ySchemaVersion}`,
          },
          O11yService.sharedO11yModules,
        );
      }

      // Set up shared proto encoder
      if (O11yService.sharedO11yModules) {
        const { collectorsModule } = O11yService.sharedO11yModules;
        const encoderModule = collectorsModule.default ?? collectorsModule;

        // Runtime validation of the encoder function
        if (typeof encoderModule.encodeCoreEnvelopeContentsRaw === "function") {
          O11yService.sharedProtoEncoderFunc =
            encoderModule.encodeCoreEnvelopeContentsRaw;
        } else {
          console.error(
            "Failed to initialize proto encoder function - encodeCoreEnvelopeContentsRaw is not a function",
          );
          return;
        }
      } else {
        console.error("sharedO11yModules is null after loading");
        return;
      }
    } catch (error) {
      console.error("Failed to initialize shared O11y resources:", error);
      // Reset shared resources on failure
      O11yService.sharedInstrApp = null;
      O11yService.sharedO11yModules = null;
      O11yService.sharedAppName = null;
      O11yService.sharedProtoEncoderFunc = null;
      O11yService.sharedUploadOwner = null;
      // Don't throw - continue without telemetry
    }
  }

  public logEvent(properties?: Record<string, unknown>): void {
    if (!this.isInitialized()) {
      console.error(
        "O11yService: Cannot log event - Service not fully initialized",
      );
      console.error("Initialization status:", this.getInitializationStatus());
      return;
    }

    if (this.instrumentation) {
      this.instrumentation.log(this.a4dO11ySchema, {
        message: JSON.stringify(properties),
      });
    } else {
      console.error(
        "O11yService: Unable to log event - Instrumentation not initialized",
      );
    }
  }

  /**
   * Log an event with a consumer-provided schema
   *
   * @param properties - Event properties to log
   * @param schema - Schema object provided by consumer (loaded from o11y_schema package)
   * @param rootId - optional correlation root; threaded onto the CoreEnvelope via
   *   instrumentationContext so a single root_id query joins a headless run's spans.
   *   (parentId can be added to the same context later for cross-session nesting.)
   */
  public logEventWithSchema(
    properties: Record<string, unknown>,
    schema: unknown,
    rootId?: string,
  ): void {
    if (!this.isInitialized()) {
      console.error(
        "O11yService: Cannot log event - Service not fully initialized",
      );
      console.error("Initialization status:", this.getInitializationStatus());
      return;
    }

    if (!schema) {
      console.error("O11yService: Schema not provided to logEventWithSchema");
      return;
    }

    if (this.instrumentation) {
      // Pass the consumer-provided schema and properties to the instrumentation logger;
      // events are encoded with this schema (e.g. PdpEvent) rather than a default.
      // Only pass the instrumentation-context arg when a rootId is supplied — a trailing
      // explicit `undefined` would change the recorded call arity (breaks strict arg matchers).
      if (rootId) {
        this.instrumentation.log(schema, properties, {
          instrumentationContext: { rootId },
        });
      } else {
        this.instrumentation.log(schema, properties);
      }
    } else {
      console.error(
        "O11yService: Unable to log event - Instrumentation not initialized",
      );
    }
  }

  public isInitialized(): boolean {
    return !!(
      O11yService.sharedProtoEncoderFunc &&
      O11yService.sharedInstrApp &&
      O11yService.sharedO11yModules &&
      this.instrumentation
    );
  }

  public getInitializationStatus(): {
    sharedProtoEncoderFunc: boolean;
    sharedInstrApp: boolean;
    sharedO11yModules: boolean;
    instrumentation: boolean;
  } {
    return {
      sharedProtoEncoderFunc: !!O11yService.sharedProtoEncoderFunc,
      sharedInstrApp: !!O11yService.sharedInstrApp,
      sharedO11yModules: !!O11yService.sharedO11yModules,
      instrumentation: !!this.instrumentation,
    };
  }

  public async waitForInitialization(
    timeoutMs: number = 5000,
  ): Promise<boolean> {
    const startTime = Date.now();

    // First check immediately (most common case)
    if (this.isInitialized()) {
      return true;
    }

    // Use exponential backoff for polling to reduce CPU usage
    let pollInterval = 5; // Start with 5ms

    while (!this.isInitialized()) {
      if (Date.now() - startTime > timeoutMs) {
        console.error(
          "O11yService: Initialization timeout after",
          timeoutMs,
          "ms",
        );
        console.error(
          "Final initialization status:",
          this.getInitializationStatus(),
        );
        return false;
      }

      // Wait with exponential backoff (5ms -> 10ms -> 20ms -> 50ms -> 100ms)
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      pollInterval = Math.min(pollInterval * 2, 100); // Cap at 100ms
    }

    return true;
  }

  async upload(): Promise<void> {
    if (!this.isInitialized()) {
      console.error(
        "O11yService: Cannot upload - Service not fully initialized",
      );
      return;
    }

    try {
      // Log anything that was buffered
      await this.uploadAsNeededAsync(true);
    } catch (error) {
      // We log the failure but do not throw, preventing disruptions in telemetry reporting.
      console.error("Telemetry upload failed:", error);
    }
  }

  initSimpleCollector(
    o11yApp: InstrumentedAppMethods,
    environment: Environment,
    o11yModules: O11yModules | null,
  ): SimpleCollector {
    if (!o11yModules) {
      throw new Error("o11yModules is null");
    }

    const { simpleCollectorModule } = o11yModules;
    const SimpleCollectorClass =
      simpleCollectorModule.default?.SimpleCollector ??
      simpleCollectorModule.SimpleCollector;

    const simpleCollector = new SimpleCollectorClass({
      environment,
    });

    o11yApp.registerLogCollector(simpleCollector, { retroactive: true });
    o11yApp.registerMetricsCollector(simpleCollector);
    return simpleCollector;
  }

  uploadAsNeededAsync(
    ignoreThreshold = false,
  ): Promise<PromiseSettledResult<Response>[]> {
    const promises: Promise<Response>[] = [];

    if (!O11yService.sharedProtoEncoderFunc) {
      if (!O11yService.loggedProtoEncoderNotInitialized) {
        O11yService.loggedProtoEncoderNotInitialized = true;
        console.error(
          "O11yService: sharedProtoEncoderFunc is not initialized (shared telemetry init likely failed); uploads skipped.",
        );
      }
      return Promise.resolve([]); // Prevents the function from throwing an error
    }

    const simpleCollector = O11yService.sharedInstrApp?.simpleCollector;
    const thresholdBytes =
      this.configuredThresholdBytes ?? this.O11Y_UPLOAD_THRESHOLD_BYTES;
    if (
      simpleCollector?.hasData &&
      (ignoreThreshold || simpleCollector.estimatedByteSize >= thresholdBytes)
    ) {
      // The buffer drained here is the STATIC shared SimpleCollector, pooled across every
      // instance in the process. Route by the first-writer-wins OWNER's destination — not this
      // instance's — so the outcome is deterministic no matter which instance's batching timer
      // fires. See sharedUploadOwner / claimOrCheckSharedUploadDestination.
      const owner = O11yService.sharedUploadOwner ?? this;

      // Headless mode: the injected local-headless collector already captured the log
      // events to its local file; perform NO network upload (zero egress). We still drain
      // the shared SimpleCollector's buffer (below) so it does not grow unbounded.
      if (owner.headlessMode) {
        try {
          simpleCollector.getRawContentsOfCoreEnvelope(); // drain buffer; discard bytes
        } catch (error) {
          console.error(
            "[O11yService][uploadAsNeededAsync] Error draining buffer in headless mode:",
            error,
          );
        }
        return Promise.resolve([]);
      }

      try {
        const rawContents = simpleCollector.getRawContentsOfCoreEnvelope();
        const binary = O11yService.sharedProtoEncoderFunc(rawContents);
        // Destination selection (opt-in Falcon publishing), routed via the shared-buffer owner:
        //   - Falcon opted in with a resolved endpoint -> Falcon POST. On failure the POST
        //     rejects (logged and rethrown); it does NOT fall back at runtime. The headless
        //     collector is a config-time fallback for the no-endpoint case only (headlessMode,
        //     handled above), not a catch for a failed Falcon POST.
        //   - else existing path: authenticated org connection, then static endpoint.
        if (owner.falconUpload?.endpoint) {
          promises.push(owner.postToFalconServiceAsync(binary));
        } else {
          promises.push(owner.uploadViaConnectionOrStaticAsync(binary));
        }
      } catch (error) {
        console.error(
          "[O11yService][uploadAsNeededAsync] Error during upload encoding:",
          error,
        );
        return Promise.resolve([]);
      }
    }

    return Promise.allSettled(promises).then(async (results) => {
      for (const result of results) {
        if (result.status === "fulfilled") {
          const response = result.value;
          if (response.status < 200 || response.status >= 300) {
            console.error(
              `[O11yService][uploadAsNeededAsync] ✗ Upload FAILED with status ${response.status} ${response.statusText}. Events may not be in Splunk.`,
            );
          }
        } else {
          console.error(
            `[O11yService][uploadAsNeededAsync] ✗ Upload FAILED:`,
            result.reason,
          );
          if (result.reason instanceof Error) {
            console.error(
              `[O11yService][uploadAsNeededAsync] Error stack:`,
              result.reason.stack,
            );
          }
        }
      }
      return results;
    });
  }

  /**
   * @deprecated Renamed to {@link uploadViaConnectionOrStaticAsync}, which reflects what this
   * path actually does (it never talked to the Falcon service). Retained as a forwarding alias
   * for backward compatibility with any existing caller of the previously-public method; will be
   * removed in a future major version. New code should call `uploadViaConnectionOrStaticAsync`.
   */
  async uploadToFalconAsync(binary: Uint8Array): Promise<Response> {
    return this.uploadViaConnectionOrStaticAsync(binary);
  }

  /**
   * The existing (pre-Falcon) upload path. Despite the historical name it does NOT talk to
   * the Falcon service: it posts the base64-encoded envelope to the authenticated org
   * connection via `requestPost` (primary), falling back to the static `o11yUploadEndpoint`
   * via `postRequest`. Selected by {@link uploadAsNeededAsync} when Falcon is not the chosen
   * destination (no Falcon API key, or no resolved Falcon endpoint).
   */
  async uploadViaConnectionOrStaticAsync(
    binary: Uint8Array,
  ): Promise<Response> {
    const b64 = Buffer.from(binary).toString("base64");
    const body = { base64Env: b64 };

    // Existing path: authenticated org connection first (primary), static endpoint as its fallback.
    if (this.getConnectionMethod) {
      try {
        const connection = await this.getConnectionMethod();
        // Use requestPost when available (jsforce: relative path from root, sets method + contentType). Core's Connection type omits it, so we cast.
        const conn = connection as
          | { requestPost?(url: string, body: object): Promise<unknown> }
          | null
          | undefined;
        if (conn?.requestPost) {
          await conn.requestPost(this.dynamicO11yUploadEndpointPath, body);
          return { status: 200, ok: true } as Response;
        }
      } catch {
        // Fall through to static endpoint (connection's fallback).
      }
    }

    const endpoint = this.o11yUploadEndpoint || "";
    if (!endpoint) {
      return Promise.reject(new Error("o11yUploadEndpoint is not defined"));
    }
    return this.postRequest(endpoint, body);
  }

  /**
   * Publish the encoded envelope to the Falcon service (o11y-processing-service)
   * using API-key authentication. This is the OPT-IN publishing path: when a Falcon
   * API key AND a resolved endpoint are configured, Falcon is the SELECTED upload
   * destination and replaces the existing org/static path for that upload. Only
   * invoked from the routing chain when `falconUpload.endpoint` is set.
   *
   * Unlike the existing path, Falcon expects the RAW CoreEnvelope protobuf bytes with
   * `Content-Type: application/octet-stream` (not the `{ base64Env }` JSON body), and
   * authenticates by the `x-o11y-api-key` header rather than an org session. It always
   * posts directly to the configured Falcon endpoint via fetch.
   */
  async postToFalconServiceAsync(binary: Uint8Array): Promise<Response> {
    if (!this.falconUpload) {
      return Promise.reject(new Error("Falcon publishing is not configured"));
    }
    const { endpoint } = this.falconUpload;
    if (!endpoint) {
      return Promise.reject(
        new Error("Falcon endpoint is not defined for publishing"),
      );
    }
    // Copy into a standalone ArrayBuffer (valid BodyInit) in case `binary` is a view over a
    // larger backing buffer; equivalent to curl --data-binary of the raw protobuf bytes.
    // Cast resolves the ArrayBufferLike union (never a SharedArrayBuffer here at runtime).
    const bytes = binary.buffer.slice(
      binary.byteOffset,
      binary.byteOffset + binary.byteLength,
    ) as ArrayBuffer;
    return fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-o11y-api-key": this.falconUpload.apiKey,
      },
      // Send the raw protobuf bytes (equivalent to curl --data-binary).
      body: bytes,
    }).catch((error) => {
      console.error(
        `[O11yService][postToFalconServiceAsync] ✗ Falcon POST FAILED for ${endpoint}:`,
        error instanceof Error ? error.message : error,
      );
      throw error;
    });
  }

  postRequest(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const bodyString = JSON.stringify(body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    return fetch(endpoint, {
      method: "POST",
      headers,
      body: bodyString,
    }).catch((error) => {
      console.error(
        `[O11yService][postRequest] ✗ POST Request FAILED for ${endpoint}:`,
        error,
      );
      if (error instanceof Error) {
        console.error(
          `[O11yService][postRequest] Error details:`,
          error.message,
          error.stack,
        );
      }
      throw error;
    });
  }

  /**
   * Force an immediate flush of buffered events, ignoring size threshold
   * This is an alias for upload() with a more explicit name for batching scenarios
   * @returns Promise that resolves when upload completes
   */
  public async forceFlush(): Promise<void> {
    const status = this.getBatchStatus();
    if (!status.hasData) {
      return; // Nothing to flush
    }
    return this.upload();
  }

  /**
   * Enable automatic batching with periodic flush and shutdown hooks
   * Uses a unified timer model: 2s buffer health checks (default) + 30s periodic flush (default)
   *
   * Features:
   * - Automatic event batching to reduce network overhead
   * - Threshold-based uploads (50KB default) for immediate upload when buffer is large
   * - Frequent threshold checks (2s default) to prevent buffer from exceeding server limits
   * - Periodic flush (30s default) to ensure events are sent regularly
   * - Shutdown hooks (SIGINT, SIGTERM, beforeExit) to flush events on application termination
   * - Automatic dynamic endpoint resolution (if workspace context getter is registered globally)
   *
   * @param options - Batching configuration options
   * @returns Cleanup function to stop batching and remove hooks
   */
  public enableAutoBatching(options?: BatchingOptions): () => void {
    const flushInterval = options?.flushInterval ?? 30_000; // 30 seconds default for real-time telemetry
    const shortCheckInterval = options?.checkInterval ?? 2_000; // 2 seconds for buffer health checks (reduced from 5s to prevent 413 errors)
    const enableShutdownHook = options?.enableShutdownHook ?? true;
    // Configure threshold (default: 50KB, safe with 2s check interval)
    this.configuredThresholdBytes =
      options?.thresholdBytes ?? this.O11Y_UPLOAD_THRESHOLD_BYTES;

    // Clear any existing timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    let lastFlushTime = Date.now();

    // Unified Timer: runs lightweight checks every 2s (default), full flush every 30s (default)
    this.flushTimer = setInterval(async () => {
      try {
        const now = Date.now();
        await this.uploadAsNeededAsync(false); // Check threshold

        // Full flush based on flushInterval (default 30s)
        if (now - lastFlushTime >= flushInterval) {
          await this.uploadAsNeededAsync(true); // ignoreThreshold = true
          lastFlushTime = now;
        }
      } catch (error) {
        console.error("[O11yService] Auto-batching flush failed:", error);
        // Don't throw - fire-and-forget approach
      }
    }, shortCheckInterval);

    // Shutdown handler
    if (enableShutdownHook) {
      const enableBeforeExit = options?.enableBeforeExitHook !== false; // Default to true

      // Create separate handlers for each signal
      const createShutdownHandler = (signal: string) => {
        return async () => {
          try {
            const status = this.getBatchStatus();
            if (status.hasData) {
              await this.uploadAsNeededAsync(true); // ignoreThreshold = true
            }
          } catch (error) {
            console.error(
              `[O11yService] Shutdown flush failed for ${signal}:`,
              error,
            );
            if (error instanceof Error) {
              console.error(`[O11yService] Error stack:`, error.stack);
            }
            // Don't throw - fire-and-forget approach
          }
        };
      };

      const sigintHandler = createShutdownHandler("SIGINT");
      const sigtermHandler = createShutdownHandler("SIGTERM");

      // Register signal handlers (always register these)
      process.on("SIGINT", sigintHandler);
      process.on("SIGTERM", sigtermHandler);

      // Conditionally register beforeExit handler
      if (enableBeforeExit) {
        this.shutdownHandler = createShutdownHandler("beforeExit");
        process.on("beforeExit", this.shutdownHandler);
      }

      // Store handlers for cleanup
      this.shutdownHandlers = {
        SIGINT: sigintHandler,
        SIGTERM: sigtermHandler,
        ...(enableBeforeExit && this.shutdownHandler
          ? { beforeExit: this.shutdownHandler }
          : {}),
      };
    }

    // Return cleanup function
    return () => {
      if (this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = null;
      }

      if (enableShutdownHook && this.shutdownHandlers) {
        if (this.shutdownHandlers.beforeExit) {
          process.removeListener(
            "beforeExit",
            this.shutdownHandlers.beforeExit,
          );
        }
        process.removeListener("SIGINT", this.shutdownHandlers.SIGINT);
        process.removeListener("SIGTERM", this.shutdownHandlers.SIGTERM);
        this.shutdownHandler = null;
        this.shutdownHandlers = undefined;
      }
    };
  }

  /**
   * Get current batch status information
   * @returns Batch status including buffer size and threshold information
   */
  public getBatchStatus(): BatchStatus {
    const simpleCollector = O11yService.sharedInstrApp?.simpleCollector;
    const hasData = simpleCollector?.hasData || false;
    const estimatedByteSize = simpleCollector?.estimatedByteSize || 0;
    const thresholdBytes =
      this.configuredThresholdBytes ?? this.O11Y_UPLOAD_THRESHOLD_BYTES;
    const isOverThreshold = estimatedByteSize >= thresholdBytes;

    return {
      hasData,
      estimatedByteSize,
      thresholdBytes,
      isOverThreshold,
    };
  }
}
