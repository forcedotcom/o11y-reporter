import { CaptureSink, createCollectorSink } from "../sinks";
import type { SpanRecord, SpanTapConfig } from "../types";

const rec: SpanRecord = {
  kind: "tool",
  id: "toolu_1",
  parentId: "sess-1:workflow",
  isRoot: false,
  rootId: "root-abc",
  name: "execute_tool",
  schemaName: "sf.agenticTelemetry.ToolCallActivity",
  startMs: 1000,
  endMs: 1200,
  payload: {
    toolName: "Read",
    mcpServerName: "",
    toolType: "builtin",
    isSuccess: true,
  },
};

describe("CaptureSink", () => {
  it("collects emitted records in order", async () => {
    const sink = new CaptureSink();
    sink.emit(rec);
    await sink.flush();
    expect(sink.records).toEqual([rec]);
  });
});

describe("createCollectorSink", () => {
  it("delivers built activities to the reporter WITH rootId and flushes", async () => {
    const logged: Array<{ props: unknown; schema: unknown; rootId?: string }> =
      [];
    let flushed = 0;
    const reporter = {
      logEventWithSchema: (props: unknown, schema: unknown, rootId?: string) =>
        logged.push({ props, schema, rootId }),
      forceFlush: async () => {
        flushed += 1;
      },
    } as unknown as SpanTapConfig["reporter"];
    const config = {
      sessionId: "sess-1",
      reporter,
    } as unknown as SpanTapConfig;
    const sink = createCollectorSink(config);
    sink.emit(rec);
    expect(sink.pending()).toHaveLength(1);
    expect(logged).toHaveLength(1);
    expect(logged[0].rootId).toBe("root-abc"); // root_id must reach the reporter
    await sink.flush();
    expect(flushed).toBe(1);
  });

  it("preserves semantic payloads; persistence redaction belongs to the host", () => {
    const logged: Array<{ props: Record<string, unknown> }> = [];
    const reporter = {
      logEventWithSchema: (props: Record<string, unknown>) =>
        logged.push({ props }),
      forceFlush: async () => undefined,
    } as unknown as SpanTapConfig["reporter"];
    const sink = createCollectorSink({
      sessionId: "sess-1",
      reporter,
    } as SpanTapConfig);
    sink.emit({
      ...rec,
      kind: "decision",
      schemaName: "sf.agenticTelemetry.DecisionEvent",
      payload: {
        decisionType: 1,
        description: "PRIVATE_DESCRIPTION",
        rationale: "PRIVATE_RATIONALE",
      },
    });

    expect(logged[0].props.userPayload).toMatchObject({
      payload: {
        decisionType: 1,
        description: "PRIVATE_DESCRIPTION",
        rationale: "PRIVATE_RATIONALE",
      },
    });
  });

  it("retains pending records when reporter flush rejects", async () => {
    const reporter = {
      logEventWithSchema: jest.fn(),
      forceFlush: jest.fn().mockRejectedValue(new Error("flush failed")),
    } as unknown as SpanTapConfig["reporter"];
    const sink = createCollectorSink({
      sessionId: "sess-1",
      reporter,
    } as SpanTapConfig);
    sink.emit(rec);
    await expect(sink.flush()).rejects.toThrow("flush failed");
    expect(sink.pending()).toHaveLength(1);
  });
});
