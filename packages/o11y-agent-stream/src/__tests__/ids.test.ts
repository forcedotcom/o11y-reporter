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

import { agentSpanId, parseToolName, workflowSpanId } from "../ids";

describe("span id scheme", () => {
  it("mirrors the bash hooks so a mixed run reconstructs one tree", () => {
    expect(workflowSpanId("sess-1")).toBe("sess-1:workflow");
    expect(agentSpanId("sess-1", "toolu_abc")).toBe("sess-1:agent:toolu_abc");
  });
});

describe("parseToolName", () => {
  it("splits an mcp tool name into server + tool", () => {
    expect(parseToolName("mcp__o11y_mcp__log_decision")).toEqual({
      toolName: "log_decision",
      mcpServerName: "o11y_mcp",
      toolType: "mcp",
    });
  });

  it("treats a bare name as a builtin tool", () => {
    expect(parseToolName("Read")).toEqual({
      toolName: "Read",
      mcpServerName: "",
      toolType: "builtin",
    });
  });

  it("handles an mcp prefix with no tool segment gracefully", () => {
    expect(parseToolName("mcp__weirdserver")).toEqual({
      toolName: "mcp__weirdserver",
      mcpServerName: "",
      toolType: "builtin",
    });
  });
});
