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
