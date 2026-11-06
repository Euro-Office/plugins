// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Builds the chat sidebar into ../../sidebar (committed, see README.md).
// Library mode with a classic IIFE script: no module script, so the page
// also works from file:// (desktop editors), and fixed file names without
// hashes, so the committed output only changes when the sources do.
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const outDir = fileURLToPath(new URL("../../sidebar", import.meta.url));

// Licence banner of the committed sidebar.js: ours plus the bundled Preact
// (MIT, its licence text has to travel with the copy).
const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const preactVersion = JSON.parse(read("package-lock.json")).packages["node_modules/preact"].version;
const banner = [
	"/*!",
	" * SPDX-FileCopyrightText: Euro-Office contributors",
	" * SPDX-License-Identifier: AGPL-3.0-only",
	" * Built from https://github.com/Euro-Office/plugins/tree/master/sdkjs-plugins/content/ai/.dev/sidebar",
	" *",
	" * Includes Preact " + preactVersion + " (https://preactjs.com), licensed under the MIT License:",
	" *",
	...read("node_modules/preact/LICENSE").trim().split("\n").map((line) => (" * " + line).trimEnd()),
	" */"
].join("\n");

const cssBanner = "/*! SPDX-FileCopyrightText: Euro-Office contributors | SPDX-License-Identifier: AGPL-3.0-only */";

// Added after minification, which drops comments (rollup's output.banner too).
const licenceBanner = {
	name: "licence-banner",
	enforce: "post" as const,
	generateBundle(_: unknown, bundle: Record<string, { type: string; fileName: string; code?: string; source?: string | Uint8Array }>) {
		for (const file of Object.values(bundle)) {
			if (file.type === "chunk" && file.fileName.endsWith(".js"))
				file.code = banner + "\n" + file.code;
			else if (file.type === "asset" && file.fileName.endsWith(".css"))
				file.source = cssBanner + "\n" + String(file.source);
		}
	}
};

export default defineConfig({
	plugins: [licenceBanner],
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
