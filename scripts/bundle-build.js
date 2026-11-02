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

// scripts/bundle-build.js

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

async function bundle() {
  try {
    // Build CommonJS bundle
    await esbuild.build({
      entryPoints: ["./src/index.ts"],
      bundle: true,
      platform: "node",
      target: "node20",
      outfile: "./dist/index.bundle.min.cjs",
      format: "cjs",
      minify: true,
      treeShaking: true,
      sourcemap: false,
      external: ["o11y", "o11y_schema"],
      banner: {
        js: "/* o11y-reporter - A wrapper service around o11y and o11y_schema for telemetry reporting */",
      },
    });

    // Build ESM bundle
    await esbuild.build({
      entryPoints: ["./src/index.ts"],
      bundle: true,
      platform: "node",
      target: "node20",
      outfile: "./dist/index.bundle.min.mjs",
      format: "esm",
      minify: true,
      treeShaking: true,
      sourcemap: false,
      external: ["o11y", "o11y_schema"],
      banner: {
        js: "/* o11y-reporter - A wrapper service around o11y and o11y_schema for telemetry reporting */",
      },
    });

    // Copy the bundled TypeScript declarations
    const bundleDtsPath = path.join(__dirname, "../src/types/bundle.d.ts");
    const outputDtsPath = path.join(__dirname, "../dist/index.bundle.d.ts");

    if (fs.existsSync(bundleDtsPath)) {
      fs.copyFileSync(bundleDtsPath, outputDtsPath);
      console.log("Bundled TypeScript declarations copied successfully.");
    } else {
      console.error("Bundle TypeScript declarations template not found!");
      process.exit(1);
    }

    console.log("Bundle build completed successfully.");
  } catch (error) {
    console.error("Bundle build failed:", error);
    process.exit(1);
  }
}

bundle();
