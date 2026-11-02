// Integer values copied verbatim from o11y_schema@264.117.0
// sf_agenticTelemetry/workflow_activity.js. Enum fields MUST be emitted as these
// ints, never as name strings, or o11y-client's LogValidator drops the span.

export const WORKFLOW_TYPE = {
  UNSPECIFIED: 0,
  BUG_FIX: 1,
  CODE_REVIEW: 2,
  FEATURE: 3,
  REFACTOR: 4,
  TEST: 5,
  DOCUMENTATION: 6,
  INVESTIGATION: 7,
  DEPLOYMENT: 8,
} as const;

export const FINISH_REASON = {
  UNSPECIFIED: 0,
  COMPLETED: 1,
  MAX_ITERATIONS: 2,
  GUARDRAIL: 3,
  HANDOFF: 4,
  TOOL_FAILURE: 5,
  ERROR: 6,
  TIME_BUDGET: 7,
} as const;

// Integer values copied verbatim from o11y_schema sf_agenticTelemetry/decision_event
// DecisionEvent.DecisionType. Emit as ints; a name string is dropped by LogValidator.
export const DECISION_TYPE = {
  UNSPECIFIED: 0,
  PLAN: 1,
  CHOOSE_TOOL: 2,
  SKIP: 3,
  CREATE: 4,
  MODIFY: 5,
  DELEGATE: 6,
} as const;

export type EnumResolution =
  | { ok: true; value: number }
  | { ok: true; accepted: false; dropped: "bad_enum"; reason: string };

/**
 * Resolve a bare enum member or its field-prefixed alias to an integer.
 *
 * @param {string} field Enum field name used to derive the exact uppercase prefix.
 * @param {string} value Member name to resolve, without case normalization.
 * @param {Record<string, number>} table Own entries mapped to schema integers.
 * @returns {EnumResolution} The resolved integer, or a bad_enum rejection without
 * coercing unknown members to 0/UNSPECIFIED.
 */
export function resolveEnum(
  field: string,
  value: string,
  table: Record<string, number>,
): EnumResolution {
  if (Object.prototype.hasOwnProperty.call(table, value)) {
    return { ok: true, value: table[value] };
  }
  const prefix = `${field.toUpperCase()}_`;
  if (value.startsWith(prefix)) {
    const bare = value.slice(prefix.length);
    if (Object.prototype.hasOwnProperty.call(table, bare)) {
      return { ok: true, value: table[bare] };
    }
  }
  return {
    ok: true,
    accepted: false,
    dropped: "bad_enum",
    reason: `unknown ${field}: ${JSON.stringify(value)}`,
  };
}

export type ResultSubtype =
  | "success"
  | "error_during_execution"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "error_max_structured_output_retries";

/**
 * Map an SDKResultMessage.subtype to a FinishReason int.
 * `error_max_budget_usd` maps to TIME_BUDGET as the closest "budget exhausted"
 * bucket — the enum has no dedicated cost-budget value.
 */
export function finishReasonForResult(subtype: ResultSubtype): number {
  switch (subtype) {
    case "success":
      return FINISH_REASON.COMPLETED;
    case "error_max_turns":
      return FINISH_REASON.MAX_ITERATIONS;
    case "error_max_budget_usd":
      return FINISH_REASON.TIME_BUDGET;
    case "error_during_execution":
    case "error_max_structured_output_retries":
      return FINISH_REASON.ERROR;
    default:
      return FINISH_REASON.UNSPECIFIED;
  }
}
