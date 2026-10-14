#!/usr/bin/env node
import { createInterface } from "node:readline";

const schemas = {
  set_workflow_metadata: {
    properties: {
      session_id: { type: "string" },
      workflow_name: { type: "string" },
      workflow_type: { type: "string" },
      finish_reason: { type: "string" },
      linked_ticket: { type: "string" },
      team: { type: "string" },
    },
    required: ["session_id"],
  },
  log_plan: {
    properties: {
      session_id: { type: "string" },
      plan_summary: { type: "string" },
      steps: { type: "array", items: { type: "string" } },
    },
    required: ["session_id", "plan_summary"],
  },
  log_decision: {
    properties: {
      session_id: { type: "string" },
      decision_type: { type: "string" },
      description: { type: "string" },
      rationale: { type: "string" },
    },
    required: ["session_id", "decision_type"],
  },
  record_handoff: {
    properties: {
      session_id: { type: "string" },
      from_agent: { type: "string" },
      to_agent: { type: "string" },
      reason: { type: "string" },
    },
    required: ["session_id", "from_agent", "to_agent"],
  },
};

for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      })}\n`,
    );
    continue;
  }
  if (
    request === null ||
    typeof request !== "object" ||
    Array.isArray(request)
  ) {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request" },
      })}\n`,
    );
    continue;
  }
  if (
    typeof request.method === "string" &&
    request.method.startsWith("notifications/")
  )
    continue;
  if (typeof request.method !== "string") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32600, message: "Invalid request" },
      })}\n`,
    );
    continue;
  }

  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "o11y", version: "0.0.0" },
      };
      break;
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = {
        tools: Object.entries(schemas).map(([name, schema]) => ({
          name,
          description:
            "Local registration-only tool for offline telemetry capture.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            ...schema,
          },
        })),
      };
      break;
    case "tools/call":
      if (!Object.hasOwn(schemas, request.params?.name)) {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32602, message: "Unknown tool" },
          })}\n`,
        );
        continue;
      }
      if (
        schemas[request.params.name].required.some(
          (key) => typeof request.params.arguments?.[key] !== "string",
        )
      ) {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32602, message: "Missing required tool argument" },
          })}\n`,
        );
        continue;
      }
      result = {
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      };
      break;
    default:
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Method not found" },
        })}\n`,
      );
      continue;
  }
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
  );
}
