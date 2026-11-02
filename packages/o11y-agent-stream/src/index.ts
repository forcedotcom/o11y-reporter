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

export { createSpanTap } from "./spanTap";
export { deriveRootId } from "./rootId";
export { CaptureSink, createCollectorSink } from "./sinks";
export { buildActivityData } from "./buildActivityData";
export {
  DECISION_TYPE,
  FINISH_REASON,
  WORKFLOW_TYPE,
  finishReasonForResult,
  resolveEnum,
} from "./enums";
export { workflowSpanId, agentSpanId, parseToolName } from "./ids";
export { createNoopO11yServer } from "./noopServer";
export type {
  SpanKind,
  SpanRecord,
  SpanSink,
  SpanTap,
  SpanTapConfig,
  SpanTapDeps,
} from "./types";
export type { SdkMcpDeps } from "./noopServer";
