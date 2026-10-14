import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureJsonl } from "./headless-steel-thread.mjs";
const modules = await import("../dist/index.js");

test("captures lifecycle, tool result, Layer-B call, stable run root, and redacts content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "o11y-steel-thread-"));
  const outputPath = join(directory, "safe.jsonl");
  try {
    const fixture = await readFile(
      new URL("./headless-steel-thread.fixture.jsonl", import.meta.url),
      "utf8",
    );
    const result = await captureJsonl(fixture, {
      outputPath,
      modules,
      runId: "headless-proof-run",
    });
    const records = (await readFile(outputPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const [run, ...spans] = records;

    assert.equal(result.runId, "headless-proof-run");
    assert.equal(
      result.rootId,
      modules.deriveRootId("headless-proof-run", {
        SF_AGENT_HEADLESS_HOST: "1",
        SF_AGENT_ROOT_SEED: "headless-proof-run",
      }),
    );
    assert.equal(result.pairedToolResults, 2);
    assert.equal(result.pairedO11yResults, 1);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    assert.equal(run.sessionId, "47d1d2e6f4160cead2dc20f5");
    assert.equal(run.rootId, result.rootId);
    assert.equal(
      spans.filter((record) => record.kind === "workflow").length,
      1,
    );
    assert.equal(spans.filter((record) => record.kind === "tool").length, 1);
    assert.equal(
      spans.filter((record) => record.kind === "decision").length,
      1,
    );
    assert.equal(
      spans.find((record) => record.kind === "decision").schemaName,
      "sf.agenticTelemetry.DecisionEvent",
    );
    assert.equal(
      spans.find((record) => record.kind === "tool").payload.isSuccess,
      true,
    );
    assert.equal(
      spans.find((record) => record.kind === "decision").payload.decisionType,
      1,
    );
    assert.equal(
      spans.find((record) => record.kind === "decision").payload.redacted,
      true,
    );
    assert.ok(records.every((record) => record.rootId === result.rootId));
    assert.ok(!JSON.stringify(records).includes("PRIVATE_"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI MCP config exposes only the local registration-only o11y server", async () => {
  const config = JSON.parse(
    await readFile(
      new URL("./headless-mcp-config.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(config.mcpServers), ["o11y"]);
  assert.deepEqual(config.mcpServers.o11y, {
    command: "node",
    args: ["packages/o11y-agent-stream/e2e/headless-o11y-mcp.mjs"],
  });
});

test("local MCP advertises required argument schemas for all four tools", async () => {
  const serverPath = new URL("./headless-o11y-mcp.mjs", import.meta.url);
  const server = spawn(process.execPath, [serverPath.pathname], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  server.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  server.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  server.stdin.end(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
  );
  const exitCode = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("close", resolve);
  });
  assert.equal(exitCode, 0, stderr);
  const response = JSON.parse(stdout.trim());
  const schemas = Object.fromEntries(
    response.result.tools.map(({ name, inputSchema }) => [name, inputSchema]),
  );
  assert.deepEqual(Object.keys(schemas), [
    "set_workflow_metadata",
    "log_plan",
    "log_decision",
    "record_handoff",
  ]);
  assert.deepEqual(schemas.log_decision.required, [
    "session_id",
    "decision_type",
  ]);
  assert.deepEqual(schemas.log_plan.required, ["session_id", "plan_summary"]);
  assert.deepEqual(schemas.record_handoff.required, [
    "session_id",
    "from_agent",
    "to_agent",
  ]);
  assert.deepEqual(schemas.set_workflow_metadata.required, ["session_id"]);
});

test("local MCP returns a JSON-RPC parse error for malformed input", async () => {
  const serverPath = new URL("./headless-o11y-mcp.mjs", import.meta.url);
  const server = spawn(process.execPath, [serverPath.pathname], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  server.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  server.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  server.stdin.end("{broken\n");
  const exitCode = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("close", resolve);
  });
  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout.trim()), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Parse error" },
  });
});

test("capture maps parser-supported short decision enums", async () => {
  const expected = [
    "UNSPECIFIED",
    "PLAN",
    "CHOOSE_TOOL",
    "SKIP",
    "CREATE",
    "MODIFY",
    "DELEGATE",
  ];
  const fixture = await readFile(
    new URL("./headless-steel-thread.fixture.jsonl", import.meta.url),
    "utf8",
  );
  const directory = await mkdtemp(join(tmpdir(), "o11y-decision-enums-"));
  try {
    for (const [index, value] of expected.entries()) {
      const result = await captureJsonl(
        fixture.replace('"PLAN"', JSON.stringify(value)),
        {
          outputPath: join(directory, `${value}.jsonl`),
          modules,
        },
      );
      assert.equal(
        result.records.find((record) => record.kind === "decision").payload
          .decisionType,
        index,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("every non-success CLI result subtype is a hard failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "o11y-steel-thread-"));
  try {
    const fixture = await readFile(
      new URL("./headless-steel-thread.fixture.jsonl", import.meta.url),
      "utf8",
    );
    for (const subtype of [
      "error_during_execution",
      "error_max_turns",
      "error_max_budget_usd",
      "error_max_structured_output_retries",
    ]) {
      const input = fixture.replace(
        '"subtype":"success"',
        `"subtype":"${subtype}"`,
      );
      await assert.rejects(
        captureJsonl(input, {
          outputPath: join(directory, `${subtype}.jsonl`),
          modules,
        }),
        (error) =>
          error.parseErrors.some((item) => item.code === "cli_result_error"),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP server and tool name must match exact allowlist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "o11y-steel-thread-"));
  try {
    const fixture = await readFile(
      new URL("./headless-steel-thread.fixture.jsonl", import.meta.url),
      "utf8",
    );
    for (const [name, expected] of [
      ["mcp__prefix-o11y__log_decision", "unexpected_mcp_tool"],
      ["mcp__o11y__unlisted_tool", "unexpected_mcp_tool"],
      ["Bash", "unexpected_builtin_tool"],
    ]) {
      const input = fixture.replace("mcp__o11y__log_decision", name);
      await assert.rejects(
        captureJsonl(input, {
          outputPath: join(directory, `${name.replaceAll("/", "_")}.jsonl`),
          modules,
        }),
        (error) => error.parseErrors.some((item) => item.code === expected),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("successful MCP result without emitted Layer-B span is a hard failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "o11y-steel-thread-"));
  try {
    const fixture = await readFile(
      new URL("./headless-steel-thread.fixture.jsonl", import.meta.url),
      "utf8",
    );
    const input = fixture.replaceAll(
      "mcp__o11y__log_decision",
      "mcp__o11y__set_workflow_metadata",
    );
    await assert.rejects(
      captureJsonl(input, {
        outputPath: join(directory, "safe.jsonl"),
        modules,
      }),
      (error) =>
        error.captureErrors.some(
          (item) => item.code === "missing_layer_b_record",
        ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Layer-B may be omitted for a scoped read-only run while structural call pairs remain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "o11y-steel-thread-"));
  const outputPath = join(directory, "safe.jsonl");
  try {
    const fixture = await readFile(
      new URL("./headless-steel-thread.fixture.jsonl", import.meta.url),
      "utf8",
    );
    const input = [
      JSON.stringify({ type: "system", session_id: "readonly-session" }),
      JSON.stringify({
        type: "assistant",
        session_id: "readonly-session",
        message: {
          content: [{ type: "tool_use", id: "read1", name: "Read", input: {} }],
        },
      }),
      JSON.stringify({
        type: "user",
        session_id: "readonly-session",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "read1", content: "ok" },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "readonly-session",
      }),
    ].join("\n");
    const result = await captureJsonl(input, {
      outputPath,
      modules,
      requireLayerB: false,
    });
    assert.equal(result.pairedToolResults, 1);
    assert.equal(result.pairedO11yResults, 0);
    assert.equal(result.kinds.decision, undefined);
    assert.deepEqual(result.kinds, { tool: 1, workflow: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing successful o11y tool result fails without writing output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "o11y-steel-thread-"));
  const outputPath = join(directory, "safe.jsonl");
  try {
    const input = [
      JSON.stringify({ type: "system", session_id: "safe-session" }),
      JSON.stringify({
        type: "assistant",
        session_id: "safe-session",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_private",
              name: "mcp__o11y__log_decision",
              input: {},
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        session_id: "safe-session",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_private",
              is_error: true,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "safe-session",
      }),
    ].join("\n");
    await assert.rejects(
      captureJsonl(input, { outputPath, modules }),
      (error) =>
        error.captureErrors.some(
          (item) => item.code === "missing_tool_call_result",
        ),
    );
    await assert.rejects(readFile(outputPath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed JSONL is a visible hard failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "o11y-steel-thread-"));
  try {
    await assert.rejects(
      captureJsonl('{"type":"system","session_id":"safe-session"}\n{broken', {
        outputPath: join(directory, "safe.jsonl"),
        modules,
      }),
      (error) =>
        error.parseErrors.some((item) => item.code === "malformed_jsonl"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("oversized JSONL is rejected before parsing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "o11y-steel-thread-"));
  try {
    await assert.rejects(
      captureJsonl(" ".repeat(5 * 1024 * 1024 + 1), {
        outputPath: join(directory, "safe.jsonl"),
        modules,
      }),
      (error) =>
        error.parseErrors.some((item) => item.code === "input_limit_exceeded"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing workflow and tool result are visible hard failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "o11y-steel-thread-"));
  try {
    await assert.rejects(
      captureJsonl(
        '{"type":"result","subtype":"success","session_id":"safe-session"}',
        {
          outputPath: join(directory, "safe.jsonl"),
          modules,
        },
      ),
      (error) =>
        error.captureErrors.some((item) => item.code === "missing_workflow") &&
        error.captureErrors.some(
          (item) => item.code === "missing_tool_call_result",
        ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unpaired tool use is a visible hard failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "o11y-steel-thread-"));
  try {
    const input = [
      JSON.stringify({ type: "system", session_id: "safe-session" }),
      JSON.stringify({
        type: "assistant",
        session_id: "safe-session",
        message: {
          content: [
            {
              type: "tool_use",
              id: "private-tool-id",
              name: "Read",
              input: {},
            },
          ],
        },
      }),
      JSON.stringify({ type: "result", session_id: "safe-session" }),
    ].join("\n");
    await assert.rejects(
      captureJsonl(input, {
        outputPath: join(directory, "safe.jsonl"),
        modules,
      }),
      (error) =>
        error.parseErrors.some((item) => item.code === "missing_tool_result"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("export collision is visible and leaves existing file untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "o11y-steel-thread-"));
  const outputPath = join(directory, "existing.jsonl");
  try {
    await writeFile(outputPath, "keep-this-file\n", { mode: 0o600 });
    const fixture = await readFile(
      new URL("./headless-steel-thread.fixture.jsonl", import.meta.url),
      "utf8",
    );
    await assert.rejects(
      captureJsonl(fixture, { outputPath, modules }),
      (error) => error.exportError === true,
    );
    assert.equal(await readFile(outputPath, "utf8"), "keep-this-file\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
