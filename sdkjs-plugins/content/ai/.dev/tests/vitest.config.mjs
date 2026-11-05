// SPDX-License-Identifier: AGPL-3.0-only
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
	test: {
		include: ["tests/**/*.test.js"],
		environment: "node",
		testTimeout: 10000,
		coverage: {
			// Plugin scripts run inside node:vm, which v8 coverage cannot
			// attribute to files reliably; coverage therefore reports the
			// test tooling itself plus anything imported as a module.
			provider: "v8",
			reporter: ["text-summary", "text"],
			include: [pluginDir + "/scripts/**/*.js"],
			exclude: ["**/node_modules/**", "**/vendor/**"],
			allowExternal: true
		}
	}
});
