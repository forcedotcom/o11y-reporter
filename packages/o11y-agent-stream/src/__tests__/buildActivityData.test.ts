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

import {
  toolCallActivitySchema,
  workflowActivitySchema,
  decisionEventSchema,
} from "o11y_schema/sf_agenticTelemetry";
import { buildActivityData } from "../buildActivityData";
import type { SpanRecord } from "../types";

const toolRecord: SpanRecord = {
  kind: "tool",
  id: "toolu_1",
  parentId: "sess-1:workflow",
  isRoot: false,
  rootId: "root-abc",
  name: "execute_tool",
  schemaName: "sf.agenticTelemetry.ToolCallActivity",
  startMs: 1000,
  endMs: 1750,
  payload: {
    toolName: "Read",
    mcpServerName: "",
    toolType: "builtin",
    isSuccess: true,
  },
};

describe("buildActivityData", () => {
  it("wraps the payload in an sf.instrumentation.Activity with tree fields", () => {
    const built = buildActivityData(toolRecord);
    expect(built.rootId).toBe("root-abc");
    expect(built.schema.namespace).toBe("sf.instrumentation");
    expect(built.data.id).toBe("toolu_1");
    expect(built.data.parentId).toBe("sess-1:workflow");
    expect(built.data.isRoot).toBe(false);
    expect(built.data.duration).toBe(750);
    expect(built.data.errorCount).toBe(0);
    expect(built.data.userPayload!.schema).toBe(toolCallActivitySchema);
    expect(built.data.userPayload!.payload).toMatchObject({
      toolName: "Read",
      toolType: "builtin",
    });
  });

  it("retains published workflow schema and numeric enum fields unchanged", () => {
    const wfRecord: SpanRecord = {
      kind: "workflow",
      id: "sess-1:workflow",
      parentId: "root-abc",
      isRoot: true,
      rootId: "root-abc",
      name: "invoke_workflow",
      schemaName: "sf.agenticTelemetry.WorkflowActivity",
      startMs: 0,
      endMs: 5000,
      payload: {
        workflowName: "claude-code-session",
        workflowType: 6,
        finishReason: 1,
        totalTokens: 42,
        totalCostUsd: 0.01,
      },
    };
    const built = buildActivityData(wfRecord);
    expect(built.data.userPayload!.schema).toBe(workflowActivitySchema);
    expect(built.data.userPayload!.payload).toBe(wfRecord.payload);
    expect(
      typeof (built.data.userPayload!.payload as { finishReason: unknown })
        .finishReason,
    ).toBe("number");
  });

  it("maps a decision record onto the Activity wrapper with the DecisionEvent payload", () => {
    const rec = {
      kind: "decision",
      id: "sess-1:decision:CHOOSE_TOOL:1",
      parentId: "sess-1:workflow",
      isRoot: false,
      rootId: "r1",
      name: "decision",
      schemaName: "sf.agenticTelemetry.DecisionEvent",
      startMs: 1000,
      endMs: 1000, // instant → duration 0
      payload: { decisionType: 2, description: "picked grep" },
    } as const;
    const built = buildActivityData(rec as any);
    expect(built.data.duration).toBe(0);
    expect(built.data.id).toBe("sess-1:decision:CHOOSE_TOOL:1");
    expect(built.data.userPayload).toBeDefined();
    expect(built.rootId).toBe("r1");
    expect(built.data.userPayload!.schema).toBe(decisionEventSchema);
    expect(built.data.userPayload!.payload).toBe(rec.payload);
  });
});
