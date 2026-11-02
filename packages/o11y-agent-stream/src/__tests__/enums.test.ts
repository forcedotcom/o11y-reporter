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
    expect(schema).not.toHaveProperty("FINISH_REASON_SUCCESS");
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
  describe.each([
    ["finish_reason", FINISH_REASON],
    ["workflow_type", WORKFLOW_TYPE],
    ["decision_type", DECISION_TYPE],
  ] as const)("%s", (field, table) => {
    const prefix = `${field.toUpperCase()}_`;

    it.each(Object.entries(table))(
      "resolves bare and prefixed %s to %i",
      (member, value) => {
        expect(resolveEnum(field, member, table)).toEqual({ ok: true, value });
        expect(resolveEnum(field, `${prefix}${member}`, table)).toEqual({
          ok: true,
          value,
        });
      },
    );

    it.each([
      "UNKNOWN",
      `${prefix}UNKNOWN`,
      "",
      prefix,
      `${prefix}${prefix}UNSPECIFIED`,
      "unspecified",
      `${prefix.toLowerCase()}UNSPECIFIED`,
      `${prefix}unspecified`,
      ...["FINISH_REASON_", "WORKFLOW_TYPE_", "DECISION_TYPE_"]
        .filter((other) => other !== prefix)
        .map((other) => `${other}UNSPECIFIED`),
      ...["constructor", "toString", "__proto__", "hasOwnProperty"].flatMap(
        (member) => [member, `${prefix}${member}`],
      ),
    ])("rejects %p without coercion", (value) => {
      expect(resolveEnum(field, value, table)).toEqual({
        ok: true,
        accepted: false,
        dropped: "bad_enum",
        reason: `unknown ${field}: ${JSON.stringify(value)}`,
      });
    });
  });

  it("rejects FINISH_REASON_SUCCESS rather than treating it as COMPLETED", () => {
    expect(
      resolveEnum("finish_reason", "FINISH_REASON_SUCCESS", FINISH_REASON),
    ).toEqual({
      ok: true,
      accepted: false,
      dropped: "bad_enum",
      reason: 'unknown finish_reason: "FINISH_REASON_SUCCESS"',
    });
  });

  it("checks an exact own entry before stripping a prefix", () => {
    expect(
      resolveEnum("decision_type", "DECISION_TYPE_PLAN", {
        DECISION_TYPE_PLAN: 7,
        PLAN: 1,
      }),
    ).toEqual({ ok: true, value: 7 });
  });

  it.each(["PLAN", "DECISION_TYPE_PLAN"])(
    "rejects inherited %s entries",
    (value) => {
      const table = Object.create({ PLAN: 1, DECISION_TYPE_PLAN: 2 });
      expect(resolveEnum("decision_type", value, table)).toEqual({
        ok: true,
        accepted: false,
        dropped: "bad_enum",
        reason: `unknown decision_type: ${JSON.stringify(value)}`,
      });
    },
  );

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
