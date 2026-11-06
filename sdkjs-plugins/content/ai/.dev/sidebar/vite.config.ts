// SPDX-License-Identifier: AGPL-3.0-only
//
// Builds the chat sidebar into ../../sidebar (committed, see README.md).
// Library mode with a classic IIFE script: no module script, so the page
// also works from file:// (desktop editors), and fixed file names without
// hashes, so the committed output only changes when the sources do.
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const outDir = fileURLToPath(new URL("../../sidebar", import.meta.url));

export default defineConfig({
	esbuild: { jsx: "automatic", jsxImportSource: "preact", legalComments: "none" },
	build: {
		outDir,
		emptyOutDir: true,
		target: "es2019",
		cssCodeSplit: false,
		lib: {
			entry: fileURLToPath(new URL("src/main.tsx", import.meta.url)),
			formats: ["iife"],
			name: "EOChatSidebar",
			fileName: () => "sidebar.js",
			cssFileName: "sidebar"
		}
	},
	test: {
		environment: "jsdom",
		include: ["src/**/*.test.tsx", "src/**/*.test.ts"],
		setupFiles: ["src/test-setup.ts"]
	}
});
