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

// Compile-time check that the hand-written bundle.d.ts, shipped as dist/index.bundle.d.ts,
// declares the metric methods and MetricsTags exactly as the implementation does. Types only;
// `yarn build` fails on a mismatch, and so does `yarn typecheck:headless`, which CI runs. Only
// the latter is strict, so only it sees an added `| undefined` or `| null`. Exact identity, not
// mutual assignability, because method parameters are bivariant.
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
