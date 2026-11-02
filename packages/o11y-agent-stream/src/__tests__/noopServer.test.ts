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

import { z } from "zod";
import { createNoopO11yServer } from "../noopServer";

// Minimal fakes for the injected SDK helpers.
const toolFake = (
  name: string,
  _desc: string,
  shape: Record<string, unknown>,
  handler: (args: unknown, extra: unknown) => Promise<unknown>,
) => ({ name, shape, handler });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createSdkMcpServerFake = (opts: { name: string; tools: any[] }) => ({
  config: opts,
});

describe("createNoopO11yServer", () => {
  const srv = createNoopO11yServer({
    createSdkMcpServer: createSdkMcpServerFake as any,
    tool: toolFake as any,
  }) as any;

  it("registers exactly the four Layer-B tools under server name o11y", () => {
    expect(srv.config.name).toBe("o11y");
    expect(srv.config.tools.map((t: any) => t.name).sort()).toEqual([
      "log_decision",
      "log_plan",
      "record_handoff",
      "set_workflow_metadata",
    ]);
  });

  it("every tool declares session_id and returns {ok:true}", async () => {
    for (const t of srv.config.tools) {
      expect(Object.prototype.hasOwnProperty.call(t.shape, "session_id")).toBe(
        true,
      );
      const res = await t.handler({ session_id: "s" }, {});
      expect(res).toEqual({
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      });
    }
  });

  it("log_decision's shape validates a required decision_type", () => {
    const dec = srv.config.tools.find((t: any) => t.name === "log_decision");
    expect(() =>
      z.object(dec.shape as any).parse({ session_id: "s" }),
    ).toThrow();
    expect(
      z
        .object(dec.shape as any)
        .parse({ session_id: "s", decision_type: "PLAN" }),
    ).toBeTruthy();
  });
});
