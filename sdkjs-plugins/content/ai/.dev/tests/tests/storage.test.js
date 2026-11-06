// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// AI.Storage.load (scripts/engine/local_storage.js): which settings win and
// which versions are accepted.

import { describe, test, expect, beforeEach } from "vitest";
import { createSandbox, createLocalStorage } from "../lib/sandbox.js";

const MODEL = { id: "vendor/model-1", name: "vendor/model-1", provider: "Custom", capabilities: 257 };

function settings(version) {
	return {
		version,
		providers: { Custom: { name: "Custom", url: "https://llm.example/v1", key: "", models: [{ id: MODEL.id, name: MODEL.name, endpoints: [1], options: {} }] } },
		models: [MODEL],
		actions: { Chat: { model: MODEL.id } }
	};
}

let sb;

beforeEach(() => {
	sb = createSandbox({
		Asc: { plugin: { info: {}, tr: (s) => s }, scope: {} },
		localStorage: createLocalStorage()
	});
	sb.ctx.window.localStorage = sb.ctx.localStorage;
	sb.load("scripts/engine/storage.js", "scripts/engine/local_storage.js", "scripts/engine/providers/base.js", "scripts/engine/providers/provider.js");
});

describe("AI.Storage.load", () => {
	test("accepts server settings with an older format version", async () => {
		// The Euro-Office Document Server sends version 3 while the plugin stores version 4.
		sb.ctx.AI.serverSettings = settings(3);
		expect(await sb.ctx.AI.Storage.load()).toBe(true);
		expect(sb.ctx.AI.Models.map((m) => m.id)).toEqual([MODEL.id]);
		expect(sb.ctx.AI.Providers.Custom.models.map((m) => m.id)).toEqual([MODEL.id]);
	});

	test("still discards local settings from another version", async () => {
		sb.ctx.localStorage.setItem("onlyoffice_ai_plugin_storage_key", JSON.stringify(settings(3)));
		expect(await sb.ctx.AI.Storage.load()).toBe(false);
	});

	test("loads local settings of the current version", async () => {
		sb.ctx.localStorage.setItem("onlyoffice_ai_plugin_storage_key", JSON.stringify(settings(sb.ctx.AI.Storage.Version)));
		expect(await sb.ctx.AI.Storage.load()).toBe(true);
		expect(sb.ctx.AI.Models.map((m) => m.id)).toEqual([MODEL.id]);
	});
});
