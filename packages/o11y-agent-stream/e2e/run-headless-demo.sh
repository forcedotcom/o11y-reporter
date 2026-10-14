#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"

budget="${O11Y_HEADLESS_DEMO_BUDGET_USD:-0.10}"
output_path="${1:-/tmp/o11y-headless-demo-$(uuidgen).jsonl}"
plugin_dir="packages/o11y-agent-stream/e2e/proof-plugin"
run_id="headless-demo-$(uuidgen)"

if [[ -e "$output_path" ]]; then
  printf 'Refusing to overwrite existing output: %s\n' "$output_path" >&2
  exit 1
fi

# Fail before invoking a model if the selected client cannot validate original schemas.
node --experimental-loader ./packages/o11y-agent-stream/e2e/local-headless-loader.mjs \
  --input-type=module -e '
    import { createRequire } from "node:module";
    import { pathToFileURL } from "node:url";
    import { logValidator } from "o11y/shared";
    const require = createRequire(pathToFileURL(process.cwd() + "/packages/o11y-agent-stream/package.json"));
    const schemas = await import(pathToFileURL(require.resolve("o11y_schema/sf_agenticTelemetry")).href);
    logValidator.validate(schemas.decisionEventSchema, { decisionType: 1 });
    logValidator.validate(schemas.workflowActivitySchema, { finishReason: 1 });
  '

printf 'Starting headless Claude session (budget: $%s)\n' "$budget"
printf 'Running /review-project-notes with Read and local log_decision capture\n'
printf 'Headless root seed: %s\n' "$run_id"

claude --strict-mcp-config \
  --mcp-config packages/o11y-agent-stream/e2e/headless-mcp-config.json \
  --plugin-dir "$plugin_dir" \
  -p --output-format stream-json --verbose \
  --max-budget-usd "$budget" \
  --tools Read \
  --allowedTools Read,mcp__o11y__log_decision \
  --permission-mode dontAsk \
  --no-session-persistence \
  '/review-project-notes' \
  | node --experimental-loader ./packages/o11y-agent-stream/e2e/local-headless-loader.mjs \
      packages/o11y-agent-stream/e2e/reporter-local-collector-proof.mjs \
      --stdin --run-id "$run_id" --output "$output_path"

node packages/o11y-agent-stream/e2e/inspect-headless-capture.mjs "$output_path"
