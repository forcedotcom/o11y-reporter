import type { SDKMessage } from "./types"; // R11: local structural mirror, NOT the ESM-only SDK
import { deriveRootId } from "./rootId";
import {
  finishReasonForResult,
  FINISH_REASON,
  DECISION_TYPE,
  WORKFLOW_TYPE,
  resolveEnum,
  type ResultSubtype,
} from "./enums";
import { agentSpanId, parseToolName, workflowSpanId } from "./ids";
import { createCollectorSink } from "./sinks";
import type {
  SpanRecord,
  SpanSink,
  SpanTap,
  SpanTapConfig,
  SpanTapDeps,
} from "./types";

const WORKFLOW_NAME = "claude-code-session";
const O11Y_SERVER = "o11y"; // in-process no-op server name; confirmed by Task 0.1

interface OpenTool {
  startMs: number;
  parentId: string;
  toolName: string;
  mcpServerName: string;
  toolType: string;
}

interface OpenAgent {
  agentName: string;
  startMs: number;
  endMs: number;
  iterationCount: number;
  failedToolCount: number;
  emitted: boolean;
}

interface WorkflowState {
  id: string;
  parentId: string;
  isRoot: boolean;
  startMs: number;
  emitted: boolean;
}

type ContentBlock = { type: string; [k: string]: unknown };

function isContentBlock(b: unknown): b is ContentBlock {
  return (
    typeof b === "object" &&
    b !== null &&
    typeof (b as { type?: unknown }).type === "string"
  );
}

function blocksOf(message: unknown): ContentBlock[] {
  const content = (message as { content?: unknown } | null)?.content;
  // Validate each member's shape: Array.isArray only checks the container, so a
  // null/malformed element would throw on the later `block.type` access and
  // abort the whole message. Drop anything that isn't a typed content block.
  return Array.isArray(content) ? content.filter(isContentBlock) : [];
}

export function createSpanTap(
  config: SpanTapConfig,
  deps: SpanTapDeps = {},
): SpanTap {
  const now = deps.now ?? Date.now;
  const sink: SpanSink = deps.sink ?? createCollectorSink(config);
  // Deliberate no-op default: this parser is a passive telemetry tap with a
  // never-throw contract, so a missing handler must stay silent rather than
  // write to the host's stderr. Hosts that want failures surfaced inject onError.
  const onError = deps.onError ?? (() => undefined);
  // Treat an empty-string rootId like an absent one: `??` only guards null/
  // undefined, so an explicitly-empty config.rootId would otherwise propagate to
  // the wire and silently break run correlation. Derive from the session instead.
  const rootId =
    config.rootId && config.rootId.length > 0
      ? config.rootId
      : deriveRootId(config.sessionId);

  const openTools = new Map<string, OpenTool>();
  const agents = new Map<string, OpenAgent>();
  const taskNames = new Map<string, string>(); // Task/Agent tool_use.id -> subagent_type
  let workflow: WorkflowState | undefined;
  // One-shot guard so the "no workflow to emit" signal fires at most once even
  // though emitWorkflow runs from both handleResult and close().
  let workflowMissingSignalled = false;
  const workflowMeta: Record<string, unknown> = {};
  // Pending o11y calls keyed by tool_use id. A Layer-B span/metadata update is NOT emitted
  // at tool_use time: the SDK validates the tool input during MCP dispatch, which happens
  // AFTER the stream surfaces the assistant block (reviewer Major "unvalidated attempts"), so
  // emitting eagerly could produce a phantom event for a call the server later rejects. We
  // stash a prepared (or locally-rejected) record and commit it only on the matching
  // NON-error tool_result; an is_error result drops it and routes to onError.
  type PreparedO11y =
    | { kind: "reject"; reason: string }
    | { kind: "metadata"; patch: Record<string, unknown>; rejects: string[] }
    | { kind: "span"; record: SpanRecord };
  const pendingO11y = new Map<string, PreparedO11y>();

  const base = (
    kind: SpanRecord["kind"],
    schemaName: SpanRecord["schemaName"],
  ) =>
    ({ kind, schemaName, rootId, appName: config.appName }) as Pick<
      SpanRecord,
      "kind" | "schemaName" | "rootId" | "appName"
    >;

  const parentSpanFor = (parentToolUseId: string | null | undefined): string =>
    parentToolUseId
      ? agentSpanId(config.sessionId, parentToolUseId)
      : workflowSpanId(config.sessionId);

  const str = (o: unknown, k: string): string | undefined => {
    const v = (o as Record<string, unknown> | null)?.[k];
    return typeof v === "string" ? v : undefined;
  };

  let judgmentSeq = 0; // mirrors server.py _judgment_seq: unique ids for repeated events

  // Build a point-in-time judgment SpanRecord (startMs === endMs → duration 0). Pure: no
  // emit. The record is stashed pending and emitted by commitO11y on a non-error tool_result.
  const judgmentRecord = (
    kind: SpanRecord["kind"],
    schemaName: SpanRecord["schemaName"],
    id: string,
    name: string,
    parentId: string,
    payload: Record<string, unknown>,
  ): SpanRecord => {
    const t = now();
    return {
      ...base(kind, schemaName),
      id,
      parentId,
      isRoot: false,
      name,
      startMs: t,
      endMs: t,
      payload,
    };
  };

  // Pure: validate + build; never emits or mutates workflowMeta (commitO11y does that,
  // gated on a non-error tool_result). Local reject-don't-coerce enum checks run HERE so a
  // bad enum never becomes a pending span; a missing required field yields a reject too.
  const prepareO11yCall = (
    tool: string,
    input: unknown,
    parentId: string,
  ): PreparedO11y => {
    switch (tool) {
      case "set_workflow_metadata": {
        const patch: Record<string, unknown> = {};
        const rejects: string[] = []; // bad enum fields: dropped (never coerced), signalled at commit
        const name = str(input, "workflow_name");
        if (name) patch.workflowName = name;
        const wt = str(input, "workflow_type");
        if (wt) {
          const r = resolveEnum("workflow_type", wt, WORKFLOW_TYPE);
          if ("value" in r) patch.workflowType = r.value;
          else rejects.push(r.reason); // drop the field, keep the drop signal
        }
        const fr = str(input, "finish_reason");
        if (fr) {
          const r = resolveEnum("finish_reason", fr, FINISH_REASON);
          if ("value" in r) patch.finishReason = r.value;
          else rejects.push(r.reason);
        }
        const lt = str(input, "linked_ticket");
        if (lt) patch.linkedTicket = lt;
        const team = str(input, "team");
        if (team) patch.team = team;
        return { kind: "metadata", patch, rejects };
      }
      case "log_plan": {
        const summary = str(input, "plan_summary");
        if (summary === undefined)
          return { kind: "reject", reason: "log_plan missing plan_summary" };
        const rawSteps = (input as { steps?: unknown } | null)?.steps;
        const steps = Array.isArray(rawSteps)
          ? rawSteps.filter((s): s is string => typeof s === "string")
          : [];
        judgmentSeq += 1; // unique id per call so a re-plan does not collide
        return {
          kind: "span",
          record: judgmentRecord(
            "plan",
            "sf.agenticTelemetry.PlanActivity",
            // Namespace all three judgment ids under the bare sessionId so the
            // scheme is uniform across plan/decision/handoff.
            `${config.sessionId}:plan:${judgmentSeq}`,
            "plan",
            parentId,
            { planSummary: summary, steps },
          ),
        };
      }
      case "log_decision": {
        const dt = str(input, "decision_type");
        if (dt === undefined)
          return {
            kind: "reject",
            reason: "log_decision missing decision_type",
          };
        const r = resolveEnum("decision_type", dt, DECISION_TYPE);
        if (!("value" in r)) return { kind: "reject", reason: r.reason }; // reject-don't-coerce
        judgmentSeq += 1;
        const payload: Record<string, unknown> = { decisionType: r.value };
        const desc = str(input, "description");
        if (desc !== undefined) payload.description = desc;
        const rat = str(input, "rationale");
        if (rat !== undefined) payload.rationale = rat;
        return {
          kind: "span",
          record: judgmentRecord(
            "decision",
            "sf.agenticTelemetry.DecisionEvent",
            `${config.sessionId}:decision:${dt}:${judgmentSeq}`,
            "decision",
            parentId,
            payload,
          ),
        };
      }
      case "record_handoff": {
        const from = str(input, "from_agent");
        const to = str(input, "to_agent");
        if (from === undefined || to === undefined)
          return {
            kind: "reject",
            reason: "record_handoff missing from_agent/to_agent",
          };
        judgmentSeq += 1;
        const payload: Record<string, unknown> = {
          fromAgent: from,
          toAgent: to,
        };
        const reason = str(input, "reason");
        if (reason !== undefined) payload.reason = reason;
        return {
          kind: "span",
          record: judgmentRecord(
            "handoff",
            "sf.agenticTelemetry.HandoffActivity",
            `${config.sessionId}:handoff:${to}:${judgmentSeq}`,
            "gen_ai.handoff",
            // Nest under the calling context (the sub-agent's span when the
            // handoff is logged inside a Task), same as log_plan/log_decision —
            // not hardcoded to the workflow root.
            parentId,
            payload,
          ),
        };
      }
      default:
        return { kind: "reject", reason: `unknown o11y tool: ${tool}` }; // never-throw
    }
  };

  // Called ONLY on a matching non-error tool_result. Applies the prepared record: a span is
  // emitted, a metadata patch folds into the workflow root, a local reject is surfaced.
  const commitO11y = (prepared: PreparedO11y): void => {
    if (prepared.kind === "span") sink.emit(prepared.record);
    else if (prepared.kind === "metadata") {
      Object.assign(workflowMeta, prepared.patch);
      // Bad enum fields were dropped (never coerced to 0); still surface the drop signal.
      for (const reason of prepared.rejects) onError(new Error(reason));
    } else onError(new Error(prepared.reason)); // locally-rejected: surface, emit nothing
  };

  const ensureAgent = (agentId: string): OpenAgent => {
    let agent = agents.get(agentId);
    if (!agent) {
      agent = {
        agentName: taskNames.get(agentId) ?? "",
        startMs: now(),
        endMs: now(),
        iterationCount: 0,
        failedToolCount: 0,
        emitted: false,
      };
      agents.set(agentId, agent);
    }
    return agent;
  };

  const emitAgent = (agentId: string, agent: OpenAgent): void => {
    if (agent.emitted) return;
    agent.emitted = true;
    sink.emit({
      ...base("agent", "sf.agenticTelemetry.AgentActivity"),
      id: agentSpanId(config.sessionId, agentId),
      // Tier 1 parents every sub-agent directly to the workflow. Multi-level
      // nesting (a Task spawned by another Task) is deferred — the true parent
      // agent is not tracked here. Tool spans still nest under their immediate
      // agent via parentSpanFor.
      parentId: workflowSpanId(config.sessionId),
      isRoot: false,
      name: "invoke_agent",
      startMs: agent.startMs,
      endMs: agent.endMs,
      payload: {
        // Re-read taskNames at emit time so a subagent_type that arrives after
        // the agent is first referenced is not permanently lost.
        agentName: taskNames.get(agentId) ?? agent.agentName,
        agentId,
        iterationCount: agent.iterationCount,
        failedToolCount: agent.failedToolCount,
      },
    });
  };

  // Single emitter for the WorkflowActivity span so the result path and the
  // close() path can't diverge. Usage (token/cost) is only present on the result
  // path — an aborted/timed-out run closes via close() with no usage data.
  const emitWorkflow = (
    endMs: number,
    finishReason: number,
    usage?: { totalTokens: number; totalCostUsd: number },
  ): void => {
    if (!workflow) {
      // Every other lost-signal path routes through onError; do the same here so
      // a stream desync that never produced a "system" message — and thus no
      // workflow span, losing the rootId anchor for the whole run — is visible to
      // the host instead of vanishing silently.
      if (!workflowMissingSignalled) {
        workflowMissingSignalled = true;
        onError(
          new Error(
            "workflow span never initialized (no system message received); WorkflowActivity dropped",
          ),
        );
      }
      return;
    }
    if (workflow.emitted) return;
    workflow.emitted = true;
    sink.emit({
      ...base("workflow", "sf.agenticTelemetry.WorkflowActivity"),
      id: workflow.id,
      parentId: workflow.parentId,
      isRoot: workflow.isRoot,
      name: "invoke_workflow",
      startMs: workflow.startMs,
      endMs,
      payload: {
        workflowName: (workflowMeta.workflowName as string) ?? WORKFLOW_NAME,
        ...workflowMeta,
        finishReason: (workflowMeta.finishReason as number) ?? finishReason,
        ...(usage
          ? { totalTokens: usage.totalTokens, totalCostUsd: usage.totalCostUsd }
          : {}),
      },
    });
  };

  const handleSystem = (): void => {
    if (workflow) return;
    workflow = {
      id: workflowSpanId(config.sessionId),
      parentId: config.parentId ?? rootId,
      isRoot: config.parentId === undefined,
      startMs: now(),
      emitted: false,
    };
  };

  const handleAssistant = (msg: SDKMessage): void => {
    const parent =
      (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ??
      null;
    if (parent) ensureAgent(parent).iterationCount += 1;
    for (const block of blocksOf((msg as { message?: unknown }).message)) {
      if (block.type !== "tool_use") continue;
      const id = String(block.id);
      const name = String(block.name);
      // The sub-agent spawner is named `Task` by the Agent SDK / standard
      // Claude Code, but `Agent` by the Bedrock/FleetView CLI build. Both anchor
      // an AgentActivity (via parent_tool_use_id) instead of a ToolCallActivity.
      if (name === "Task" || name === "Agent") {
        // block.input is unvalidated `unknown`; only accept a string
        // subagent_type so a non-string can't leak into the agentName field.
        const input = block.input;
        const subagentType =
          typeof input === "object" &&
          input !== null &&
          typeof (input as { subagent_type?: unknown }).subagent_type ===
            "string"
            ? (input as { subagent_type: string }).subagent_type
            : "";
        taskNames.set(id, subagentType);
        continue;
      }
      const parsed = parseToolName(name);
      if (parsed.mcpServerName === O11Y_SERVER) {
        // Prepare + stash; do NOT emit yet. commitO11y runs on the matching tool_result.
        pendingO11y.set(
          id,
          prepareO11yCall(parsed.toolName, block.input, parentSpanFor(parent)),
        );
        continue;
      }
      openTools.set(id, {
        startMs: now(),
        parentId: parentSpanFor(parent),
        toolName: parsed.toolName,
        mcpServerName: parsed.mcpServerName,
        toolType: parsed.toolType,
      });
    }
  };

  const emitTool = (
    open: OpenTool,
    id: string,
    isSuccess: boolean,
    endMs: number,
  ): void => {
    sink.emit({
      ...base("tool", "sf.agenticTelemetry.ToolCallActivity"),
      id,
      parentId: open.parentId,
      isRoot: false,
      name: "execute_tool",
      startMs: open.startMs,
      endMs,
      payload: {
        toolName: open.toolName,
        mcpServerName: open.mcpServerName,
        toolType: open.toolType,
        isSuccess,
      },
    });
  };

  const handleUser = (msg: SDKMessage): void => {
    const parent =
      (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ??
      null;
    if (parent) ensureAgent(parent).endMs = now();
    for (const block of blocksOf((msg as { message?: unknown }).message)) {
      if (block.type !== "tool_result") continue;
      const id = String(block.tool_use_id);
      const pending = pendingO11y.get(id);
      if (pending) {
        pendingO11y.delete(id);
        // Commit on a non-error result; drop + surface on is_error. Either way this is an
        // o11y call: it never closes an openTools span and never becomes a ToolCallActivity.
        if (block.is_error === true)
          onError(new Error(`o11y tool rejected by server (tool_use ${id})`));
        else commitO11y(pending);
        continue;
      }
      const isError = block.is_error === true;
      if (parent && isError) ensureAgent(parent).failedToolCount += 1;
      const open = openTools.get(id);
      if (!open) continue;
      openTools.delete(id);
      emitTool(open, id, !isError, now());
    }
  };

  const handleResult = (msg: SDKMessage): void => {
    const subtype = (msg as { subtype?: string }).subtype as ResultSubtype;
    const durationMs = Number(
      (msg as { duration_ms?: number }).duration_ms ?? 0,
    );
    const usage = (msg as { usage?: Record<string, number> }).usage ?? {};
    const totalTokens =
      (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    const totalCostUsd = Number(
      (msg as { total_cost_usd?: number }).total_cost_usd ?? 0,
    );
    emitWorkflow(
      (workflow?.startMs ?? 0) + durationMs,
      finishReasonForResult(subtype),
      {
        totalTokens,
        totalCostUsd,
      },
    );
    for (const [agentId, agent] of agents) emitAgent(agentId, agent);
  };

  return {
    async onMessage(msg: SDKMessage): Promise<void> {
      try {
        switch ((msg as { type?: string }).type) {
          case "system":
            handleSystem();
            break;
          case "assistant":
            handleAssistant(msg);
            break;
          case "user":
            handleUser(msg);
            break;
          case "result":
            handleResult(msg);
            break;
          default:
            break;
        }
      } catch (err) {
        onError(err, msg);
      }
    },

    async close(): Promise<void> {
      try {
        const t = now();
        for (const [id, open] of openTools) emitTool(open, id, false, t);
        openTools.clear();
        // In-flight Layer-B calls never received their confirming tool_result (abnormal
        // termination). Surface each as a lost signal rather than fabricate an unconfirmed
        // span — mirrors openTools flushing as failed and preserves commit-only-on-non-error.
        for (const [id] of pendingO11y)
          onError(new Error(`o11y tool unresolved at close (tool_use ${id})`));
        pendingO11y.clear();
        emitWorkflow(t, FINISH_REASON.UNSPECIFIED);
        for (const [agentId, agent] of agents) emitAgent(agentId, agent);
        await sink.flush();
      } catch (err) {
        onError(err);
      }
    },
  };
}
