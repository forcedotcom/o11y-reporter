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

import { createHash } from "node:crypto";

/**
 * root id = sha256("sf-agent-root:" + seed)[:32]. In a headless orchestrated run the
 * seed is the orchestrator's runId (SF_AGENT_ROOT_SEED), so every spawned session
 * shares one root_id. The seed is honored ONLY when SF_AGENT_HEADLESS_HOST is also
 * set, so a leaked seed cannot change a standalone session's root. Absent the
 * gate, the session id is the seed (1:1).
 * @param sessionId Session id used as the seed outside a headless host.
 * @param env Environment containing the optional headless host gate and run seed.
 * @returns Deterministic 32-character lowercase hex root id.
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
