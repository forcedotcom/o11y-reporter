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

/**
 * Input checks for the O11yService metric methods (incrementCounter, trackValue, bucketValue).
 *
 * Pure functions with no o11y import and no service state, so they can be tested on their own.
 * Each check returns a reason code, or null when the input passes, like validateExtensionName.
 * O11yService.recordMetric runs them in order, forwards accepted calls to o11y, and
 * keeps the per-window state.
 */

export type MetricMethod = "incrementCounter" | "trackValue" | "bucketValue";

/** Why a call was dropped. */
export type RejectCode =
  | "not-initialized"
  | "operation-surrogate"
  | "increment-not-positive"
  | "increment-infinite"
  | "increment-too-small"
  | "increment-too-large"
  | "value-out-of-range"
  | "buckets-missing"
  | "buckets-count"
  | "buckets-hole"
  | "buckets-not-integer"
  | "buckets-out-of-range"
  | "buckets-duplicate"
  | "tags-too-many"
  | "tag-surrogate"
  | "tag-infinite"
  | "tag-o11yapp"
  | "counter-overflow"
  | "budget"
  | "threw";

/** A reject with a fixed hint in {@link REJECT_HINTS}; a "threw" line carries the error's message. */
export type HintedRejectCode = Exclude<RejectCode, "threw">;

/** Why a recorded call may not show up exactly as written. */
export type WarnCode =
  | "increment-fraction"
  | "value-fraction"
  | "value-negative"
  | "buckets-changed"
  | "tags-map-or-set"
  | "tag-status"
  | "tag-monc-identifier"
  | "headless";

export const REJECT_HINTS: Record<HintedRejectCode, string> = {
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

export const WARN_HINTS: Record<WarnCode, string> = {
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

// These limits, and the o11y and server behavior the rest of this file encodes, were checked
// against o11y 266.23.0 and 266.24.0 and the server's release 266 (October 2026). Recheck them
// when either side changes: compare client validation and encoded CoreEnvelope sizes with
// server integer/tag/bucket limits. REJECT_HINTS repeats the enforced numbers.
// See docs/metrics-api.md, sections 6-8 and Appendix A, for rules, sizing, and evidence.

/** The server reads counters and bucket entries as a 32-bit int. */
export const MAX_INT32 = 2147483647;
/** Process-wide 128 KiB metric budget; leaves room for logs below the 196,596-byte raw route limit. */
export const METRICS_BUDGET_BYTES = 131072;
/** The server's default limit on buckets per histogram. Falcon keeps it; Core may allow 40. */
export const MAX_BUCKETS = 20;
/** The server keeps 20 tags, and o11y always adds `status`. */
export const MAX_USER_TAGS = 19;
/** o11y's per-extension histogram limit; bounds the first-buckets map. */
export const MAX_FIRST_BUCKETS = 500;
/** Minimum time between two console lines for the same `<method>:<code>` key. */
export const LOG_INTERVAL_MS = 60_000;

// A lone UTF-16 surrogate is invalid UTF-8, so the server rejects the whole envelope.
const LONE_SURROGATE = /\p{Cs}/u;

/** A call's arguments after the snapshot step, as recordMetric checks and forwards them. */
export interface MetricCall {
  method: MetricMethod;
  operation: unknown;
  /** `increment` for incrementCounter; `value` for trackValue and bucketValue. */
  amount: unknown;
  /** The buckets snapshot; set for bucketValue only. */
  buckets?: BucketsSnapshot;
  hasError: unknown;
  /** A `{ ...tags }` copy for a non-null object; otherwise the caller's value, unchanged. */
  tags: unknown;
}

export interface BucketsSnapshot {
  /** What gets forwarded: the copy when one was made, otherwise the caller's value. */
  value: unknown;
  /** Whether the caller's value passes o11y's test (`Array.isArray` or `instanceof Array`). */
  isArray: boolean;
  /** The copied entries; undefined unless an array's length is an integer from 1 to 20. */
  entries: unknown[] | undefined;
  /** Whether some index below the length is not an own property of the caller's array. */
  hasHole: boolean;
}

export interface ExtensionMetricsState {
  /** Series recorded in the current upload window. */
  touchedSeries: Set<string>;
  /** Per counter series, the sum of rounded increments in the current upload window. */
  counterTotals: Map<string, number>;
  /** Per histogram series, its first buckets (sorted, joined) and their count. Never reset. */
  firstBuckets: Map<string, { joined: string; count: number }>;
  /** Rate-limit state per `<method>:<code>` key. Never reset. */
  limiter: Map<string, LimiterEntry>;
}

export interface LimiterEntry {
  lastLoggedAt: number;
  suppressed: number;
}

export type SiftedTag = [key: string, value: string | number | boolean];

export function createMetricsState(): ExtensionMetricsState {
  return {
    touchedSeries: new Set(),
    counterTotals: new Map(),
    firstBuckets: new Map(),
    limiter: new Map(),
  };
}

/**
 * Copy bucketValue's buckets once, so later checks and o11y see the same entries and a later
 * change to the caller's array can't reach o11y, which keeps the array by reference. `length` is
 * read once, and only 1 to 20 entries are copied, by index: `Array.from` or spread would walk a
 * huge `length` or the caller's own iterator, which can exhaust memory before any check runs.
 */
export function snapshotBuckets(buckets: unknown): BucketsSnapshot {
  if (!(Array.isArray(buckets) || buckets instanceof Array)) {
    return {
      value: buckets,
      isArray: false,
      entries: undefined,
      hasHole: false,
    };
  }
  const source = buckets as unknown[];
  const length: unknown = source.length;
  if (
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < 1 ||
    length > MAX_BUCKETS
  ) {
    return {
      value: buckets,
      isArray: true,
      entries: undefined,
      hasHole: false,
    };
  }
  const entries: unknown[] = [];
  let hasHole = false;
  for (let i = 0; i < length; i++) {
    if (!Object.hasOwn(source, i)) {
      hasHole = true;
    }
    entries.push(source[i]);
  }
  return { value: entries, isArray: true, entries, hasHole };
}

/** Check operation, amount, then buckets; report the first failure. Skip mismatched types for o11y. */
export function checkArguments(call: MetricCall): HintedRejectCode | null {
  if (
    typeof call.operation === "string" &&
    LONE_SURROGATE.test(call.operation)
  ) {
    return "operation-surrogate";
  }
  const amountCode =
    call.method === "incrementCounter"
      ? checkIncrement(call.amount)
      : checkValue(call.amount);
  if (amountCode) {
    return amountCode;
  }
  return call.buckets ? checkBuckets(call.buckets) : null;
}

function checkIncrement(increment: unknown): HintedRejectCode | null {
  if (typeof increment !== "number") {
    return null;
  }
  if (!(increment > 0)) {
    return "increment-not-positive";
  }
  if (increment === Infinity) {
    return "increment-infinite";
  }
  if (increment < 0.5) {
    return "increment-too-small";
  }
  if (Math.round(increment) > MAX_INT32) {
    return "increment-too-large";
  }
  return null;
}

function checkValue(value: unknown): HintedRejectCode | null {
  if (typeof value !== "number") {
    return null;
  }
  return !Number.isFinite(value) || Math.abs(value) >= 2 ** 63
    ? "value-out-of-range"
    : null;
}

function checkBuckets(buckets: BucketsSnapshot): HintedRejectCode | null {
  if (!buckets.isArray) {
    return buckets.value === undefined ? "buckets-missing" : null;
  }
  if (buckets.entries === undefined) {
    return "buckets-count";
  }
  if (buckets.hasHole) {
    return "buckets-hole";
  }
  const numbers = buckets.entries.filter(
    (entry): entry is number => typeof entry === "number",
  );
  if (numbers.some((entry) => !Number.isInteger(entry))) {
    return "buckets-not-integer";
  }
  if (numbers.some((entry) => entry < 0 || entry > MAX_INT32)) {
    return "buckets-out-of-range";
  }
  // A Set compares with SameValueZero, so 0 and -0 count as the same entry.
  return new Set(numbers).size !== numbers.length ? "buckets-duplicate" : null;
}

/**
 * Whether an argument has a type that o11y rejects before it records anything. Such
 * a call is forwarded without the remaining checks or accounting, and o11y's throw is reported
 * as "threw".
 */
export function failsTypeGate(call: MetricCall): boolean {
  if (typeof call.operation !== "string") {
    return true;
  }
  if (call.method === "incrementCounter") {
    if (call.amount !== undefined && typeof call.amount !== "number") {
      return true;
    }
  } else if (typeof call.amount !== "number") {
    return true;
  }
  if (call.buckets) {
    if (!call.buckets.isArray && call.buckets.value !== undefined) {
      return true;
    }
    if (call.buckets.entries?.some((entry) => typeof entry !== "number")) {
      return true;
    }
  }
  if (call.hasError !== undefined && typeof call.hasError !== "boolean") {
    return true;
  }
  return (
    call.tags !== undefined &&
    (typeof call.tags !== "object" || call.tags === null)
  );
}

/**
 * The tag keys that reach the wire as written: own enumerable string keys, except `status`, which
 * o11y overwrites, and `__proto__`, which o11y's `Object.assign` copy drops.
 */
function userTagKeys(tags: Record<string, unknown>): string[] {
  return Object.keys(tags).filter(
    (key) => key !== "status" && key !== "__proto__",
  );
}

/** Check tag count, UTF-16, infinities, then reserved o11yApp; `undefined` counts as `{}`. */
export function checkTags(
  tags: Record<string, unknown> | undefined,
): HintedRejectCode | null {
  if (tags === undefined) {
    return null;
  }
  const keys = userTagKeys(tags);
  if (keys.length > MAX_USER_TAGS) {
    return "tags-too-many";
  }
  if (
    keys.some((key) => {
      const value = tags[key];
      return (
        LONE_SURROGATE.test(key) ||
        (typeof value === "string" && LONE_SURROGATE.test(value))
      );
    })
  ) {
    return "tag-surrogate";
  }
  if (keys.some((key) => tags[key] === Infinity || tags[key] === -Infinity)) {
    return "tag-infinite";
  }
  return keys.includes("o11yApp") ? "tag-o11yapp" : null;
}

/** o11y's placeholder for a tag value it can't send as is. */
function siftValue(value: unknown): string | number | boolean {
  if (value === null) {
    return "null";
  }
  if (value === "") {
    return "empty";
  }
  if (Number.isNaN(value)) {
    return "NaN";
  }
  const type = typeof value;
  return type === "number" || type === "string" || type === "boolean"
    ? (value as string | number | boolean)
    : type;
}

/**
 * The tags as o11y keys and sends them: placeholder values, `status` set from `hasError`, and
 * `__proto__` dropped, sorted by key with the default `sort()` order.
 */
export function siftTags(
  tags: Record<string, unknown> | undefined,
  hasError: unknown,
): SiftedTag[] {
  const source = tags ?? {};
  return [...userTagKeys(source), "status"]
    .sort()
    .map(
      (key): SiftedTag => [
        key,
        key === "status"
          ? hasError
            ? "error"
            : "success"
          : siftValue(source[key]),
      ],
    );
}

/** One key per o11y series: the method, the operation and the sifted tags. */
export function seriesKey(
  method: MetricMethod,
  operation: string,
  sifted: SiftedTag[],
): string {
  return `${method}:${operation}${JSON.stringify(sifted)}`;
}

/**
 * Estimate one series with one value: 80 bytes of framing including o11y's `status` tag,
 * UTF-8 operation/extension names, 9 bytes plus UTF-8 key/value lengths per user tag,
 * and 5 bytes per histogram bucket. Later recorded values cost 8 bytes each;
 * counter updates reuse the series total. `bucketCount` is the on-wire bucket count.
 */
export function seriesSize(
  method: MetricMethod,
  operation: string,
  extensionName: string,
  sifted: SiftedTag[],
  bucketCount: number,
): number {
  let size =
    80 + Buffer.byteLength(operation) + Buffer.byteLength(extensionName);
  for (const [key, value] of sifted) {
    if (key !== "status") {
      size += 9 + Buffer.byteLength(key) + Buffer.byteLength(String(value));
    }
  }
  return method === "bucketValue" ? size + 5 * bucketCount : size;
}

/** Buckets sorted numerically and joined, to compare a call's buckets with a series' first ones. */
export function sortedBucketsKey(entries: readonly number[]): string {
  return [...entries].sort((a, b) => a - b).join(",");
}

export interface WarningFlags {
  /** The caller's tags were a Map or Set (read before the copy dropped their entries). */
  tagsMapOrSet: boolean;
  bucketsChanged: boolean;
  headless: boolean;
}

/** Warnings after acceptance, ordered by amount, buckets, tags, then headless delivery. */
export function metricWarnings(
  call: MetricCall,
  flags: WarningFlags,
): WarnCode[] {
  const warnings: WarnCode[] = [];
  const amount = call.amount;
  if (call.method === "incrementCounter") {
    // The reject rules already ruled out increments below 0.5.
    if (typeof amount === "number" && !Number.isInteger(amount)) {
      warnings.push("increment-fraction");
    }
  } else if (typeof amount === "number") {
    if (Math.abs(amount) > 0 && Math.abs(amount) < 1) {
      warnings.push("value-fraction");
    }
    if (call.method === "bucketValue" && amount < 0) {
      warnings.push("value-negative");
    }
  }
  if (flags.bucketsChanged) {
    warnings.push("buckets-changed");
  }
  if (flags.tagsMapOrSet) {
    warnings.push("tags-map-or-set");
  }
  const tags = call.tags as Record<string, unknown> | undefined;
  if (tags !== undefined && Object.hasOwn(tags, "status")) {
    warnings.push("tag-status");
  }
  if (tags !== undefined && Object.hasOwn(tags, "monc_identifier")) {
    warnings.push("tag-monc-identifier");
  }
  if (flags.headless) {
    warnings.push("headless");
  }
  return warnings;
}

/**
 * The rate-limit decision for one `<method>:<code>` key. Returns the number of occurrences
 * suppressed since the key was last logged when this one should be logged, or null when it
 * should be suppressed. The first occurrence is always logged, and so is one after the clock
 * moved back, which would otherwise hide every repeat until the clock caught up.
 */
export function shouldLog(
  limiter: Map<string, LimiterEntry>,
  key: string,
  now: number,
): number | null {
  const entry = limiter.get(key);
  if (!entry) {
    limiter.set(key, { lastLoggedAt: now, suppressed: 0 });
    return 0;
  }
  const elapsed = now - entry.lastLoggedAt;
  if (elapsed >= 0 && elapsed < LOG_INTERVAL_MS) {
    entry.suppressed++;
    return null;
  }
  const suppressed = entry.suppressed;
  entry.lastLoggedAt = now;
  entry.suppressed = 0;
  return suppressed;
}

/**
 * One rate-limited console line. It never quotes tag keys or values, or bucket entries; the
 * operation is cut to 80 characters.
 */
export function formatMetricMessage(
  kind: "reject" | "warn",
  method: MetricMethod,
  code: RejectCode | WarnCode,
  hint: string,
  operation: unknown,
  suppressed: number,
): string {
  const op =
    typeof operation === "string"
      ? JSON.stringify(operation.slice(0, 80))
      : `of type ${typeof operation}`;
  const outcome =
    kind === "reject" ? "Dropped metric" : "Recorded metric with caveat";
  const more =
    suppressed > 0 ? `; ${suppressed} more since the last report` : "";
  return `[O11yService][${method}] ${outcome} ${code}: ${hint} (operation ${op})${more}`;
}

/**
 * The hint for a "threw" line: the error's message, cut to 200 characters. Reading a thrown value
 * can run caller code (a Proxy's getPrototypeOf trap for `instanceof`, a `message` getter), so
 * this never throws: it falls back to the value's `typeof`, or to "unreadable error".
 */
export function describeError(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message: unknown = error.message;
      if (typeof message === "string") {
        return message.slice(0, 200);
      }
    }
    return typeof error;
  } catch {
    return "unreadable error";
  }
}
