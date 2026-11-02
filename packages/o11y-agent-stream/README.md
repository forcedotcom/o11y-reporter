# @salesforce/o11y-agent-stream

Layer-A + Layer-B telemetry for headless agent orchestration. Parses a Claude
Agent SDK message stream (the `stream-json` shape) and emits one correlated
`sf.agenticTelemetry` Activity tree — without changing the agent or its tools.

## What it captures

A single pass over the orchestrator's model-message stream produces both layers,
correlated because they ride the same stream:

- **Layer A — structural spans**, derived from the stream's own events:
  - `WorkflowActivity` (the run), `ToolCallActivity` (each `tool_use` /
    `tool_result` pair), `AgentActivity` (each sub-agent).
- **Layer B — judgment records**, from the four o11y judgment tool calls, in
  order — `set_workflow_metadata`, `log_plan`, `log_decision`, `record_handoff`
  — mapped to `PlanActivity`, `DecisionEvent`, and `HandoffActivity`
  (`set_workflow_metadata` folds into the workflow span).

Every record carries a shared `rootId`, so a single query joins the whole run.

## Install

```sh
yarn add @salesforce/o11y-agent-stream @salesforce/o11y-reporter
```

`@anthropic-ai/claude-agent-sdk` is an optional peer dependency: the parser reads
the stream structurally and never imports the SDK at runtime.

## Usage

Attach a tap in the orchestrator's message loop, feed it every message, and close
it when the run ends. `onMessage` never throws — parser and sink failures route
to the optional `onError` hook.

```ts
import { createSpanTap, deriveRootId } from "@salesforce/o11y-agent-stream";
import { O11yService } from "@salesforce/o11y-reporter";

const reporter = O11yService.getInstance("my-orchestrator");
await reporter.initialize("my-orchestrator", uploadEndpoint);

const tap = createSpanTap({
  sessionId, // the model session id (becomes cs_id)
  reporter, // Tier-2 upload transport (consumed by the default collector sink)
});

for await (const msg of query(/* ... */)) {
  await tap.onMessage(msg);
}
await tap.close(); // flushes the sink, uploading buffered events
```

### Offline / testing

Inject a `CaptureSink` to collect records in memory instead of uploading:

```ts
import { createSpanTap, CaptureSink } from "@salesforce/o11y-agent-stream";

const sink = new CaptureSink();
const tap = createSpanTap({ sessionId, appName }, { sink });
// ...feed messages...
await tap.close();
console.log(sink.records);
```

## Correlation model

- **`rootId`** — one per run. Omit it and the tap calls
  `deriveRootId(sessionId)`; a standalone session is then 1:1 with its own root.
  To join every session under one headless run, either set
  `SF_AGENT_HEADLESS_HOST=1` and `SF_AGENT_ROOT_SEED=<runId>` in each spawned
  session's environment (so `deriveRootId` returns the same root for all of
  them), or compute the root host-side from a per-run seed and pass it as
  `config.rootId`.
- **`parentId`** — span chaining within a run. Pass a host span id to nest a
  session under an orchestrator-level span; omit it and the workflow span is the
  root.
- **`sessionId`** — the model session (`cs_id`); distinguishes the sessions that
  share one `rootId`.

## API

| Export                         | Purpose                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `createSpanTap(config, deps?)` | Build a tap: call `onMessage(msg)` per stream message and `close()` at run end   |
| `CaptureSink`                  | In-memory sink for tests and offline capture                                     |
| `createCollectorSink(config)`  | Default sink: maps each record to its wire shape and uploads via `O11yService`   |
| `deriveRootId(seed, env?)`     | Deterministic `root_id` from a run/session seed (respects the headless env gate) |
| `buildActivityData(record)`    | Map a `SpanRecord` to its Activity wire form (`{ schema, data, rootId }`)        |
| `createNoopO11yServer()`       | In-process no-op MCP server exposing the four Layer-B tools                      |

Types: `SpanTapConfig`, `SpanTapDeps`, `SpanRecord`, `SpanSink`, `SpanTap`,
`SpanKind`.

## Example

See [`examples/mas-headless-host.ts`](./examples/mas-headless-host.ts) for a
reference orchestrator host: it derives one `rootId` per run, injects the
spawn-scoped environment, and attaches a tap per session so every session joins
the same trace.

## Status

Tier 1: Layer-A + Layer-B parsing and correlation. Both layers are captured from
the stream, so the orchestrator's structural spans and the model's judgment
records land as one `sf.agenticTelemetry` tree under a shared `rootId`.
