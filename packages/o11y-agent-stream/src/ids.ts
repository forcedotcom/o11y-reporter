// Span ids mirror the inside-out hooks (ingest.sh): `<sessionId>:workflow`,
// `<sessionId>:agent:<agentId>`. Tool spans are keyed by the SDK tool_use.id.

export function workflowSpanId(sessionId: string): string {
  return `${sessionId}:workflow`;
}

export function agentSpanId(sessionId: string, agentId: string): string {
  return `${sessionId}:agent:${agentId}`;
}

export interface ParsedToolName {
  toolName: string;
  mcpServerName: string;
  toolType: string;
}

/**
 * MCP tools are named `mcp__<server>__<tool>`. Everything else is a builtin.
 * tool_type is a free string on the proto ('mcp' | 'builtin').
 */
export function parseToolName(name: string): ParsedToolName {
  const prefix = "mcp__";
  if (name.startsWith(prefix)) {
    const rest = name.slice(prefix.length);
    const sep = rest.indexOf("__");
    if (sep !== -1) {
      return {
        toolName: rest.slice(sep + 2),
        mcpServerName: rest.slice(0, sep),
        toolType: "mcp",
      };
    }
  }
  return { toolName: name, mcpServerName: "", toolType: "builtin" };
}
