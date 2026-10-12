import { createHash } from "node:crypto";

/**
 * root id = sha256("sf-agent-root:" + seed)[:32]. Byte-identical to bash
 * `_sf_root_id` and Python `derive_root_id`. In a headless orchestrated run the
 * seed is the orchestrator's runId (SF_AGENT_ROOT_SEED), so every spawned session
 * shares one root_id. The seed is honored ONLY when SF_AGENT_HEADLESS_HOST is also
 * set — a leaked seed in a standalone session must not desync bash (which would use
 * the seed) from the Python server (which never overrides). Absent the gate, the
 * session id is the seed, exactly as before (1:1).
 */
export function deriveRootId(
  sessionId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const seed =
    env.SF_AGENT_HEADLESS_HOST && env.SF_AGENT_ROOT_SEED
      ? env.SF_AGENT_ROOT_SEED
      : sessionId;
  return createHash("sha256")
    .update(`sf-agent-root:${seed}`)
    .digest("hex")
    .slice(0, 32);
}
