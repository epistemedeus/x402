import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

const packageRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Resolves `@x402/evm` subpaths through this package's published export map.
 * The integration consumer loads `dist`, and the map moves with the worktree.
 *
 * @returns Vite plugin that reads this package's export map.
 */
function evmPackageExport(): Plugin {
  return {
    name: "evm-package-export",
    enforce: "pre",
    resolveId(source) {
      const prefix = "@x402/evm";
      if (source !== prefix && !source.startsWith(`${prefix}/`)) {
        return null;
      }
      const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
        exports: Record<string, { import?: { default?: string } }>;
      };
      const subpath = source === prefix ? "." : `.${source.slice(prefix.length)}`;
      const target = pkg.exports[subpath]?.import?.default;
      if (typeof target !== "string") {
        return null;
      }
      return join(packageRoot, target);
    },
  };
}

export default defineConfig(({ mode }) => ({
  test: {
    env: loadEnv(mode, process.cwd(), ""),
    include: ["test/integrations/**/*.test.ts"],
    fileParallelism: false,
  },
  plugins: [evmPackageExport(), tsconfigPaths({ projects: ["."] })],
}));
