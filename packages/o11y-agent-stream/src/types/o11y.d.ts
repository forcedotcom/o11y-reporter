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
