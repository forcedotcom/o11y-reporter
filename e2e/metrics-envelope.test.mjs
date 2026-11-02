// Real-o11y test for the metric methods. It drives the built bundle, so run it after
// `yarn package`, against the real o11y client, collector and encoder, and decodes the exact
// CoreEnvelope bytes that would be uploaded. It needs no network and no Falcon key: a fake
// Connection stands in for the org, and its requestPost captures the base64 envelope. Each check
// uses its own extensions and starts from an empty upload window.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { O11yService } = await import(
  new URL("../dist/index.bundle.min.mjs", import.meta.url).href
);

// Decode with the protobufjs and o11y_schema that o11y itself resolves (o11y's nested
// o11y_schema can differ from the root one), so the assertions are on the real wire format.
const requireFromRepo = createRequire(
  new URL("../package.json", import.meta.url),
);
const requireFromO11y = createRequire(
  requireFromRepo.resolve("o11y/collectors"),
);
const protobuf = requireFromO11y("protobufjs");
const { coreEnvelopeSchema } = await import(
  pathToFileURL(requireFromO11y.resolve("o11y_schema/sf_instrumentation")).href
);
const CoreEnvelope = protobuf.Root.fromJSON(
  coreEnvelopeSchema.pbjsSchema,
).lookupType("sf.instrumentation.CoreEnvelope");

const APP = "o11y-reporter-extensions";
const CONNECT_PATH = "/services/data/v65.0/connect/proxy/ui-telemetry";
const BUDGET_BYTES = 131_072;
// The static route returns 413 above 2^18 body bytes. Base64 plus JSON framing leaves
// 196,596 raw envelope bytes; the 128 KiB metrics budget leaves headroom for logs.
const ROUTE_LIMIT_BYTES = 196_596;

const posts = [];
const getConnection = async () => ({
  requestPost: async (path, body) => {
    posts.push({ path, body });
    return {};
  },
});

/** An initialized service for a dedicated extension. */
const service = async (extensionName) => {
  const svc = O11yService.getInstance(extensionName);
  await svc.initialize(extensionName, "", getConnection);
  assert.ok(svc.isInitialized(), `${extensionName} is initialized`);
  return svc;
};

/** Flush the shared buffer, and return what this flush posted, or undefined. */
const flush = async (svc) => {
  const before = posts.length;
  await svc.forceFlush();
  assert.ok(posts.length - before <= 1, "a flush posts at most one envelope");
  return posts.length > before ? posts.at(-1) : undefined;
};

const rawEnvelope = (post) => Buffer.from(post.body.base64Env, "base64");
const decode = (post) =>
  CoreEnvelope.toObject(CoreEnvelope.decode(rawEnvelope(post)), {
    longs: Number,
    arrays: true,
    defaults: false,
  });

/**
 * One owner's series of one kind (upCounters, valueRecorders or bucketHistograms), without
 * timestamps. o11y's own metrics (owner "o11y") ride in every envelope, so other owners are left
 * out.
 */
const seriesOf = (post, kind, owner) =>
  ((post && decode(post).metrics?.[kind]) ?? [])
    .filter((series) => series.ownerName === owner)
    .map(
      ({
        createdTimestamp: _created,
        lastUpdatedTimestamp: _updated,
        ...rest
      }) => rest,
    );
const tagList = (tags) =>
  Object.entries(tags).map(([name, value]) => ({ name, value }));
const errorLines = (errors) =>
  errors.mock.calls.map((call) => call.arguments.join(" "));

test("each metric type reaches the uploaded envelope as recorded", async () => {
  const svc = await service("metrics-types");
  await flush(svc);
  svc.incrementCounter("calls", 2, false, { route: "a" });
  svc.incrementCounter("calls", 3, false, { route: "a" });
  svc.trackValue("latency", 12, true, { route: "a" });
  svc.bucketValue("size", 7, [1, 10, 100], false, { kind: "x" });

  const post = await flush(svc);

  assert.equal(post.path, CONNECT_PATH);
  const owner = { ownerName: "metrics-types", ownerAppName: APP };
  assert.deepEqual(seriesOf(post, "upCounters", "metrics-types"), [
    {
      ...owner,
      name: "calls",
      value: 5,
      tags: tagList({ route: "a", status: "success" }),
    },
  ]);
  // hasError arrives as the status tag.
  assert.deepEqual(seriesOf(post, "valueRecorders", "metrics-types"), [
    {
      ...owner,
      name: "latency",
      values: [12],
      tags: tagList({ route: "a", status: "error" }),
    },
  ]);
  // A histogram carries its recorded values and its bucket boundaries.
  assert.deepEqual(seriesOf(post, "bucketHistograms", "metrics-types"), [
    {
      ...owner,
      name: "size",
      values: [7],
      buckets: [1, 10, 100],
      tags: tagList({ kind: "x", status: "success" }),
    },
  ]);
});

test("an idle flush posts nothing, and a later upload carries only the new values", async () => {
  const svc = await service("metrics-deltas");
  await flush(svc);
  svc.incrementCounter("calls", 2);
  svc.trackValue("latency", 5);
  await flush(svc);

  assert.equal(await flush(svc), undefined);

  svc.incrementCounter("calls", 1);
  const post = await flush(svc);
  assert.deepEqual(
    seriesOf(post, "upCounters", "metrics-deltas").map(({ name, value }) => ({
      name,
      value,
    })),
    [{ name: "calls", value: 1 }],
  );
  assert.deepEqual(seriesOf(post, "valueRecorders", "metrics-deltas"), []);
});

test("calls that would break the encoder are dropped, so the upload and another extension's log go through", async (t) => {
  const svc = await service("metrics-poison");
  const peer = await service("metrics-peer");
  await flush(svc);
  const errors = t.mock.method(console, "error", () => {});
  svc.incrementCounter("calls");
  // Forwarded as is, either call makes the encoder throw after the drain, which loses the window.
  svc.bucketValue("poison", 5, [1.5, 10]);
  svc.incrementCounter("poison", Infinity);
  peer.logEvent({ msg: "peer log must survive" });

  const post = await flush(svc);

  assert.deepEqual(errorLines(errors), [
    '[O11yService][bucketValue] Dropped metric buckets-not-integer: bucket entries must be whole numbers (operation "poison")',
    '[O11yService][incrementCounter] Dropped metric increment-infinite: increment must be finite (operation "poison")',
  ]);
  assert.deepEqual(
    seriesOf(post, "upCounters", "metrics-poison").map(({ name, value }) => ({
      name,
      value,
    })),
    [{ name: "calls", value: 1 }],
  );
  const peerMessages = (decode(post).bundles ?? []).flatMap((bundle) =>
    (bundle.messages ?? []).filter(
      (message) => message.loggerName === "metrics-peer",
    ),
  );
  assert.equal(peerMessages.length, 1);
});

test("o11y rejects the inputs the guard leaves to it, without recording a series", async (t) => {
  // Each row ends with a fragment of o11y's own message, so a guard that threw by itself fails.
  const rows = [
    ["incrementCounter", [5], "operation argument is required"],
    ["bucketValue", ["size", 5, null], "buckets argument is required"],
    [
      "incrementCounter",
      ["calls", 1, false, null],
      "tags argument is required",
    ],
    ["incrementCounter", [""], "operation argument is required"],
    ["incrementCounter", ["a`b"], "isn't allowed to contain characters"],
    ["incrementCounter", ["o11y-error"], "The value o11y-error isn't allowed"],
    [
      "trackValue",
      ["latency", 5, false, () => "tags"],
      "tags argument is required",
    ],
  ];
  // One extension per row, because each extension rate-limits its own "threw" lines.
  const services = [];
  for (let i = 0; i < rows.length; i++) {
    services.push(await service(`metrics-threw-${i}`));
  }
  await flush(services[0]);
  const errors = t.mock.method(console, "error", () => {});

  rows.forEach(([method, args], i) => services[i][method](...args));
  const post = await flush(services[0]);

  const lines = errorLines(errors);
  assert.equal(lines.length, rows.length);
  rows.forEach(([method, , fragment], i) => {
    assert.ok(
      lines[i].startsWith(`[O11yService][${method}] Dropped metric threw: `),
      lines[i],
    );
    assert.ok(lines[i].includes(fragment), lines[i]);
    for (const kind of ["upCounters", "valueRecorders", "bucketHistograms"]) {
      assert.deepEqual(seriesOf(post, kind, `metrics-threw-${i}`), []);
    }
  });
});

test("a rejected call does not use up one of o11y's 1000 counter series per extension", async (t) => {
  const svc = await service("metrics-slots");
  await flush(svc);
  for (let i = 0; i < 999; i++) {
    svc.incrementCounter(`c${i}`);
  }
  await flush(svc);
  const errors = t.mock.method(console, "error", () => {});

  svc.incrementCounter("rejected", 0);
  svc.incrementCounter("c999");
  const post = await flush(svc);

  assert.deepEqual(errorLines(errors), [
    '[O11yService][incrementCounter] Dropped metric increment-not-positive: increment must be greater than 0 (operation "rejected")',
  ]);
  assert.deepEqual(
    seriesOf(post, "upCounters", "metrics-slots").map(({ name }) => name),
    ["c999"],
  );
});

test("a burst is cut at the metrics budget, so the upload stays within the route's size limit", async (t) => {
  const svc = await service("metrics-burst");
  await flush(svc);
  const errors = t.mock.method(console, "error", () => {});

  for (let i = 0; i < 30_000; i++) {
    svc.trackValue("burst", i);
  }
  const post = await flush(svc);

  // The first value costs 80 framing bytes (including status) plus UTF-8 operation/owner
  // names; every later value costs 8 bytes. This series has no user tags or buckets.
  const size =
    80 + Buffer.byteLength("burst") + Buffer.byteLength("metrics-burst");
  const accepted = 1 + Math.floor((BUDGET_BYTES - size) / 8);
  const [series] = seriesOf(post, "valueRecorders", "metrics-burst");
  assert.deepEqual(
    series.values,
    Array.from({ length: accepted }, (_, i) => i),
  );
  assert.ok(
    rawEnvelope(post).length <= ROUTE_LIMIT_BYTES,
    `${rawEnvelope(post).length} raw bytes`,
  );
  assert.deepEqual(errorLines(errors), [
    '[O11yService][trackValue] Dropped metric budget: the metrics budget for the current upload window (131072 bytes) is used up; record fewer values per window or flush more often (operation "burst")',
  ]);
});

test("the estimate stays within 1.0 to 1.15 times the encoded size of a metrics-only window", async (t) => {
  // Probe estimation overhead with a seeded generator, five extensions and eight
  // operations; half the calls are counters, a quarter value recorders and a quarter histograms
  // with 6 buckets, and half carry 2 tags.
  let seed = 12345;
  const random = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (list) => list[Math.floor(random() * list.length)];
  const extensions = [
    "fx-salesforcedx-vscode-core",
    "fx-salesforcedx-vscode-apex",
    "fx-salesforcedx-vscode-lwc",
    "fx-salesforcedx-vscode-soql",
    "fx-agentforce-dx-vscode",
  ];
  const operations = [
    "command.duration",
    "extension.activation",
    "apex.test.run",
    "lwc.preview.start",
    "org.open",
    "deploy.source.time",
    "retrieve.components",
    "lsp.request",
  ];
  const services = [];
  for (const extension of extensions) {
    services.push(await service(extension));
  }
  await flush(services[0]);
  const errors = t.mock.method(console, "error", () => {});
  const warnings = t.mock.method(console, "warn", () => {});

  for (let i = 0; i < 2000; i++) {
    const svc = pick(services);
    const operation = pick(operations);
    const kind = pick(["counter", "counter", "value", "histogram"]);
    const tags =
      random() < 0.5
        ? {}
        : {
            result: pick(["ok", "failed", "cancelled"]),
            lang: pick(["apex", "js", "ts"]),
          };
    const value = Math.round(random() * 5000);
    if (kind === "counter") {
      svc.incrementCounter(operation, 1, false, tags);
    } else if (kind === "value") {
      svc.trackValue(operation, value, false, tags);
    } else {
      svc.bucketValue(
        operation,
        value,
        [10, 50, 100, 500, 1000, 5000],
        false,
        tags,
      );
    }
  }
  const estimate = services[0].getBatchStatus().estimatedByteSize;
  const post = await flush(services[0]);

  // Every call was recorded as written, so the ratio is over the whole mix.
  assert.equal(errors.mock.callCount(), 0);
  assert.equal(warnings.mock.callCount(), 0);
  const ratio = estimate / rawEnvelope(post).length;
  assert.ok(
    ratio >= 1.0 && ratio <= 1.15,
    `estimate ${estimate} / ${rawEnvelope(post).length} encoded bytes = ${ratio}`,
  );
});
