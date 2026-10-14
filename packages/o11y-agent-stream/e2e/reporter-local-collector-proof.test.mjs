import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { inspectCollectorOutput } from "./inspect-headless-capture.mjs";

const e2eDirectory = new URL(".", import.meta.url).pathname;
const loaderPath = new URL("./local-headless-loader.mjs", import.meta.url)
  .pathname;
const proofPath = new URL(
  "./reporter-local-collector-proof.mjs",
  import.meta.url,
).pathname;
const requireFromStream = createRequire(
  new URL("../package.json", import.meta.url),
);
const schemas = await import(
  pathToFileURL(requireFromStream.resolve("o11y_schema/sf_agenticTelemetry"))
    .href
);
const fixedClientRoot = process.env.O11Y_HEADLESS_CLIENT_ROOT;
const fixedClientAvailable =
  typeof fixedClientRoot === "string" && fixedClientRoot.length > 0;

function fixedClientTest(name, fn) {
  return test(name, { skip: !fixedClientAvailable }, fn);
}

function runProof(args, input, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-loader", loaderPath, proofPath, ...args],
      {
        cwd: join(e2eDirectory, "../../.."),
        stdio: ["pipe", "pipe", "pipe"],
        env,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

fixedClientTest(
  "reporter path captures bounded spans locally with zero egress and redaction",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "o11y-reporter-local-"));
    const outputPath = join(directory, "local.jsonl");
    try {
      const result = await runProof(["--output", outputPath]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(
        result.stdout,
        /REPORTER_LOCAL_PASS records=3 egress=0 redacted=true/,
      );
      assert.equal(
        (await readFile(outputPath, "utf8")).includes("PRIVATE_"),
        false,
      );
      assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
      const records = (await readFile(outputPath, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.deepEqual(
        records.map((r) => r.data.userPayload.schema.name),
        ["ToolCallActivity", "DecisionEvent", "WorkflowActivity"],
      );
      assert.equal(records[1].data.userPayload.payload.decisionType, 1);
      assert.equal(records[2].data.userPayload.payload.finishReason, 1);
      assert.equal(records[0].data.parentId, records[2].data.id);
      assert.equal(records[1].data.parentId, records[2].data.id);
      assert.deepEqual(
        records.map((r) => r.data.userPayload.schema),
        [
          schemas.toolCallActivitySchema,
          schemas.decisionEventSchema,
          schemas.workflowActivitySchema,
        ],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("local client opt-in never falls back for invalid roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "o11y-loader-"));
  try {
    for (const root of [
      "",
      "relative/path",
      join(directory, "missing"),
      directory,
    ]) {
      const outputPath = join(directory, "must-not-exist.jsonl");
      const result = await runProof(["--output", outputPath], undefined, {
        ...process.env,
        O11Y_HEADLESS_CLIENT_ROOT: root,
      });
      assert.equal(result.code, 1);
      assert.doesNotMatch(result.stdout, /PASS/);
      await assert.rejects(stat(outputPath), { code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loader selects exports for reporter and stream without substituting published schemas", async () => {
  const script = `
    import { resolve } from ${JSON.stringify(pathToFileURL(loaderPath).href)};
    const parents = [${JSON.stringify(new URL("../../../dist/index.bundle.min.mjs", import.meta.url).href)},
      ${JSON.stringify(new URL("../dist/buildActivityData.js", import.meta.url).href)}];
    const root = process.env.O11Y_HEADLESS_CLIENT_ROOT;
    for (const parentURL of parents) {
      const calls = [];
      const next = async (specifier, context) => { calls.push({specifier, parentURL: context.parentURL}); return {url: specifier}; };
      await resolve("o11y/shared", {parentURL}, next);
      if (root && !calls[0].specifier.startsWith(new URL("file://" + root + "/").href)) throw new Error("wrong client");
      if (!root && calls[0].specifier !== "o11y/shared") throw new Error("default changed");
      calls.length = 0;
      await resolve("o11y_schema/sf_agenticTelemetry", {parentURL}, next);
      if (calls[0].specifier !== "o11y_schema/sf_agenticTelemetry" || calls[0].parentURL !== parentURL) throw new Error("schema substituted");
    }
  `;
  for (const selected of [false, true]) {
    const env = { ...process.env };
    if (!selected) delete env.O11Y_HEADLESS_CLIENT_ROOT;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, stderr);
  }
});

fixedClientTest(
  "reporter path exposes local collector write failures",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "o11y-reporter-local-"));
    try {
      const result = await runProof([
        "--output",
        join(directory, "local.jsonl"),
        "--fail-local-write",
      ]);
      assert.equal(result.code, 1);
      assert.match(
        result.stderr,
        /REPORTER_LOCAL_ERROR local_collector_failed=intentional local write failure/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

fixedClientTest("reporter path exposes flush failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "o11y-reporter-local-"));
  try {
    const result = await runProof([
      "--output",
      join(directory, "local.jsonl"),
      "--fail-reporter-flush",
    ]);
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /REPORTER_LOCAL_ERROR intentional reporter flush failure/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

fixedClientTest(
  "collector close exposes durability failures without deleting partial output",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "o11y-reporter-local-"));
    const outputPath = join(directory, "partial.jsonl");
    try {
      const result = await runProof([
        "--output",
        outputPath,
        "--fail-local-sync",
      ]);
      assert.equal(result.code, 1);
      assert.match(
        result.stderr,
        /local_collector_failed=intentional local sync failure/,
      );
      assert.doesNotMatch(result.stdout, /PASS/);
      assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
      assert.equal(
        (await readFile(outputPath, "utf8")).trim().split("\n").length,
        3,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

fixedClientTest(
  "same stdin capture reaches reporter; malformed, missing and invalid records fail before persistence",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "o11y-reporter-local-"));
    try {
      const fixture = await readFile(
        new URL("./headless-steel-thread.fixture.jsonl", import.meta.url),
        "utf8",
      );
      const success = await runProof(
        ["--stdin", "--output", join(directory, "stdin.jsonl")],
        fixture,
      );
      assert.equal(success.code, 0, success.stderr);
      for (const [name, input] of [
        ["malformed", "{broken"],
        ["enum", fixture.replace('"PLAN"', '"INVALID"')],
        [
          "missing",
          fixture
            .split("\n")
            .filter((line) => !line.includes("toolu_fixture_decision"))
            .join("\n"),
        ],
        [
          "failed-result",
          fixture.replace(
            '"subtype":"success"',
            '"subtype":"error_max_budget_usd"',
          ),
        ],
      ]) {
        const outputPath = join(directory, `${name}.jsonl`);
        const result = await runProof(
          ["--stdin", "--output", outputPath],
          input,
        );
        assert.equal(result.code, 1, name);
        assert.match(result.stderr, /CAPTURE_ERROR/);
        await assert.rejects(stat(outputPath), { code: "ENOENT" });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("existing file survives success, local-write and flush probes unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "o11y-reporter-local-"));
  const outputPath = join(directory, "existing.jsonl");
  try {
    await writeFile(outputPath, "keep-existing\n", { mode: 0o600 });
    for (const flags of [
      [],
      ["--fail-local-write"],
      ["--fail-reporter-flush"],
    ]) {
      const result = await runProof(["--output", outputPath, ...flags]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /EEXIST/);
      assert.equal(await readFile(outputPath, "utf8"), "keep-existing\n");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

fixedClientTest(
  "inspector rejects missing records, wrong PLAN, broken parents and leaked text",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "o11y-reporter-local-"));
    try {
      const originalPath = join(directory, "original.jsonl");
      const result = await runProof(["--output", originalPath]);
      assert.equal(result.code, 0, result.stderr);
      const records = (await readFile(originalPath, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      for (const [name, mutate] of [
        ["missing", (copy) => copy.pop()],
        [
          "decision",
          (copy) => {
            copy[1].data.userPayload.payload.decisionType = 2;
          },
        ],
        [
          "parent",
          (copy) => {
            copy[0].data.parentId = "wrong";
          },
        ],
        [
          "leak",
          (copy) => {
            copy[1].data.userPayload.payload.rationale = "PRIVATE_SECRET";
          },
        ],
      ]) {
        const copy = structuredClone(records);
        mutate(copy);
        const outputPath = join(directory, `${name}.jsonl`);
        await writeFile(
          outputPath,
          copy.map(JSON.stringify).join("\n") + "\n",
          { mode: 0o600 },
        );
        await assert.rejects(inspectCollectorOutput(outputPath));
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("runner preflight accepts installed client before capture validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "o11y-runner-"));
  const runner = new URL("./run-headless-demo.sh", import.meta.url).pathname;
  const fixture = new URL(
    "./headless-steel-thread.fixture.jsonl",
    import.meta.url,
  ).pathname;
  try {
    const env = { ...process.env, O11Y_TEST_FIXTURE: fixture };
    delete env.O11Y_HEADLESS_CLIENT_ROOT;
    const script = `claude() { printf 'MODEL_STUB_CALLED\\n' >&2; }; export -f claude; bash "$1" "$2"`;
    const child = spawn(
      "bash",
      ["-c", script, "proof-test", runner, join(directory, "installed.jsonl")],
      {
        env,
        cwd: join(e2eDirectory, "../../.."),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /MODEL_STUB_CALLED/);
    assert.doesNotMatch(stdout, /PASS/);
    assert.match(stderr, /CAPTURE_ERROR missing_session_id/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

fixedClientTest(
  "runner uses supported flags and exact tool allowlist with a selected fixed client",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "o11y-runner-"));
    const runner = new URL("./run-headless-demo.sh", import.meta.url).pathname;
    const fixture = new URL(
      "./headless-steel-thread.fixture.jsonl",
      import.meta.url,
    ).pathname;
    try {
      const env = {
        ...process.env,
        O11Y_TEST_FIXTURE: fixture,
        O11Y_HEADLESS_CLIENT_ROOT: fixedClientRoot,
        O11Y_HEADLESS_DEMO_BUDGET_USD: "0.07",
      };
      // Exported shell function replaces the model command, not reporter/capture code.
      const script = `claude() { node -e 'process.stderr.write("MODEL_STUB_ARGS=" + JSON.stringify(process.argv.slice(1)) + "\\n"); process.stdout.write(require("node:fs").readFileSync(process.env.O11Y_TEST_FIXTURE))' -- "$@"; }; export -f claude; bash "$1" "$2"`;
      const child = spawn(
        "bash",
        ["-c", script, "proof-test", runner, join(directory, "selected.jsonl")],
        {
          env,
          cwd: join(e2eDirectory, "../../.."),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(code, 0, stderr);
      assert.match(stdout, /REPORTER_LOCAL_PASS records=3/);
      assert.match(stdout, /source=LocalCollector/);
      const args = JSON.parse(stderr.match(/MODEL_STUB_ARGS=(.*)/)[1]);
      assert.deepEqual(args, [
        "--strict-mcp-config",
        "--mcp-config",
        "packages/o11y-agent-stream/e2e/headless-mcp-config.json",
        "--plugin-dir",
        "packages/o11y-agent-stream/e2e/proof-plugin",
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-budget-usd",
        "0.07",
        "--tools",
        "Read",
        "--allowedTools",
        "Read,mcp__o11y__log_decision",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        "/review-project-notes",
      ]);
      const runId = stdout.match(
        /Headless root seed: (headless-demo-[\w-]+)/,
      )[1];
      const { deriveRootId } = await import("../dist/index.js");
      assert.ok(
        stdout.includes(
          `root=${deriveRootId(runId, {
            SF_AGENT_HEADLESS_HOST: "1",
            SF_AGENT_ROOT_SEED: runId,
          })}`,
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("proof skill has no hook fixture and requests one Read and PLAN decision", async () => {
  const skill = new URL(
    "./proof-plugin/skills/review-project-notes/",
    import.meta.url,
  );
  const content = await readFile(new URL("SKILL.md", skill), "utf8");
  assert.doesNotMatch(content, /hooks:|hooks\/|telemetry\//);
  assert.match(content, /Use `Read` exactly once/);
  assert.match(
    content,
    /`mcp__o11y__log_decision` exactly once with decision\s+type `PLAN`/,
  );
  for (const path of [new URL("hooks/", skill), new URL("telemetry/", skill)]) {
    const entries = await readdir(path, {
      recursive: true,
      withFileTypes: true,
    }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    assert.ok(entries.every((entry) => entry.isDirectory()));
  }
  await assert.rejects(
    stat(new URL("./hook-egress-receiver.mjs", import.meta.url)),
    { code: "ENOENT" },
  );
  const runner = await readFile(
    new URL("./run-headless-demo.sh", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    runner,
    /SF_AGENT_|HOOK_EGRESS|hook-egress-receiver|receiver/,
  );
});
