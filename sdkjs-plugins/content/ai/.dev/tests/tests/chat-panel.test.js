// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// The chat panel's button in the right bar: created closed at startup
// (scripts/code.js → AIChatWindow.addButton, chatWindow.js), opened by the
// toolbar and context menu Chatbot entries instead of a second panel.

import { describe, test, expect } from "vitest";
import { createAgent, FakePluginWindow } from "../lib/agent.js";
import { readPluginFile } from "../lib/sandbox.js";
import { createWordDocument } from "../fakes/word.js";

async function startup(opts = {}) {
	const agent = await createAgent({ fake: createWordDocument({ body: ["Hello"] }), open: false, ...opts });
	FakePluginWindow.last = null;
	return agent;
}

const chatbotToolbar = (agent) => agent.toolbar.find((b) => b.text === "Chatbot");

describe("chat button at startup", () => {
	test("init creates the panel closed in the right bar, once", async () => {
		const agent = await startup();
		agent.ctx.AIChatWindow.addButton();
		const win = FakePluginWindow.last;
		expect(win).not.toBeNull();
		expect(win.variation).toMatchObject({ type: "panelRight", isActivated: false, url: "sidebar/index.html" });
		expect(agent.ctx.chatWindow).toBe(win);
		agent.ctx.AIChatWindow.addButton();
		expect(FakePluginWindow.last).toBe(win);
		expect(win.activations || 0).toBe(0);
	});

	test("code.js clears the stored chat before init and adds the button after the buttons are registered", () => {
		const code = readPluginFile("scripts/code.js");
		const init = code.slice(code.indexOf("async function initWithTranslate"));
		expect(init.indexOf("registerButtons(window)")).toBeLessThan(init.indexOf("window.AIChatWindow.addButton()"));
		const pluginInit = code.slice(code.indexOf("window.Asc.plugin.init = "));
		expect(pluginInit.indexOf("clearChatState()")).toBeLessThan(pluginInit.indexOf("await initWithTranslate(1 << 1)"));
	});

	test("no chat model: no button; choosing the first chat model adds it", async () => {
		const agent = await startup();
		const create = agent.ctx.AI.Request.create;
		agent.ctx.AI.Request.create = () => null;
		agent.ctx.AIChatWindow.addButton();
		expect(FakePluginWindow.last).toBeNull();
		agent.ctx.AI.Request.create = create;
		agent.ctx.AI.ActionsChange("Summarization", "fake-1");
		expect(FakePluginWindow.last).toBeNull();
		agent.ctx.AI.ActionsChange("Chat", "fake-1");
		expect(FakePluginWindow.last.variation.isActivated).toBe(false);
	});

	test("pdf keeps its behaviour: no button at startup", async () => {
		const agent = await startup({ editorType: "pdf" });
		agent.ctx.AIChatWindow.addButton();
		expect(FakePluginWindow.last).toBeNull();
	});
});

describe("Chatbot opens the existing panel", () => {
	test("toolbar Chatbot activates the panel instead of creating a second one", async () => {
		const agent = await startup();
		agent.ctx.AIChatWindow.addButton();
		const win = FakePluginWindow.last;
		await win.fire("onWindowReady", {});
		chatbotToolbar(agent).clicks[0]();
		expect(FakePluginWindow.last).toBe(win);
		expect(win.activations).toBe(1);
	});

	test("attached text before the page is ready is sent once it is; afterwards right away", async () => {
		const agent = await startup();
		agent.ctx.AIChatWindow.addButton();
		const win = FakePluginWindow.last;
		agent.ctx.AIChatWindow.show("Selected text", false);
		expect(win.sent("onAttachedText")).toEqual([]);
		await win.fire("onWindowReady", {});
		expect(win.sent("onAttachedText")).toEqual(["Selected text"]);
		agent.ctx.AIChatWindow.show("More", true);
		expect(win.sent("onAttachedText")).toEqual(["Selected text", { text: "More", forceSend: true }]);
		await win.fire("onWindowReady", {});
		expect(win.sent("onAttachedText")).toHaveLength(2);
	});

	test("docking back reopens the panel once its page has reloaded", async () => {
		const agent = await startup();
		agent.ctx.AIChatWindow.addButton();
		agent.host.methods.OnWindowDockChangedCallback = () => undefined;
		const win = FakePluginWindow.last;
		await win.fire("onWindowReady", {});
		const docked = win.fire("onDockedChanged");
		await Promise.resolve();
		win.handlers.onUpdateState();
		await docked;
		expect(win.activations || 0).toBe(0);
		await win.fire("onWindowReady", {});
		expect(win.activations).toBe(1);
		await win.fire("onWindowReady", {});
		expect(win.activations).toBe(1);
	});
});

describe("closing and missing models", () => {
	test("closing the panel with X adds the closed button again", async () => {
		const agent = await startup();
		Object.assign(agent.ctx, { CustomAssistantManager: class {}, textAnnotatorPopup: null, customAnnotationPopup: null });
		agent.host.methods.CloseWindow = () => undefined;
		agent.sandbox.load("scripts/code.js");
		agent.ctx.AIChatWindow.addButton();
		const win = FakePluginWindow.last;
		await agent.ctx.Asc.plugin.button(-1, win.id);
		expect(agent.ctx.chatWindow).toBeUndefined();
		await new Promise((r) => setTimeout(r, 0));
		expect(FakePluginWindow.last).not.toBe(win);
		expect(FakePluginWindow.last.variation.isActivated).toBe(false);
		expect(agent.ctx.chatWindow).toBe(FakePluginWindow.last);
	});

	test("toolbar Chatbot without a chat model opens the AI settings, also when the panel exists", async () => {
		const agent = await startup();
		agent.ctx.AIChatWindow.addButton();
		const win = FakePluginWindow.last;
		await win.fire("onWindowReady", {});
		let settings = 0;
		agent.ctx.AI.Request.create = (action, disableSettings) => { if (!disableSettings) settings++; return null; };
		chatbotToolbar(agent).clicks[0]();
		expect(settings).toBe(1);
		expect(win.activations || 0).toBe(0);
	});
});
