#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/**
 * Validate actual LocalCollector Activity envelopes without displaying raw payloads.
 * @param {string} outputPath Reporter/LocalCollector JSONL output.
 * @returns {Promise<{rootId: string, bytes: number}>} Correlation and file size.
 * @throws {Error} On unsafe persistence, missing fields/records, or broken correlation.
 */
export async function inspectCollectorOutput(outputPath) {
  const metadata = await stat(outputPath);
  if ((metadata.mode & 0o777) !== 0o600) throw new Error("unsafe_output_mode");
  if (metadata.size === 0 || metadata.size > 64 * 1024)
    throw new Error("invalid_output_size");
  const records = (await readFile(outputPath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  if (
    records.length !== 3 ||
    !records.every(
      (record) => record.schemaId === "sf.instrumentation.Activity",
    )
  ) {
    throw new Error("missing_required_activities");
  }
  const rootId = records[0].rootId;
  if (
    !/^[a-f0-9]{32}$/.test(rootId) ||
    !records.every((record) => record.rootId === rootId)
  ) {
    throw new Error("root_correlation_mismatch");
  }
  if (
    !/^headless-local-[a-f0-9]{24}$/.test(records[0].loggerName) ||
    !records.every((record) => record.loggerName === records[0].loggerName)
  ) {
    throw new Error("session_correlation_mismatch");
  }
  const find = (name) =>
    records.find((record) => record.data?.userPayload?.schema?.name === name);
  const workflow = find("WorkflowActivity");
  const tool = find("ToolCallActivity");
  const decision = find("DecisionEvent");
  if (!workflow || !tool || !decision)
    throw new Error("missing_required_payloads");
  const descriptor = (record) =>
    record.data.userPayload.schema.pbjsSchema?.nested?.sf?.nested
      ?.agenticTelemetry?.nested?.[record.data.userPayload.schema.name];
  if (
    descriptor(workflow)?.fields?.finishReason?.type !== "FinishReason" ||
    descriptor(workflow)?.fields?.workflowType?.type !== "WorkflowType" ||
    descriptor(decision)?.fields?.decisionType?.type !== "DecisionType"
  ) {
    throw new Error("rewritten_enum_schema");
  }
  const wp = workflow.data.userPayload.payload;
  const tp = tool.data.userPayload.payload;
  const dp = decision.data.userPayload.payload;
  if (
    workflow.data.name !== "invoke_workflow" ||
    workflow.data.isRoot !== true ||
    workflow.data.parentId !== rootId ||
    wp.workflowName !== "claude-code-session" ||
    wp.finishReason !== 1 ||
    tp.toolName !== "Read" ||
    tp.isSuccess !== true ||
    dp.decisionType !== 1 ||
    tool.data.parentId !== workflow.data.id ||
    decision.data.parentId !== workflow.data.id
  ) {
    throw new Error("unexpected_activity_payload");
  }
  const allowed = new Map([
    [wp, ["workflowName", "workflowType", "finishReason", "totalTokens"]],
    [tp, ["toolName", "mcpServerName", "toolType", "isSuccess"]],
    [dp, ["decisionType"]],
  ]);
  for (const [payload, keys] of allowed) {
    if (Object.keys(payload).some((key) => !keys.includes(key)))
      throw new Error("unsafe_payload_field");
  }
  if (
    !records.every((record) => /^[a-f0-9]{24}$/.test(record.data.id)) ||
    new Set(records.map((record) => record.data.id)).size !== 3
  )
    throw new Error("invalid_span_identity");
  return { rootId, bytes: metadata.size };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [outputPath] = process.argv.slice(2);
  inspectCollectorOutput(outputPath)
    .then(({ rootId, bytes }) => {
      process.stdout.write(
        `DEMO_PASS file=${outputPath} mode=0600 bytes=${bytes} root=${rootId} records=workflow,Read,PLAN source=LocalCollector\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`DEMO_CHECK_FAILED ${error.message}\n`);
      process.exitCode = 1;
    });
}
