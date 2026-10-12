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

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

let cachedModules: Promise<{
  o11yClientVersion: string;
  getInstrumentation: (name?: string) => Instrumentation;
  o11ySchemaVersion: string;
  registerInstrumentedApp: (
    name: string,
    options?: InstrumentedAppOptions,
  ) => InstrumentedAppMethods;
  ConsoleCollector: ConsoleCollector;
  a4d_instrumentation: unknown;
  simpleCollectorModule: any;
  collectorsModule: any;
}> | null = null;

export const loadO11yModules = async (): Promise<
  Awaited<typeof cachedModules>
> => {
  if (!cachedModules) {
    cachedModules = (async () => {
      const [
        o11yClient,
        o11ySchema,
        a4dInstrumentationModule,
        simpleCollectorModule,
        collectorsModule,
      ] = await Promise.all([
        import("o11y/client"),
        import("o11y_schema/version"),
        import("o11y_schema/sf_a4dInstrumentation"),
        import("o11y/simple_collector"),
        import("o11y/collectors"),
      ]);

      const {
        registerInstrumentedApp,
        ConsoleCollector,
        _version: o11yClientVersion,
        getInstrumentation,
      } = o11yClient;
      const { version: o11ySchemaVersion } = o11ySchema;

      return {
        o11yClientVersion,
        getInstrumentation,
        o11ySchemaVersion,
        registerInstrumentedApp,
        ConsoleCollector,
        a4d_instrumentation: a4dInstrumentationModule.a4dInstrumentationSchema,
        simpleCollectorModule,
        collectorsModule,
      };
    })();
  }
  return cachedModules;
};
