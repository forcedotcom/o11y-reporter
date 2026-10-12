/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: "node",
  rootDir: "src",
  testMatch: ["**/__tests__/**/*.test.ts"],
  transform: {
    "^.+\\.[tj]sx?$": [
      "ts-jest",
      { tsconfig: { allowJs: true, checkJs: false } },
    ],
  },
  transformIgnorePatterns: ["/node_modules/(?!(o11y|o11y_schema)/)"],
  testTimeout: 10000,
};
