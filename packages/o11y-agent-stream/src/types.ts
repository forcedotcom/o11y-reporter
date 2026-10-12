// Build-order dependency: '@salesforce/o11y-reporter' resolves via the root
// package's `types` field to dist/index.bundle.d.ts, which is emitted only by
// the root's BUNDLE step (`yarn package`), not by plain `tsc --build`. So the
// root must be packaged before this sub-package compiles, or this import fails
// with TS2307/TS7016. A TS project `references` entry does NOT fix it (that runs
// tsc, which emits dist/index.d.ts, not the bundled dts). CI enforces the order
// by running `yarn package` on the root before building this workspace.
import type { O11yService } from "@salesforce/o11y-reporter";

/**
 * Structural mirror of `@anthropic-ai/claude-agent-sdk`'s `SDKMessage`.
 *
 * The agent SDK is pure ESM (`"type": "module"`, `main: sdk.mjs`, no CommonJS /
 * `exports` entry), so a type-only `import { SDKMessage } from
 * '@anthropic-ai/claude-agent-sdk'` cannot compile inside this CommonJS
 * `module: node16` sub-package — TypeScript raises TS1479 even though the import
 * is erased (ruling R11). The parser reads these fields only through structural
 * casts, never through the SDK's nominal type, so this local mirror is
 * behaviourally identical and keeps the agent SDK a purely optional peer (no
 * type- or run-time dependency on it). The trailing catch-all member keeps any
 * real SDK message assignable to `onMessage`. Mirrors claude-agent-sdk@0.1.77 —
 * re-check the consumed fields on an SDK bump.
 */
export type SDKMessage =
  | { type: "system"; subtype?: string; session_id?: string }
  | {
      type: "assistant";
      parent_tool_use_id?: string | null;
      message?: unknown;
      session_id?: string;
    }
  | {
      type: "user";
      parent_tool_use_id?: string | null;
      message?: unknown;
      session_id?: string;
    }
  | {
      type: "result";
      subtype?: string;
      duration_ms?: number;
      total_cost_usd?: number;
      usage?: Record<string, number>;
      session_id?: string;
    }
  | { type: string };

export type SpanKind =
  | "workflow"
  | "tool"
  | "agent"
  | "plan"
  | "decision"
  | "handoff";

export interface SpanRecord {
  kind: SpanKind;
  id: string; // this span's id
  parentId: string; // parent span id (chain, never the root_id)
  isRoot: boolean; // true only for the standalone workflow root
  rootId: string; // envelope correlation key (same for whole run)
  name: string; // invoke_workflow | execute_tool | invoke_agent
  schemaName:
    | "sf.agenticTelemetry.WorkflowActivity"
    | "sf.agenticTelemetry.ToolCallActivity"
    | "sf.agenticTelemetry.AgentActivity"
    | "sf.agenticTelemetry.PlanActivity"
    | "sf.agenticTelemetry.DecisionEvent"
    | "sf.agenticTelemetry.HandoffActivity";
  startMs: number;
  endMs: number;
  payload: Record<string, unknown>; // camelCase agenticTelemetry fields
  appName?: string; // -> loggerAppName
}

export interface SpanSink {
  emit(record: SpanRecord): void; // called once per span, at close
  flush(): Promise<void>; // called by tap.close()
}

export interface SpanTapConfig {
  sessionId: string;
  reporter: O11yService; // transport bootstrap; consumed by the default collector sink (Tier 2)
  rootId?: string; // host-provided trace root; absent => deriveRootId(sessionId)
  parentId?: string; // host-provided parent span; absent => workflow is the root
  appName?: string; // -> loggerAppName
}

export interface SpanTapDeps {
  sink?: SpanSink; // injected in tests; defaults to the collector sink
  now?: () => number; // injected in tests; defaults to Date.now
  onError?: (err: unknown, msg?: SDKMessage) => void; // never-throw reporting hook
}

export interface SpanTap {
  onMessage(msg: SDKMessage): Promise<void>;
  close(): Promise<void>;
}
