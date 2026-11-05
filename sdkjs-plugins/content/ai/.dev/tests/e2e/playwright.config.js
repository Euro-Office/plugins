// SPDX-License-Identifier: AGPL-3.0-only
//
// Opt-in e2e test. Needs a running Document Server with this plugin
// (./start-server.sh) on http://localhost and a Chromium:
//   npx playwright install chromium     (or set CHROME_PATH to a local Chrome)
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "*.spec.js",
	timeout: 180000,
	retries: 0,
	reporter: [["list"]],
	use: {
		baseURL: process.env.E2E_BASE_URL || "http://localhost",
		viewport: { width: 1400, height: 900 },
		launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] } : {},
		screenshot: "only-on-failure",
		trace: "retain-on-failure"
	}
});
