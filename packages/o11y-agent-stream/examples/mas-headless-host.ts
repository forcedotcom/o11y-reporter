/**
 * Reference MAS headless orchestration host wiring.
 *
 * Illustrates the sequence a MAS-style orchestrator follows for every headless
 * session it spawns under one run: derive a shared `root_id` from the
 * orchestrator's `runId`, inject the two spawn-scoped env vars, register the
 * in-process no-op `o11y` server, and attach the span tap with a host-stamped
 * `rootId`/`parentId` so every session under that run joins the same trace
 * (consumed by the Task 11 validation harness, which runs this twice with the
 * same `runId` and different `sessionSeedIndex` to produce a joined run).
 *
 * This file imports `@anthropic-ai/claude-agent-sdk` directly. That is legal
 * here (an illustrative ESM example) but is NOT legal inside
 * `@salesforce/o11y-agent-stream`'s CommonJS package source (ruling R11) — the
 * package only ever receives `createSdkMcpServer`/`tool` via dependency
 * injection (see `createNoopO11yServer` / `SdkMcpDeps`), so it never takes a
 * static or type-only dependency on the ESM-only SDK.
 *
 * For the MAS ADK insertion point (where this same wiring is applied inside
 * `run-adk-claude-agent-shared.ts`, AFTER workflow-input parsing) and the
 * host-selection matrix (tapped host -> no-op `o11y`; non-tapped host -> the
 * real `o11y_mcp`), see:
 *   instrumentation-sme/docs/architecture/mas-headless-wiring.md
 */
import {
  query,
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createSpanTap,
  deriveRootId,
  createNoopO11yServer,
  type SdkMcpDeps,
} from "@salesforce/o11y-agent-stream";

export async function runHeadlessSession(
  runId: string,
  sessionSeedIndex: number,
  reporter: any,
  prompt: string,
) {
  // 1. One root_id per run, shared by every session spawned under it. The
  //    2-arg env form only honors SF_AGENT_ROOT_SEED when SF_AGENT_HEADLESS_HOST
  //    is ALSO set, so a leaked seed on a non-headless path can't desync ids.
  const rootId = deriveRootId(runId, {
    SF_AGENT_HEADLESS_HOST: "1",
    SF_AGENT_ROOT_SEED: runId,
  });

  // 2. Spawn-scoped only: this env object is passed to this one child process
  //    and never persisted or ambiently inherited beyond it.
  const env = {
    ...process.env,
    SF_AGENT_HEADLESS_HOST: "1",
    SF_AGENT_ROOT_SEED: runId,
  }; // spawn-scoped

  // 3. Register the in-process no-op `o11y` server. Binding the no-op here is
  //    correct ONLY because this host IS tapped (step 5) — see the
  //    host-selection matrix in the playbook before reusing this snippet for a
  //    non-tapped / standalone host.
  //
  //    Ruling 11 cast: SdkMcpDeps intentionally types createSdkMcpServer/tool with
  //    `unknown`-bearing signatures so the CJS package never hard-depends on the
  //    SDK's concrete types. That same looseness bites on the INPUT side too: the
  //    real (imported) createSdkMcpServer's stricter `tools: SdkMcpToolDefinition[]`
  //    parameter isn't assignable to SdkMcpDeps's deliberately loose `tools:
  //    unknown[]` slot, so the DI object needs the same "honest, localized" cast
  //    treatment as the output below. Both casts stay in this ESM example only —
  //    noopServer.ts is untouched.
  const o11y = createNoopO11yServer({
    createSdkMcpServer,
    tool,
  } as SdkMcpDeps) as ReturnType<typeof createSdkMcpServer>;

  // 4. Per-session id + tap, host-stamped with the shared rootId and a
  //    parentId pointing at the spawning orchestrator span (cross-session
  //    nesting; deferrable — see the playbook).
  const sessionId = `${runId}:${sessionSeedIndex}`;
  const tap = createSpanTap({
    sessionId,
    reporter,
    rootId,
    parentId: `${rootId}:orchestrator`,
  });

  // 5. Attach the tap to this session's message stream.
  const q = query({ prompt, options: { mcpServers: { o11y }, env } });
  for await (const msg of q) {
    await tap.onMessage(msg);
  }
  await tap.close();

  return rootId;
}
