# Headless Telemetry Integration Tests

This directory contains development test code for running and debugging the local
headless telemetry pipeline. It includes deterministic integration tests and an
opt-in live Claude runner. It is not the production host implementation or a
telemetry output directory, and it is not included in the published package.

**Status:** Earlier live three-record collector delivery and loopback hook suppression
were verified on 2026-10-12. That evidence predates this hook-free runner and does
not verify it. Hook integration is deferred; the revised live runner has not been run.
Installed client remains blocked; full success coverage requires a fixed client.

## Purpose And Ownership

These tests belong in `o11y-reporter`: they verify the integration between its
`o11y-agent-stream` package, reporter service, and local collector. `e2e` describes
the local pipeline boundary, not remote delivery to Falcon or Splunk.

| Concern                                        | Source and test owner                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| Stream parsing and record mapping              | `o11y-reporter/packages/o11y-agent-stream/src/` and `src/__tests__/`    |
| Stream-to-reporter-to-collector integration    | This directory                                                          |
| Reporter routing and flush behavior            | `o11y-reporter/src/` and `src/test/`                                    |
| Schema validation and enum handling            | `o11y-client/packages/o11y/`                                            |
| LocalCollector implementation                  | `o11y-client/packages/o11y-local/`, published as `@o11y/local-headless` |
| Hook installation, suppression, and generation | Hooks kit / `o11y-agent-instrumenter`; integration here is deferred     |

The initial harness is hook-free: its skill has no hook frontmatter, hook files,
or hook telemetry instructions. Structural spans come from the shared stream
parser; the skill explicitly calls `log_decision` with the parser-supported short
enum `PLAN`. Hook consumption and full instrumenter onboarding require separate
integration coverage and upstream hook tests. Runtime behavior belongs in
`src/`; test helpers here are not a production host or hooks implementation.

## Files And Entry Points

Run commands below from the repository root with Node `>=22.12.0` and built packages.

| File                                           | Purpose                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `*.test.mjs`                                   | Deterministic local integration and failure-path tests; no model invocation                      |
| `headless-steel-thread.mjs`                    | Stream validation and redacted capture baseline; standalone output is `SpanRecord` JSONL         |
| `reporter-local-collector-proof.mjs`           | Actual reporter/LocalCollector test harness; fixture input by default, live input with `--stdin` |
| `run-headless-demo.sh`                         | Opt-in live integration test using Claude; model network access and spend required               |
| `inspect-headless-capture.mjs`                 | Checks LocalCollector Activity output, despite the historical capture name                       |
| `proof-plugin/` and `headless-mcp-config.json` | Controlled hook-free skill and registration-only local MCP configuration                         |
| `local-headless-loader.mjs`                    | Temporary dependency compatibility and explicit fixed-client selection                           |

Names containing `demo`, `proof`, and `steel-thread` are historical test-harness
names, not separate product components. Keep the live runner separate from default
tests: it invokes a model and must never run implicitly in CI.

Root `test:headless-integration` explicitly runs the two Node `.mjs` test files;
root/workspace Jest commands do not discover them. PR validation runs deterministic
integration tests after builds and Jest tests in the Node 22 `validate-agent-stream`
lane. The root Node 20 lane remains unchanged. CI never invokes the live runner.

## Pipeline Under Test

The bounded runner is wired to send the same live Claude `stream-json` through shared
`createSpanTap`/`CaptureSink`, in-memory safe projection, `createCollectorSink`,
`O11yService`, and `@o11y/local-headless` `LocalCollector`. Output contains three
actual collector `sf.instrumentation.Activity` envelopes: successful `Read`,
`DecisionEvent` with `decisionType=1` (`PLAN`), and completed `WorkflowActivity`.
The inspector reads these envelopes, not a separate fixture or capture file.

## Build

With repository dependencies already installed, build using local tools:

```sh
./node_modules/.bin/tsc --build tsconfig.json
node scripts/bundle-build.js
./node_modules/.bin/tsc --build packages/o11y-agent-stream/tsconfig.json
```

Installed `o11y@266.18.0` rejects correct numeric enum payloads: its validator lacks
enum handling and message-local type resolution. Existing `buildActivityData` passes
original published schema objects unchanged. No validator injection option exists;
prevalidating in the reporter cannot avoid the client's unconditional validation.
Do not rewrite enum types, monkey-patch the singleton, or bypass validation.
Upstream fixed local build supplies scoped enum resolution and integer membership
validation. Select its package directory explicitly with `O11Y_HEADLESS_CLIENT_ROOT`.
The proof loader maps only `o11y` / `o11y/*` using that package's exports, including
external imports from the prebuilt reporter bundle and built shared stream. It does
not remap `o11y_schema`, mutate descriptors, patch validators or change manifests.
Without this variable, normal installed-package resolution remains unchanged.
Invalid roots, missing exports and missing build files fail without fallback.

Installed `@o11y/local-headless@266.18.0` also has extensionless relative ESM
imports. The narrow loader adds `.js` only inside that package.

## Live Run

Run only with explicit model-network authorization and a fixed client selected.
The runner checks original workflow/decision validation before invoking Claude.
Default budget `$0.10`;
override with `O11Y_HEADLESS_DEMO_BUDGET_USD`. Output path must not exist.

```sh
O11Y_HEADLESS_CLIENT_ROOT=/absolute/path/to/o11y-client/packages/o11y \
  packages/o11y-agent-stream/e2e/run-headless-demo.sh /tmp/o11y-live-collector-UNIQUE.jsonl
node packages/o11y-agent-stream/e2e/inspect-headless-capture.mjs /tmp/o11y-live-collector-UNIQUE.jsonl
```

The existing `/review-project-notes` skill reads synthetic Sample Project Notes
once, then calls only `mcp__o11y__log_decision` with `PLAN`. Strict MCP config
registers only the local no-op server; tool acknowledgement alone is not delivery.
The runner pipes that live stream into `reporter-local-collector-proof.mjs --stdin`.
Without `--stdin`, that script runs the deterministic fixture, not a live model.

The runner uses `--permission-mode dontAsk`, permits only `Read` and
`mcp__o11y__log_decision`, and passes one generated run ID to the capture pipeline.
It does not install, suppress, or inspect hooks, configure a hook endpoint, or claim
hook-egress evidence. Ambient Claude hooks are outside this harness's coverage.
Reporter delivery separately traps `fetch`; its zero-egress check does not cover
the model subprocess or ambient hooks.

Expected summaries with the explicitly selected fixed client:

```text
REPORTER_LOCAL_PASS records=3 egress=0 redacted=true session=<hash> root=<root-id> file=<path>
DEMO_PASS file=<path> mode=0600 bytes=<nonzero> root=<root-id> records=workflow,Read,PLAN source=LocalCollector
```

Raw stream stays memory-only, bounded to 5 MiB. Shared capture validates successful
CLI result, session identity, exact tool allowlists, tool/result pairs and semantic
emission before delivery. The local proof additionally requires exactly one
workflow, successful Read and PLAN decision with matching parent IDs.

Persistence uses an injected LocalCollector sink, exclusive `wx`, mode `0600`,
short-write handling and `fsync` after reporter flush. Existing files are never
overwritten, appended or deleted. Failed partial new files remain for inspection;
nonzero exit and missing PASS mark failure. Payload allowlists exclude prompt,
tool input/result and decision description/rationale. Span IDs are hashed; common
root and hashed session identity (`loggerName=headless-local-<session-hash>`)
remain inspectable. No raw stream file or additional success fixture is written.

Reporter is initialized with no endpoint or connection, injected LocalCollector,
and a non-secret local-only Falcon opt-in key to select its existing headless route.
`fetch` is trapped during reporter delivery; any attempt fails the proof. Local
collector errors, enum validation errors and explicit headless flush/drain errors
are visible. This trap does not isolate the Claude subprocess or its global hooks.

## Deterministic Checks

No live model, credentials, fixed-client checkout, or remote telemetry needed for the
default check. Reporter/`LocalCollector` success cases are skipped unless
`O11Y_HEADLESS_CLIENT_ROOT` selects a built fixed client; the installed-client
preflight failure remains covered on every run.

```sh
yarn test:headless-integration
./node_modules/.bin/jest --runInBand --config packages/o11y-agent-stream/jest.config.js
./node_modules/.bin/jest --runInBand --config jest.config.js src/test/o11yService.test.ts
```

Run complete reporter-success coverage with an explicitly selected built fixed
client. Merging `o11y-client#1079` alone does not update this checkout's dependency;
normal installed-client coverage needs a released fixed version and dependency update:

```sh
O11Y_HEADLESS_CLIENT_ROOT=/absolute/path/to/o11y-client/packages/o11y \
  yarn test:headless-integration
```

Installed `o11y@266.18.0` exits nonzero with `Expected type DecisionType but received
type number`, without PASS. The loader contains no machine-specific path.

`headless-steel-thread.mjs` remains the safe capture baseline; its standalone CLI
still writes four-line `SpanRecord` JSONL. The current demo runner no longer uses
that persistence path. Its tests exercise shared capture validation independently.

## Gaps

Deterministic tests do not substitute for a live run. Earlier capped live runs
verified collector delivery and zero loopback hook POSTs in the earlier experiment;
that evidence predates this hook-free runner. Rerun it only with explicit live
authorization before claiming live verification. Hook integration is deferred.
No UI, Splunk, remote receiver,
full four-tool coverage or production readiness claimed.
Capture buffers/replays messages, so tool timestamps do not prove live durations.
