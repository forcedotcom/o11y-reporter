# O11y Reporter

A lightweight telemetry reporting service for Salesforce extensions that enables sending metrics and events to Salesforce's observability platform.

## Usage

The O11y Reporter service provides a simple way to send telemetry events and metrics to Salesforce's observability platform. Here's how to use it:

### 1. Initialize the Service

```typescript
import { O11yService } from "@salesforce/o11y-reporter";

// Get the singleton instance
const o11yService = O11yService.getInstance(extensionName);

// Initialize with your extension name and upload endpoint (static endpoint only)
await o11yService.initialize(
  "your-extension-name",
  "https://your-upload-endpoint",
);
```

**Dynamic endpoint (authenticated org):** To send telemetry to the current org’s endpoint (with automatic fallback to the static endpoint if the connection is unavailable), pass an optional `getConnection` callback and, if needed, an options object with `dynamicO11yUploadEndpointPath`. If you omit the path, a default is used.

```typescript
import { O11yService, type Connection } from "@salesforce/o11y-reporter";

const o11yService = O11yService.getInstance(extensionName);

await o11yService.initialize(
  "your-extension-name",
  "https://fallback-static-endpoint",
  () => yourWorkspaceContext.getConnection(),
  { dynamicO11yUploadEndpointPath: "/your/telemetry/path" },
);
```

The `Connection` type is re-exported from `@salesforce/core`; depend on it when using `getConnection`.

**Opt-in Falcon publishing (API key):** Publish telemetry to the Falcon service instead of the org/static endpoint by passing a `falcon` option. Opt-in is keyed on the API key: with a valid key **and** a resolved endpoint, Falcon becomes the selected upload destination; a missing key preserves the existing behavior exactly. Supply only the pod base host — the library appends the fixed `/ui-telemetry` ingest path. The key is sent as the `x-o11y-api-key` header; never hardcode it (read it from config/env), and note a key is valid only against the environment (`dev`/`prod`) it was minted on.

```typescript
import {
  O11yService,
  type FalconUploadOptions,
} from "@salesforce/o11y-reporter";

const o11yService = O11yService.getInstance(extensionName);

await o11yService.initialize(
  "your-extension-name",
  "https://fallback-static-endpoint",
  () => yourWorkspaceContext.getConnection(),
  {
    falcon: {
      apiKey: process.env.O11Y_FALCON_API_KEY!, // never hardcode
      environment: "dev", // "dev" | "prod"; defaults to "dev"
      endpoints: {
        dev: "https://your-dev-pod-host",
        prod: "https://your-prod-pod-host",
      },
    },
  },
);
```

**Local-headless fallback (zero network egress):** When Falcon is opted in (key present) but **no** endpoint resolves, inject a `headlessCollector` to capture telemetry locally with no network upload. The consumer owns the collector package (e.g. `@o11y/local-headless`) and injects the instance; the library takes no runtime dependency on it.

```typescript
import { LocalCollector } from "@o11y/local-headless";

await o11yService.initialize(
  "your-extension-name",
  "https://fallback-static-endpoint",
  undefined,
  {
    falcon: { apiKey: process.env.O11Y_FALCON_API_KEY! }, // no endpoint -> headless
    headlessCollector: new LocalCollector(/* ... */),
  },
);
```

**Multi-instance note:** Multiple extensions in one process (e.g. the Salesforce Extension Pack sharing a single VS Code extension host) share one process-global telemetry buffer, because the underlying o11y client registers exactly one app per process. The upload destination is therefore claimed **first-writer-wins**: the first extension to initialize determines where all pooled events are published, and a later extension that configures a _conflicting_ destination is logged as an error and follows the first owner's route. Configure a consistent Falcon/headless destination across co-hosted extensions.

**Application identity — `appName` vs. per-consumer identity:** Every event carries a per-consumer `loggerName` sourced from the `extensionName` you pass to `initialize`, so co-hosted extensions stay distinguishable even though they share one buffer — you do not need to configure anything for that. Optionally pass a process-level `appName` to label the CoreEnvelope for the whole process (e.g. `"salesforce-extension-pack"`); it is **first-writer-wins** (the first `initialize` sets it, a later different value is logged and ignored) and defaults to `"o11y-reporter-extensions"`. `appName` is the shared _process_ label, not the per-extension identity — that always rides on `loggerName`.

- **Single-product process** (CLI, ADK Agent, adk-mcp): one consumer _is_ the process, so `appName` may simply equal your `extensionName` (or any product label). Setting it is enough on its own.
- **Co-hosted process** (Salesforce Extension Pack in one VS Code extension host): `appName` cannot vary per extension (first-writer-wins across the shared buffer), so don't try to make it the per-extension identifier — rely on `loggerName` (= `extensionName`), which is stamped per event automatically.

**Input validation (fails closed):** `extensionName` is validated before any state is touched — it must be a non-blank string with no surrounding whitespace, no backtick, at most 80 characters, and must not be the registered app name (`"o11y-reporter-extensions"`) or a reserved o11y instrumentation name (`IdleDetector`, `Network`, `WebVitals`). A supplied `appName` must be non-blank. An invalid value is logged and telemetry is left uninitialized; it never throws, so a bad config cannot disrupt the host application. Valid names are preserved exactly (no trimming, prefixing, or hashing) so `extensionName === loggerName` on the wire.

```typescript
await o11yService.initialize(
  "salesforcedx-vscode-apex", // -> per-event loggerName
  "https://your-endpoint",
  undefined,
  { appName: "salesforce-extension-pack" }, // -> process-level CoreEnvelope appName
);
```

### 2. Send Telemetry Events

#### Using Default Schema

```typescript
// Send a telemetry event with properties (uses default sf_a4dInstrumentation schema)
o11yService.logEvent({
  name: "extension/eventName",
  properties: {
    // Add your custom properties here
    customProperty: "value",
  },
  measurements: {
    // Optional measurements
    duration: 100,
  },
});

// Send an exception event
o11yService.logEvent({
  exception: new Error("Error message"),
  properties: {
    // Add your custom properties here
    errorType: "RuntimeError",
  },
  measurements: {
    // Optional measurements
    errorCount: 1,
  },
});
```

#### Using Custom Schema

The service supports consumer-provided O11y schemas. This allows you to use custom schemas from the `o11y_schema` package instead of the default `sf_a4dInstrumentation` schema.

**Step 1: Add `o11y_schema` to your `package.json`:**

```json
{
  "dependencies": {
    "o11y_schema": "^256.154.0"
  }
}
```

**Step 2: Load the schema with a dynamic `import()` and use it with `logEventWithSchema(properties, schema)` (exactly two parameters):**

`o11y_schema` is ESM-only, so load it with a dynamic `import()` rather than a static `import`. If your code is compiled to CommonJS, a static `import` becomes `require()`, which throws `ERR_REQUIRE_ESM` on Node versions before 20.19 and 22.12.

```typescript
import { O11yService } from "@salesforce/o11y-reporter";

const o11yService = O11yService.getInstance("your-extension");
await o11yService.initialize("your-extension", "https://your-endpoint");

// Cache the promise so the schema module is loaded only once.
let pdpEventSchemaPromise: Promise<Record<string, unknown>> | undefined;
const getPdpEventSchema = (): Promise<Record<string, unknown>> => {
  pdpEventSchemaPromise ??=
    // @ts-expect-error - o11y_schema package doesn't provide TypeScript declarations
    import("o11y_schema/sf_pdp").then((m) => m.pdpEventSchema);
  return pdpEventSchemaPromise;
};

// Two parameters only: (properties, schema). Shape of properties depends on your schema.
o11yService.logEventWithSchema(
  { customProperty: "value" },
  await getPdpEventSchema(),
);

// Load other schemas the same way, e.g. import("o11y_schema/sf_a4dInstrumentation")
// exports a4dInstrumentationSchema.
```

**Note:** `logEventWithSchema(properties, schema)` takes exactly **two** parameters: the event properties object and the schema. You must provide a valid schema object (e.g. `Record<string, unknown>`). If you don't need a custom schema, use `logEvent(properties)` which uses the default schema.

**Behavior:** Events sent with `logEventWithSchema(properties, schema)` are encoded using the schema you pass (e.g. `PdpEvent`, `a4dInstrumentationSchema`). They are not wrapped in the default A4dInstrumentation schema; the payload uses your schema's format directly (e.g. `sf.pdp.PdpEvent` in the binary payload).

**Note:** The `o11y_schema` package doesn't provide TypeScript declarations, so the dynamic `import()` needs a `@ts-expect-error` comment (or a local `declare module "o11y_schema/*";`). If you compile to CommonJS, use `"module": "node16"` or `"nodenext"` in `tsconfig.json`: with `"module": "commonjs"`, TypeScript rewrites `import()` to `require()`, which brings back the `ERR_REQUIRE_ESM` error.

**With automatic batching enabled, events are automatically uploaded based on threshold (50KB) or periodic flush (30 seconds). You can also manually flush if needed:**

```typescript
await o11yService.forceFlush();
```

### 3. Enable Automatic Batching

The service supports automatic batching of events for efficient telemetry collection. Events are automatically buffered and uploaded based on size threshold or periodic flush intervals.

```typescript
// Enable automatic batching with default settings (30-second flush interval)
const cleanup = o11yService.enableAutoBatching();

// Or customize the batching behavior
const cleanup = o11yService.enableAutoBatching({
  flushInterval: 30_000, // 30 seconds (default)
  enableShutdownHook: true, // Enable shutdown hooks (default: true)
  enableBeforeExitHook: true, // Enable beforeExit hook (default: true)
});
```

**Batching Behavior:**

- Events are buffered in memory until upload conditions are met
- **Threshold-based upload**: Events are uploaded when buffer size reaches 50KB
- **Periodic flush**: Events are automatically flushed every 30 seconds (configurable)
- **Shutdown hooks**: Buffered events are flushed on SIGINT, SIGTERM and beforeExit. These hooks only flush; they don't exit the process (see below).

**Benefits:**

- Reduces network overhead by batching multiple events
- Improves performance by avoiding per-event uploads
- Ensures events are not lost on application shutdown

**Stopping batching on shutdown:**

When your application or extension shuts down, call the cleanup function and then flush whatever is still buffered:

```typescript
cleanup(); // Stops the batching timer and removes the shutdown hooks. Does not flush.
await o11yService.forceFlush(); // Uploads any events still in the buffer.
```

Call them in this order: `cleanup()` removes the shutdown hooks, so without the `forceFlush()` that follows it, events logged since the last upload are lost.

- **CLIs and scripts:** the batching timer keeps Node's event loop alive, so the process won't exit on its own, and the `beforeExit` hook won't fire, until you call `cleanup()`. Run the two calls above when your work is done.
- **Ctrl+C and termination signals:** the SIGINT and SIGTERM hooks flush events but don't exit, and registering them turns off Node's default exit on those signals. If your app doesn't already handle them, add a handler that runs the two calls above and then exits, for example `process.once("SIGINT", async () => { cleanup(); await o11yService.forceFlush(); process.exit(130); });`.
- **VS Code extensions:** run the two calls in `deactivate()` and return the promise, so VS Code waits for the flush.

### 4. Manual Flush

You can manually flush buffered events at any time:

```typescript
// Force an immediate flush of all buffered events
await o11yService.forceFlush();

// Or use the upload method (alias for forceFlush when batching is enabled)
await o11yService.upload();
```

### 5. Check Batch Status

Monitor the current batch status:

```typescript
const status = o11yService.getBatchStatus();
console.log(`Buffer size: ${status.estimatedByteSize} bytes`);
console.log(`Has data: ${status.hasData}`);
console.log(`Over threshold: ${status.isOverThreshold}`);
```

## Configuration

The service can be configured with the following options:

- `o11yUploadEndpoint`: The endpoint URL for uploading telemetry data

### Batching Options

When enabling automatic batching, you can configure the following options:

```typescript
interface BatchingOptions {
  /** Periodic flush interval in milliseconds (default: 30000) */
  flushInterval?: number;
  /** Buffer size threshold in bytes before triggering upload (default: 50000 = 50KB) */
  thresholdBytes?: number;
  /** Threshold check interval in milliseconds (default: 2000) */
  checkInterval?: number;
  /** Enable shutdown hooks (default: true) */
  enableShutdownHook?: boolean;
  /** Enable beforeExit hook (default: true). Note: beforeExit won't fire for STDIO servers where stdin stays open */
  enableBeforeExitHook?: boolean;
}
```

**Configuration Examples:**

```typescript
// Default configuration (30-second flush, shutdown hooks enabled)
o11yService.enableAutoBatching();

// Custom flush interval (60 seconds)
o11yService.enableAutoBatching({ flushInterval: 60_000 });

// Disable shutdown hooks (not recommended)
o11yService.enableAutoBatching({ enableShutdownHook: false });

// Disable beforeExit hook (useful for STDIO servers)
o11yService.enableAutoBatching({ enableBeforeExitHook: false });
```

## Best Practices

1. **Initialize Early**: Initialize the service as early as possible in your extension's lifecycle.

2. **Error Handling**: Always wrap telemetry calls in try-catch blocks to prevent them from affecting your main application flow.

3. **Property Naming**: Use consistent property names and avoid sending sensitive information.

4. **Enable Automatic Batching**: Use `enableAutoBatching()` to automatically batch and upload events efficiently. This is recommended for most use cases.

5. **Manual Flush for Critical Events**: For critical events that need immediate upload, call `forceFlush()` after logging the event.

6. **Stop Batching on Shutdown**: Call the cleanup function returned by `enableAutoBatching()`, then `await forceFlush()`, so the last events are sent and the batching timer doesn't keep the process alive.

## Example Implementation

Here's a complete example of how to use the O11y Reporter in your extension:

```typescript
import { O11yService } from "@salesforce/o11y-reporter";

class YourExtension {
  private o11yService: O11yService;
  private stopBatching?: () => void;

  constructor() {
    this.o11yService = O11yService.getInstance(extensionName);
  }

  async initialize() {
    await this.o11yService.initialize(
      "your-extension",
      "https://your-endpoint",
    );

    // Enable automatic batching for efficient telemetry collection
    this.stopBatching = this.o11yService.enableAutoBatching({
      flushInterval: 30_000, // 30 seconds
      enableShutdownHook: true, // Flush on shutdown
    });
  }

  async trackUserAction(actionName: string, properties: Record<string, any>) {
    try {
      // Using default schema
      this.o11yService.logEvent({
        name: `user/${actionName}`,
        properties: {
          ...properties,
          timestamp: new Date().toISOString(),
        },
      });

      // With batching enabled, events are automatically uploaded
      // For critical events, you can force an immediate flush:
      await this.o11yService.forceFlush();
    } catch (error) {
      // Log error but don't throw
      console.error("Failed to send telemetry:", error);
    }
  }

  async trackUserActionWithSchema(
    actionName: string,
    properties: Record<string, any>,
    schema: Record<string, unknown>,
  ) {
    try {
      // Two parameters: caller's properties (conform to schema) and schema.
      this.o11yService.logEventWithSchema(properties, schema);

      // With batching enabled, events are automatically uploaded
      await this.o11yService.forceFlush();
    } catch (error) {
      console.error("Failed to send telemetry:", error);
    }
  }

  async trackError(error: Error, context: Record<string, any>) {
    try {
      this.o11yService.logEvent({
        exception: error,
        properties: {
          ...context,
          timestamp: new Date().toISOString(),
        },
      });

      await this.o11yService.upload();
    } catch (err) {
      console.error("Failed to send error telemetry:", err);
    }
  }

  // Call on shutdown, e.g. from your extension's deactivate()
  async dispose() {
    try {
      this.stopBatching?.(); // Stop the timer and remove the shutdown hooks
      this.stopBatching = undefined;
      await this.o11yService.forceFlush(); // Send any events still buffered
    } catch (error) {
      console.error("Failed to flush telemetry on shutdown:", error);
    }
  }
}
```

## License

This project is licensed under the Apache License 2.0. See the [LICENSE.txt](LICENSE.txt) file for details.
