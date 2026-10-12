import { deriveRootId } from "../rootId";

describe("deriveRootId", () => {
  // Golden vectors verified byte-identical against bash `_sf_root_id` (ingest.sh)
  // and Python `derive_root_id` on 2026-09-08. Do NOT edit without re-deriving.
  it.each([
    ["test-session-1", "e8503a23416810990d9cc26ebaf01367"],
    ["abc123", "d33d2a546f4326b51ea45a7d7fd77812"],
    [
      "550e8400-e29b-41d4-a716-446655440000",
      "64f71167a3fa97883c5f751c18f24bc5",
    ],
    ["", "c66954dcfe55e3701f6c54da25d27a90"],
  ])("derives the shared root id for %p", (sessionId, expected) => {
    expect(deriveRootId(sessionId)).toBe(expected);
  });

  it("returns 32 lowercase hex characters", () => {
    expect(deriveRootId("anything")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("prefers SF_AGENT_ROOT_SEED only when SF_AGENT_HEADLESS_HOST is set", () => {
    // seed present, headless set → hashes the seed (== deriveRootId('run-1'))
    expect(
      deriveRootId("sess-x", {
        SF_AGENT_HEADLESS_HOST: "1",
        SF_AGENT_ROOT_SEED: "run-1",
      }),
    ).toBe(deriveRootId("run-1", {}));
    // seed present, headless UNSET → ignores the seed (safety: no standalone desync)
    expect(deriveRootId("sess-x", { SF_AGENT_ROOT_SEED: "run-1" })).toBe(
      deriveRootId("sess-x", {}),
    );
  });
});
