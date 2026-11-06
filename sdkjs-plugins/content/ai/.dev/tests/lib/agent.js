// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Drives the real chat agent loop (scripts/engine/agentLoop.js): loads the
// background-plugin scripts, calls registerButtons(window) with stub UI
// classes, opens the chat window and fires "onChatMessage" like the chat sidebar does.
// The request engine is replaced by a scripted fake provider.

import { createSandbox } from "./sandbox.js";
import { createHost } from "../fakes/host.js";

const SCRIPTS = [
	"scripts/engine/providers/base.js",
	"vendor/md/markdown-it.js",
	"scripts/engine/library.js",
	"scripts/helpers/aiProvenance.js",
	"scripts/engine/aiEdits.js",
	"scripts/engine/toolApproval.js",
	"scripts/engine/actions.js",
	"scripts/engine/chatWindow.js",
	"scripts/engine/promptTools.js",
	"scripts/engine/agentLoop.js",
	"scripts/engine/contextMenu.js",
	"scripts/engine/toolbar.js",
	"scripts/engine/register.js",
	"scripts/helpers/helperFuncs.js",
	"scripts/helpers/helpers.js",
	"scripts/helpers/toolCategories.js",
	"scripts/helpers/agentHistory.js",
	"scripts/helpers/citations.js",
	"scripts/helpers/toolPreviews.js",
	"scripts/helpers/documentContext.js",
	"scripts/helpers/smartActions.js"
];

// Asc.ButtonContextMenu / Asc.ButtonToolbar stand-ins: any property can be
// set and any other method can be called. Like plugins.dev.js (sdkjs-plugins
// v1), a button registers itself with its parent (`childs`), addCheckers()
// stores the option types and copy() makes a sibling with the same id,
// editors, separator and checkers. Every button is recorded in `created`.
class StubButton {
	constructor(parent, id) {
		// Defaults of plugins.dev.js Button: no "pdf" unless editors is set.
		this.editors = ["word", "cell", "slide"];
		this.text = "";
		this.icons = null;
		this.data = "";
		this.separator = false;
		this.enableToggle = false;
		this.split = false;
		this.menu = null;
		this.parent = parent || null;
		this.id = id === undefined ? "btn-" + (StubButton.seq = (StubButton.seq || 0) + 1) : id;
		this.clicks = [];
		this.checkers = [];
		this.childs = null;
		if (this.parent) {
			if (!this.parent.childs) this.parent.childs = [];
			this.parent.childs.push(this);
		}
		const proxy = new Proxy(this, {
			get(target, prop, receiver) {
				if (prop in target || typeof prop === "symbol")
					return Reflect.get(target, prop, receiver);
				return () => receiver;
			}
		});
		StubButton.created.push(proxy);
		return proxy;
	}
	addCheckers(...types) { this.checkers = types; }
	attachOnClick(handler) { this.clicks.push(handler); }
	copy() {
		const ret = new this.constructor(this.parent, this.id);
		ret.editors = this.editors;
		ret.separator = this.separator;
		ret.checkers = this.checkers.slice();
		ret.clicks = this.clicks;   // the click handler is registered per id
		return ret;
	}
}
StubButton.created = [];
class StubContextMenuButton extends StubButton {}
class StubToolbarButton extends StubButton {}

// Asc.PluginWindow stand-in that records commands sent to the chat sidebar.
export class FakePluginWindow {
	constructor() {
		this.id = "chat-window-" + (FakePluginWindow.count = (FakePluginWindow.count || 0) + 1);
		this.handlers = {};
		this.commands = [];  // [name, data]
		this.onCommand = null;
		FakePluginWindow.last = this;
	}
	attachEvent(name, f) { this.handlers[name] = f; }
	command(name, data) {
		this.commands.push([name, data]);
		if (this.onCommand) this.onCommand(name, data);
	}
	show(variation) { this.variation = variation; }
	activate() { this.activations = (this.activations || 0) + 1; }
	async fire(name, data) { return await this.handlers[name](data); }
	sent(name) { return this.commands.filter((c) => c[0] === name).map((c) => c[1]); }
}

/**
 * Scripted provider. Each queued step is either a response object
 * ({ content?, tool_calls?, stream? }) or a function (requestData, engine) =>
 * response. Every request's messages are snapshotted in `requests`.
 */
export function createFakeEngine({ supportsTools = true } = {}) {
	const engine = {
		modelUI: { name: "Fake model", provider: "FakeProvider", id: "fake-1" },
		model: { id: "fake-1" },
		queue: [],
		requests: [],
		fallback: { content: "Done." },
		async chatRequestAgent(requestData, block, streamFunc) {
			engine.requests.push(JSON.parse(JSON.stringify(requestData)));
			let step = engine.queue.length ? engine.queue.shift() : engine.fallback;
			if (typeof step === "function")
				step = await step(requestData, engine);
			if (step && step.stream && streamFunc) {
				for (const chunk of step.stream)
					await streamFunc(chunk);
			}
			return step && step.raw === null ? null : step;
		}
	};
	const provider = { isSupportTools: () => supportsTools, isSupportToolMessages: () => supportsTools };
	return { engine, provider };
}

export function toolCall(id, name, args) {
	return { id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args || {}) } };
}

/**
 * @param {object} opts
 * @param {"word"|"cell"|"slide"} opts.editorType
 * @param {object} opts.fake        fake document from fakes/*.js
 * @param {boolean} [opts.supportsTools]
 * @param {object} [opts.localStorage] initial localStorage entries
 */
export async function createAgent({ editorType = "word", fake = {}, supportsTools = true, localStorage, open = true } = {}) {
	const host = createHost({ editorType, api: fake.Api, methods: fake.methods });
	const { engine, provider } = createFakeEngine({ supportsTools });
	const sandbox = createSandbox({
		Asc: {
			plugin: host.plugin,
			scope: host.scope,
			ButtonContextMenu: StubContextMenuButton,
			ButtonToolbar: StubToolbarButton,
			PluginWindow: FakePluginWindow
		},
		AI: {
			Request: { create: () => engine },
			Storage: { getProvider: () => provider }
		},
		onOpenSettingsModal: () => {}
	});
	if (localStorage)
		for (const [k, v] of Object.entries(localStorage)) sandbox.ctx.localStorage.setItem(k, v);
	sandbox.load(...SCRIPTS);
	StubButton.created = [];
	await sandbox.ctx.registerButtons(sandbox.ctx);
	const buttons = StubButton.created.slice();

	// open: false leaves the chat window to the test (chat-panel.test.js).
	let win = null;
	if (open) {
		sandbox.ctx.chatWindowShow();
		win = FakePluginWindow.last;
		// The sidebar reports that it has loaded; approvals need a ready window.
		await win.fire("onWindowReady", {});
	}

	// Approval policy for onToolApprovalRequest: a decision string, or a
	// function (request) => decision | undefined (undefined leaves it pending).
	const agent = {
		sandbox, ctx: sandbox.ctx, host, engine, win, fake,
		// Context menu and toolbar buttons created by registerButtons(), in order.
		contextMenu: buttons.filter((b) => b instanceof StubContextMenuButton),
		toolbar: buttons.filter((b) => b instanceof StubToolbarButton),
		approvals: [],
		decide: "allow",
		// Sends a chat turn in the sidebar's format { messages, usedTools, turnId }.
		// `text` may be a string or a message list; opts.legacy sends a bare array.
		async send(text, opts = {}) {
			const messages = Array.isArray(text) ? text : [{ role: "user", content: text }];
			const turnId = opts.turnId || "turn-" + (++agent.turns);
			await win.fire("onChatMessage", opts.legacy ? messages : { messages, usedTools: opts.usedTools || [], turnId });
			return turnId;
		},
		turns: 0,
		lastRequest() { return engine.requests[engine.requests.length - 1]; },
		get state() { return sandbox.ctx.AgentState; }
	};
	if (win) win.onCommand = (name, data) => {
		if (name !== "onToolApprovalRequest") return;
		agent.approvals.push(data);
		const decision = typeof agent.decide === "function" ? agent.decide(data) : agent.decide;
		if (decision)
			queueMicrotask(() => win.handlers.onToolApprovalResponse({ id: data.id, decision }));
	};
	return agent;
}
