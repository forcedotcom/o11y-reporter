#!/usr/bin/env node
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { captureJsonl } from "./headless-steel-thread.mjs";
import { inspectCollectorOutput } from "./inspect-headless-capture.mjs";

/**
 * Deliver the same bounded capture through the reporter and real LocalCollector.
 * @param {string} input Raw CLI JSONL, memory-only.
 * @param {{outputPath: string, runId?: string, failLocalWrite?: boolean, failLocalSync?: boolean, failReporterFlush?: boolean}} options Local destination and failure probes.
 * @returns {Promise<object>} Capture identity after validated, durable local delivery.
 * @throws {Error} On capture, schema validation, delivery, flush, egress or persistence failure. Existing files are never changed.
 */
export async function deliverLocalCapture(
  input,
  {
    outputPath,
    runId,
    failLocalWrite = false,
    failLocalSync = false,
    failReporterFlush = false,
  },
) {
  const agent = await import(new URL("../dist/index.js", import.meta.url).href);
  const capture = await captureJsonl(input, {
    outputPath,
    modules: agent,
    runId,
    persist: false,
  });
  // Persist only the bounded workflow/Read/PLAN contract, not arbitrary stream content.
  if (
    capture.records.length !== 3 ||
    capture.kinds.workflow !== 1 ||
    capture.kinds.tool !== 1 ||
    capture.kinds.decision !== 1 ||
    capture.pairedToolResults !== 2 ||
    capture.pairedO11yResults !== 1
  ) {
    throw new Error("unexpected_capture_records");
  }
  const workflow = capture.records.find((record) => record.kind === "workflow");
  const tool = capture.records.find((record) => record.kind === "tool");
  const decision = capture.records.find((record) => record.kind === "decision");
  if (
    workflow.payload.finishReason !== 1 ||
    tool.payload.toolName !== "Read" ||
    tool.payload.isSuccess !== true ||
    decision.payload.decisionType !== 1 ||
    tool.parentId !== workflow.id ||
    decision.parentId !== workflow.id
  ) {
    throw new Error("unexpected_capture_payload");
  }
  const originalFetch = globalThis.fetch;
  let egressAttempts = 0;
  let fd;
  let collector;
  const localErrors = [];
  globalThis.fetch = async () => {
    egressAttempts += 1;
    throw new Error("network egress forbidden in local proof");
  };
  try {
    const [{ O11yService }, { LocalCollector }] = await Promise.all([
      import(
        new URL("../../../dist/index.bundle.min.mjs", import.meta.url).href
      ),
      import("@o11y/local-headless"),
    ]);
    fd = openSync(outputPath, "wx", 0o600);
    collector = new LocalCollector({
      sink: {
        write(line) {
          if (failLocalWrite)
            throw new Error("intentional local write failure");
          const bytes = Buffer.from(`${line}\n`);
          let offset = 0;
          while (offset < bytes.length) {
            const count = writeSync(fd, bytes, offset, bytes.length - offset);
            if (count === 0) throw new Error("local write made no progress");
            offset += count;
          }
        },
        close() {
          if (failLocalSync) throw new Error("intentional local sync failure");
          fsyncSync(fd);
        },
      },
      onError: (error) => localErrors.push(error),
    });
    const service = O11yService.getInstance("headless-local-proof");
    const sessionHash = createHash("sha256")
      .update(capture.sessionId)
      .digest("hex")
      .slice(0, 24);
    await service.initialize(`headless-local-${sessionHash}`, "", undefined, {
      appName: "headless-local-proof",
      falcon: { apiKey: "local-only-proof-key" },
      headlessCollector: collector,
    });
    if (!service.isInitialized())
      throw new Error("reporter_initialization_failed");
    if (failReporterFlush) {
      service.forceFlush = async () => {
        throw new Error("intentional reporter flush failure");
      };
    }
    const sink = agent.createCollectorSink({
      sessionId: capture.sessionId,
      reporter: service,
    });
    for (const record of capture.records) {
      const payload = { ...record.payload };
      delete payload.redacted;
      sink.emit({ ...record, payload });
    }
    await sink.flush();
    collector.close();
    if (localErrors.length)
      throw new Error(`local_collector_failed=${localErrors[0].message}`);
    if (egressAttempts !== 0)
      throw new Error(`unexpected_network_egress=${egressAttempts}`);
    await inspectCollectorOutput(outputPath);
    return capture;
  } finally {
    // Keep failed partial output for inspection. Never unlink a path that may belong to someone else.
    try {
      if (fd !== undefined) closeSync(fd);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
}

/**
 * Run deterministic fixture proof, or consume the live runner's stdin with --stdin.
 * @param {string[]} args CLI arguments.
 * @returns {Promise<void>} Writes a delivery summary; rejects visibly on failure.
 */
export async function runReporterLocalCollectorProof(args) {
  const outputPath = args[args.indexOf("--output") + 1];
  const runId = args.includes("--run-id")
    ? args[args.indexOf("--run-id") + 1]
    : undefined;
  if (!args.includes("--output") || !outputPath)
    throw new Error("missing --output");
  let input = "";
  if (args.includes("--stdin")) {
    const decoder = new TextDecoder();
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 5 * 1024 * 1024) throw new Error("input_limit_exceeded");
      input += decoder.decode(chunk, { stream: true });
    }
    input += decoder.decode();
  } else {
    input = await readFile(
      new URL("./headless-steel-thread.fixture.jsonl", import.meta.url),
      "utf8",
    );
  }
  const capture = await deliverLocalCapture(input, {
    outputPath,
    runId,
    failLocalWrite: args.includes("--fail-local-write"),
    failLocalSync: args.includes("--fail-local-sync"),
    failReporterFlush: args.includes("--fail-reporter-flush"),
  });
  const sessionHash = createHash("sha256")
    .update(capture.sessionId)
    .digest("hex")
    .slice(0, 24);
  process.stdout.write(
    `REPORTER_LOCAL_PASS records=3 egress=0 redacted=true session=${sessionHash} root=${capture.rootId} file=${outputPath}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runReporterLocalCollectorProof(process.argv.slice(2)).catch((error) => {
    for (const item of [
      ...(error.parseErrors ?? []),
      ...(error.captureErrors ?? []),
    ]) {
      process.stderr.write(`CAPTURE_ERROR ${item.code}\n`);
    }
    process.stderr.write(
      `REPORTER_LOCAL_ERROR ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
