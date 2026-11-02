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

// Unit tests for the metric methods (incrementCounter, trackValue, bucketValue) and their guard.
// o11y is faked: each extension gets its own memoized instrumentation whose metric methods are
// jest.fn(), and the shared SimpleCollector is a plain object the tests control. The real o11y
// behavior is pinned by e2e/metrics-envelope.test.mjs.
import { O11yService } from "../../src/o11yService";
import type { InitializeOptions } from "../../src/o11yService";
import { loadO11yModules } from "../../src/utils/o11yLoader";

jest.mock("../../src/utils/o11yLoader", () => ({
  loadO11yModules: jest.fn(),
}));

type Method = "incrementCounter" | "trackValue" | "bucketValue";

interface FakeInstrumentation {
  log: jest.Mock;
  incrementCounter: jest.Mock;
  trackValue: jest.Mock;
  bucketValue: jest.Mock;
}

// One fake instrumentation per extensionName, like o11y's memoized getInstrumentation.
let instrumentations: Map<string, FakeInstrumentation>;
// The shared SimpleCollector the service registers and drains.
let collector: {
  hasData: boolean;
  estimatedByteSize: number;
  getRawContentsOfCoreEnvelope: jest.Mock;
};
let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

const buildModules = () => ({
  o11yClientVersion: "1.0.0",
  o11ySchemaVersion: "1.0.0",
  a4d_instrumentation: { name: "sf_a4dInstrumentation" },
  getInstrumentation: jest.fn((name: string) => {
    let instrumentation = instrumentations.get(name);
    if (!instrumentation) {
      instrumentation = {
        log: jest.fn(),
        incrementCounter: jest.fn(),
        trackValue: jest.fn(),
        bucketValue: jest.fn(),
      };
      instrumentations.set(name, instrumentation);
    }
    return instrumentation;
  }),
  registerInstrumentedApp: jest.fn(() => ({
    registerLogCollector: jest.fn(),
    registerMetricsCollector: jest.fn(),
  })),
  ConsoleCollector: jest.fn(),
  simpleCollectorModule: {
    default: { SimpleCollector: jest.fn(() => collector) },
  },
  collectorsModule: {
    default: {
      encodeCoreEnvelopeContentsRaw: jest.fn(() => new Uint8Array([1, 2, 3])),
    },
  },
});

/** getInstance(id) + initialize(name, ...). `id` defaults to the extension name. */
const init = async (
  name: string,
  {
    id = name,
    getConnection,
    options,
  }: {
    id?: string;
    getConnection?: () => Promise<any>;
    options?: InitializeOptions;
  } = {},
): Promise<O11yService> => {
  const service = O11yService.getInstance(id);
  await service.initialize(
    name,
    "http://static.example.invalid",
    getConnection,
    options,
  );
  return service;
};

/** A fake org Connection whose requestPost accepts every upload. */
const coreConnection = () => {
  const requestPost = jest.fn().mockResolvedValue({});
  const getConnection = jest.fn().mockResolvedValue({ requestPost });
  return { getConnection, requestPost };
};

/** The fake instrumentation that initialize() bound for an extension. */
const o11y = (extensionName: string): FakeInstrumentation =>
  instrumentations.get(extensionName)!;

/** Call a metric method with arguments its types may not allow. */
const record = (service: O11yService, method: Method, args: unknown[]) => {
  (service as any)[method](...args);
};

// Copies of the hint text, so a changed hint fails here first.
const DROP_HINTS: Record<string, string> = {
  "not-initialized":
    "Service not fully initialized; await initialize() before recording metrics",
  "operation-surrogate": "operation must not contain a lone UTF-16 surrogate",
  "increment-not-positive": "increment must be greater than 0",
  "increment-infinite": "increment must be finite",
  "increment-too-small":
    "increment must be at least 0.5, because o11y rounds it to a whole number",
  "increment-too-large": "increment must round to at most 2147483647",
  "value-out-of-range": "value must be finite and less than 2^63 in magnitude",
  "buckets-missing": "buckets are required",
  "buckets-count": "buckets must have 1 to 20 entries",
  "buckets-hole": "buckets must not have holes",
  "buckets-not-integer": "bucket entries must be whole numbers",
  "buckets-out-of-range": "bucket entries must be from 0 to 2147483647",
  "buckets-duplicate": "bucket entries must be unique",
  "tags-too-many": "at most 19 tags are allowed, not counting status",
  "tag-surrogate":
    "tag keys and string values must not contain a lone UTF-16 surrogate",
  "tag-infinite": "tag values must not be Infinity or -Infinity",
  "tag-o11yapp": "the tag key o11yApp is reserved",
  "counter-overflow":
    "this counter's total in the current upload window would exceed 2147483647; flush more often or use a smaller increment",
  budget:
    "the metrics budget for the current upload window (131072 bytes) is used up; record fewer values per window or flush more often",
};

const CAVEAT_HINTS: Record<string, string> = {
  "increment-fraction": "increment is rounded to a whole number",
  "value-fraction":
    "the server truncates this value to 0; use integer units such as ms or bytes",
  "value-negative":
    "the server's histogram maximum starts at 0, so negative values may be misreported",
  "buckets-changed":
    "this series keeps the buckets from its first call; use a new operation name to change them",
  "tags-map-or-set":
    "a Map or Set has no own enumerable keys, so no tags are recorded; pass a plain object",
  "tag-status":
    "the status tag is replaced with success or error from hasError",
  "tag-monc-identifier": "the server overwrites the monc_identifier tag",
  headless: "headless mode discards metrics",
};

// The expected console lines. `shownOperation` is the operation as the line shows it: a JSON
// string such as '"calls"', or "of type number" for a non-string.
const dropped = (method: Method, code: string, shownOperation: string) =>
  `[O11yService][${method}] Dropped metric ${code}: ${DROP_HINTS[code]} (operation ${shownOperation})`;
const caveat = (method: Method, code: string, shownOperation: string) =>
  `[O11yService][${method}] Recorded metric with caveat ${code}: ${CAVEAT_HINTS[code]} (operation ${shownOperation})`;
const threw = (method: Method, message: string, shownOperation: string) =>
  `[O11yService][${method}] Dropped metric threw: ${message} (operation ${shownOperation})`;

beforeEach(() => {
  // Every test starts from a fresh process: no instances, no shared app, no metrics state.
  const statics = O11yService as any;
  statics.instances = new Map();
  statics.sharedInstrApp = null;
  statics.sharedO11yModules = null;
  statics.sharedAppName = null;
  statics.sharedResourcesInitPromise = null;
  statics.sharedProtoEncoderFunc = null;
  statics.sharedUploadOwner = null;
  statics.metricsWindowBytes = 0;
  statics.metricsState = new Map();
  instrumentations = new Map();
  collector = {
    hasData: true,
    estimatedByteSize: 0,
    getRawContentsOfCoreEnvelope: jest.fn(() => ({})),
  };
  (loadO11yModules as jest.Mock).mockReset().mockResolvedValue(buildModules());
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("metric delegation and reporting", () => {
  test("forwards each call to its own extension's instrumentation, passing every argument position", async () => {
    const a = await init("ext-a");
    const b = await init("ext-b");

    a.incrementCounter("calls");
    b.trackValue("latency", 12, false, { route: "home" });
    b.bucketValue("size", 7, [1, 10, 100], true, { kind: "x" });

    expect(o11y("ext-a").incrementCounter.mock.calls).toStrictEqual([
      ["calls", undefined, undefined, undefined],
    ]);
    expect(o11y("ext-b").trackValue.mock.calls).toStrictEqual([
      ["latency", 12, false, { route: "home" }],
    ]);
    expect(o11y("ext-b").bucketValue.mock.calls).toStrictEqual([
      ["size", 7, [1, 10, 100], true, { kind: "x" }],
    ]);
    expect(o11y("ext-a").trackValue).not.toHaveBeenCalled();
    expect(o11y("ext-b").incrementCounter).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("drops a call made before initialize() and logs the status line with it", () => {
    const service = O11yService.getInstance("never-initialized");

    service.trackValue("latency", 5);

    expect(errorSpy.mock.calls).toStrictEqual([
      [
        '[O11yService][trackValue] Dropped metric not-initialized: Service not fully initialized; await initialize() before recording metrics (operation "latency")',
      ],
      [
        "Initialization status:",
        {
          sharedProtoEncoderFunc: false,
          sharedInstrApp: false,
          sharedO11yModules: false,
          instrumentation: false,
        },
      ],
    ]);
  });

  test("logs a repeated reject once per 60 seconds per method and code, then counts what it suppressed", () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    const service = O11yService.getInstance("never-initialized");
    const status = [
      "Initialization status:",
      {
        sharedProtoEncoderFunc: false,
        sharedInstrApp: false,
        sharedO11yModules: false,
        instrumentation: false,
      },
    ];

    service.trackValue("latency", 1);
    now.mockReturnValue(1_059_999);
    service.trackValue("latency", 2);
    service.trackValue("latency", 3);
    service.trackValue("latency", 4);
    // Another method is another key, so it is logged.
    service.incrementCounter("calls");
    now.mockReturnValue(1_060_000);
    service.trackValue("latency", 5);
    now.mockReturnValue(1_120_000);
    service.trackValue("latency", 6); // nothing suppressed since the last report
    now.mockReturnValue(1_179_999); // 60 s count from the last logged line, not the first
    service.trackValue("latency", 7);
    now.mockReturnValue(1_180_000);
    service.trackValue("latency", 8); // one suppressed since the last report

    expect(errorSpy.mock.calls).toStrictEqual([
      [dropped("trackValue", "not-initialized", '"latency"')],
      status,
      [dropped("incrementCounter", "not-initialized", '"calls"')],
      status,
      [
        `${dropped("trackValue", "not-initialized", '"latency"')}; 3 more since the last report`,
      ],
      status,
      [dropped("trackValue", "not-initialized", '"latency"')],
      status,
      [
        `${dropped("trackValue", "not-initialized", '"latency"')}; 1 more since the last report`,
      ],
      status,
    ]);
  });

  test("logs again when the clock moves back, instead of waiting for it to catch up", () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    const service = O11yService.getInstance("never-initialized");
    const status = [
      "Initialization status:",
      {
        sharedProtoEncoderFunc: false,
        sharedInstrApp: false,
        sharedO11yModules: false,
        instrumentation: false,
      },
    ];

    service.trackValue("latency", 1);
    now.mockReturnValue(940_000); // the clock stepped back a minute
    service.trackValue("latency", 2);
    service.trackValue("latency", 3); // 60 s count from the line just logged

    expect(errorSpy.mock.calls).toStrictEqual([
      [dropped("trackValue", "not-initialized", '"latency"')],
      status,
      [dropped("trackValue", "not-initialized", '"latency"')],
      status,
    ]);
  });

  test("instances without an extensionName share one rate limit", () => {
    O11yService.getInstance("first").incrementCounter("calls");
    O11yService.getInstance("second").incrementCounter("calls");

    // One drop line and one status line; the second instance's call was suppressed.
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  test("keeps a separate rate limit per extension", async () => {
    const a = await init("ext-a");
    const b = await init("ext-b");
    const reject = () => {
      throw new Error("o11y rejected the input");
    };
    o11y("ext-a").trackValue.mockImplementation(reject);
    o11y("ext-b").trackValue.mockImplementation(reject);

    a.trackValue("latency", 5);
    b.trackValue("latency", 5);
    a.trackValue("latency", 5);

    expect(errorSpy.mock.calls).toStrictEqual([
      [threw("trackValue", "o11y rejected the input", '"latency"')],
      [threw("trackValue", "o11y rejected the input", '"latency"')],
    ]);
  });

  test("reports an o11y throw as threw, with the message cut to 200 characters", async () => {
    const service = await init("ext-a");
    o11y("ext-a").trackValue.mockImplementationOnce(() => {
      throw new Error("x".repeat(250));
    });

    expect(() => service.trackValue("latency", 5)).not.toThrow();

    expect(errorSpy.mock.calls).toStrictEqual([
      [threw("trackValue", "x".repeat(200), '"latency"')],
    ]);
  });

  test("reports an instrumentation without metric methods as threw", async () => {
    const service = await init("ext-a");
    service.instrumentation = { log: jest.fn() } as any;

    expect(() => service.bucketValue("size", 5, [1, 10])).not.toThrow();

    expect(errorSpy.mock.calls).toStrictEqual([
      [
        expect.stringMatching(
          /^\[O11yService\]\[bucketValue\] Dropped metric threw: .*is not a function \(operation "size"\)$/,
        ),
      ],
    ]);
  });

  test.each([
    [
      "a Proxy whose getPrototypeOf trap throws",
      () =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("trap");
            },
          },
        ),
      "unreadable error",
    ],
    [
      "an Error whose message getter throws",
      () => {
        const error = new Error("hidden");
        Object.defineProperty(error, "message", {
          get() {
            throw new Error("getter");
          },
        });
        return error;
      },
      "unreadable error",
    ],
    ["a string", () => "plain string", "string"],
    [
      "an Error whose message is not a string",
      () => {
        const error = new Error();
        (error as any).message = 42;
        return error;
      },
      "object",
    ],
  ])(
    "never throws when the tags throw %s",
    async (_label, makeThrown, shownMessage) => {
      const service = await init("ext-a");
      const tags = {
        get route(): string {
          throw makeThrown();
        },
      };

      expect(() =>
        service.incrementCounter("calls", 1, false, tags),
      ).not.toThrow();

      expect(o11y("ext-a").incrementCounter).not.toHaveBeenCalled();
      expect(errorSpy.mock.calls).toStrictEqual([
        [threw("incrementCounter", shownMessage, '"calls"')],
      ]);
    },
  );

  test("reads the tags once and forwards a copy, so a later change does not reach o11y", async () => {
    const service = await init("ext-a");
    let reads = 0;
    const tags = {
      get route() {
        reads++;
        return "home";
      },
    };
    const mutable = { route: "home" };

    service.trackValue("latency", 5, false, tags);
    service.incrementCounter("calls", 1, false, mutable);
    mutable.route = "away";

    expect(reads).toBe(1);
    const forwarded = o11y("ext-a").trackValue.mock.calls[0][3];
    expect(forwarded).not.toBe(tags);
    expect(forwarded).toStrictEqual({ route: "home" });
    expect(o11y("ext-a").incrementCounter.mock.calls[0][3]).toStrictEqual({
      route: "home",
    });
  });
});

/** An array with a hole at index 1, like `[first, , last]`. */
const withHole = (first: number, last: number): number[] => {
  const buckets: number[] = [];
  buckets[0] = first;
  buckets[2] = last;
  return buckets;
};

describe("metric argument checks", () => {
  test.each<[string, Method, unknown[]]>([
    ["operation-surrogate", "incrementCounter", ["calls\ud800"]],
    ["operation-surrogate", "trackValue", ["\udc00latency", 5]],
    ["operation-surrogate", "bucketValue", ["size\ud83d", 5, [1]]],
    ["increment-not-positive", "incrementCounter", ["calls", 0]],
    ["increment-not-positive", "incrementCounter", ["calls", -0]],
    ["increment-not-positive", "incrementCounter", ["calls", -1]],
    ["increment-not-positive", "incrementCounter", ["calls", NaN]],
    ["increment-not-positive", "incrementCounter", ["calls", -Infinity]],
    ["increment-infinite", "incrementCounter", ["calls", Infinity]],
    ["increment-too-small", "incrementCounter", ["calls", 0.49]],
    ["increment-too-small", "incrementCounter", ["calls", Number.MIN_VALUE]],
    ["increment-too-large", "incrementCounter", ["calls", 2147483647.5]],
    ["increment-too-large", "incrementCounter", ["calls", 2 ** 31]],
    ["increment-too-large", "incrementCounter", ["calls", Number.MAX_VALUE]],
    ["value-out-of-range", "trackValue", ["latency", NaN]],
    ["value-out-of-range", "trackValue", ["latency", Infinity]],
    ["value-out-of-range", "trackValue", ["latency", -Infinity]],
    ["value-out-of-range", "trackValue", ["latency", 2 ** 63]],
    ["value-out-of-range", "trackValue", ["latency", -(2 ** 63)]],
    ["value-out-of-range", "bucketValue", ["size", NaN, [1]]],
    ["value-out-of-range", "bucketValue", ["size", 2 ** 63, [1]]],
    ["buckets-missing", "bucketValue", ["size", 5, undefined]],
    ["buckets-missing", "bucketValue", ["size", 5]],
    ["buckets-count", "bucketValue", ["size", 5, []]],
    [
      "buckets-count",
      "bucketValue",
      ["size", 5, Array.from({ length: 21 }, (_, i) => i)],
    ],
    ["buckets-hole", "bucketValue", ["size", 5, withHole(1, 3)]],
    ["buckets-hole", "bucketValue", ["size", 5, new Array(2)]],
    ["buckets-hole", "bucketValue", ["size", 5, Object.create([1, 10])]],
    ["buckets-not-integer", "bucketValue", ["size", 5, [1.5, 10]]],
    ["buckets-not-integer", "bucketValue", ["size", 5, [NaN]]],
    ["buckets-not-integer", "bucketValue", ["size", 5, [1, Infinity]]],
    ["buckets-not-integer", "bucketValue", ["size", 5, ["a", 1.5]]],
    ["buckets-out-of-range", "bucketValue", ["size", 5, [-1]]],
    ["buckets-out-of-range", "bucketValue", ["size", 5, [2 ** 31]]],
    ["buckets-out-of-range", "bucketValue", ["size", 5, [2 ** 32]]],
    ["buckets-duplicate", "bucketValue", ["size", 5, [1, 1]]],
    ["buckets-duplicate", "bucketValue", ["size", 5, [0, -0]]],
    ["buckets-duplicate", "bucketValue", ["size", 5, [5, 1, 5]]],
    // Report the first failure: operation, amount, then bucket count/holes/integers/range/duplicates.
    ["operation-surrogate", "incrementCounter", ["calls\ud800", 0]],
    ["value-out-of-range", "bucketValue", ["size", NaN, []]],
    ["buckets-hole", "bucketValue", ["size", 5, withHole(1.5, 3)]],
    ["buckets-not-integer", "bucketValue", ["size", 5, [1.5, -1]]],
    ["buckets-out-of-range", "bucketValue", ["size", 5, [-1, -1]]],
    ["increment-not-positive", "incrementCounter", ["calls", 0, "yes"]],
  ])("drops %s: %s %O", async (code, method, args) => {
    const service = await init("ext-a");

    record(service, method, args);

    expect(o11y("ext-a")[method]).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls).toStrictEqual([
      [dropped(method, code, JSON.stringify(args[0]))],
    ]);
  });

  test.each<[Method, unknown[]]>([
    ["incrementCounter", ["calls", 2147483647]],
    ["incrementCounter", ["calls", 2147483647.4]],
    ["incrementCounter", ["calls\u{1F600}"]],
    ["trackValue", ["latency", 2 ** 63 - 1024]],
    ["trackValue", ["latency", -(2 ** 63 - 1024)]],
    ["bucketValue", ["size", 5, [0, 2147483647]]],
    ["bucketValue", ["size", 5, Array.from({ length: 20 }, (_, i) => i)]],
  ])("accepts the boundary input %s %O", async (method, args) => {
    const service = await init("ext-a");

    record(service, method, args);

    expect(o11y("ext-a")[method]).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  const tagsFunction = () => "tags";
  test.each<[string, Method, unknown[], unknown[], string]>([
    [
      "a numeric operation",
      "incrementCounter",
      [5],
      [5, undefined, undefined, undefined],
      "of type number",
    ],
    [
      "a missing operation",
      "trackValue",
      [undefined, 5],
      [undefined, 5, undefined, undefined],
      "of type undefined",
    ],
    [
      "a string increment",
      "incrementCounter",
      ["calls", "2"],
      ["calls", "2", undefined, undefined],
      '"calls"',
    ],
    [
      "a string value",
      "trackValue",
      ["latency", "5"],
      ["latency", "5", undefined, undefined],
      '"latency"',
    ],
    [
      "a bigint value",
      "trackValue",
      ["latency", 5n],
      ["latency", 5n, undefined, undefined],
      '"latency"',
    ],
    [
      "null buckets",
      "bucketValue",
      ["size", 5, null],
      ["size", 5, null, undefined, undefined],
      '"size"',
    ],
    [
      "string buckets",
      "bucketValue",
      ["size", 5, "1,10"],
      ["size", 5, "1,10", undefined, undefined],
      '"size"',
    ],
    [
      "array-like buckets",
      "bucketValue",
      ["size", 5, { 0: 1, length: 1 }],
      ["size", 5, { 0: 1, length: 1 }, undefined, undefined],
      '"size"',
    ],
    [
      "a string bucket entry",
      "bucketValue",
      ["size", 5, ["1", 10]],
      ["size", 5, ["1", 10], undefined, undefined],
      '"size"',
    ],
    [
      "an undefined bucket entry",
      "bucketValue",
      ["size", 5, [1, undefined, 3]],
      ["size", 5, [1, undefined, 3], undefined, undefined],
      '"size"',
    ],
    [
      "a string hasError",
      "trackValue",
      ["latency", 5, "yes"],
      ["latency", 5, "yes", undefined],
      '"latency"',
    ],
    [
      "null tags",
      "incrementCounter",
      ["calls", 1, false, null],
      ["calls", 1, false, null],
      '"calls"',
    ],
    [
      "numeric tags",
      "incrementCounter",
      ["calls", 1, false, 5],
      ["calls", 1, false, 5],
      '"calls"',
    ],
    [
      "a 25-character string as tags",
      "incrementCounter",
      ["calls", 1, false, "x".repeat(25)],
      ["calls", 1, false, "x".repeat(25)],
      '"calls"',
    ],
    [
      "function tags",
      "trackValue",
      ["latency", 5, false, tagsFunction],
      ["latency", 5, false, tagsFunction],
      '"latency"',
    ],
  ])(
    "forwards %s for o11y to reject, and reports its throw",
    async (_label, method, args, forwarded, shownOperation) => {
      const service = await init("ext-a");
      // A call that skipped the type gate would be dropped for budget instead of reaching o11y.
      (O11yService as any).metricsWindowBytes = 131072;
      o11y("ext-a")[method].mockImplementationOnce(() => {
        throw new Error("o11y rejected the input");
      });

      record(service, method, args);

      expect(o11y("ext-a")[method].mock.calls).toStrictEqual([forwarded]);
      expect(errorSpy.mock.calls).toStrictEqual([
        [threw(method, "o11y rejected the input", shownOperation)],
      ]);
    },
  );

  test("forwards a copy of the buckets, reading each entry once", async () => {
    const service = await init("ext-a");
    const buckets = [1, 10];
    let reads = 0;
    Object.defineProperty(buckets, 1, {
      enumerable: true,
      get() {
        reads++;
        return 10;
      },
    });

    service.bucketValue("size", 5, buckets);
    buckets.push(100);

    const forwarded = o11y("ext-a").bucketValue.mock.calls[0][2];
    expect(forwarded).not.toBe(buckets);
    expect(forwarded).toStrictEqual([1, 10]);
    expect(reads).toBe(1);
  });

  test("drops buckets with a huge length without walking them", async () => {
    const service = await init("ext-a");
    const buckets: number[] = [];
    buckets.length = 2 ** 32 - 1;

    service.bucketValue("size", 5, buckets);

    expect(o11y("ext-a").bucketValue).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls).toStrictEqual([
      [dropped("bucketValue", "buckets-count", '"size"')],
    ]);
  });

  test("copies the buckets by index, ignoring the array's own iterator", async () => {
    const service = await init("ext-a");
    const buckets = [1, 10, 100];
    Object.defineProperty(buckets, Symbol.iterator, {
      value: function* () {
        for (;;) yield 1;
      },
    });

    service.bucketValue("size", 5, buckets);

    expect(o11y("ext-a").bucketValue.mock.calls[0][2]).toStrictEqual([
      1, 10, 100,
    ]);
  });

  test("checks an object that inherits from Array.prototype like an array", async () => {
    const service = await init("ext-a");
    const fraction = Object.setPrototypeOf(
      { 0: 1.5, length: 1 },
      Array.prototype,
    );
    const valid = Object.setPrototypeOf(
      { 0: 1, 1: 10, length: 2 },
      Array.prototype,
    );

    service.bucketValue("size", 5, fraction);
    service.bucketValue("size", 5, valid);

    expect(errorSpy.mock.calls).toStrictEqual([
      [dropped("bucketValue", "buckets-not-integer", '"size"')],
    ]);
    const forwarded = o11y("ext-a").bucketValue.mock.calls[0][2];
    expect(Array.isArray(forwarded)).toBe(true);
    expect(forwarded).toStrictEqual([1, 10]);
  });

  test("rate-limits each method and code separately", async () => {
    const service = await init("ext-a");

    service.trackValue("latency", NaN);
    service.trackValue("latency", NaN);
    service.trackValue("latency\ud800", 1);
    service.bucketValue("size", NaN, [1]);

    expect(errorSpy.mock.calls).toStrictEqual([
      [dropped("trackValue", "value-out-of-range", '"latency"')],
      [dropped("trackValue", "operation-surrogate", '"latency\\ud800"')],
      [dropped("bucketValue", "value-out-of-range", '"size"')],
    ]);
  });
});

class RouteTags {
  route = "home";
}

const tagsOf = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`t${i}`, i]));

const headlessOptions = (): InitializeOptions => ({
  falcon: { apiKey: "unit-test-placeholder" },
  headlessCollector: { collect: jest.fn(), close: jest.fn() },
});

describe("metric tag checks and warnings", () => {
  test.each<[string, Method, unknown[]]>([
    ["tags-too-many", "incrementCounter", ["calls", 1, false, tagsOf(20)]],
    ["tag-surrogate", "trackValue", ["latency", 5, false, { "k\ud800": "v" }]],
    ["tag-surrogate", "trackValue", ["latency", 5, false, { k: "v\udc00" }]],
    ["tag-infinite", "bucketValue", ["size", 5, [1], false, { k: Infinity }]],
    ["tag-infinite", "bucketValue", ["size", 5, [1], false, { k: -Infinity }]],
    ["tag-o11yapp", "incrementCounter", ["calls", 1, false, { o11yApp: "x" }]],
    // Report the first failure: tag count, UTF-16, infinities, then reserved o11yApp.
    [
      "tags-too-many",
      "incrementCounter",
      ["calls", 1, false, { ...tagsOf(20), t0: "\ud800" }],
    ],
    [
      "tag-surrogate",
      "incrementCounter",
      ["calls", 1, false, { k: "\ud800", n: Infinity }],
    ],
    [
      "tag-infinite",
      "incrementCounter",
      ["calls", 1, false, { n: Infinity, o11yApp: "x" }],
    ],
  ])("drops %s: %s %O", async (code, method, args) => {
    const service = await init("ext-a");

    record(service, method, args);

    expect(o11y("ext-a")[method]).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls).toStrictEqual([
      [dropped(method, code, JSON.stringify(args[0]))],
    ]);
  });

  test("does not count status, or an own __proto__ key, toward the 19-tag limit", async () => {
    const service = await init("ext-a");
    const withProto = {
      ...tagsOf(19),
      ...JSON.parse('{"__proto__":"x"}'),
    };

    service.incrementCounter("calls", 1, false, { ...tagsOf(19), status: "x" });
    service.trackValue("latency", 5, false, withProto);

    // Number tag values are forwarded as the strings o11y sends.
    expect(o11y("ext-a").incrementCounter.mock.calls[0][3]).toStrictEqual({
      ...Object.fromEntries(
        Object.entries(tagsOf(19)).map(([key, value]) => [key, String(value)]),
      ),
      status: "x",
    });
    expect(o11y("ext-a").trackValue).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls).toStrictEqual([
      [caveat("incrementCounter", "tag-status", '"calls"')],
    ]);
  });

  test("leaves a type o11y rejects to o11y, before the tag rules", async () => {
    const service = await init("ext-a");
    o11y("ext-a").incrementCounter.mockImplementationOnce(() => {
      throw new Error("o11y rejected the input");
    });

    record(service, "incrementCounter", [5, 1, false, { o11yApp: "x" }]);

    expect(errorSpy.mock.calls).toStrictEqual([
      [threw("incrementCounter", "o11y rejected the input", "of type number")],
    ]);
  });

  test("checks the arguments before the tags", async () => {
    const service = await init("ext-a");

    service.trackValue("latency", NaN, false, { o11yApp: "x" });

    expect(errorSpy.mock.calls).toStrictEqual([
      [dropped("trackValue", "value-out-of-range", '"latency"')],
    ]);
  });

  test.each<[string, Method, unknown[]]>([
    ["increment-fraction", "incrementCounter", ["calls", 1.5]],
    ["increment-fraction", "incrementCounter", ["calls", 0.5]],
    ["value-fraction", "trackValue", ["latency", 0.5]],
    ["value-fraction", "trackValue", ["latency", -0.25]],
    ["value-fraction", "bucketValue", ["size", 0.5, [1]]],
    ["value-negative", "bucketValue", ["size", -5, [1]]],
    [
      "tags-map-or-set",
      "incrementCounter",
      ["calls", 1, false, new Map([["k", "v"]])],
    ],
    [
      "tags-map-or-set",
      "incrementCounter",
      ["calls", 1, false, new Set(["k"])],
    ],
    ["tag-status", "trackValue", ["latency", 5, true, { status: "ok" }]],
    [
      "tag-monc-identifier",
      "trackValue",
      ["latency", 5, false, { monc_identifier: "x" }],
    ],
  ])("records and warns %s: %s %O", async (code, method, args) => {
    const service = await init("ext-a");

    record(service, method, args);

    expect(o11y("ext-a")[method]).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls).toStrictEqual([
      [caveat(method, code, JSON.stringify(args[0]))],
    ]);
  });

  test("forwards a Map's tags as an empty object", async () => {
    const service = await init("ext-a");

    record(service, "trackValue", ["latency", 5, false, new Map([["k", "v"]])]);

    expect(o11y("ext-a").trackValue.mock.calls[0][3]).toStrictEqual({});
  });

  test("logs every warning for one call, in table order", async () => {
    const service = await init("ext-a");
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    const tags = { status: "x", monc_identifier: "y" };
    service.bucketValue("size", 5, [1], false, tags); // the series' first buckets
    now.mockReturnValue(1_060_000); // past the rate limit for this call's warnings
    warnSpy.mockClear();

    service.bucketValue("size", -0.5, [2], false, tags);

    expect(warnSpy.mock.calls).toStrictEqual([
      [caveat("bucketValue", "value-fraction", '"size"')],
      [caveat("bucketValue", "value-negative", '"size"')],
      [caveat("bucketValue", "buckets-changed", '"size"')],
      [caveat("bucketValue", "tag-status", '"size"')],
      [caveat("bucketValue", "tag-monc-identifier", '"size"')],
    ]);
  });

  test.each<[string, Method, unknown[]]>([
    ["unsorted buckets", "bucketValue", ["size", 5, [100, 1, 10]]],
    ["a whitespace operation", "trackValue", [" ", 5]],
    ["a 500-character operation", "trackValue", ["x".repeat(500), 5]],
    ["a non-ASCII operation", "trackValue", ["größe_ms", 5]],
    ["the operation log", "incrementCounter", ["log"]],
    ["an orgid tag", "incrementCounter", ["calls", 1, false, { orgid: "00D" }]],
    ["an OrgId tag", "incrementCounter", ["calls", 1, false, { OrgId: "00D" }]],
    ["an empty tag key", "incrementCounter", ["calls", 1, false, { "": "v" }]],
    [
      "placeholder tag values",
      "incrementCounter",
      ["calls", 1, false, { a: "null", b: "empty", c: "NaN" }],
    ],
    [
      "tag values o11y replaces with placeholders",
      "incrementCounter",
      ["calls", 1, false, { a: null, b: "", c: NaN, d: {} }],
    ],
    ["array tags", "incrementCounter", ["calls", 1, false, ["a"]]],
    [
      "class-instance tags",
      "incrementCounter",
      ["calls", 1, false, new RouteTags()],
    ],
    [
      "frozen tags",
      "incrementCounter",
      ["calls", 1, false, Object.freeze({ route: "home" })],
    ],
    [
      "a symbol tag key",
      "incrementCounter",
      ["calls", 1, false, { [Symbol("s")]: "v", route: "home" }],
    ],
    [
      "a non-enumerable tag key",
      "incrementCounter",
      [
        "calls",
        1,
        false,
        Object.defineProperty({}, "route", { value: "home" }),
      ],
    ],
    [
      "an inherited tag key",
      "incrementCounter",
      ["calls", 1, false, Object.create({ route: "home" })],
    ],
    ["a negative value for trackValue", "trackValue", ["latency", -5]],
    ["a zero value for trackValue", "trackValue", ["latency", 0]],
    ["a zero value for bucketValue", "bucketValue", ["size", 0, [1]]],
  ])("passes %s through without a message", async (_label, method, args) => {
    const service = await init("ext-a");

    record(service, method, args);

    expect(o11y("ext-a")[method]).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test.each([
    ["an empty operation", ""],
    ["a backtick in the operation", "a`b"],
    ["the operation o11y-error", "o11y-error"],
  ])(
    "leaves %s to o11y, and reports its throw without a caveat",
    async (_label, operation) => {
      const service = await init("ext-a");
      o11y("ext-a").incrementCounter.mockImplementationOnce(() => {
        throw new Error("o11y rejected the input");
      });

      service.incrementCounter(operation, 1.5); // a fraction warns only if o11y accepts the call

      expect(o11y("ext-a").incrementCounter.mock.calls).toStrictEqual([
        [operation, 1.5, undefined, undefined],
      ]);
      expect(errorSpy.mock.calls).toStrictEqual([
        [
          threw(
            "incrementCounter",
            "o11y rejected the input",
            JSON.stringify(operation),
          ),
        ],
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    },
  );

  test("reports tags whose inherited Symbol.toStringTag getter throws as threw", async () => {
    const service = await init("ext-a");
    const tags = Object.create({
      get [Symbol.toStringTag]() {
        throw new Error("tag getter");
      },
    });

    service.incrementCounter("calls", 1, false, tags);

    expect(o11y("ext-a").incrementCounter).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls).toStrictEqual([
      [threw("incrementCounter", "tag getter", '"calls"')],
    ]);
  });

  test("warns that headless mode discards metrics, after any other warning", async () => {
    const service = await init("ext-a", { options: headlessOptions() });

    service.trackValue("latency", 0.5);

    expect(o11y("ext-a").trackValue).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls).toStrictEqual([
      [caveat("trackValue", "value-fraction", '"latency"')],
      [caveat("trackValue", "headless", '"latency"')],
    ]);
  });

  test("warns when the upload owner is headless, whatever this instance's own mode", async () => {
    await init("ext-a", { options: headlessOptions() });
    const b = await init("ext-b");
    // ext-b's conflicting upload destination was logged at initialize().
    errorSpy.mockClear();

    b.incrementCounter("calls");

    expect(warnSpy.mock.calls).toStrictEqual([
      [caveat("incrementCounter", "headless", '"calls"')],
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("warns when a histogram series is given buckets other than its first", async () => {
    const service = await init("ext-a");

    service.bucketValue("size", 5, [1, 10]);
    service.bucketValue("size", 6, [10, 1]); // the same buckets in another order
    expect(warnSpy).not.toHaveBeenCalled();
    service.bucketValue("size", 7, [1, 100]);

    expect(o11y("ext-a").bucketValue).toHaveBeenCalledTimes(3);
    // The comparison sorts a copy, so o11y gets the caller's order.
    expect(o11y("ext-a").bucketValue.mock.calls[1][2]).toStrictEqual([10, 1]);
    expect(warnSpy.mock.calls).toStrictEqual([
      [caveat("bucketValue", "buckets-changed", '"size"')],
    ]);
  });

  test("remembers the first buckets of at most 500 histogram series", async () => {
    const service = await init("ext-a");
    for (let i = 0; i < 500; i++) {
      service.bucketValue(`h${i}`, 1, [1]);
    }

    service.bucketValue("h500", 1, [1, 2]);
    service.bucketValue("h500", 1, [5]); // nothing remembered to compare with
    service.bucketValue("h499", 1, [7]); // the 500th series is remembered

    expect(warnSpy.mock.calls).toStrictEqual([
      [caveat("bucketValue", "buckets-changed", '"h499"')],
    ]);
  });
});

describe("metric upload window accounting", () => {
  const estimate = (service: O11yService) =>
    service.getBatchStatus().estimatedByteSize;

  test("estimates each series once per window, plus 8 bytes per recorded value", async () => {
    const service = await init("ext-a");
    const steps: number[] = [];

    service.incrementCounter("calls"); // S = 80 + 5 + 5 = 90; first touch costs S - 8
    steps.push(estimate(service));
    service.incrementCounter("calls", 3); // a counter adds nothing after its first touch
    steps.push(estimate(service));
    service.trackValue("latency", 5); // S = 92; first touch costs S - 8, plus 8
    steps.push(estimate(service));
    service.trackValue("latency", 6); // 8 per value
    steps.push(estimate(service));
    service.bucketValue("size", 5, [1, 10, 100]); // S = 80 + 4 + 5 + 3 * 5 = 104
    steps.push(estimate(service));
    service.trackValue("latency", 7, false, { route: "home" }); // S = 92 + 9 + 5 + 4 = 110
    steps.push(estimate(service));
    service.trackValue("latency", 7, true, { route: "home" }); // hasError is another series
    steps.push(estimate(service));

    expect(steps).toStrictEqual([82, 82, 174, 182, 286, 396, 506]);
  });

  test("sizes a tag value as o11y sends it", async () => {
    const service = await init("ext-a");

    service.trackValue("latency", 5, false, { e: "" }); // sent as "empty": 92 + 9 + 1 + 5

    expect(estimate(service)).toBe(107);
  });

  test.each<[string, unknown, string]>([
    ["a null", null, "null"],
    ["a NaN", NaN, "NaN"],
    ["an undefined", undefined, "undefined"],
    ["a function", () => 1, "function"],
    ["a symbol", Symbol("s"), "symbol"],
    ["a bigint", BigInt(5), "bigint"],
    ["an object", {}, "object"],
    ["a -0", -0, "0"],
  ])(
    "forwards %s tag value and sizes it as o11y sends it",
    async (_label, value, sent) => {
      const service = await init("ext-a");

      record(service, "trackValue", ["latency", 5, false, { t: value }]);

      expect(o11y("ext-a").trackValue).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(estimate(service)).toBe(92 + 9 + 1 + Buffer.byteLength(sent));
    },
  );

  test("adds the metrics estimate to the collector's", async () => {
    const service = await init("ext-a");
    collector.estimatedByteSize = 1000;

    service.incrementCounter("calls");

    expect(estimate(service)).toBe(1082);
  });

  test("reports 0 without a collector", () => {
    const service = O11yService.getInstance("never-initialized");
    (O11yService as any).metricsWindowBytes = 500;

    expect(estimate(service)).toBe(0);
  });

  test("counts metrics toward the upload threshold", async () => {
    const { getConnection, requestPost } = coreConnection();
    const service = await init("ext-a", { getConnection });
    const stop = service.enableAutoBatching({
      thresholdBytes: 1000,
      enableShutdownHook: false,
    });
    collector.estimatedByteSize = 908;

    await service.uploadAsNeededAsync(false);
    expect(collector.getRawContentsOfCoreEnvelope).not.toHaveBeenCalled();

    service.trackValue("latency", 5); // 908 + 92 is exactly the threshold
    await service.uploadAsNeededAsync(false);
    stop();

    expect(collector.getRawContentsOfCoreEnvelope).toHaveBeenCalledTimes(1);
    expect(requestPost).toHaveBeenCalledWith(
      "/services/data/v65.0/connect/proxy/ui-telemetry",
      { base64Env: "AQID" },
    );
  });

  test("drops an increment that would take a counter past 2147483647 in the window", async () => {
    const service = await init("ext-a");

    service.incrementCounter("calls", 2147483647);
    service.incrementCounter("calls");
    service.incrementCounter("calls", 1, false, { k: "other series" });

    expect(o11y("ext-a").incrementCounter).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls).toStrictEqual([
      [dropped("incrementCounter", "counter-overflow", '"calls"')],
    ]);
  });

  test("adds the rounded increment to the counter's total", async () => {
    const service = await init("ext-a");

    service.incrementCounter("calls", 2147483646);
    service.incrementCounter("calls", 1.4); // o11y adds 1, so the total is 2147483647
    service.incrementCounter("calls", 0.5); // o11y adds 1

    expect(
      o11y("ext-a").incrementCounter.mock.calls.map((call) => call[1]),
    ).toStrictEqual([2147483646, 1.4]);
    expect(errorSpy.mock.calls).toStrictEqual([
      [dropped("incrementCounter", "counter-overflow", '"calls"')],
    ]);
  });

  test("drops a call that would take the window past 131072 bytes, but never one that adds nothing", async () => {
    const service = await init("ext-a");
    service.incrementCounter("calls");
    // Leave room for exactly one new trackValue series (92 bytes).
    (O11yService as any).metricsWindowBytes = 131072 - 92;

    service.trackValue("latency", 5);
    service.trackValue("latency", 6);
    service.incrementCounter("calls");

    expect(o11y("ext-a").trackValue).toHaveBeenCalledTimes(1);
    expect(o11y("ext-a").incrementCounter).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls).toStrictEqual([
      [dropped("trackValue", "budget", '"latency"')],
    ]);
    expect(estimate(service)).toBe(131072);
  });

  test("counts a call only after o11y accepts it", async () => {
    const service = await init("ext-a");
    o11y("ext-a").incrementCounter.mockImplementationOnce(() => {
      throw new Error("o11y rejected the input");
    });

    service.incrementCounter("calls", 5);
    service.incrementCounter("calls", 2147483647);

    expect(errorSpy.mock.calls).toStrictEqual([
      [threw("incrementCounter", "o11y rejected the input", '"calls"')],
    ]);
    expect(o11y("ext-a").incrementCounter).toHaveBeenCalledTimes(2);
    expect(estimate(service)).toBe(82);
  });

  test("a call o11y rejects adds no bytes, touches no series, pins no buckets and logs no caveat", async () => {
    const service = await init("ext-a");
    for (const method of [
      "incrementCounter",
      "trackValue",
      "bucketValue",
    ] as const) {
      o11y("ext-a")[method].mockImplementationOnce(() => {
        throw new Error("Max size of 1000 exceeded for UpCounters");
      });
    }

    service.incrementCounter("calls", 1.5); // would cost 82 and warn increment-fraction
    service.trackValue("latency", 0.5); // would cost 92 and warn value-fraction
    service.bucketValue("size", 5, [1, 10, 100]); // would cost 104 and pin 3 buckets

    expect(estimate(service)).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
    service.trackValue("latency", 5); // still a first touch: 92
    service.bucketValue("size", 5, [1]); // still a first touch, with k = 1: 94
    expect(estimate(service)).toBe(92 + 94);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("treats the same tags in another order as one series", async () => {
    const service = await init("ext-a");

    service.incrementCounter("calls", 2147483647, false, { a: "1", b: "2" });
    service.incrementCounter("calls", 1, false, { b: "2", a: "1" });
    service.trackValue("latency", 5, false, { a: "1", b: "2" });
    service.trackValue("latency", 6, false, { b: "2", a: "1" });

    expect(o11y("ext-a").incrementCounter).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls).toStrictEqual([
      [dropped("incrementCounter", "counter-overflow", '"calls"')],
    ]);
    // calls: 90 + 2 * (9 + 1 + 1) - 8; latency: 92 + 22, then 8
    expect(estimate(service)).toBe(104 + 114 + 8);
  });

  test("treats a number or boolean tag value and its string form as one series", async () => {
    const service = await init("ext-a");

    service.incrementCounter("calls", 2147483647, false, { k: 1 });
    service.incrementCounter("calls", 1, false, { k: "1" });
    service.bucketValue("size", 5, [1, 10], false, { b: true });
    service.bucketValue("size", 5, [1, 100], false, { b: "true" });

    expect(o11y("ext-a").incrementCounter.mock.calls).toStrictEqual([
      ["calls", 2147483647, false, { k: "1" }],
    ]);
    expect(errorSpy.mock.calls).toStrictEqual([
      [dropped("incrementCounter", "counter-overflow", '"calls"')],
    ]);
    expect(warnSpy.mock.calls).toStrictEqual([
      [caveat("bucketValue", "buckets-changed", '"size"')],
    ]);
  });

  test("leaves a type o11y rejects to o11y even when the budget is used up", async () => {
    const service = await init("ext-a");
    (O11yService as any).metricsWindowBytes = 131072;
    o11y("ext-a").trackValue.mockImplementationOnce(() => {
      throw new Error("o11y rejected the input");
    });

    record(service, "trackValue", [5, 1]);

    expect(errorSpy.mock.calls).toStrictEqual([
      [threw("trackValue", "o11y rejected the input", "of type number")],
    ]);
  });

  test("charges a histogram series once per window, whatever buckets later calls pass", async () => {
    const service = await init("ext-a");

    service.bucketValue("size", 5, [1, 10]); // S = 80 + 4 + 5 + 2 * 5 = 99
    service.bucketValue("size", 6, [10, 1]);
    service.bucketValue("size", 7, [1, 100]);

    expect(estimate(service)).toBe(99 + 8 + 8);
  });

  test("shares series state and rate limits between instances with one extensionName", async () => {
    const first = await init("ext-a", { id: "first" });
    const second = await init("ext-a", { id: "second" });

    first.incrementCounter("calls", 2147483647);
    second.incrementCounter("calls"); // the same series, so the same total
    first.trackValue("latency", 5);
    second.trackValue("latency", 6); // already touched in this window
    second.trackValue("latency", NaN);
    first.trackValue("latency", NaN); // the same rate-limit key

    expect(errorSpy.mock.calls).toStrictEqual([
      [dropped("incrementCounter", "counter-overflow", '"calls"')],
      [dropped("trackValue", "value-out-of-range", '"latency"')],
    ]);
    expect(estimate(first)).toBe(82 + 92 + 8);
  });

  test("sizes names and tags in UTF-8 bytes", async () => {
    const a = await init("ext-a");
    const b = await init("ext-ö");

    a.trackValue("größe", 5, false, { ü: "日本\u{1F642}" }); // 80 + 7 + 5 + (9 + 2 + 10)
    const afterA = estimate(a);
    b.incrementCounter("calls"); // 80 + 5 + 6 - 8

    expect([afterA, estimate(b)]).toStrictEqual([113, 113 + 83]);
  });

  test("drops an operation too long for an empty window, and cuts it to 80 characters in the line", async () => {
    const service = await init("ext-a");

    service.trackValue("o".repeat(140_000), 5);

    expect(o11y("ext-a").trackValue).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls).toStrictEqual([
      [dropped("trackValue", "budget", JSON.stringify("o".repeat(80)))],
    ]);
    expect(estimate(service)).toBe(0);
  });
});

describe("metric upload window resets", () => {
  const estimate = (service: O11yService) =>
    service.getBatchStatus().estimatedByteSize;

  test("an upload over the org connection starts a new window", async () => {
    const { getConnection, requestPost } = coreConnection();
    const service = await init("ext-a", { getConnection });
    service.incrementCounter("calls", 2147483647);

    await service.forceFlush();

    expect(requestPost).toHaveBeenCalledWith(
      "/services/data/v65.0/connect/proxy/ui-telemetry",
      { base64Env: "AQID" },
    );
    expect(estimate(service)).toBe(0);
    service.incrementCounter("calls"); // the counter's total started over
    expect(o11y("ext-a").incrementCounter).toHaveBeenCalledTimes(2);
    expect(estimate(service)).toBe(82); // and its first touch costs again
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("a failed send still starts a new window", async () => {
    const requestPost = jest.fn().mockRejectedValue(new Error("org down"));
    const getConnection = jest.fn().mockResolvedValue({ requestPost });
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockRejectedValue(new Error("static down"));
    const service = await init("ext-a", { getConnection });
    service.incrementCounter("calls", 2147483647);

    await service.forceFlush();

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://static.example.invalid",
      expect.objectContaining({ method: "POST" }),
    );
    expect(estimate(service)).toBe(0);
    service.incrementCounter("calls");
    expect(o11y("ext-a").incrementCounter).toHaveBeenCalledTimes(2);
  });

  test("a Falcon upload starts a new window", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ status: 202, ok: true } as Response);
    const service = await init("ext-a", {
      options: {
        falcon: {
          apiKey: "unit-test-placeholder",
          endpoint: "https://falcon.example.invalid",
        },
      },
    });
    service.trackValue("latency", 5);

    await service.forceFlush();

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://falcon.example.invalid/ui-telemetry",
      expect.objectContaining({ method: "POST" }),
    );
    expect(estimate(service)).toBe(0);
  });

  test("a headless drain starts a new window", async () => {
    const service = await init("ext-a", { options: headlessOptions() });
    service.trackValue("latency", 5);

    await service.forceFlush();

    expect(collector.getRawContentsOfCoreEnvelope).toHaveBeenCalledTimes(1);
    expect(estimate(service)).toBe(0);
  });

  test("a metric recorded while an upload is in flight counts toward the new window", async () => {
    const requestPost = jest.fn().mockResolvedValue({});
    let connect: (connection: unknown) => void = () => {};
    const getConnection = jest.fn(
      () =>
        new Promise((resolve) => {
          connect = resolve;
        }),
    );
    const service = await init("ext-a", { getConnection });
    service.incrementCounter("calls");

    const flushing = service.forceFlush(); // drains now, then waits for the connection
    expect(collector.getRawContentsOfCoreEnvelope).toHaveBeenCalledTimes(1);
    service.trackValue("latency", 5);
    connect({ requestPost });
    await flushing;

    expect(requestPost).toHaveBeenCalledTimes(1);
    expect(estimate(service)).toBe(92);
  });

  test("a new shared buffer starts a new window", async () => {
    const service = await init("ext-a");
    service.incrementCounter("calls");
    (O11yService as any).sharedInstrApp = null;
    (O11yService as any).sharedResourcesInitPromise = null;

    await service.initialize("ext-a", "http://static.example.invalid");

    expect(service.isInitialized()).toBe(true);
    expect(estimate(service)).toBe(0);
    service.incrementCounter("calls");
    expect(estimate(service)).toBe(82);
  });

  test("a failed shared initialization clears the window", async () => {
    const service = await init("ext-a");
    service.incrementCounter("calls", 5);
    (O11yService as any).sharedInstrApp = null;
    (O11yService as any).sharedResourcesInitPromise = null;
    const failing = buildModules();
    failing.registerInstrumentedApp.mockImplementation(() => {
      throw new Error("register failed");
    });
    (loadO11yModules as jest.Mock).mockResolvedValue(failing);

    await service.initialize("ext-a", "http://static.example.invalid");

    expect(service.isInitialized()).toBe(false);
    const statics = O11yService as any;
    expect(statics.metricsWindowBytes).toBe(0);
    expect(statics.metricsState.get("ext-a").touchedSeries.size).toBe(0);
    expect(statics.metricsState.get("ext-a").counterTotals.size).toBe(0);
  });

  test("keeps first buckets and rate limits across an upload", async () => {
    const { getConnection } = coreConnection();
    const service = await init("ext-a", { getConnection });
    service.bucketValue("size", 5, [1, 10, 100]);
    service.bucketValue("size", 5, [1]); // other buckets: the series keeps its first
    service.trackValue("latency", NaN);

    await service.forceFlush();
    service.bucketValue("size", 5, [1]); // still sent with its 3 first buckets
    service.trackValue("latency", NaN); // still rate-limited

    expect(estimate(service)).toBe(104);
    expect(warnSpy.mock.calls).toStrictEqual([
      [caveat("bucketValue", "buckets-changed", '"size"')],
    ]);
    expect(errorSpy.mock.calls).toStrictEqual([
      [dropped("trackValue", "value-out-of-range", '"latency"')],
    ]);
  });
});

describe("extensionName lone surrogates", () => {
  // The last two would fail the backtick and whitespace checks too, which echo the name.
  test.each(["ext\ud800", "\udc00ext", "a\ud83d", "a`\ud800", " \ud800"])(
    "rejects %j before claiming any shared state",
    async (name) => {
      const service = O11yService.getInstance("surrogate");

      await service.initialize(name, "http://static.example.invalid");

      expect(errorSpy.mock.calls).toStrictEqual([
        [
          "[O11yService] Invalid extensionName; telemetry not initialized. extensionName must not contain a lone UTF-16 surrogate (it cannot be encoded as UTF-8).",
        ],
      ]);
      expect(service.isInitialized()).toBe(false);
      expect(loadO11yModules).not.toHaveBeenCalled();
    },
  );

  test("accepts a surrogate pair", async () => {
    const service = await init("ext😀");

    expect(service.isInitialized()).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
