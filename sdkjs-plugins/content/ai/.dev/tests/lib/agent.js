// SPDX-License-Identifier: AGPL-3.0-only
//
// Drives the real chat agent loop in scripts/engine/register.js: loads the
// background-plugin scripts, calls registerButtons(window) with stub UI
// classes, opens the chat window and fires "onChatMessage" like chat.js does.
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
// set and any method (addCheckers, attachOnClick, copy, ...) can be called.
class StubButton {
	constructor(parent) {
		this.parent = parent;
		this.clicks = [];
		return new Proxy(this, {
			get(target, prop, receiver) {
				if (prop in target || typeof prop === "symbol")
					return Reflect.get(target, prop, receiver);
				return (...args) => (prop === "attachOnClick" ? target.clicks.push(args[0]) : receiver);
			}
		});
	}
}

// Asc.PluginWindow stand-in that records commands sent to chat.html.
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
	activate() {}
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
export async function createAgent({ editorType = "word", fake = {}, supportsTools = true, localStorage } = {}) {
	const host = createHost({ editorType, api: fake.Api, methods: fake.methods });
	const { engine, provider } = createFakeEngine({ supportsTools });
	const sandbox = createSandbox({
		Asc: {
			plugin: host.plugin,
			scope: host.scope,
			ButtonContextMenu: StubButton,
			ButtonToolbar: StubButton,
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
	await sandbox.ctx.registerButtons(sandbox.ctx);

	sandbox.ctx.chatWindowShow();
	const win = FakePluginWindow.last;
	// chat.html reports that it has loaded; approvals need a ready window.
	await win.fire("onWindowReady", {});

	// Approval policy for onToolApprovalRequest: a decision string, or a
	// function (request) => decision | undefined (undefined leaves it pending).
	const agent = {
		sandbox, ctx: sandbox.ctx, host, engine, win, fake,
		approvals: [],
		decide: "allow",
		// Sends a chat turn in chat.js's format { messages, usedTools, turnId }.
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
	win.onCommand = (name, data) => {
		if (name !== "onToolApprovalRequest") return;
		agent.approvals.push(data);
		const decision = typeof agent.decide === "function" ? agent.decide(data) : agent.decide;
		if (decision)
			queueMicrotask(() => win.handlers.onToolApprovalResponse({ id: data.id, decision }));
	};
	return agent;
}
