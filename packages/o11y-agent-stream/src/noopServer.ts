import { z } from "zod";

/**
 * Registration-only in-process `o11y` MCP server. It makes `mcp__o11y__log_*`
 * legal + stream-visible; capture is o11y-agent-stream's remap (Task 3), so every
 * handler returns a content-wrapped CallToolResult and emits NOTHING. The four
 * shapes are the frozen Layer-B contract (Task 0.3): session_id is the required
 * first arg on all four so the pretooluse-open.sh-injected instruction
 * (unconditional) never fails inputSchema validation. session_id is accepted and
 * ignored (the parser stamps ids).
 *
 * WARNING (host-scope contract): this server captures NOTHING on its own — it is
 * correct ONLY when its host's message stream is tapped by o11y-agent-stream. A
 * standalone / non-tapped host MUST bind these four tool names to the REAL emitting
 * server (o11y_mcp → o11y-processing-service), NOT this no-op; using the no-op
 * without a tap silently drops all Layer-B telemetry.
 *
 * DI note: createSdkMcpServer/tool are injected by the host so this CommonJS
 * package never statically imports the ESM claude-agent-sdk (ruling R11).
 */
type ToolFn = (
  name: string,
  description: string,
  shape: Record<string, z.ZodTypeAny>,
  handler: (args: unknown, extra: unknown) => Promise<unknown>,
) => unknown;
type CreateSdkMcpServerFn = (opts: {
  name: string;
  version?: string;
  tools: unknown[];
}) => unknown;
export interface SdkMcpDeps {
  createSdkMcpServer: CreateSdkMcpServerFn;
  tool: ToolFn;
}

const ok = async (): Promise<unknown> => ({
  content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
});

export function createNoopO11yServer(sdk: SdkMcpDeps): unknown {
  const { tool, createSdkMcpServer } = sdk;
  const sid = { session_id: z.string() };
  const tools = [
    tool(
      "set_workflow_metadata",
      "Set workflow-level metadata (no-op capture; parsed from the stream).",
      {
        ...sid,
        workflow_name: z.string().optional(),
        workflow_type: z.string().optional(),
        finish_reason: z.string().optional(),
        linked_ticket: z.string().optional(),
        team: z.string().optional(),
      },
      ok,
    ),
    tool(
      "log_plan",
      "Record a plan (no-op capture).",
      {
        ...sid,
        plan_summary: z.string(),
        steps: z.array(z.string()).optional(),
      },
      ok,
    ),
    tool(
      "log_decision",
      "Record a decision at a judgment fork (no-op capture).",
      {
        ...sid,
        decision_type: z.string(),
        description: z.string().optional(),
        rationale: z.string().optional(),
      },
      ok,
    ),
    tool(
      "record_handoff",
      "Record a handoff to a sub-agent (no-op capture).",
      {
        ...sid,
        from_agent: z.string(),
        to_agent: z.string(),
        reason: z.string().optional(),
      },
      ok,
    ),
  ];
  return createSdkMcpServer({ name: "o11y", version: "0.0.0", tools });
}
