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

// Product integration only: synthetic SDK events, built stream/reporter, installed LocalCollector.
// Run after root packaging and stream build on Node >=22.12. No model, CLI, or network required.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";

const { O11yService } = await import(
  new URL("../dist/index.bundle.min.mjs", import.meta.url).href
);
const { createSpanTap, createCollectorSink, deriveRootId } = await import(
  new URL("../packages/o11y-agent-stream/dist/index.js", import.meta.url).href
);
const requireFromRepo = createRequire(
  new URL("../package.json", import.meta.url),
);
const requireFromO11y = createRequire(
  requireFromRepo.resolve("o11y/collectors"),
);
const protobuf = requireFromO11y("protobufjs");

// Shipped local-headless 266.24.0 uses extensionless relative ESM imports. Bundle its
// installed entry in memory so Node can load it without a custom loader or patched package.
const client = await build({
  entryPoints: [requireFromRepo.resolve("@o11y/local-headless")],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { LocalCollector } = await import(
  `data:text/javascript;base64,${Buffer.from(client.outputFiles[0].text).toString("base64")}`
);

test("SDK spans reach real LocalCollector with schema, correlation and a local drain", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "o11y-stream-integration-"));
  const outputPath = join(directory, "events.jsonl");
  const collectorErrors = [];
  const collector = new LocalCollector({
    filePath: outputPath,
    onError: (error) => collectorErrors.push(error),
  });
  t.after(async () => {
    collector.close();
    await rm(directory, { recursive: true, force: true });
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network egress forbidden in stream integration test");
  });
  const reporter = O11yService.getInstance("stream-integration");
  await reporter.initialize("stream-integration", "", undefined, {
    // A non-secret sentinel opts into local fallback; no Falcon endpoint is configured.
    falcon: { apiKey: "local-test-placeholder" },
    headlessCollector: collector,
  });
  assert.ok(reporter.isInitialized());
  const sessionId = "synthetic-session";
  const rootId = deriveRootId(sessionId);
  const sink = createCollectorSink({ sessionId, reporter });
  const tapErrors = [];
  let clock = 1000;
  const tap = createSpanTap(
    { sessionId, reporter },
    {
      sink,
      now: () => (clock += 100),
      onError: (error) => tapErrors.push(error),
    },
  );
  for (const message of [
    { type: "system", subtype: "init", session_id: sessionId },
    {
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }],
      },
    },
    {
      type: "user",
      session_id: sessionId,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tool-1", is_error: false },
        ],
      },
    },
    {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      duration_ms: 500,
    },
  ]) {
    await tap.onMessage(message);
  }
  const pending = sink.pending();
  assert.equal(pending.length, 2);
  assert.ok(reporter.getBatchStatus().hasData);
  await tap.close();
  assert.deepEqual(tapErrors, []);
  assert.deepEqual(collectorErrors, []);
  assert.equal(sink.pending().length, 0);
  assert.equal(reporter.getBatchStatus().hasData, false);
  collector.close();

  const records = (await readFile(outputPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((record) => record.loggerName === "stream-integration");
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.v, 1);
    assert.equal(record.schemaId, "sf.instrumentation.Activity");
    assert.equal(record.schemaName, "Activity");
    assert.equal(record.rootId, rootId);
    const built = pending.find((item) => item.data.id === record.data.id);
    assert.ok(built, `unexpected span ${record.data.id}`);
    assert.deepEqual(record.data, built.data);
    // LocalCollector stores decoded {schema, payload}; the wire encoder separately
    // turns userPayload into protobuf bytes. Verify wrapper and nested schema apart.
    for (const { schema, payload } of [
      {
        schema: built.schema,
        payload: { ...record.data, userPayload: undefined },
      },
      record.data.userPayload,
    ]) {
      const type = protobuf.Root.fromJSON(schema.pbjsSchema).lookupType(
        `${schema.namespace}.${schema.name}`,
      );
      assert.equal(type.verify(payload), null);
    }
  }
  const workflow = records.find((record) => record.data.isRoot);
  const tool = records.find((record) => record.data.id === "tool-1");
  assert.equal(workflow.data.id, `${sessionId}:workflow`);
  assert.equal(workflow.data.parentId, rootId);
  assert.equal(
    workflow.data.userPayload.schema.namespace,
    "sf.agenticTelemetry",
  );
  assert.equal(workflow.data.userPayload.schema.name, "WorkflowActivity");
  assert.equal(workflow.data.userPayload.payload.finishReason, 1);
  assert.equal(tool.data.parentId, workflow.data.id);
  assert.equal(tool.data.isRoot, false);
  assert.equal(tool.data.userPayload.schema.namespace, "sf.agenticTelemetry");
  assert.equal(tool.data.userPayload.schema.name, "ToolCallActivity");
  assert.equal(tool.data.userPayload.payload.toolName, "Read");
  assert.equal(tool.data.userPayload.payload.isSuccess, true);
  const contents = await readFile(outputPath, "utf8");
  await sink.flush();
  assert.equal(
    await readFile(outputPath, "utf8"),
    contents,
    "idle drain adds no records",
  );

  // Failed reporter flush must retain pending records rather than claim delivery.
  const failedFlush = t.mock.method(reporter, "forceFlush", async () => {
    throw new Error("intentional flush failure");
  });
  const failedSink = createCollectorSink({ sessionId, reporter });
  failedSink.emit({
    kind: "tool",
    id: "tool-2",
    name: "execute_tool",
    rootId,
    parentId: workflow.data.id,
    isRoot: false,
    startMs: 1000,
    endMs: 1100,
    payload: { toolName: "Read", isSuccess: true },
  });
  await assert.rejects(failedSink.flush(), /intentional flush failure/);
  assert.equal(failedSink.pending().length, 1);
  failedFlush.mock.restore();
  await failedSink.flush();
  assert.equal(failedSink.pending().length, 0);
  assert.equal(reporter.getBatchStatus().hasData, false);

  // LocalCollector reports sink failures through onError; it does not throw into the host.
  const writeErrors = [];
  const failedCollector = new LocalCollector({
    sink: {
      write() {
        throw new Error("intentional write failure");
      },
      close() {},
    },
    onError: (error) => writeErrors.push(error),
  });
  failedCollector.collect(pending[0].schema, pending[0].data, { rootId });
  failedCollector.close();
  assert.equal(writeErrors.length, 1);
  assert.equal(writeErrors[0].message, "intentional write failure");
  assert.deepEqual(collectorErrors, []);
  assert.equal(
    fetch.mock.callCount(),
    0,
    "reporter makes no fetch egress attempts",
  );
});
