// SPDX-License-Identifier: AGPL-3.0-only
//
// Layer 7: chat window UI (chat.html + scripts/chat.js + scripts/chatChips.js)
// in jsdom: tool approval cards and smart-action chips.

import { describe, test, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { readPluginFile } from "../lib/sandbox.js";

let win, $, events, sent;

function fire(name, data) {
	events[name](data);
}

beforeEach(() => {
	const html = readPluginFile("chat.html").replace(/<script[\s\S]*?<\/script>/gi, "");
	const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://example.test/chat.html" });
	win = dom.window;
	events = {};
	sent = [];
	win.Asc = {
		plugin: {
			tr: (s) => s,
			attachEvent: (name, f) => { events[name] = f; },
			sendToPlugin: (name, data) => sent.push([name, data === undefined ? undefined : JSON.parse(JSON.stringify(data))]),
			info: { editorType: "word" },
			theme: { type: "light" }
		}
	};
	win.eval(readPluginFile("vendor/jquery/jquery-3.7.1.min.js"));
	win.eval(readPluginFile("vendor/md/markdown-it.js"));
	win.eval(readPluginFile("scripts/helpers/agentHistory.js"));
	win.eval(readPluginFile("scripts/helpers/citations.js"));
	win.PerfectScrollbar = class { update() {} destroy() {} };
	win.Tooltip = class { constructor() {} _deleteTooltipElement() {} };
	win.opened = [];
	win.open = (url) => win.opened.push(url);
	win.eval(readPluginFile("scripts/chat.js"));
	win.eval(readPluginFile("scripts/chatChips.js"));
	$ = win.$;
});

describe("tool approval card", () => {
	function requestApproval(extra = {}) {
		fire("onToolCallStart", { type: "native", id: "c1", functionName: "replaceSelection", humanName: "Replace Selection", arguments: "{\n  \"text\": \"Hi\"\n}" });
		fire("onToolApprovalRequest", { id: "approval_1_c1", toolCallId: "c1", functionName: "replaceSelection", humanName: "Replace Selection", arguments: "{\n  \"text\": \"Hi\"\n}", ...extra });
		return $(".tool_call_approval");
	}

	test("renders the question, the arguments and three buttons on the tool call", () => {
		const $box = requestApproval();
		expect($box).toHaveLength(1);
		expect($box.find(".tool_call_approval_question").text()).toBe("Allow this action? Replace Selection");
		expect($box.find("pre.tool_call_approval_code").text()).toBe("{\n  \"text\": \"Hi\"\n}");
		expect($box.find("button").map((i, b) => $(b).text()).get()).toEqual(["Allow", "Always allow", "Deny"]);
		expect($box.attr("role")).toBe("group");
		expect($("#" + $box.attr("aria-labelledby")).length).toBe(1);
		// rendered inside the tool call bubble that onToolCallStart created
		expect($box.closest(".message").find(".tool_call_header").length).toBe(1);
	});

	test.each([["Allow", "allow"], ["Always allow", "always"], ["Deny", "deny"]])("%s sends decision %s once and removes the card", (label, decision) => {
		const $box = requestApproval();
		$box.find("button").filter((i, b) => $(b).text() === label).trigger("click");
		expect(sent).toEqual([["onToolApprovalResponse", { id: "approval_1_c1", decision }]]);
		expect($(".tool_call_approval")).toHaveLength(0);
		// a second click on a stale button does nothing
		$box.find("button").first().trigger("click");
		expect(sent).toHaveLength(1);
	});

	test("writeMacro shows the code (as text, not HTML) and offers a session-only allow", () => {
		const code = "Api.GetDocument().GetElement(0).AddText(\"<img src=x onerror=alert(1)>\")";
		fire("onToolCallStart", { type: "native", id: "m1", functionName: "writeMacro", humanName: "Write Macro", arguments: "{}" });
		fire("onToolApprovalRequest", { id: "approval_2_m1", toolCallId: "m1", functionName: "writeMacro", humanName: "Write Macro", arguments: JSON.stringify({ code }), code });
		const $box = $(".tool_call_approval");
		expect($box.find(".tool_call_approval_label").text()).toBe("The assistant wants to run this macro:");
		expect($box.find("pre.tool_call_approval_code").text()).toBe(code);
		expect($box.find("img")).toHaveLength(0);
		expect($box.find("button").map((i, b) => $(b).text()).get()).toEqual(["Allow", "Allow for this session", "Deny"]);
		$box.find("button").eq(1).trigger("click");
		expect(sent).toEqual([["onToolApprovalResponse", { id: "approval_2_m1", decision: "always" }]]);
	});

	test("a request without a prior tool call creates its own bubble", () => {
		fire("onToolApprovalRequest", { id: "approval_3_system_1", toolCallId: "system_1", functionName: "editParagraph", humanName: "Edit Paragraph", arguments: "{}" });
		expect($(".tool_call_approval")).toHaveLength(1);
		expect($(".tool_call_approval pre")).toHaveLength(0); // "{}" is not shown
	});

	test("the card disappears when the tool call ends (e.g. agent stopped)", () => {
		requestApproval();
		fire("onToolCallEnd", { type: "native", id: "c1", functionName: "replaceSelection", result: { error: "The user declined this action." } });
		expect($(".tool_call_approval")).toHaveLength(0);
		expect(sent).toEqual([]);
	});

	test("ignores malformed requests", () => {
		fire("onToolApprovalRequest", null);
		fire("onToolApprovalRequest", { functionName: "x" });
		expect($(".tool_call_approval")).toHaveLength(0);
	});
});

describe("smart action chips", () => {
	const payload = { key: "word|11|abc", summary: "Selected text (11 chars)", actions: [{ id: "improve", text: "Improve writing" }, { id: "continue", text: "Continue writing" }] };
	const chips = () => $("#selection_chips");

	test("render the summary and one button per action", () => {
		fire("onSelectionSuggestions", payload);
		expect(chips().hasClass("hidden")).toBe(false);
		expect(chips().find(".selection_chips_summary_text").text()).toBe("Selected text (11 chars)");
		expect(chips().find(".selection_chip").map((i, b) => $(b).text()).get()).toEqual(["Improve writing", "Continue writing"]);
		expect(chips().attr("aria-label")).toBe("Suggested actions");
	});

	test("an empty action list hides the row; invalid actions are dropped", () => {
		fire("onSelectionSuggestions", payload);
		fire("onSelectionSuggestions", { key: "", summary: "", actions: [] });
		expect(chips().hasClass("hidden")).toBe(true);
		fire("onSelectionSuggestions", { key: "k", summary: "s", actions: [{ id: "a" }, null, { id: "b", text: "B" }] });
		expect(chips().find(".selection_chip").map((i, b) => $(b).text()).get()).toEqual(["B"]);
		fire("onSelectionSuggestions", "nonsense");
		expect(chips().find(".selection_chip")).toHaveLength(1);
	});

	test("clicking a chip sends onSmartActionChip and hides the chips", () => {
		fire("onSelectionSuggestions", payload);
		chips().find(".selection_chip").eq(1).trigger("click");
		expect(sent).toEqual([["onSmartActionChip", { id: "continue" }]]);
		expect(chips().hasClass("hidden")).toBe(true);
	});

	test("dismiss hides them until the selection changes", () => {
		fire("onSelectionSuggestions", payload);
		chips().find(".selection_chips_dismiss").trigger("click");
		expect(chips().hasClass("hidden")).toBe(true);
		fire("onSelectionSuggestions", payload); // same selection: stays dismissed
		expect(chips().hasClass("hidden")).toBe(true);
		fire("onSelectionSuggestions", { ...payload, key: "word|5|def" });
		expect(chips().hasClass("hidden")).toBe(false);
	});

	test("Escape dismisses", () => {
		fire("onSelectionSuggestions", payload);
		chips().trigger($.Event("keydown", { key: "Escape" }));
		expect(chips().hasClass("hidden")).toBe(true);
	});

	test("busy state hides chips and notifies the plugin", () => {
		fire("onSelectionSuggestions", payload);
		win.ChatChips.setBusy(true);
		expect(chips().hasClass("hidden")).toBe(true);
		expect(sent).toEqual([["onSelectionSuggestionsBusy", true]]);
		win.ChatChips.setBusy(true); // no duplicate notification
		win.ChatChips.setBusy(false);
		expect(sent).toEqual([["onSelectionSuggestionsBusy", true], ["onSelectionSuggestionsBusy", false]]);
		expect(chips().hasClass("hidden")).toBe(false);
	});
});

describe("sending messages and agent transcripts", () => {
	function submit(text) {
		$("#input_message").val(text);
		$("#input_message_submit")[0].click();
	}
	const chatMessages = () => sent.filter((m) => m[0] === "onChatMessage").map((m) => m[1]);

	beforeEach(() => win.Asc.plugin.init());

	test("a message is sent as { messages, usedTools, turnId }", () => {
		submit("Summarize this");
		const [req] = chatMessages();
		expect(req.messages).toEqual([{ role: "user", content: "Summarize this" }]);
		expect(req.usedTools).toEqual([]);
		expect(req.turnId).toMatch(/^t[a-z0-9]+$/);
		expect(sent.some((m) => m[0] === "onWindowReady")).toBe(true);
	});

	test("the transcript of a turn is replayed as history in the next request", () => {
		submit("Read the document");
		const turnId = chatMessages()[0].turnId;
		fire("onToolCallStart", { type: "native", id: "c1", functionName: "readDocument", humanName: "Read Document", arguments: "{}" });
		fire("onToolCallEnd", { type: "native", id: "c1", functionName: "readDocument", result: { message: "Function executed successfully" } });
		fire("onAgentTranscript", { turnId, hasFinalReply: true, messages: [
			{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "readDocument", arguments: "{}" } }] },
			{ role: "tool", tool_call_id: "c1", content: "Function executed successfully" }
		] });
		fire("onChatReply", "It is about cats.");
		fire("onChatStreamEnd");
		submit("Shorter please");
		const req = chatMessages()[1];
		expect(req.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
		expect(req.messages[2].tool_call_id).toBe("c1");
		expect(req.messages[3].content).toBe("It is about cats.");
		expect(req.usedTools).toEqual(["readDocument"]);
	});

	test("transcripts for unknown turns are ignored", () => {
		submit("Hi");
		fire("onAgentTranscript", { turnId: "nope", hasFinalReply: true, messages: [{ role: "tool", tool_call_id: "x", content: "y" }] });
		fire("onAgentTranscript", null);
		fire("onChatReply", "Hello");
		fire("onChatStreamEnd");
		submit("Again");
		expect(chatMessages()[1].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
	});
});

describe("document location links", () => {
	beforeEach(() => win.Asc.plugin.init());

	test("valid eo:// links become location chips that send onNavigate", () => {
		fire("onChatReply", "See [paragraph 3](eo://word/paragraph/3), [bad](eo://word/paragraph/0) and [web](https://example.com).");
		fire("onChatStreamEnd");
		const $chip = $("a.eo_location_link");
		expect($chip).toHaveLength(1);
		expect($chip.attr("role")).toBe("button");
		expect($chip.attr("title")).toContain("Go to location");
		expect($("a").filter((i, a) => $(a).text() === "bad")).toHaveLength(0); // replaced by plain text
		expect($(".message").text()).toContain("bad");

		$chip[0].click();
		expect(sent.filter((m) => m[0] === "onNavigate")).toEqual([["onNavigate", { href: "eo://word/paragraph/3" }]]);
		expect(win.opened).toEqual([]);

		$("a").filter((i, a) => $(a).text() === "web")[0].click();
		expect(win.opened).toEqual(["https://example.com/"]);
	});

	test("javascript: links are never rendered as links", () => {
		fire("onChatReply", "[x](javascript:alert(1))");
		fire("onChatStreamEnd");
		expect($("a[href^=javascript]")).toHaveLength(0);
	});
});
