#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const ALLOWED_BUILTIN_TOOLS = new Set(["Read"]);
const O11Y_TOOLS = [
  "set_workflow_metadata",
  "log_plan",
  "log_decision",
  "record_handoff",
];
const SAFE_TOOL_NAMES = new Set([...ALLOWED_BUILTIN_TOOLS, ...O11Y_TOOLS]);

function digestId(id) {
  return createHash("sha256").update(id).digest("hex").slice(0, 24);
}

function isSafeRootId(id) {
  return typeof id === "string" && /^[a-f0-9]{32}$/i.test(id);
}

function safeRecord(record) {
  const payload = {};
  switch (record.kind) {
    case "tool":
      payload.toolName = SAFE_TOOL_NAMES.has(record.payload.toolName)
        ? record.payload.toolName
        : "other";
      payload.mcpServerName =
        record.payload.mcpServerName === "o11y" ? "o11y" : "";
      payload.toolType = record.payload.toolType;
      payload.isSuccess = record.payload.isSuccess;
      break;
    case "decision":
      payload.decisionType = record.payload.decisionType;
      payload.redacted = true;
      break;
    case "plan":
      payload.stepCount = Array.isArray(record.payload.steps)
        ? record.payload.steps.length
        : 0;
      payload.redacted = true;
      break;
    case "handoff":
      payload.redacted = true;
      break;
    case "workflow":
      payload.workflowName = "claude-code-session";
      for (const key of ["workflowType", "finishReason", "totalTokens"]) {
        if (Number.isFinite(record.payload[key]))
          payload[key] = record.payload[key];
      }
      break;
    case "agent":
      payload.agentName = "redacted";
      payload.iterationCount = record.payload.iterationCount;
      payload.failedToolCount = record.payload.failedToolCount;
      break;
  }
  return {
    kind: record.kind,
    id: digestId(record.id),
    parentId:
      record.parentId === record.rootId
        ? record.rootId
        : digestId(record.parentId),
    isRoot: record.isRoot,
    rootId: record.rootId,
    schemaName: record.schemaName,
    name: record.name,
    startMs: record.startMs,
    endMs: record.endMs,
    payload,
  };
}

function errorCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("workflow span never initialized"))
    return "missing_workflow";
  if (message.includes("flush")) return "flush_failed";
  return "capture_failed";
}

function* jsonLines(input) {
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== "\n") continue;
    yield input.slice(start, index);
    start = index + 1;
  }
  if (start < input.length) yield input.slice(start);
}

/**
 * Validate and replay bounded Claude stream JSONL through one span tap.
 * @param {string} input Raw JSONL, retained only within configured byte bound.
 * @param {{outputPath: string, modules: object, runId?: string, persist?: boolean, requireLayerB?: boolean, inputTooLarge?: boolean}} options Capture dependencies; persist=false keeps sanitized records in memory for reporter delivery.
 * @returns {Promise<{outputPath: string, runId: string, sessionId: string, rootId: string, pairedToolResults: number, pairedO11yResults: number, kinds: object, records: object[]}>} Sanitized records plus capture identity; raw records never leave this function.
 * @throws {Error} When validation, capture, flush, or local export fails.
 */
export async function captureJsonl(
  input,
  {
    outputPath,
    modules,
    runId,
    inputTooLarge = false,
    requireLayerB = true,
    persist = true,
  } = {},
) {
  if (!outputPath || !modules) throw new Error("capture options missing");
  const { CaptureSink, createSpanTap, deriveRootId } = modules;
  const captureErrors = [];
  const parseErrors = [];
  if (typeof input !== "string")
    throw new Error("capture input must be a string");
  if (inputTooLarge || Buffer.byteLength(input) > MAX_INPUT_BYTES) {
    throw Object.assign(
      new Error("headless capture did not complete cleanly"),
      {
        captureErrors,
        parseErrors: [{ code: "input_limit_exceeded" }],
        kinds: {},
      },
    );
  }
  const sink = new CaptureSink();
  let sessionId;
  let sawResult = false;
  let lineNumber = 0;
  const pendingToolCalls = new Map();
  let pairedToolResults = 0;
  let pairedO11yResults = 0;

  for (const rawLine of jsonLines(input)) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message.type === "error") {
        parseErrors.push({ code: "cli_error", line: lineNumber });
        continue;
      }
      const content = message.message?.content;
      if (message.type === "assistant" && Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== "tool_use" || typeof block.id !== "string")
            continue;
          if (pendingToolCalls.has(block.id)) {
            parseErrors.push({
              code: "duplicate_tool_use_id",
              line: lineNumber,
            });
            continue;
          }
          const name = typeof block.name === "string" ? block.name : "";
          const separator = name.startsWith("mcp__")
            ? name.indexOf("__", 5)
            : -1;
          const mcpServerName = separator > 5 ? name.slice(5, separator) : "";
          const toolName = mcpServerName ? name.slice(separator + 2) : name;
          const recognizedO11yTool =
            mcpServerName === "o11y" && O11Y_TOOLS.includes(toolName);
          if (mcpServerName && !recognizedO11yTool) {
            parseErrors.push({ code: "unexpected_mcp_tool", line: lineNumber });
          }
          if (!mcpServerName && !ALLOWED_BUILTIN_TOOLS.has(toolName)) {
            parseErrors.push({
              code: "unexpected_builtin_tool",
              line: lineNumber,
            });
          }
          pendingToolCalls.set(block.id, { isO11y: recognizedO11yTool });
        }
      }
      if (message.type === "user" && Array.isArray(content)) {
        for (const block of content) {
          if (
            block?.type !== "tool_result" ||
            typeof block.tool_use_id !== "string"
          )
            continue;
          const pending = pendingToolCalls.get(block.tool_use_id);
          if (!pending) {
            parseErrors.push({ code: "orphan_tool_result", line: lineNumber });
          } else {
            pendingToolCalls.delete(block.tool_use_id);
            if (block.is_error !== true) {
              pairedToolResults += 1;
              if (pending.isO11y) pairedO11yResults += 1;
            }
          }
        }
      }
      const currentSession = message.session_id;
      if (typeof currentSession === "string") {
        if (!SAFE_ID.test(currentSession)) {
          parseErrors.push({ code: "invalid_session_id", line: lineNumber });
          continue;
        }
        if (sessionId && sessionId !== currentSession) {
          parseErrors.push({ code: "session_id_changed", line: lineNumber });
          continue;
        }
        sessionId = currentSession;
      }
      if (message.type === "result") {
        if (message.subtype === "success") sawResult = true;
        else parseErrors.push({ code: "cli_result_error", line: lineNumber });
      }
    } catch {
      parseErrors.push({ code: "malformed_jsonl", line: lineNumber });
    }
  }

  if (pendingToolCalls.size) parseErrors.push({ code: "missing_tool_result" });
  if (!sessionId) parseErrors.push({ code: "missing_session_id" });
  const stableRunId = runId ?? sessionId;
  if (typeof stableRunId !== "string" || !SAFE_ID.test(stableRunId)) {
    parseErrors.push({ code: "invalid_run_id" });
  }
  if (parseErrors.length) {
    throw Object.assign(
      new Error("headless capture did not complete cleanly"),
      {
        captureErrors,
        parseErrors,
        kinds: {},
      },
    );
  }

  const rootId = deriveRootId(stableRunId, {
    SF_AGENT_HEADLESS_HOST: "1",
    SF_AGENT_ROOT_SEED: stableRunId,
  });
  const tap = createSpanTap(
    { sessionId, rootId, appName: "o11y-headless-steel-thread" },
    {
      sink,
      onError: (error) => captureErrors.push({ code: errorCode(error) }),
    },
  );
  try {
    for (const rawLine of jsonLines(input)) {
      const line = rawLine.trim();
      if (line) await tap.onMessage(JSON.parse(line));
    }
  } finally {
    await tap.close();
  }

  const kinds = sink.records.reduce((counts, record) => {
    counts[record.kind] = (counts[record.kind] ?? 0) + 1;
    return counts;
  }, {});
  if (!sawResult) captureErrors.push({ code: "missing_result" });
  if (!kinds.workflow) captureErrors.push({ code: "missing_workflow" });
  if (!kinds.tool || pairedToolResults === 0)
    captureErrors.push({ code: "missing_tool_call_result" });
  if (requireLayerB) {
    if (pairedO11yResults === 0) {
      captureErrors.push({ code: "missing_o11y_tool_result" });
    }
    if (!(kinds.decision || kinds.plan || kinds.handoff)) {
      captureErrors.push({ code: "missing_layer_b_record" });
    }
  }
  if (captureErrors.length) {
    throw Object.assign(
      new Error("headless capture did not complete cleanly"),
      {
        captureErrors,
        parseErrors,
        kinds,
      },
    );
  }
  if (!outputPath)
    throw Object.assign(new Error("local export failed"), {
      exportError: true,
    });
  if (!isSafeRootId(rootId)) {
    throw Object.assign(
      new Error("headless capture did not complete cleanly"),
      {
        captureErrors: [{ code: "invalid_root_id" }],
        parseErrors,
        kinds,
      },
    );
  }

  const records = [
    {
      kind: "run",
      runId: digestId(stableRunId),
      sessionId: digestId(sessionId),
      rootId,
      pairedToolResults,
      pairedO11yResults,
      recordCount: sink.records.length,
      kinds,
    },
    ...sink.records.map(safeRecord),
  ];
  const result = {
    outputPath,
    runId: stableRunId,
    sessionId,
    rootId,
    pairedToolResults,
    pairedO11yResults,
    kinds,
    records: records.slice(1),
  };
  if (!persist) return result;
  let file;
  try {
    file = await open(outputPath, "wx", 0o600);
    await file.writeFile(
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    await file.sync();
    await file.close();
  } catch (error) {
    await file?.close().catch(() => undefined);
    throw Object.assign(new Error("local export failed"), {
      exportError: true,
      cause: error,
    });
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  if (args.includes("--help")) {
    process.stdout.write(
      "Usage: claude -p --output-format stream-json <bounded prompt> | node headless-steel-thread.mjs --output /tmp/run.jsonl [--run-id ID]\n" +
        "Consumes raw JSONL only in memory; persists sanitized SpanRecord JSONL.\n",
    );
    return;
  }
  const outputPath =
    valueAfter("--output") ?? `/tmp/o11y-headless-${randomUUID()}.jsonl`;
  const runId = valueAfter("--run-id");
  const requireLayerB = !args.includes("--allow-no-layer-b");
  let parser;
  try {
    parser = await import(new URL("../dist/index.js", import.meta.url).href);
  } catch {
    process.stderr.write("PARSER_ERROR shared_tap_unavailable\n");
    process.exitCode = 1;
    return;
  }
  const { createSpanTap, CaptureSink, deriveRootId } = parser;
  const decoder = new TextDecoder();
  let input = "";
  let inputBytes = 0;
  let inputTooLarge = false;
  for await (const chunk of process.stdin) {
    inputBytes += chunk.length;
    if (inputBytes > MAX_INPUT_BYTES) {
      inputTooLarge = true;
      break;
    }
    input += decoder.decode(chunk, { stream: true });
  }
  if (!inputTooLarge) input += decoder.decode();
  try {
    const result = await captureJsonl(input, {
      outputPath,
      runId,
      inputTooLarge,
      requireLayerB,
      modules: { createSpanTap, CaptureSink, deriveRootId },
    });
    process.stdout.write(
      `PASS run=${digestId(result.runId)} session=${digestId(result.sessionId)} root=${result.rootId} pairedToolResults=${result.pairedToolResults} pairedO11yResults=${result.pairedO11yResults} records=${JSON.stringify(result.kinds)} file=${result.outputPath}\n`,
    );
  } catch (error) {
    for (const item of error.parseErrors ?? []) {
      process.stderr.write(
        `CAPTURE_ERROR ${item.code}${item.line ? ` line=${item.line}` : ""}\n`,
      );
    }
    for (const item of error.captureErrors ?? [])
      process.stderr.write(`CAPTURE_ERROR ${item.code}\n`);
    if (error.exportError)
      process.stderr.write("CAPTURE_ERROR export_failed\n");
    process.stderr.write(
      "FAIL headless capture incomplete; no success file written\n",
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`CAPTURE_ERROR harness_failed: ${detail}\n`);
    process.exitCode = 1;
  });
}
