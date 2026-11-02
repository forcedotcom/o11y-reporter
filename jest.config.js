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

/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.[tj]sx?$": ["ts-jest", {}],
  },
  // The root project owns only its own src/ tests. Workspace packages under
  // packages/* carry their own jest.config.js (e.g. o11y-agent-stream widens
  // transformIgnorePatterns for pure-ESM o11y/o11y_schema); excluding them here
  // keeps `yarn test` (jest --testPathPattern=src/) from sweeping their suites
  // in under this config and failing on ESM syntax. Run them via
  // `yarn workspace <pkg> test`.
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/packages/"],
  testTimeout: 10000,
};
