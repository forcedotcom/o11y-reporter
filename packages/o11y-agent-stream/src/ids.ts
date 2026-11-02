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

// Span ids use `<sessionId>:workflow` and
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
