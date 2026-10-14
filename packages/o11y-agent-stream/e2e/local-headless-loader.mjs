import { readFileSync } from "node:fs";
import { extname, isAbsolute, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";

const configuredRoot = process.env.O11Y_HEADLESS_CLIENT_ROOT;
let clientRoot;
let clientExports;
if (configuredRoot !== undefined) {
  if (!configuredRoot || !isAbsolute(configuredRoot)) {
    throw new Error(
      "O11Y_HEADLESS_CLIENT_ROOT must be an absolute local package directory",
    );
  }
  clientRoot = pathToFileURL(`${resolvePath(configuredRoot)}${sep}`);
  const manifest = JSON.parse(
    readFileSync(new URL("package.json", clientRoot), "utf8"),
  );
  if (manifest.name !== "o11y" || !manifest.exports) {
    throw new Error(
      "O11Y_HEADLESS_CLIENT_ROOT must contain the o11y package exports",
    );
  }
  clientExports = manifest.exports;
}

/**
 * Select an explicitly configured local client and repair local-headless relative imports.
 * @param {string} specifier Requested module.
 * @param {object} context Node resolution context.
 * @param {Function} nextResolve Next resolver.
 * @returns {Promise<object>} Resolution retaining normal published schema lookup.
 * @throws {Error} On an invalid local root, missing export or unbuilt module; never falls back.
 */
export async function resolve(specifier, context, nextResolve) {
  if (clientRoot && (specifier === "o11y" || specifier.startsWith("o11y/"))) {
    const key = specifier === "o11y" ? "." : `.${specifier.slice(4)}`;
    const target = clientExports[key];
    if (typeof target !== "string" || !target.startsWith("./")) {
      throw new Error(`Unsupported local o11y export: ${specifier}`);
    }
    return nextResolve(new URL(target, clientRoot).href, context);
  }
  if (
    context.parentURL?.includes("/node_modules/@o11y/local-headless/dist/") &&
    specifier.startsWith(".") &&
    !extname(specifier)
  ) {
    return nextResolve(`${specifier}.js`, context);
  }
  return nextResolve(specifier, context);
}
