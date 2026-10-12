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

declare module "o11y_schema/version" {
  export const version: string;
}

declare module "o11y_schema/sf_a4dInstrumentation" {
  export const a4dInstrumentationSchema: unknown;
}

declare module "o11y/collectors";
declare module "o11y/simple_collector";
type Environment =
  import("o11y/dist/modules/o11y/client/interfaces").Environment;
type Instrumentation =
  import("o11y/dist/modules/o11y/client/interfaces").Instrumentation;
type InstrumentedAppMethods =
  import("o11y/dist/modules/o11y/client/interfaces").InstrumentedAppMethods;
type InstrumentedAppOptions =
  import("o11y/dist/modules/o11y/client/interfaces").InstrumentedAppOptions;
type ConsoleCollector =
  import("o11y/dist/modules/o11y/client/client").ConsoleCollector;
type SimpleCollector =
  import("o11y/dist/modules/o11y/collectors/simple_collector").SimpleCollector;
type ProtoEncoderFuncType = (input: unknown) => Uint8Array;
