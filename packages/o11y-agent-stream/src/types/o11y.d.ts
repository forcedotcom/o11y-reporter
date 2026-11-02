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

declare module "o11y/shared" {
  export const schemaUtil: {
    makePayload: (
      schema: unknown,
      data: Record<string, unknown>,
    ) => { schema: unknown; payload: Record<string, unknown> };
  };
}
declare module "o11y_schema/sf_instrumentation" {
  export const activitySchema: { namespace: string; name: string };
}
declare module "o11y_schema/sf_agenticTelemetry" {
  export const workflowActivitySchema: { namespace: string; name: string };
  export const toolCallActivitySchema: { namespace: string; name: string };
  export const agentActivitySchema: { namespace: string; name: string };
  export const planActivitySchema: { namespace: string; name: string };
  export const decisionEventSchema: { namespace: string; name: string };
  export const handoffActivitySchema: { namespace: string; name: string };
}
