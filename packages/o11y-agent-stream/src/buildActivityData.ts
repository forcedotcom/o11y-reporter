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

import { schemaUtil } from "o11y/shared";
import { activitySchema } from "o11y_schema/sf_instrumentation";
import {
  agentActivitySchema,
  toolCallActivitySchema,
  workflowActivitySchema,
  planActivitySchema,
  decisionEventSchema,
  handoffActivitySchema,
} from "o11y_schema/sf_agenticTelemetry";
import type { SpanKind, SpanRecord } from "./types";

type Schema = typeof activitySchema;

const AGENTIC_SCHEMA_BY_KIND: Record<SpanKind, Schema> = {
  workflow: workflowActivitySchema as unknown as Schema,
  tool: toolCallActivitySchema as unknown as Schema,
  agent: agentActivitySchema as unknown as Schema,
  plan: planActivitySchema as unknown as Schema,
  decision: decisionEventSchema as unknown as Schema,
  handoff: handoffActivitySchema as unknown as Schema,
};

// Structural match for o11y-client's sf.instrumentation.Activity data object.
// CoreCollector.collect accepts `data` as loose SchematizedData, so this shape
// is sufficient; we intentionally do not import the private ActivityData type.
export interface ActivityRecordData {
  id: string;
  name: string;
  duration: number;
  errorCount: number;
  isRoot?: boolean;
  parentId?: string;
  userPayload?: ReturnType<typeof schemaUtil.makePayload>;
}

export interface BuiltActivity {
  schema: Schema;
  data: ActivityRecordData;
  rootId: string;
}

/**
 * Map a completed SpanRecord onto the generic sf.instrumentation.Activity
 * wrapper, nesting the agenticTelemetry payload as user_payload. Identity,
 * timing and hierarchy live on the wrapper (id / parent_id / is_root /
 * duration); the payload carries only the schema's own fields.
 * @param record Completed span with numeric enum values from the shared parser.
 * @returns Activity data and schema retaining the span's correlation root.
 */
export function buildActivityData(record: SpanRecord): BuiltActivity {
  const agenticSchema = AGENTIC_SCHEMA_BY_KIND[record.kind];
  const data: ActivityRecordData = {
    id: record.id,
    name: record.name,
    duration: record.endMs - record.startMs,
    errorCount: 0,
    isRoot: record.isRoot,
    parentId: record.parentId,
    userPayload: schemaUtil.makePayload(agenticSchema, record.payload),
  };
  return { schema: activitySchema, data, rootId: record.rootId };
}
