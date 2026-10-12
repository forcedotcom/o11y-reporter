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
 * Compile-time conformance check against the REAL @o11y/local-headless types.
 *
 * o11y-reporter deliberately does NOT depend on @o11y/local-headless at runtime: the
 * consumer owns the dependency and injects a LocalCollector instance, which we register
 * on the shared app through the structural {@link LocalHeadlessCollector} contract (see
 * src/types/o11yService.types.ts). This file asserts, at compile time only, that the real
 * LocalCollector actually satisfies that contract — so if the package's collect()/close()
 * surface ever drifts, this fails to typecheck.
 *
 * It lives OUTSIDE the runtime build/jest graph (its own tsconfig.typecheck.json with
 * bundler module resolution) because our shipped code compiles as CommonJS (module:node16)
 * and @o11y/local-headless is ESM-only — a CJS module cannot even reference its types.
 * `import type` here is erased entirely; nothing is emitted. Run via `yarn typecheck:headless`.
 */
import type { LocalCollector } from "@o11y/local-headless";
import type { LocalHeadlessCollector } from "../src/types/o11yService.types";

type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

// A class name in type position is its instance type; if LocalCollector stops matching the
// LocalHeadlessCollector contract, `Extends<...>` becomes `false` and `Assert<true>` errors.
// Exported so `noUnusedLocals` treats it as used — its mere existence IS the assertion.
export type LocalCollectorConformsToContract = Assert<
  Extends<LocalCollector, LocalHeadlessCollector>
>;
