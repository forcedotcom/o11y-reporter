# o11y-reporter metrics API

Maintainer reference for the metrics API, its validation rules, upload sizing,
tests, and known limits. Source references name files and symbols rather than
fixed line numbers.

o11y behaviour was verified by running o11y 266.23.0. The repo pins 266.24.0,
whose changes don't touch metrics, and the real-o11y test (§10.2) passes on it.
Server evidence describes release 266 (October 2026); deployed behaviour and
unverified limits are called out in §17 and Appendix A.

## 1. Contract

o11y-client's `Instrumentation` has three metric methods: `incrementCounter`
(an up-counter), `trackValue` (a value recorder) and `bucketValue` (a bucket
histogram). `O11yService` exposes all three.

1. The names and argument order match o11y-client.
2. The methods return `void` and, called on the service, never throw, like `logEvent` (§5).
3. Known inputs that poison an upload, leak a series slot, or cause server drops or corruption are rejected. Inputs the server only alters are recorded with a warning. Every reject and warning is reported on the console, rate-limited.
4. A per-window metrics budget limits metric volume against the only route limit found: 2^18 bytes on Core's static route (§7.2). Logs and unknown route limits remain caveats (§15, §17).
5. Consumers that don't call the metric methods see no change in behaviour or output.

## 2. Consumers

Node.js SDKs built on o11y-reporter that need metrics parity with o11y-client.

## 3. Why a plain pass-through is unsafe

Each point below was checked by running o11y 266.23.0 and by reading the server code. Appendix A lists the evidence.

1. **o11y throws on bad input.** o11y-reporter registers its app with `isProduction: false` (`src/o11yService.ts`, shared initialization). In that mode o11y rethrows its validation errors instead of swallowing them. The setting is global to that copy of o11y.
2. **Some inputs poison the next upload.** They pass o11y's checks, but at upload time o11y's encoder fails its verify step (for example, on a fractional bucket), or the server rejects the whole envelope (for example, on a lone UTF-16 surrogate, which it reads as invalid UTF-8). The shared buffer is drained before the send (`src/telemetryEmitters.ts`), so the whole window is lost, including the logs of every other extension in the process. A histogram's buckets stay pinned to its series, so a bad bucket array poisons every later window that updates that series.
3. **Some inputs leak a series slot.** o11y inserts a new series into its size-limited map before the up-counter rejects a non-positive increment. The map never evicts, so the slot is gone for the life of the process. After 999 valid counters and one rejected increment, the next new counter throws `Max size of 1000 exceeded for UpCounters`.
4. **The server silently drops or changes some data.** It drops a histogram whose buckets are `[]` (o11y's default), and Falcon still returns 202; keeps only the first 20 tags; reads counters as a 32-bit `int`, so a window total above 2147483647 wraps negative; and truncates values to whole numbers.
5. **The collector's size estimate ignores metric values.** It counts 8 bytes per series updated in the window, however many values the series holds. In one probe window (715 series, 13,065 values) it estimated 5,720 bytes for an envelope of 206,532 bytes. That is over the 196,596 raw bytes that Core's static route accepts (§7.2). The metric part of the collector's estimate is at most 16 KB per extension (o11y's limit of 2000 series × 8 bytes), so without the guard estimate the 50 KB threshold rarely fires on metric volume, and the 30 s flush can send a body that the route rejects with 413.
6. **Headless mode discards metrics.** The local-headless collector is registered for logs only (`src/o11yService.ts`), and the headless emitter drains without sending.

## 4. Guarded wrapper

Each method validates its input, rejects inputs with a known bad outcome, warns on lossy ones, and then delegates to o11y-client. Recorded metric bytes count toward the upload estimate and toward a hard budget per upload window.

Alternatives considered:

- **Thin wrapper** (catch and log only). Poison, slot leaks and silent server drops would all remain.
- **Coercing wrapper** (round, clamp or sort inputs). The stored data would silently differ from what the caller wrote, and some inputs, such as `Infinity` or missing buckets, have no correct fix.

## 5. Public API

```ts
export type MetricsTags = Record<string, string | number | boolean>;

export declare class O11yService {
  // ...existing members...
  incrementCounter(
    operation: string,
    increment?: number,
    hasError?: boolean,
    tags?: MetricsTags,
  ): void;
  trackValue(
    operation: string,
    value: number,
    hasError?: boolean,
    tags?: MetricsTags,
  ): void;
  bucketValue(
    operation: string,
    value: number,
    buckets: number[],
    hasError?: boolean,
    tags?: MetricsTags,
  ): void;
}
```

- **Names and argument order match o11y-client.** upCounter is `incrementCounter`, and histogram is `bucketValue`.
- **One deliberate difference: `buckets` is required.** o11y-client defaults it to `[]`, and the server silently drops histograms without buckets. A compile error is better than a metric that never shows up.
- **Defaults come from o11y:** `increment` 1, `hasError` false, `tags` `{}`.
- **Never throw, called on the service.** A detached reference such as `const { trackValue } = service` has no `this`, so calling it throws a `TypeError`, as a detached `logEvent` does.
- **Owner.** Each call goes to the extension's own o11y instrumentation, the one `initialize()` bound (`src/o11yService.ts`, `bindInstrumentation`). So the extension name is the metric's owner on the wire. The server names the metric `<extensionName>.<operation>`, so callers shouldn't repeat the extension name in `operation`. Put the unit in the operation name instead, for example `latency_ms`.
- **Fixed arity.** The methods forward every argument position, passing `undefined` where the caller omitted one. o11y's defaults are default parameters, so this behaves the same at runtime, and unit tests pin the exact call with `toStrictEqual`.
- **Exports.** `MetricsTags` is exported from the package entry (`src/index.ts`), next to `BatchingOptions` and the other types.
- **`instrumentation` stays log-only.** The public field keeps its log-only type (`src/types/bundle.d.ts`). The three methods are the supported way to record metrics, so the types don't steer callers around the checks.

## 6. Call behaviour

### 6.1 Flow

Each method runs these steps in `O11yService.recordMetric`:

1. **Initialization check.** If `isInitialized()` returns false, report `not-initialized` and return.
2. **Inside one `try`:** snapshot, check, delegate, commit, and warn as described below.
3. **`catch`:** report `threw` with the error's message, cut to 200 characters. Formatting the error must not throw, yet it can run caller code: a tags getter can throw any value, `instanceof` runs a Proxy's `getPrototypeOf` trap, and reading `message` can run a getter. Format inside a nested `try`. If the caught value is an `Error`, read its `message` once and use it if it is a string. Otherwise use the value's `typeof`. If the nested `try` throws, use the fixed hint `unreadable error`.

The steps inside the `try` are:

1. **Snapshot the inputs.** For `tags`, if `typeof tags` is `"object"` and `tags` isn't `null`, copy it once with `{ ...tags }`. Otherwise forward it unchanged: o11y applies its default to `undefined` and throws on anything else.
2. For `buckets`, if `Array.isArray(buckets) || buckets instanceof Array` (o11y tests `instanceof`), read `n = buckets.length` once. If `n` is an integer from 1 to 20, copy the entries with an index loop (`for (let i = 0; i < n; i++)`), noting any `i` where `!Object.hasOwn(buckets, i)`. Otherwise don't copy; rule 9 rejects the call. A value that isn't an array is kept as is: rule 8 rejects `undefined`, and o11y throws on anything else at the type gate.
3. **Check** rules 2 to 13 (§6.2) in table order. The first match wins. Numeric rules skip non-numbers, and string rules skip non-strings.
4. **Type gate.** If an argument has a type that o11y rejects before it records anything, delegate now with fixed arity and skip rules 14 to 19, accounting, commit and warnings. o11y throws, and the call is reported as `threw`.
5. **Check** rules 14 to 19. Before rules 18 and 19, turn number and boolean tag values in the snapshot into strings (§6.4), then compute the series key (§7.4) and the call's byte cost (§7.1), which they use.
6. **Delegate** with fixed arity, passing the snapshots: `instrumentation.incrementCounter(operation, increment, hasError, tags)`, `instrumentation.trackValue(operation, value, hasError, tags)`, or `instrumentation.bucketValue(operation, value, buckets, hasError, tags)`.
7. **Commit**, only after the delegate returns: add the byte cost to the window; mark the series as touched; for a counter, add the rounded increment to the series' window total; for a histogram, if no buckets are recorded for the series yet and the map has room, record its buckets, sorted numerically and joined, and their count. Sort a copy: o11y keeps the forwarded array.
8. **Warn** for each warning rule that matched (§6.3), each under its own rate-limit key.

The type gate trips when:

- `operation` is not a string;
- `increment` is defined and is not a number;
- `value` is not a number;
- `buckets` is defined and is not an array, or a copied entry is not a number;
- `hasError` is defined and is not a boolean;
- `tags` is defined, and either `typeof tags` isn't `"object"` or `tags` is `null`.

Snapshot details:

- Don't copy buckets with `Array.from` or spread. They walk the caller's `length` or its own `Symbol.iterator`, so after `buckets.length = 2 ** 32 - 1` the copy would abort the process with a fatal out-of-memory error before rule 9 runs.
- Rule 9 reads `n`, rule 10 reads the hole flag, and the `tags-map-or-set` warning reads the caller's tags, because the copies turn holes into `undefined` and drop a `Map`'s entries. Every other check reads the snapshots, and the snapshots are what get forwarded.
- o11y keeps the buckets array by reference. Forwarding a copy stops a later `push(2.5)` on the caller's array from poisoning a future upload. It also means that an array-like object built on `Array.prototype`, which passes o11y's `instanceof` test, reaches o11y only as a real array that the guard has checked.

### 6.2 Reject rules

A rejected call is not forwarded to o11y. It is reported with `console.error`. The rules run in this order, with the type gate (§6.1) between rules 13 and 14.

| #   | Code                     | Applies to                  | Condition                                                                                | What happens without the rule                                                                                                                                                                                             |
| --- | ------------------------ | --------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `not-initialized`        | all                         | `isInitialized()` is false                                                               | There's nothing to record into. Same check as `logEvent`.                                                                                                                                                                 |
| 2   | `operation-surrogate`    | all                         | `operation` is a string that matches `/\p{Cs}/u` (a lone UTF-16 surrogate)               | Poison: the server can't parse the envelope (invalid UTF-8) and rejects all of it.                                                                                                                                        |
| 3   | `increment-not-positive` | `incrementCounter`          | `increment` is a number and `!(increment > 0)`: 0, -0, negative, `NaN` or `-Infinity`    | Slot leak: o11y creates the series, then throws.                                                                                                                                                                          |
| 4   | `increment-infinite`     | `incrementCounter`          | `increment === Infinity`                                                                 | Poison: the encoder's verify step fails (`integer expected`).                                                                                                                                                             |
| 5   | `increment-too-small`    | `incrementCounter`          | `0 < increment < 0.5`                                                                    | o11y rounds it to 0, so a slot is used and nothing is counted.                                                                                                                                                            |
| 6   | `increment-too-large`    | `incrementCounter`          | `Math.round(increment) > 2147483647`                                                     | The server reads counters as a 32-bit int, so the value wraps.                                                                                                                                                            |
| 7   | `value-out-of-range`     | `trackValue`, `bucketValue` | `value` is a number and either `!Number.isFinite(value)` or `Math.abs(value) >= 2 ** 63` | The server converts values to 64-bit integers: `NaN` becomes 0, and infinite or huge values become the minimum or maximum.                                                                                                |
| 8   | `buckets-missing`        | `bucketValue`               | `buckets === undefined`                                                                  | o11y defaults to `[]`, and the server drops the series.                                                                                                                                                                   |
| 9   | `buckets-count`          | `bucketValue`               | an array whose `length` isn't an integer from 1 to 20                                    | The server drops the series.                                                                                                                                                                                              |
| 10  | `buckets-hole`           | `bucketValue`               | an array with an index `i < length` where `!Object.hasOwn(buckets, i)`                   | Poison: o11y's own check skips holes, and the encoder's verify step fails (`integer[] expected`).                                                                                                                         |
| 11  | `buckets-not-integer`    | `bucketValue`               | a number entry that isn't an integer: a fraction, `NaN` or `±Infinity`                   | Poison, repeated in every window that updates the series, because the first buckets stay pinned.                                                                                                                          |
| 12  | `buckets-out-of-range`   | `bucketValue`               | an integer entry below 0 or above 2147483647                                             | Entries go on the wire as uint32 and are read back as int32. Negative entries and entries from 2^31 read as negative, and the server drops the series. Entries of 2^32 or more can wrap silently to a different boundary. |
| 13  | `buckets-duplicate`      | `bucketValue`               | the same number appears twice (0 and -0 count as the same)                               | Colliding bucket labels on the server.                                                                                                                                                                                    |
| 14  | `tags-too-many`          | all                         | more than 19 own enumerable string keys, not counting `status` and `__proto__`           | The server keeps only the first 20 tags, and o11y always adds `status`.                                                                                                                                                   |
| 15  | `tag-surrogate`          | all                         | a key, or a string value, matches `/\p{Cs}/u`                                            | Poison, as for `operation-surrogate`.                                                                                                                                                                                     |
| 16  | `tag-infinite`           | all                         | a value of `Infinity` or `-Infinity`                                                     | o11y's series key writes both as `null`, so different series merge.                                                                                                                                                       |
| 17  | `tag-o11yapp`            | all                         | the key `o11yApp`                                                                        | The server keeps the caller's value instead of the app attribution.                                                                                                                                                       |
| 18  | `counter-overflow`       | `incrementCounter`          | the series' total in this window plus `Math.round(increment)` would exceed 2147483647    | The 32-bit total wraps on the server.                                                                                                                                                                                     |
| 19  | `budget`                 | all                         | the window's metric bytes plus this call's cost would exceed 131,072 (§7.2)              | An oversized body that the route rejects, losing the whole window.                                                                                                                                                        |
| 20  | `threw`                  | all                         | o11y threw, or taking the snapshot threw                                                 | o11y rejected the input and recorded nothing. Reported from the `catch`.                                                                                                                                                  |

Notes:

- An `increment` of `undefined` counts as 1.
- A non-number `increment` or `value`, or a non-number bucket entry, skips the numeric rules. The type gate (§6.1) then delegates the call, and o11y throws (`threw`).
- Rules 14 to 17 read the snapshot's own enumerable string keys (`Object.keys`) and their values, except `status` and `__proto__`. o11y overwrites `status` and drops an own `__proto__` before it keys or encodes the tags (§7.4). A `status` key only triggers the `tag-status` warning.
- `undefined` tags count as `{}` for rules 14 to 17, the series key and the §7.1 sum, as o11y's default parameters do. `undefined` is still what gets forwarded.

### 6.3 Warning rules

The call is still forwarded and recorded. The warning is reported with `console.warn` after o11y accepts the call. One call can trigger several warnings.

| Code                  | Applies to                  | Condition                                                                            | What gets stored                                                                                   |
| --------------------- | --------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `increment-fraction`  | `incrementCounter`          | a non-integer `increment` of at least 0.5                                            | o11y rounds it with `Math.round`.                                                                  |
| `value-fraction`      | `trackValue`, `bucketValue` | `0 < Math.abs(value) < 1`                                                            | The server truncates it to 0. Use integer units such as ms or bytes.                               |
| `value-negative`      | `bucketValue`               | `value < 0`                                                                          | The server's histogram maximum starts at 0. Other handling of negative values is unverified (§17). |
| `buckets-changed`     | `bucketValue`               | the buckets, sorted numerically, differ from the first ones recorded for this series | The first buckets win, on both the client and the server.                                          |
| `tags-map-or-set`     | all                         | `Object.prototype.toString.call(tags)` is `[object Map]` or `[object Set]`           | No tags. o11y reads only own enumerable keys, so the call lands in the untagged series.            |
| `tag-status`          | all                         | the key `status`                                                                     | Replaced with `success` or `error`, from `hasError`.                                               |
| `tag-monc-identifier` | all                         | the key `monc_identifier`                                                            | Overwritten by the server.                                                                         |
| `headless`            | all                         | `(O11yService.sharedUploadOwner ?? this).headlessMode`                               | Drained and discarded (§8).                                                                        |

### 6.4 Passed through without a message

- Unsorted buckets.
- Any other well-formed operation string, including whitespace, long or non-ASCII names, and `log`.
- The tag key `orgid`, in any case. The server may replace its value with the org ID; the README says so.
- The empty tag key `''`.
- Tag values that o11y turns into placeholder strings: `null` becomes `null`, `''` becomes `empty` and `NaN` becomes `NaN`. `undefined`, objects, functions, symbols and bigints become their `typeof` name. `-0` is sent as `0`.
- Number and boolean tag values. o11y sends every tag value with `toString()`, so `1` and `"1"` are one value on the wire. The methods forward them as strings, after rules 14 to 17, so that o11y and the guard key them as one series too (§7.4).
- Tags that are arrays, class instances or frozen objects. Tag keys that are symbols, non-enumerable or inherited, which o11y ignores.

Inputs that o11y rejects itself throw and are reported as `threw`:

- wrong argument types (the type gate, §6.1);
- an operation that is `''`, contains a backtick or equals `o11y-error`;
- `null` or non-object tags;
- `null` or non-array buckets, and non-number bucket entries;
- a new series beyond o11y's per-extension limits of 1000 counters, 500 value recorders and 500 histograms.

`MetricsTags` rules out most of these at compile time, but JavaScript callers and `as any` can still pass them.

### 6.5 Messages and rate limiting

Formats:

```text
[O11yService][<method>] Dropped metric <code>: <hint> (operation <op>)
[O11yService][<method>] Recorded metric with caveat <code>: <hint> (operation <op>)
```

- Rejects use `console.error`, and warnings use `console.warn`.
- `<op>` is `JSON.stringify(operation.slice(0, 80))` for a string. For anything else it is `of type <typeof operation>`.
- `<hint>` is a fixed sentence for each code that says what to change, for example `buckets must have 1 to 20 entries`. `REJECT_HINTS` and `WARN_HINTS` in `src/metricsGuard.ts` hold the exact wording.
- For `threw`, `<hint>` is the error's message cut to 200 characters. o11y's messages can quote the operation, but never a tag value.
- For `not-initialized`, `<hint>` contains `logEvent`'s phrase `Service not fully initialized`. It is followed by a second call, `console.error("Initialization status:", this.getInitializationStatus())`, as in `logEvent`. Both lines go out together, under one rate-limit decision.
- If earlier occurrences were suppressed, the line ends with `; <n> more since the last report`.
- Messages never include caller-supplied tag keys or values, bucket entries, or the API key.

Rate limiting:

- The state is per extension, keyed `<method>:<code>`. That gives at most 84 keys (3 methods × 28 codes), of which 54 can occur.
- The first occurrence of a key is logged. A later occurrence is logged only if at least 60 s (by `Date.now()`) have passed since that key was last logged, or if the clock has moved back since then, which would otherwise hide every repeat until the clock caught up. Otherwise it adds to the key's suppressed count, which the next logged line reports and resets. There are no timers.
- A call on an instance whose `extensionName` isn't set yet uses the state under the key `""`. `validateExtensionName` never accepts that name.

## 7. Upload sizing and guard state

### 7.1 Estimate

A process-wide counter, `metricsWindowBytes`, holds the guard's byte estimate for the current upload window. Each committed call adds:

- 8 bytes per `trackValue` or `bucketValue` value, which is a packed double on the wire. Counter increments add nothing, because a counter is one number per window.
- On the series' first call in the window, `S - 8` more bytes. The collector already counts 8 bytes per series updated in the window, and:

```text
S = 80 + b(operation) + b(extensionName)
       + sum over user tags of (9 + b(key) + b(String(value)))
       + (bucketValue ? 5 * k : 0)
```

`b()` is the UTF-8 byte length (`Buffer.byteLength`). The user tags are the sifted snapshot's own enumerable string keys, except `status` and `__proto__` (§7.4). The `status` tag that o11y adds is part of the 80.

`k` is the number of buckets the series carries on the wire: the count recorded in `firstBuckets` (§7.4), or, if none is recorded, the call's own. o11y sends a series' first buckets in every window.

So a counter series costs `S - 8` once per window. A value recorder or histogram costs `S` for its first value in the window and 8 for each later one.

On the 12 random-mix windows of a design probe (76 to 714 series, up to 13,065 values), the collector's estimate plus `metricsWindowBytes` came to between 1.06 and 1.12 times the encoded envelope size. The formula errs high, which is the safe direction: windows dominated by series come out near 1.1, and windows dominated by values near 1.0. Small windows, of a few KB, can come out up to about 300 bytes low, mostly because nothing counts the 84-byte envelope header or the full size of o11y's own metrics.

Where the estimate is used (`src/o11yService.ts`):

- The threshold check in `uploadAsNeededAsync` compares `simpleCollector.estimatedByteSize + metricsWindowBytes` with the threshold.
- `getBatchStatus()` adds `metricsWindowBytes` to `estimatedByteSize` when a shared collector exists. Without one, the value stays 0.
- `BatchStatus.estimatedByteSize` documents that it includes recorded metrics, in both `src/types/o11yService.types.ts` and `src/types/bundle.d.ts`.

For consumers that don't record metrics, `metricsWindowBytes` stays 0, so both numbers are unchanged. Existing `getBatchStatus` coverage is in `src/test/o11yService.test.ts`. The guard never reads `simpleCollector.metricsCount`, because that getter walks every series.

### 7.2 Budget

The `budget` rule rejects a call when `metricsWindowBytes` plus the call's cost would exceed 131,072 bytes, which is about 16,000 values. The rule stays in force until the next drain.

- **Why a hard cap.** A synchronous loop can fill the buffer before any timer or threshold check runs, and one oversized body loses the whole window. A better estimate alone can't prevent that.
- **Why 131,072.** On Core, the upload goes to the Connect route (`/services/data/v65.0/connect/proxy/ui-telemetry`) first, falling back to the static `o11yUploadEndpoint`. The static route answers 413 to a request body over 2^18 bytes. The body is `{"base64Env":"..."}`, which is 16 + 4 × ceil(n / 3) bytes for n raw envelope bytes, so the limit is 196,596 raw bytes. That is the only route limit found: the Connect route's and Falcon's are unknown (§17). A budget of 131,072 leaves at least about 50 KB of it for logs and o11y's own metrics. The budget doesn't count the collector's 8 bytes per series, and each series costs the guard at least 74 bytes, so at most about 1,770 series add about 14 KB on top.
- **Scope.** The budget is process-wide because the envelope is shared, so one extension can use it up for the others in a window.
- **Free calls.** A call that costs 0 bytes, which is an increment on a counter already touched in this window, is never rejected for budget.

With auto-batching, the 2 s check (`enableAutoBatching`) sees metric bytes and flushes at the threshold (50 KB by default), so the budget only bites on bursts. A `thresholdBytes` above 131,072 doesn't raise the budget.

### 7.3 One drain point

The `drain` closures in `buildTelemetryEmitter` use one private static helper:

```ts
class O11yService {
  private static drainSharedCollector(simpleCollector: SimpleCollector) {
    const contents = simpleCollector.getRawContentsOfCoreEnvelope();
    O11yService.resetMetricsWindow();
    return contents;
  }
}
```

Each closure uses `drain: () => O11yService.drainSharedCollector(simpleCollector)`.

`resetMetricsWindow()` zeroes `metricsWindowBytes` and clears every extension's touched series and counter totals. It runs in three places in `src/o11yService.ts`:

- **After each successful drain**, in the helper above. At the drain, o11y resets its counters and stops sending series until they are updated again, whatever then happens to the send. The drain runs synchronously at the start of the emitter's `flush()` (`src/telemetryEmitters.ts`), so no metric call can land between the drain and the reset.
- **Where the shared buffer is created**, next to `sharedUploadOwner = null`.
- **In the shared-initialization failure path**.

The first-buckets map and the rate limiter are not reset. o11y keeps a series' buckets for the life of the process, and the limiter works on elapsed time.

### 7.4 State and series key

Private statics on `O11yService`:

- `metricsWindowBytes: number`, process-wide.
- `metricsState: Map<string, ExtensionMetricsState>`, keyed by `extensionName`.

Each state entry has:

- `touchedSeries: Set<string>`: the series recorded in this window;
- `counterTotals: Map<string, number>`: the sum of rounded increments per counter series in this window;
- `firstBuckets: Map<string, { joined: string; count: number }>`: per histogram series, its first buckets, sorted numerically and joined into a string, and their count. It is kept across windows and holds at most 500 entries, o11y's own histogram limit;
- `limiter: Map<string, { lastLoggedAt: number; suppressed: number }>`.

The state is keyed by `extensionName`, not by instance. `getInstance` keys instances by `extensionId`, but o11y shares one instrumentation, with its series limits, per `extensionName`.

The series key is `<method>:<operation>` followed by `JSON.stringify` of the tag entries, sorted by key with the default `sort()` order, as o11y does. The tags are taken from the snapshot, with number and boolean values already turned into strings (§6.4), after the same sifting o11y applies:

- the placeholder values from §6.4;
- `status` set to `error` or `success`, from `hasError`;
- `__proto__` removed. o11y copies tags with `Object.assign`, which drops an own `__proto__` key, while `{ ...tags }` keeps it. The tag count (§6.2) and the size formula (§7.1) skip it for the same reason.

That is the identity o11y uses for its own series. So each key maps to exactly one o11y series. The guard records only series that o11y accepted, so the touched-series and counter-total maps are bounded by o11y's own series limits. Sifting first also stops `JSON.stringify` from throwing on a bigint.

## 8. Headless mode

The local-headless collector only receives logs, and the headless emitter drains without encoding or sending (`src/o11yService.ts`, `buildTelemetryEmitter`). So in headless mode, metrics are drained and discarded.

The methods still check and forward exactly as in upload mode, so a call behaves the same on every route. They also log the rate-limited `headless` warning. The window reset still runs at the headless drain.

Writing metrics to the local file would need `@o11y/local-headless` to accept metrics. That is not supported.

## 9. Implementation map

| File                                   | Responsibility                                                                                                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/metricsGuard.ts`                  | Reason codes, per-method checks (pure functions that return a code or `null`, like `validateExtensionName`), sift, series key, size formula and rate-limit decision. It doesn't import o11y, so it can be tested on its own. |
| `src/o11yService.ts`                   | Guard state; the three methods and `recordMetric`; `drainSharedCollector` and `resetMetricsWindow`; initialization resets; batch estimate; type re-exports; extension-name check (§16).                                      |
| `src/types/o11yService.types.ts`       | `MetricsTags`, the metric methods on the internal `Instrumentation`, and JSDoc on `BatchStatus.estimatedByteSize`.                                                                                                           |
| `src/types/bundle.d.ts`                | Shipped `MetricsTags` and metric methods, log-only public `Instrumentation`, and batch-size JSDoc.                                                                                                                           |
| `src/types/bundle.drift-guard.ts`      | Compile-time check (§10.3).                                                                                                                                                                                                  |
| `src/index.ts`                         | Export of `type MetricsTags`.                                                                                                                                                                                                |
| `src/test/o11yService.metrics.test.ts` | Unit tests (§10.1).                                                                                                                                                                                                          |
| `e2e/metrics-envelope.test.mjs`        | Real-o11y tests (§10.2).                                                                                                                                                                                                     |
| `package.json`                         | `"test:metrics-integration": "node --test e2e/metrics-envelope.test.mjs"`.                                                                                                                                                   |
| `tsconfig.typecheck.json`              | Includes the drift guard and `src/types/o11y.d.ts` (§10.3).                                                                                                                                                                  |
| `.github/workflows/pr-validation.yml`  | Strict type-check and real-o11y test steps (§10.4).                                                                                                                                                                          |
| `README.md`                            | Consumer metrics guidance and extension-name rules (§11, §16).                                                                                                                                                               |

`isInitialized()` and `bindInstrumentation` do not require metric methods. This preserves log-only instrumentation and test doubles in `src/test/o11yService.test.ts` and `packages/o11y-agent-stream`. An instrumentation without the metric methods makes the call throw inside the `try`, so it is reported as `threw`.

## 10. Testing

### 10.1 Unit tests

`src/test/o11yService.metrics.test.ts` mocks o11y through `loadO11yModules`, as `src/test/o11yService.test.ts` does. A separate file gives it fresh module statics. The `yarn test` CI step picks it up. It covers:

- delegation to the calling extension's own instrumentation, for two extensions, with the full fixed-arity argument list pinned by `toStrictEqual`;
- `not-initialized`, o11y throwing (no rethrow; `threw` logged), and the 60 s rate limit with its suppressed count, using a mocked `Date.now`, including a clock that moves back;
- `test.each` tables for every reject (§6.2), warning (§6.3) and pass-through (§6.4) row, asserting whether the delegate was called and which code was logged;
- the snapshot: the forwarded buckets are a copy, a tags getter runs once, and mutating the caller's objects after the call doesn't change what was forwarded;
- the type gate and hostile inputs, each asserting the code and whether the delegate was called;
- the series key: the same tags in another order, and a number or boolean tag value and its string form, are one series;
- commit after success: a call that o11y rejects leaves the window bytes, touched series and counter totals unchanged;
- the estimate (`getBatchStatus().estimatedByteSize` and the threshold decision), including a histogram series whose later calls pass fewer buckets than its first: the estimate keeps counting the first buckets;
- the budget and window reset on Core (fake `Connection` from `getConnection`), Falcon (placeholder key `unit-test-placeholder` and mocked `fetch`), and headless routes;
- the `headless` warning.

Hostile-input coverage includes:

- `undefined` tags forwarded as `undefined`;
- `null`, numeric and 25-character string tags, `null` buckets, and a numeric operation with the budget nearly full delegated and logged as `threw`;
- an array whose `length` was set to `2 ** 32 - 1` reporting `buckets-count` without delegating;
- an array with its own endless `Symbol.iterator` copied by index and forwarded;
- an array-like built on `Array.prototype` (`Object.setPrototypeOf({ 0: 1.5, length: 1 }, Array.prototype)`) reporting `buckets-not-integer`;
- a tags getter that throws a Proxy whose `getPrototypeOf` trap throws, or an `Error` whose `message` getter throws, logging `threw` with `unreadable error` and returning normally.

`yarn build` type-checks this file too (`tsconfig.json` includes `src/**/*.ts`), and CI builds before it tests. ts-jest doesn't type-check (`isolatedModules`), so a passing `yarn test` doesn't prove the file compiles. Rows whose inputs fall outside the §5 types pass them through `as any`: `Map`, `Set`, array, class-instance or non-object tags; object, function, symbol or bigint tag values; a non-number `increment` or `value`; non-array buckets or non-number entries; and omitted buckets. A bare `// @ts-expect-error` fails `eslint:ci`, which requires a description. Run `yarn build` as well as `yarn test`.

The tests never use a real Falcon key. Route assertions use the literal Connect path, rather than private upload fields or destination keys. The `dynamicO11yUploadEndpointPath` initialize option keeps its name.

### 10.2 Real-o11y test

`e2e/metrics-envelope.test.mjs` uses `node:test` against the built bundle (`dist/index.bundle.min.mjs`) and the real o11y package.

- It needs no network and no Falcon key. A fake `Connection` whose `requestPost` captures `base64Env` stands in for the org.
- It decodes the envelope with the protobufjs and `o11y_schema/sf_instrumentation` that o11y itself resolves (`createRequire` from `o11y/collectors`), using `coreEnvelopeSchema.pbjsSchema`, the type `sf.instrumentation.CoreEnvelope`, and `toObject` with `{ longs: Number, arrays: true, defaults: false }`.
- Assertions keep only the test's own owners, because o11y's self-metrics (owner `o11y`) ride in every envelope. They strip timestamps.

It checks that:

1. counters, value recorders and histograms decode with the expected names, values, buckets and tags. `hasError` shows up as the `status` tag. Later uploads carry deltas, and an idle flush posts nothing.
2. after typical poison calls (`bucketValue("poison", 5, [1.5, 10])` and `incrementCounter("poison", Infinity)`), the upload still goes through, and a second extension's log is still in it.
3. a rejected increment of 0 doesn't use up a counter slot. On a dedicated extension: 999 valid series, one rejected call, then a 1000th valid series records. The test flushes between batches to stay under the budget, because o11y's slots outlive flushes.
4. a burst beyond the budget is cut at 131,072 guard bytes, and the posted envelope is at most 196,596 raw bytes.
5. on a metrics-only window of 2,000 calls in the design probe's mix, `getBatchStatus().estimatedByteSize` is between 1.0 and 1.15 times the encoded envelope size. The mix comes from a seeded generator and uses five extensions and eight operations. Half the calls are counters, a quarter value recorders and a quarter histograms with 6 buckets, and half the calls carry 2 tags.

These checks span seven tests: initial recording and later/idle uploads have
separate tests, and another test checks that inputs delegated to o11y's own
validation are rejected without recording a series.

CI runs these checks (§10.4). During design, a throwaway version of checks 1 and 2 passed on Node 20.16.0 and 22.22.3. With the guard bypassed (calling `svc.instrumentation.bucketValue` directly), it failed as expected: no envelope was posted, so the peer's log was lost too. Probes showed the slot leak behind check 3; check 4's limit is arithmetic from the route limit (§7.2); and check 5's band comes from the design probe's 12 windows (§7.1).

### 10.3 Type drift guard

`src/types/bundle.d.ts` is maintained by hand and shipped verbatim as `dist/index.bundle.d.ts` (`scripts/bundle-build.js`). The bundle declaration is not automatically generated from the class, and `skipLibCheck` skips type-checking `.d.ts` files.

`src/types/bundle.drift-guard.ts` holds types only. `yarn build` compiles it, because `tsconfig.json` includes `src/**/*.ts`:

```ts
import type { MetricsTags as ImplMetricsTags } from "../index";
import type { O11yService as Impl } from "../o11yService";
import type {
  MetricsTags as ShippedMetricsTags,
  O11yService as Shipped,
} from "./bundle";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
type MetricMethod = "incrementCounter" | "trackValue" | "bucketValue";

export type MetricMethodsMatchShippedTypes = Assert<
  Equals<Pick<Impl, MetricMethod>, Pick<Shipped, MetricMethod>>
>;
export type MetricsTagsMatchShippedTypes = Assert<
  Equals<ImplMetricsTags, ShippedMetricsTags>
>;
```

- It checks exact type identity, not mutual assignability, because method parameters are bivariant. Mutual assignability would miss, for example, a narrowed tags type or a parameter that became optional.
- It covers only the metric members (`Pick`), because the rest of `bundle.d.ts` already drifts. `isInitialized`, `getInitializationStatus` and `waitForInitialization` are missing, and `initSimpleCollector` and `uploadAsNeededAsync` have the wrong return types.
- In a probe it caught 7 of 7 deliberate mismatches.
- `yarn build` isn't strict: `tsconfig.json` sets `noImplicitAny` but not `strict`. So it reads `number[] | undefined` as `number[]`, and misses an added `| undefined` or `| null`. `tsconfig.typecheck.json` therefore includes the guard too, with `src/types/o11y.d.ts`, which declares the o11y modules that the guard's imports reach, and the strict `yarn typecheck:headless` fails on those mismatches as well.
- `tsc` emits it under `dist/`, but it isn't in the package's `files`, so it isn't published.

### 10.4 CI

`.github/workflows/pr-validation.yml` runs:

- **Unit tests** in `yarn test` (the `validate` job, Node 20.x). The "Build project" step before it type-checks them (§10.1).
- **The drift guard** in `yarn build`, again inside `yarn package`, and in the strict `yarn typecheck:headless` (§10.3), right after "Build project".
- **The real-o11y test** through `yarn test:metrics-integration`, right after "Package project".
- **Formatting** through `format:ci` (`prettier --check .`), covering `.ts`, `.mjs` and `.md` files. `eslint:ci` lints only `.js` and `.ts` files.

## 11. Consumer documentation

The [README Metrics section](../README.md#metrics) covers:

- the three methods, with examples, and that, called on the service, they never throw;
- the names: upCounter is `incrementCounter`, and histogram is `bucketValue`;
- integer units such as ms or bytes, because the server truncates values to whole numbers;
- counters are 32-bit per upload window;
- low-cardinality tags. o11y's per-extension limits (1000 counters, 500 value recorders, 500 histograms) last for the whole process. The server allows 2000 series per extension per server JVM, and doesn't reset that until the JVM restarts;
- a series keeps the buckets from its first call, so changing them needs a new operation name;
- the reserved tag keys `status`, `o11yApp` and `monc_identifier`, and that the server may replace an `orgid` value with the org ID;
- the per-window budget, and what to do on `budget` errors (record fewer values per window, or flush more often);
- headless mode discards metrics;
- record metrics with these methods, not through `instrumentation`.

The `measurements` example also notes that measurements are fields on the logged event, not metrics.

## 12. Maintainer verification

When changing metrics validation or dependencies, run `yarn build`, `yarn test`,
`yarn typecheck:headless`, `yarn package`, and `yarn test:metrics-integration`.
Run `yarn format:ci` and `yarn eslint:ci` as well. The integration test consumes
the packaged bundle, so package before running it.

Recheck client validation and encoded CoreEnvelope sizes against server
integer, tag, bucket and route limits when either side changes. Appendix A
records the checked behaviour; §17 distinguishes unknowns from enforced limits.

## 13. Unsupported features and alternatives

- A second type check against o11y's own types is not included in the metrics drift guard.
- Writing metrics to the headless file needs metrics support in `@o11y/local-headless`.
- The `instrumentation` field is not deprecated, but remains log-only in the public types.

Considered and dropped:

- **Early flush** as soon as the guard bytes pass the threshold. The corrected estimate already makes the existing 2 s check fire, and the budget covers bursts that a flush couldn't split anyway. It would also need a process-wide "auto-batching is on" flag, but the batching timer is per instance.
- **A drain-generation counter**, with per-extension state reset lazily. Drains are synchronous and happen in one place, so resetting right there is simpler.

## 14. Known limitations

These are documented, not fixed:

- At runtime, the public `instrumentation` field still exposes o11y's unchecked metric methods, even though it is typed log-only. A poison value sent that way loses the whole shared window.
- o11y allows one registered app per loaded copy, and it registers the app before it sets the production flag. If another library in the process shares the reporter's copy of o11y and registers first, the reporter's registration throws, shared initialization fails, and every `logEvent` and metric call reports `not-initialized`. That is existing behaviour. A library that registers later throws before it can change the production flag, and a separate o11y copy has its own flag. Only a direct `utility.markProduction(true)` call on the reporter's copy (`o11y/shared` exports `utility`) makes o11y swallow its errors. Then the "o11y throws" cases (§6.4) log nothing, the guard's own rejects still work, and the guard may count bytes for calls that o11y dropped, which only makes the budget stricter.
- On Core's Connect route, the server skips the whole envelope, logs and metrics alike, while the org has instrumentation turned off. That is existing behaviour.

## 15. Risks

1. **Server cardinality is permanent per JVM.** The server tracks at most 2000 series per lowercased owner, in a set that is never cleared until the JVM restarts, and every org whose telemetry that JVM processes shares it. High-cardinality tags can block an extension's new series. Client limits can't prevent this.
2. **One metric scope.** The server puts every reporter metric in the same scope, which includes the registered app name `o11y-reporter-extensions`. Only the `monc_identifier` derived from the owner tells extensions apart.
3. **Data loss by design under bursts.** Calls past the budget are dropped, with a rate-limited error, rather than risking the whole window.
4. **Logs are outside the guard.** The collector's log estimate undercounts CJK text (about 0.65 times the real size), which eats into the margin under the static route's limit.
5. **Hot-path cost.** Building the series key (a sort plus `JSON.stringify`) runs on every call. That's fine at o11y's limits, but very hot counters pay it on each call.
6. **Poison costs two requests.** A rejected batch on the connection route is re-sent with the same body to the static endpoint. That only matters for poison that bypasses the guard, for example through `instrumentation`.
7. **Batch-size accounting.** `getBatchStatus().estimatedByteSize` includes metric bytes for consumers that record metrics.

## 16. Extension-name validation

`validateExtensionName` (`src/o11yService.ts`) rejects lone UTF-16 surrogates
with `/\p{Cs}/u`. The extension name is an envelope-level string, the owner of
every message and metric it records. A name containing a lone surrogate
poisons every envelope that carries that extension's data, logs included.

The check runs right after the blank-name check, before the checks whose
messages quote the name: a lone surrogate can't be encoded as UTF-8, so it
would garble the log line. The README's `extensionName` rules state it too.

## 17. Open questions

These are unverified:

- The body-size limits of Falcon and of Core's Connect route. They decide whether the 131,072-byte budget is enough on those routes. Only the static route's limit was found; the Connect route is served separately.
- The HTTP status Core returns for invalid UTF-8. Core uses the same parser, but 400 is verified only for Falcon.
- The metrics backend's rules for metric names, tag keys and tag values: character set, maximum length, the empty key and whitespace. Any of these could turn a pass-through case into a silent drop.
- Whether the server versions deployed on Falcon and Core match the server code read for the evidence below.
- Whether Core's bucket limit is 40, as its configuration says, rather than the default 20. The guard uses the stricter 20 either way.
- How the metrics publisher handles negative values in percentile sets and histograms.
- The server's production protection limits and the number of JVMs, which set the real fleet-wide cardinality budget per extension.
- Whether a 0-valued counter is kept. It only matters if the `0 < x < 0.5` rule were relaxed.
- Whether o11y exports its series limits as constants. The guard doesn't need them; the README quotes them.

## Appendix A. Evidence

Sources:

- **o11y:** the published o11y 266.23.0 package (`dist/modules/o11y`), read and run. All runtime behaviour was confirmed against it. The repo pins 266.24.0, whose changes don't touch metrics.
- **server:** the server code that receives uploads on Core and Falcon, and the metrics publishing behind it, as of release 266 (October 2026). It isn't public, so the table gives its behaviour without source references.
- **probes:** throwaway scripts run during design against o11y 266.23.0, plus a protobuf-java parse (3.22.3 and 3.25.5) of the captured envelopes. They aren't checked in; §10.2 keeps the key checks.

| Rule or claim                             | Verified behaviour                                                                                                                                                                                         | Checked in                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `isProduction: false` throws              | o11y rethrows when `!utility.isProduction`.                                                                                                                                                                | o11y                        |
| `operation-surrogate`, `tag-surrogate`    | o11y encodes the string, but the server's parser fails with `Protocol message had invalid UTF-8`, which Falcon maps to HTTP 400.                                                                           | server, probes              |
| `increment-not-positive`                  | o11y creates the series, then throws `UpCounter can only increment positive numbers.` After 999 valid series and one rejected call, the next new series throws `Max size of 1000 exceeded for UpCounters`. | o11y, probes                |
| `increment-infinite`                      | The encoder's verify step fails with `metrics.upCounters.value: integer expected`. A co-hosted extension's log in the same window was lost.                                                                | o11y, probes                |
| `increment-too-small`                     | o11y rounds 0.4 to 0, uses a slot and sends 0.                                                                                                                                                             | o11y, probes                |
| `increment-too-large`, `counter-overflow` | Counters are parsed as a Java `int`: 2^30 + 2^30 in one window reads back as -2147483648. o11y sums increments per window and resets them at the drain.                                                    | o11y, protobuf-java probe   |
| `value-out-of-range`, `value-fraction`    | The server converts values with `Double.longValue`: `NaN` becomes 0, `+Infinity` or at least 2^63 becomes `Long.MAX_VALUE`, `-Infinity` becomes `Long.MIN_VALUE`, and fractions are truncated.             | server                      |
| `value-negative`                          | The histogram maximum starts at 0.                                                                                                                                                                         | server                      |
| `buckets-missing`                         | o11y defaults buckets to `[]`. The server fails to build a histogram without buckets and drops the series, and Falcon still answers 202.                                                                   | o11y, server                |
| `buckets-count`                           | The server rejects an empty bucket list, and one longer than its bucket limit: 20 by default, which Falcon keeps, and 40 in Core's configuration.                                                          | server                      |
| `buckets-hole`                            | o11y validates bucket entries with `Object.entries`, which skips holes. The encoder's verify step then fails with `integer[] expected`.                                                                    | o11y, probes                |
| `buckets-not-integer`                     | `[1.5, 10]` fails the encoder's verify step in the first window, and again in every window that updates the series.                                                                                        | probes                      |
| `buckets-out-of-range`                    | -1 goes on the wire as 4294967295 and is read back as -1. 2^31 reads as -2147483648, and values of 2^32 or more wrap silently. The server rejects a negative bucket boundary and drops the series.         | server, protobuf-java probe |
| `buckets-duplicate`                       | A duplicated 0 produces colliding bucket labels.                                                                                                                                                           | server                      |
| `buckets-changed`                         | Neither o11y's series key nor the server's cache key includes buckets. o11y keeps the first array, and the server creates each histogram once, with the first buckets it receives.                         | o11y, server                |
| Forwarding a buckets copy                 | o11y keeps the caller's array and copies it only when reading. A `push(2.5)` after the call failed the next encode, and took another extension's log with it.                                              | o11y, probes                |
| `tags-too-many`                           | The server keeps the first 20 tags. o11y always adds `status`.                                                                                                                                             | server, o11y                |
| `tag-infinite`                            | o11y's series key uses `JSON.stringify`, which writes `Infinity` as `null`.                                                                                                                                | o11y                        |
| `tag-o11yapp`                             | The server adds `o11yApp` only when it is absent, so the caller's value wins.                                                                                                                              | server                      |
| `tag-status`                              | o11y overwrites `status` on its own copy, so the caller's object isn't mutated.                                                                                                                            | o11y                        |
| `tag-monc-identifier`                     | The server always overwrites it.                                                                                                                                                                           | server                      |
| `orgid` (passed through)                  | The server replaces the value with the org ID only for a blank value or a reserved placeholder, and only from an allow-listed org.                                                                         | server                      |
| `tags-map-or-set`                         | A `Map` or `Set` has no own enumerable keys, so o11y drops every tag.                                                                                                                                      | probes                      |
| Collector estimate                        | `estimatedByteSize` is the message size plus 8 per series updated since the last drain. Counting walks every series.                                                                                       | o11y                        |
| Core static route limit                   | Answers 413 when the request's `Content-Length` is over 2^18. The Connect route is served separately and wasn't checked.                                                                                   | server                      |
| Server cardinality                        | At most 2000 series per lowercased owner per JVM, in a set that is never cleared.                                                                                                                          | server                      |
| Metric naming                             | One scope for every reporter metric, with names built from the owner and operation.                                                                                                                        | server                      |
