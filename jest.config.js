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
