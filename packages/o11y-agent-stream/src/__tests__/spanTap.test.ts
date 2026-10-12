import { FINISH_REASON } from "../enums";
import { deriveRootId } from "../rootId";
import { CaptureSink } from "../sinks";
import { createSpanTap } from "../spanTap";
import type {
  SpanRecord,
  SpanSink,
  SpanTapConfig,
  SpanTapDeps,
} from "../types";

// Minimal SDK-message factories (structural; we import SDKMessage as a type only).
const sys = (session_id: string, model = "claude-x") =>
  ({
    type: "system",
    subtype: "init",
    model,
    tools: [],
    mcp_servers: [],
    cwd: "/",
    session_id,
  }) as any;
const assistantToolUse = (
  session_id: string,
  id: string,
  name: string,
  input: unknown = {},
  parent: string | null = null,
) =>
  ({
    type: "assistant",
    session_id,
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id, name, input }] },
  }) as any;
// Third arg accepts either the legacy positional boolean (existing call sites)
// or an options object `{ isError? }` (new Layer-B server-rejection tests) —
// both normalize to the same `is_error` field on the emitted tool_result block.
const userToolResult = (
  session_id: string,
  tool_use_id: string,
  errorOrOpts: boolean | { isError?: boolean } = false,
  parent: string | null = null,
) => {
  const is_error =
    typeof errorOrOpts === "boolean"
      ? errorOrOpts
      : (errorOrOpts.isError ?? false);
  return {
    type: "user",
    session_id,
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_result", tool_use_id, is_error }] },
  } as any;
};
const result = (session_id: string, subtype = "success", duration_ms = 5000) =>
  ({
    type: "result",
    subtype,
    duration_ms,
    total_cost_usd: 0.02,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 2,
    },
    session_id,
  }) as any;

function newTap(overrides: Partial<SpanTapConfig> = {}) {
  const sink = new CaptureSink();
  let clock = 1000;
  const deps: SpanTapDeps = { sink, now: () => (clock += 100) };
  const config = {
    sessionId: "sess-1",
    reporter: {} as any,
    ...overrides,
  } as SpanTapConfig;
  return { tap: createSpanTap(config, deps), sink };
}

const byKind = (records: SpanRecord[], kind: string) =>
  records.filter((r) => r.kind === kind);

describe("createSpanTap Layer-A mapping", () => {
  it("pairs a tool_use with its tool_result into one execute_tool span", async () => {
    const { tap, sink } = newTap();
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(
      assistantToolUse("sess-1", "toolu_1", "mcp__o11y_mcp__log_decision"),
    );
    await tap.onMessage(userToolResult("sess-1", "toolu_1"));
    await tap.onMessage(result("sess-1"));
    await tap.close();

    const tools = byKind(sink.records, "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: "toolu_1",
      parentId: "sess-1:workflow",
      name: "execute_tool",
      schemaName: "sf.agenticTelemetry.ToolCallActivity",
      payload: {
        toolName: "log_decision",
        mcpServerName: "o11y_mcp",
        toolType: "mcp",
        isSuccess: true,
      },
    });
    expect(tools[0].endMs).toBeGreaterThan(tools[0].startMs);
  });

  it("opens the workflow root and closes it on result with int finish_reason + usage", async () => {
    const { tap, sink } = newTap();
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(result("sess-1", "error_max_turns"));
    await tap.close();

    const wf = byKind(sink.records, "workflow");
    expect(wf).toHaveLength(1);
    expect(wf[0].isRoot).toBe(true);
    expect(wf[0].parentId).toBe(wf[0].rootId);
    expect(wf[0].payload).toMatchObject({
      workflowName: "claude-code-session",
      finishReason: 2,
      totalTokens: 33,
      totalCostUsd: 0.02,
    });
    expect(
      typeof (wf[0].payload as { finishReason: unknown }).finishReason,
    ).toBe("number");
  });

  it("uses the host rootId and nests the workflow under a host parentId", async () => {
    const { tap, sink } = newTap({ rootId: "run-42", parentId: "run-42:step" });
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(result("sess-1"));
    await tap.close();

    const wf = byKind(sink.records, "workflow")[0];
    expect(wf.rootId).toBe("run-42");
    expect(wf.isRoot).toBe(false);
    expect(wf.parentId).toBe("run-42:step");
  });

  it("derives rootId from sessionId when the host provides none", async () => {
    const { tap, sink } = newTap({ sessionId: "test-session-1" });
    await tap.onMessage(sys("test-session-1"));
    await tap.onMessage(result("test-session-1"));
    await tap.close();
    expect(byKind(sink.records, "workflow")[0].rootId).toBe(
      "e8503a23416810990d9cc26ebaf01367",
    );
  });

  it("treats an explicit empty-string rootId like an absent one and derives from the session", async () => {
    const { tap, sink } = newTap({ rootId: "" });
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(result("sess-1"));
    await tap.close();
    const wf = byKind(sink.records, "workflow")[0];
    // An empty string must NOT reach the wire — it would upload with no root_id
    // and silently break correlation. It falls through to the derived root.
    expect(wf.rootId).toBe(deriveRootId("sess-1"));
    expect(wf.rootId).not.toBe("");
    expect(wf.isRoot).toBe(true); // no host parentId → derived-root run is its own root
  });

  it("surfaces a missing workflow span (no system message) via onError exactly once", async () => {
    const errors: unknown[] = [];
    const sink = new CaptureSink();
    const tap = createSpanTap(
      { sessionId: "sess-1", reporter: {} as any } as SpanTapConfig,
      { sink, onError: (e) => errors.push(e) },
    );
    // No "system" message ever arrives (stream desync); result + close both call
    // emitWorkflow with no workflow to emit — the loss must be surfaced, not silent.
    await tap.onMessage(result("sess-1"));
    await tap.close();
    expect(byKind(sink.records, "workflow")).toHaveLength(0);
    expect(errors).toHaveLength(1); // signalled once, not once per emitWorkflow call
    expect((errors[0] as Error).message).toContain(
      "workflow span never initialized",
    );
  });

  it("anchors a sub-agent span and nests its tools under it", async () => {
    const { tap, sink } = newTap();
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(
      assistantToolUse("sess-1", "toolu_task", "Task", {
        subagent_type: "explorer",
      }),
    );
    await tap.onMessage(
      assistantToolUse("sess-1", "toolu_inner", "Read", {}, "toolu_task"),
    );
    await tap.onMessage(
      userToolResult("sess-1", "toolu_inner", true, "toolu_task"),
    );
    await tap.onMessage(result("sess-1"));
    await tap.close();

    const agents = byKind(sink.records, "agent");
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "sess-1:agent:toolu_task",
      parentId: "sess-1:workflow",
      name: "invoke_agent",
      payload: {
        agentName: "explorer",
        agentId: "toolu_task",
        failedToolCount: 1,
      },
    });
    const innerTool = byKind(sink.records, "tool").find(
      (t) => t.id === "toolu_inner",
    )!;
    expect(innerTool.parentId).toBe("sess-1:agent:toolu_task");
  });

  it("treats an `Agent`-named spawner (Bedrock/FleetView CLI) the same as `Task`", async () => {
    // The Agent SDK / standard Claude Code name the sub-agent spawner `Task`,
    // but the Bedrock/FleetView CLI build names it `Agent`. Both must anchor an
    // AgentActivity (not a redundant ToolCallActivity) and harvest subagent_type.
    const { tap, sink } = newTap();
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(
      assistantToolUse("sess-1", "toolu_agent", "Agent", {
        subagent_type: "explorer",
      }),
    );
    await tap.onMessage(
      assistantToolUse("sess-1", "toolu_inner", "Bash", {}, "toolu_agent"),
    );
    await tap.onMessage(
      userToolResult("sess-1", "toolu_inner", false, "toolu_agent"),
    );
    await tap.onMessage(result("sess-1"));
    await tap.close();

    const agents = byKind(sink.records, "agent");
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "sess-1:agent:toolu_agent",
      parentId: "sess-1:workflow",
      name: "invoke_agent",
      payload: {
        agentName: "explorer",
        agentId: "toolu_agent",
        failedToolCount: 0,
      },
    });
    // The `Agent` spawner tool_use must NOT also surface as a ToolCallActivity.
    expect(
      byKind(sink.records, "tool").find((t) => t.id === "toolu_agent"),
    ).toBeUndefined();
    // Its inner tool still nests under the agent span via parent_tool_use_id.
    const innerTool = byKind(sink.records, "tool").find(
      (t) => t.id === "toolu_inner",
    )!;
    expect(innerTool.parentId).toBe("sess-1:agent:toolu_agent");
  });

  it("emits an orphaned tool span on close() when no tool_result arrived", async () => {
    const { tap, sink } = newTap();
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(assistantToolUse("sess-1", "toolu_orphan", "Read"));
    await tap.close(); // abort/timeout: no result, no tool_result

    const tool = byKind(sink.records, "tool").find(
      (t) => t.id === "toolu_orphan",
    )!;
    expect(tool.payload).toMatchObject({ isSuccess: false });
  });

  it("never throws on a malformed message and reports it", async () => {
    const errors: unknown[] = [];
    const sink = new CaptureSink();
    const tap = createSpanTap(
      { sessionId: "sess-1", reporter: {} as any } as SpanTapConfig,
      { sink, onError: (e) => errors.push(e) },
    );
    // A message whose `message` getter throws when the handler walks it. This
    // genuinely exercises the try/catch — a plain `{ message: null }` would NOT,
    // because blocksOf() defensively treats a non-array content as [] and never throws.
    const boom = {
      type: "assistant",
      session_id: "sess-1",
      parent_tool_use_id: null,
      get message() {
        throw new Error("boom");
      },
    } as any;
    await expect(tap.onMessage(boom)).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(sink.records).toHaveLength(0);
  });

  it("silently ignores an unhandled SDKMessage type (e.g. a stream_event partial delta) — no throw, no emit, no onError", async () => {
    const errors: unknown[] = [];
    const sink = new CaptureSink();
    const tap = createSpanTap(
      { sessionId: "sess-1", reporter: {} as any } as SpanTapConfig,
      { sink, onError: (e) => errors.push(e) },
    );
    await tap.onMessage(sys("sess-1"));
    // "stream_event" is a real claude-agent-sdk message type (partial-delta
    // streaming) this Tier-1 tap does not process; it must fall through the
    // switch's default arm quietly rather than error or fabricate a span.
    await expect(
      tap.onMessage({ type: "stream_event", session_id: "sess-1" } as any),
    ).resolves.toBeUndefined();
    await tap.onMessage(result("sess-1"));
    await tap.close();
    expect(errors).toHaveLength(0); // unrecognized type is not an error condition
    expect(byKind(sink.records, "tool")).toHaveLength(0);
    expect(byKind(sink.records, "agent")).toHaveLength(0);
  });

  it("never throws out of close() when sink.flush() rejects, and routes the failure to onError", async () => {
    const errors: unknown[] = [];
    const boomSink: SpanSink = {
      emit: () => undefined,
      flush: async () => {
        throw new Error("flush boom");
      },
    };
    const tap = createSpanTap(
      { sessionId: "sess-1", reporter: {} as any } as SpanTapConfig,
      { sink: boomSink, onError: (e) => errors.push(e) },
    );
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(result("sess-1"));
    await expect(tap.close()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("flush boom");
  });
});

describe("Layer-B remap for the o11y server (commit on non-error tool_result)", () => {
  it("remaps log_decision to a DecisionEvent, emitted only on its non-error tool_result", async () => {
    const { tap, sink } = newTap();
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(
      assistantToolUse("sess-1", "toolu_d", "mcp__o11y__log_decision", {
        session_id: "sess-1",
        decision_type: "CHOOSE_TOOL",
        description: "picked grep",
      }),
    );
    expect(byKind(sink.records, "decision")).toHaveLength(0); // not yet — awaiting the tool_result
    await tap.onMessage(userToolResult("sess-1", "toolu_d")); // {ok:true} ack → commit
    await tap.onMessage(result("sess-1"));
    await tap.close();

    expect(byKind(sink.records, "tool")).toHaveLength(0); // NOT a ToolCallActivity
    const dec = byKind(sink.records, "decision");
    expect(dec).toHaveLength(1);
    expect(dec[0]).toMatchObject({
      schemaName: "sf.agenticTelemetry.DecisionEvent",
      parentId: "sess-1:workflow",
      payload: { decisionType: 2, description: "picked grep" },
    });
    expect(dec[0].endMs).toBe(dec[0].startMs); // instant, duration 0
  });

  it("drops a server-rejected (is_error) Layer-B call and routes it to onError", async () => {
    const errors: unknown[] = [];
    const sink = new CaptureSink();
    const tap = createSpanTap(
      { sessionId: "sess-1", reporter: {} as any } as SpanTapConfig,
      { sink, onError: (e) => errors.push(e) },
    );
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(
      assistantToolUse("sess-1", "toolu_e", "mcp__o11y__log_decision", {
        session_id: "sess-1",
        decision_type: "CHOOSE_TOOL",
      }),
    );
    await tap.onMessage(userToolResult("sess-1", "toolu_e", { isError: true })); // server rejected
    await tap.onMessage(result("sess-1"));
    await tap.close();
    expect(byKind(sink.records, "decision")).toHaveLength(0); // never emitted
    expect(byKind(sink.records, "tool")).toHaveLength(0); // and never a generic tool span
    expect(errors).toHaveLength(1); // surfaced, not blindly dropped
  });

  it("rejects a bad decision_type locally — no span even on a {ok:true} result", async () => {
    const errors: unknown[] = [];
    const sink = new CaptureSink();
    const tap = createSpanTap(
      { sessionId: "sess-1", reporter: {} as any } as SpanTapConfig,
      { sink, onError: (e) => errors.push(e) },
    );
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(
      assistantToolUse("sess-1", "toolu_bad", "mcp__o11y__log_decision", {
        session_id: "sess-1",
        decision_type: "NONSENSE",
      }),
    );
    await tap.onMessage(userToolResult("sess-1", "toolu_bad")); // even a {ok:true} ack → still no span
    await tap.onMessage(result("sess-1"));
    await tap.close();
    expect(errors).toHaveLength(1); // reject-don't-coerce fired the drop signal
    expect(byKind(sink.records, "decision")).toHaveLength(0); // reject-don't-coerce: no coerced-0 record
  });

  it("emits log_plan and record_handoff on their non-error tool_results", async () => {
    const { tap, sink } = newTap();
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(
      assistantToolUse("sess-1", "toolu_p", "mcp__o11y__log_plan", {
        session_id: "sess-1",
        plan_summary: "do X then Y",
        steps: ["X", "Y"],
      }),
    );
    await tap.onMessage(userToolResult("sess-1", "toolu_p"));
    await tap.onMessage(
      assistantToolUse("sess-1", "toolu_h", "mcp__o11y__record_handoff", {
        session_id: "sess-1",
        from_agent: "root",
        to_agent: "explorer",
        reason: "search",
      }),
    );
    await tap.onMessage(userToolResult("sess-1", "toolu_h"));
    await tap.onMessage(result("sess-1"));
    await tap.close();
    expect(byKind(sink.records, "plan")).toHaveLength(1);
    expect(byKind(sink.records, "handoff")[0]).toMatchObject({
      name: "gen_ai.handoff",
      payload: { fromAgent: "root", toAgent: "explorer", reason: "search" },
    });
  });

  it("nests a handoff logged inside a sub-agent under that agent's span, not the workflow root", async () => {
    const { tap, sink } = newTap();
    await tap.onMessage(sys("sess-1"));
    // A sub-agent is spawned...
    await tap.onMessage(
      assistantToolUse("sess-1", "toolu_task", "Task", {
        subagent_type: "explorer",
      }),
    );
    // ...and the handoff is logged from *inside* it (parent_tool_use_id = the Task).
    await tap.onMessage(
      assistantToolUse(
        "sess-1",
        "toolu_h",
        "mcp__o11y__record_handoff",
        { session_id: "sess-1", from_agent: "explorer", to_agent: "planner" },
        "toolu_task",
      ),
    );
    await tap.onMessage(
      userToolResult("sess-1", "toolu_h", false, "toolu_task"),
    );
    await tap.onMessage(result("sess-1"));
    await tap.close();
    // Parents to the sub-agent's span, consistent with how log_plan/log_decision
    // nest from the same context — not hardcoded to sess-1:workflow.
    expect(byKind(sink.records, "handoff")[0].parentId).toBe(
      "sess-1:agent:toolu_task",
    );
  });

  it("namespaces all three judgment-record ids uniformly under the bare sessionId", async () => {
    const { tap, sink } = newTap();
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(
      assistantToolUse("sess-1", "toolu_p", "mcp__o11y__log_plan", {
        session_id: "sess-1",
        plan_summary: "do X",
      }),
    );
    await tap.onMessage(userToolResult("sess-1", "toolu_p"));
    await tap.onMessage(
      assistantToolUse("sess-1", "toolu_d", "mcp__o11y__log_decision", {
        session_id: "sess-1",
        decision_type: "CHOOSE_TOOL",
      }),
    );
    await tap.onMessage(userToolResult("sess-1", "toolu_d"));
    await tap.onMessage(
      assistantToolUse("sess-1", "toolu_h", "mcp__o11y__record_handoff", {
        session_id: "sess-1",
        from_agent: "root",
        to_agent: "explorer",
      }),
    );
    await tap.onMessage(userToolResult("sess-1", "toolu_h"));
    await tap.onMessage(result("sess-1"));
    await tap.close();
    // Shared judgmentSeq increments 1→2→3 across the three calls; all three ids
    // share the bare-sessionId base (previously log_plan used the workflow-span id).
    expect(byKind(sink.records, "plan")[0].id).toBe("sess-1:plan:1");
    expect(byKind(sink.records, "decision")[0].id).toBe(
      "sess-1:decision:CHOOSE_TOOL:2",
    );
    expect(byKind(sink.records, "handoff")[0].id).toBe(
      "sess-1:handoff:explorer:3",
    );
  });

  it("accumulates set_workflow_metadata (committed on its tool_result) onto the WorkflowActivity at result", async () => {
    const { tap, sink } = newTap();
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(
      assistantToolUse(
        "sess-1",
        "toolu_m",
        "mcp__o11y__set_workflow_metadata",
        {
          session_id: "sess-1",
          workflow_name: "my-flow",
          workflow_type: "FEATURE",
        },
      ),
    );
    await tap.onMessage(userToolResult("sess-1", "toolu_m"));
    await tap.onMessage(result("sess-1"));
    await tap.close();
    const wf = byKind(sink.records, "workflow")[0];
    expect(wf.payload).toMatchObject({
      workflowName: "my-flow",
      workflowType: 3,
    });
  });

  it("drops a bad workflow_type but signals it, keeping the valid metadata fields", async () => {
    const errors: unknown[] = [];
    const sink = new CaptureSink();
    const tap = createSpanTap(
      { sessionId: "sess-1", reporter: {} as any } as SpanTapConfig,
      { sink, onError: (e) => errors.push(e) },
    );
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(
      assistantToolUse(
        "sess-1",
        "toolu_m",
        "mcp__o11y__set_workflow_metadata",
        {
          session_id: "sess-1",
          workflow_name: "my-flow",
          workflow_type: "BOGUS",
        },
      ),
    );
    await tap.onMessage(userToolResult("sess-1", "toolu_m"));
    await tap.onMessage(result("sess-1"));
    await tap.close();
    const wf = byKind(sink.records, "workflow")[0];
    expect(wf.payload).toMatchObject({ workflowName: "my-flow" }); // valid field applied
    expect(wf.payload.workflowType).toBeUndefined(); // bad enum dropped, NOT coerced to 0
    expect(errors).toHaveLength(1); // drop signal fired
  });

  it("accepts a valid finish_reason on set_workflow_metadata, overriding the result's natural finish reason with the resolved int", async () => {
    const errors: unknown[] = [];
    const sink = new CaptureSink();
    const tap = createSpanTap(
      { sessionId: "sess-1", reporter: {} as any } as SpanTapConfig,
      { sink, onError: (e) => errors.push(e) },
    );
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(
      assistantToolUse(
        "sess-1",
        "toolu_fr",
        "mcp__o11y__set_workflow_metadata",
        {
          session_id: "sess-1",
          finish_reason: "HANDOFF",
        },
      ),
    );
    await tap.onMessage(userToolResult("sess-1", "toolu_fr"));
    // "success" naturally maps to FINISH_REASON.COMPLETED; the explicit metadata
    // finish_reason must win over that natural mapping.
    await tap.onMessage(result("sess-1", "success"));
    await tap.close();
    const wf = byKind(sink.records, "workflow")[0];
    expect(wf.payload.finishReason).toBe(FINISH_REASON.HANDOFF); // 4, not COMPLETED's 1
    expect(errors).toHaveLength(0); // nothing rejected for this field
  });

  it("rejects a bad finish_reason on set_workflow_metadata, dropping (not coercing) the field while signalling the drop", async () => {
    const errors: unknown[] = [];
    const sink = new CaptureSink();
    const tap = createSpanTap(
      { sessionId: "sess-1", reporter: {} as any } as SpanTapConfig,
      { sink, onError: (e) => errors.push(e) },
    );
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(
      assistantToolUse(
        "sess-1",
        "toolu_fr",
        "mcp__o11y__set_workflow_metadata",
        {
          session_id: "sess-1",
          workflow_name: "my-flow",
          finish_reason: "NONSENSE",
        },
      ),
    );
    await tap.onMessage(userToolResult("sess-1", "toolu_fr"));
    // Use a subtype whose natural finish reason (MAX_ITERATIONS=2) is distinct
    // from both COMPLETED(1) and UNSPECIFIED(0): if the bad enum were coerced
    // instead of dropped, this would not land on the natural value.
    await tap.onMessage(result("sess-1", "error_max_turns"));
    await tap.close();
    const wf = byKind(sink.records, "workflow")[0];
    expect(wf.payload).toMatchObject({ workflowName: "my-flow" }); // valid field still applied
    expect(wf.payload.finishReason).toBe(FINISH_REASON.MAX_ITERATIONS); // fell through to the natural value, not coerced from "NONSENSE"
    expect(errors).toHaveLength(1); // drop signal fired
    expect((errors[0] as Error).message).toContain("finish_reason");
  });

  it("rejects record_handoff missing from_agent, emitting no handoff span", async () => {
    const errors: unknown[] = [];
    const sink = new CaptureSink();
    const tap = createSpanTap(
      { sessionId: "sess-1", reporter: {} as any } as SpanTapConfig,
      { sink, onError: (e) => errors.push(e) },
    );
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(
      assistantToolUse("sess-1", "toolu_h1", "mcp__o11y__record_handoff", {
        session_id: "sess-1",
        to_agent: "explorer", // from_agent absent
      }),
    );
    await tap.onMessage(userToolResult("sess-1", "toolu_h1"));
    await tap.onMessage(result("sess-1"));
    await tap.close();
    expect(byKind(sink.records, "handoff")).toHaveLength(0);
    expect(byKind(sink.records, "tool")).toHaveLength(0); // not treated as a generic tool call either
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe(
      "record_handoff missing from_agent/to_agent",
    );
  });

  it("rejects record_handoff missing to_agent, emitting no handoff span", async () => {
    const errors: unknown[] = [];
    const sink = new CaptureSink();
    const tap = createSpanTap(
      { sessionId: "sess-1", reporter: {} as any } as SpanTapConfig,
      { sink, onError: (e) => errors.push(e) },
    );
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(
      assistantToolUse("sess-1", "toolu_h2", "mcp__o11y__record_handoff", {
        session_id: "sess-1",
        from_agent: "root", // to_agent absent
      }),
    );
    await tap.onMessage(userToolResult("sess-1", "toolu_h2"));
    await tap.onMessage(result("sess-1"));
    await tap.close();
    expect(byKind(sink.records, "handoff")).toHaveLength(0);
    expect(byKind(sink.records, "tool")).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe(
      "record_handoff missing from_agent/to_agent",
    );
  });

  it("rejects a call to an unknown o11y tool by name, never throwing and emitting nothing", async () => {
    const errors: unknown[] = [];
    const sink = new CaptureSink();
    const tap = createSpanTap(
      { sessionId: "sess-1", reporter: {} as any } as SpanTapConfig,
      { sink, onError: (e) => errors.push(e) },
    );
    await tap.onMessage(sys("sess-1"));
    await expect(
      tap.onMessage(
        assistantToolUse("sess-1", "toolu_u", "mcp__o11y__frobnicate", {
          session_id: "sess-1",
        }),
      ),
    ).resolves.toBeUndefined();
    await tap.onMessage(userToolResult("sess-1", "toolu_u"));
    await tap.onMessage(result("sess-1"));
    await expect(tap.close()).resolves.toBeUndefined();
    expect(byKind(sink.records, "tool")).toHaveLength(0); // not routed to the generic ToolCallActivity path
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("unknown o11y tool: frobnicate");
  });

  it("surfaces an unresolved Layer-B call at close() instead of dropping it silently", async () => {
    const errors: unknown[] = [];
    const sink = new CaptureSink();
    const tap = createSpanTap(
      { sessionId: "sess-1", reporter: {} as any } as SpanTapConfig,
      { sink, onError: (e) => errors.push(e) },
    );
    await tap.onMessage(sys("sess-1"));
    await tap.onMessage(
      assistantToolUse("sess-1", "toolu_d", "mcp__o11y__log_decision", {
        session_id: "sess-1",
        decision_type: "CHOOSE_TOOL",
        description: "picked grep",
      }),
    );
    // no tool_result arrives — session aborts
    await tap.close();
    expect(byKind(sink.records, "decision")).toHaveLength(0); // never confirmed → no span
    expect(errors).toHaveLength(1); // but the loss is surfaced
  });
});
