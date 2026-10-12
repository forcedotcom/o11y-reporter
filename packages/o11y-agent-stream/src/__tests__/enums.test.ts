import {
  decisionEventSchema,
  workflowActivitySchema,
} from "o11y_schema/sf_agenticTelemetry";
import {
  DECISION_TYPE,
  FINISH_REASON,
  WORKFLOW_TYPE,
  finishReasonForResult,
  resolveEnum,
  type ResultSubtype,
} from "../enums";

// Pull the enum value maps straight out of the installed schema's pbjs
// definition so a schema bump that renumbers an enum fails HERE loudly, rather
// than silently in prod (o11y-client's LogValidator drops spans with a wrong int).
// The ambient d.ts types the schema loosely, so reach into pbjsSchema structurally.
function schemaEnumValues(
  enumName: "WorkflowType" | "FinishReason",
): Record<string, number> {
  const values = (
    workflowActivitySchema as unknown as {
      pbjsSchema?: {
        nested?: {
          sf?: {
            nested?: {
              agenticTelemetry?: {
                nested?: {
                  WorkflowActivity?: {
                    nested?: Record<
                      string,
                      { values?: Record<string, number> }
                    >;
                  };
                };
              };
            };
          };
        };
      };
    }
  ).pbjsSchema?.nested?.sf?.nested?.agenticTelemetry?.nested?.WorkflowActivity
    ?.nested?.[enumName]?.values;
  if (!values) {
    throw new Error(
      `o11y_schema shape changed: WorkflowActivity.${enumName}.values not found`,
    );
  }
  return values;
}

describe("enum drift guard vs installed o11y_schema", () => {
  it("WORKFLOW_TYPE ints match sf_agenticTelemetry WorkflowType", () => {
    const schema = schemaEnumValues("WorkflowType");
    for (const [key, value] of Object.entries(WORKFLOW_TYPE)) {
      expect(schema[`WORKFLOW_TYPE_${key}`]).toBe(value);
    }
  });

  it("FINISH_REASON ints match sf_agenticTelemetry FinishReason", () => {
    const schema = schemaEnumValues("FinishReason");
    for (const [key, value] of Object.entries(FINISH_REASON)) {
      expect(schema[`FINISH_REASON_${key}`]).toBe(value);
    }
  });
});

describe("enum maps", () => {
  it("exposes finish-reason values as integers matching the proto", () => {
    expect(FINISH_REASON.COMPLETED).toBe(1);
    expect(FINISH_REASON.MAX_ITERATIONS).toBe(2);
    expect(FINISH_REASON.ERROR).toBe(6);
    expect(FINISH_REASON.TIME_BUDGET).toBe(7);
    for (const v of Object.values(FINISH_REASON))
      expect(typeof v).toBe("number");
    for (const v of Object.values(WORKFLOW_TYPE))
      expect(typeof v).toBe("number");
  });
});

describe("finishReasonForResult", () => {
  it.each([
    ["success", 1],
    ["error_max_turns", 2],
    ["error_max_budget_usd", 7],
    ["error_during_execution", 6],
    ["error_max_structured_output_retries", 6],
  ] as const)("maps %p to finish_reason %i", (subtype, expected) => {
    expect(finishReasonForResult(subtype)).toBe(expected);
    expect(typeof finishReasonForResult(subtype)).toBe("number");
  });

  it("maps an unrecognized subtype to FINISH_REASON.UNSPECIFIED instead of throwing (schema drift / new SDK subtype)", () => {
    // Cast past the literal-union type: the whole point is a subtype the SDK
    // introduces that this package's ResultSubtype union doesn't know about yet.
    expect(
      finishReasonForResult("totally_unknown_reason" as ResultSubtype),
    ).toBe(FINISH_REASON.UNSPECIFIED);
  });
});

describe("DECISION_TYPE", () => {
  it("matches the sf_agenticTelemetry DecisionType ints", () => {
    const values = (
      decisionEventSchema as unknown as {
        pbjsSchema?: {
          nested?: {
            sf?: {
              nested?: {
                agenticTelemetry?: {
                  nested?: {
                    DecisionEvent?: {
                      nested?: Record<
                        string,
                        { values?: Record<string, number> }
                      >;
                    };
                  };
                };
              };
            };
          };
        };
      }
    ).pbjsSchema?.nested?.sf?.nested?.agenticTelemetry?.nested?.DecisionEvent
      ?.nested?.DecisionType?.values;
    if (!values)
      throw new Error(
        "o11y_schema shape changed: DecisionEvent.DecisionType.values not found",
      );
    for (const [key, value] of Object.entries(DECISION_TYPE)) {
      expect(values[`DECISION_TYPE_${key}`]).toBe(value);
    }
  });
});

describe("resolveEnum (reject, don't coerce)", () => {
  it("resolves a real member to its int", () => {
    expect(resolveEnum("decision_type", "CHOOSE_TOOL", DECISION_TYPE)).toEqual({
      ok: true,
      value: 2,
    });
  });
  it("rejects an unknown member as an ok-error, never coercing to 0", () => {
    const r = resolveEnum("decision_type", "TYPo", DECISION_TYPE);
    expect(r).toMatchObject({ ok: true, accepted: false, dropped: "bad_enum" });
    expect((r as { value?: number }).value).toBeUndefined();
    expect(r.reason).toContain("decision_type");
  });
});
