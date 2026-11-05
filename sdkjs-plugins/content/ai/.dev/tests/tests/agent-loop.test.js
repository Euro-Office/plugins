// SPDX-License-Identifier: AGPL-3.0-only
//
// Layer 4: the agent loop in scripts/engine/register.js ("onChatMessage"),
// driven end-to-end with a scripted provider and the fake Document API.

import { describe, test, expect } from "vitest";
import { createAgent, toolCall } from "../lib/agent.js";
import { createWordDocument } from "../fakes/word.js";

const ALWAYS_KEY = "onlyoffice_ai_tool_always_allow";

function wordAgent(opts = {}) {
	const fake = createWordDocument({
		body: ["Hello world", "Second paragraph"],
		selection: { paragraph: 1, start: 0, end: 5 },
		...(opts.doc || {})
	});
	return createAgent({ editorType: "word", fake, ...opts });
}

// Messages after the system prompt and the user message of the last request.
function transcript(agent) {
	return agent.lastRequest().messages.slice(2);
}

describe("native tool calling", () => {
	test("read-only tools run without approval; results go back as tool messages", async () => {
		const agent = await wordAgent();
		agent.engine.queue.push(
			{ content: "", tool_calls: [toolCall("c1", "readDocument", {}), toolCall("c2", "getSelection", {})] },
			{ content: "The document says hello." }
		);
		await agent.send("What is in the document?");

		expect(agent.approvals).toEqual([]);
		expect(agent.engine.requests).toHaveLength(2);
		const msgs = transcript(agent);
		expect(msgs[0]).toEqual({ role: "assistant", content: null, tool_calls: [toolCall("c1", "readDocument", {}), toolCall("c2", "getSelection", {})] });
		expect(msgs.slice(1).map((m) => [m.role, m.tool_call_id])).toEqual([["tool", "c1"], ["tool", "c2"]]);
		expect(msgs[1].content).toMatch(/^Function executed successfully\n\{"totalElements":2/);
		expect(JSON.parse(msgs[2].content.split("\n")[1])).toMatchObject({ hasSelection: true, text: "Hello" });
		expect(agent.win.sent("onChatReply")).toEqual(["The document says hello."]);
		expect(agent.win.sent("onToolCallStart").map((d) => [d.id, d.functionName, d.humanName])).toEqual([["c1", "readDocument", "Read Document"], ["c2", "getSelection", "Read Selection"]]);
		expect(agent.win.sent("onToolCallEnd").every((d) => d.result.message)).toBe(true);
	});

	test("the provider gets tool definitions and a system prompt with the live selection", async () => {
		const agent = await wordAgent();
		await agent.send("Fix this");
		const req = agent.engine.requests[0];
		expect(req.tools.map((t) => t.name)).toContain("replaceSelection");
		expect(req.tools.every((t) => !("readOnly" in t))).toBe(true);
		expect(req.messages[0].role).toBe("system");
		expect(req.messages[0].content).toContain("You have access to tools");
		expect(req.messages[0].content).toContain("CURRENT EDITOR STATE");
		expect(req.messages[0].content).toContain("<<<SELECTION\nHello\nSELECTION>>>");
		expect(req.messages[1]).toEqual({ role: "user", content: "Fix this" });
	});

	test("an existing system message is kept and extended with the context", async () => {
		const agent = await wordAgent();
		await agent.send([{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }]);
		const sys = agent.engine.requests[0].messages.filter((m) => m.role === "system");
		expect(sys).toHaveLength(1);
		expect(sys[0].content).toMatch(/^Be brief\.\n\nCURRENT EDITOR STATE/);
	});

	test("editing tools ask for approval and run when allowed", async () => {
		const agent = await wordAgent();
		agent.engine.queue.push({ tool_calls: [toolCall("c1", "replaceSelection", { text: "Howdy" })] });
		await agent.send("Make it casual");

		expect(agent.approvals).toHaveLength(1);
		expect(agent.approvals[0]).toMatchObject({ toolCallId: "c1", functionName: "replaceSelection", humanName: "Replace Selection" });
		expect(JSON.parse(agent.approvals[0].arguments)).toEqual({ text: "Howdy" });
		expect(agent.approvals[0].code).toBeUndefined();
		expect(agent.fake.doc.texts()[0]).toBe("Howdy world");
		expect(transcript(agent)[1]).toMatchObject({ role: "tool", tool_call_id: "c1", content: expect.stringMatching(/^Function executed successfully/) });
	});

	test("deny: the tool does not run, the model is told and the loop continues", async () => {
		const agent = await wordAgent();
		agent.decide = "deny";
		agent.engine.queue.push(
			{ tool_calls: [toolCall("c1", "replaceSelection", { text: "Howdy" }), toolCall("c2", "readDocument", {})] },
			{ content: "OK, I left it." }
		);
		await agent.send("Change it");

		expect(agent.fake.doc.texts()[0]).toBe("Hello world");
		const msgs = transcript(agent);
		expect(msgs.map((m) => m.role)).toEqual(["assistant", "tool", "tool"]);
		expect(msgs[1]).toEqual({ role: "tool", tool_call_id: "c1", content: agent.ctx.TOOL_DECLINED_MESSAGE });
		// a refusal is not a failure: later calls still run
		expect(msgs[2].content).toMatch(/^Function executed successfully/);
		expect(agent.win.sent("onChatReply")).toEqual(["OK, I left it."]);
	});

	test("a failing tool skips the remaining calls of the turn but answers every tool_call_id", async () => {
		const agent = await wordAgent();
		agent.engine.queue.push(
			{ tool_calls: [toolCall("c1", "readDocument", { startIndex: 0 }), toolCall("c2", "readDocument", {}), toolCall("c3", "getSelection", {})] },
			{ content: "Sorry." }
		);
		await agent.send("Read");
		const msgs = transcript(agent);
		expect(msgs.map((m) => m.tool_call_id || m.role)).toEqual(["assistant", "c1", "c2", "c3"]);
		expect(msgs[1].content).toMatch(/^Error:\nParameter "startIndex" must be a number >= 1/);
		expect(msgs[2].content).toBe("Skipped because a previous tool call failed.");
		expect(msgs[3].content).toBe("Skipped because a previous tool call failed.");
	});

	test("unknown tools and invalid argument JSON are reported to the model", async () => {
		const agent = await wordAgent();
		agent.engine.queue.push({ tool_calls: [toolCall("c1", "deleteEverything", {})] }, { tool_calls: [toolCall("c2", "readDocument", "{startIndex: 1}")] });
		await agent.send("Go");
		const all = agent.lastRequest().messages.filter((m) => m.role === "tool");
		expect(all[0].content).toMatch(/Unknown tool "deleteEverything"\. Available tools: .*readDocument/);
		expect(all[1].content).toMatch(/Arguments are not valid JSON/);
		expect(agent.approvals).toEqual([]);
	});

	test("tool messages never leak raw exceptions from non-Error throws", async () => {
		const agent = await wordAgent();
		agent.ctx.EditorHelper = new agent.ctx.EditorHelperImpl();
		agent.ctx.EditorHelper.names2funcs.readDocument.call = async () => { throw "plain string"; };
		agent.engine.queue.push({ tool_calls: [toolCall("c1", "readDocument", {})] });
		await agent.send("Go");
		expect(transcript(agent)[1].content).toBe("Error:\nplain string");
	});
});

describe("approval memory", () => {
	test("'always' is remembered across turns for normal tools", async () => {
		const agent = await wordAgent();
		agent.decide = "always";
		agent.engine.queue.push({ tool_calls: [toolCall("c1", "editParagraph", { index: 2, action: "delete" })] });
		await agent.send("Delete");
		expect(JSON.parse(agent.ctx.localStorage.getItem(ALWAYS_KEY))).toEqual({ editParagraph: true });

		agent.decide = () => { throw new Error("must not ask again"); };
		agent.engine.queue.push({ tool_calls: [toolCall("c2", "editParagraph", { index: 1, action: "replace", text: "Hi" })] });
		await agent.send("Again");
		expect(agent.approvals).toHaveLength(1);
		expect(agent.fake.doc.texts()).toEqual(["Hi"]);
	});

	test("a persisted 'always' from an earlier session is honoured", async () => {
		const agent = await wordAgent({ localStorage: { [ALWAYS_KEY]: JSON.stringify({ replaceSelection: true }) } });
		agent.engine.queue.push({ tool_calls: [toolCall("c1", "replaceSelection", { text: "Yo" })] });
		await agent.send("Go");
		expect(agent.approvals).toEqual([]);
		expect(agent.fake.doc.texts()[0]).toBe("Yo world");
	});

	test("corrupt persisted approvals are ignored", async () => {
		const agent = await wordAgent({ localStorage: { [ALWAYS_KEY]: "[\"replaceSelection\"]" } });
		agent.engine.queue.push({ tool_calls: [toolCall("c1", "replaceSelection", { text: "Yo" })] });
		await agent.send("Go");
		expect(agent.approvals).toHaveLength(1);
	});

	test("writeMacro shows the code and 'always' only lasts for this chat window", async () => {
		const code = "Api.GetDocument().GetElement(0).GetText()";
		const agent = await wordAgent();
		agent.decide = "always";
		agent.engine.queue.push({ tool_calls: [toolCall("c1", "writeMacro", { code })] }, { content: "ok" }, { tool_calls: [toolCall("c2", "writeMacro", { code })] });
		await agent.send("Run a macro");
		expect(agent.approvals).toHaveLength(1);
		expect(agent.approvals[0].code).toBe(code);
		expect(agent.ctx.localStorage.getItem(ALWAYS_KEY)).toBeNull();

		await agent.send("Again");
		expect(agent.approvals).toHaveLength(1); // same window: no second prompt

		// A new chat window (new session) asks again even with other tools persisted.
		agent.ctx.localStorage.setItem(ALWAYS_KEY, JSON.stringify({ writeMacro: true }));
		agent.ctx.chatWindow = null;
		agent.ctx.chatWindowShow();
		const { FakePluginWindow } = await import("../lib/agent.js");
		const win2 = FakePluginWindow.last;
		await win2.fire("onWindowReady", {});
		expect(win2).not.toBe(agent.win);
		const asked = [];
		win2.onCommand = (name, data) => {
			if (name === "onToolApprovalRequest") {
				asked.push(data);
				queueMicrotask(() => win2.handlers.onToolApprovalResponse({ id: data.id, decision: "deny" }));
			}
		};
		agent.engine.queue.push({ tool_calls: [toolCall("c3", "writeMacro", { code })] });
		await win2.fire("onChatMessage", [{ role: "user", content: "Once more" }]);
		expect(asked).toHaveLength(1);
	});

	test("responses for unknown approval ids are ignored", async () => {
		const agent = await wordAgent();
		agent.decide = (req) => {
			agent.win.handlers.onToolApprovalResponse({ id: "approval_999_x", decision: "allow" });
			agent.win.handlers.onToolApprovalResponse(null);
			return "deny";
		};
		agent.engine.queue.push({ tool_calls: [toolCall("c1", "replaceSelection", { text: "x" })] });
		await agent.send("Go");
		expect(agent.fake.doc.texts()[0]).toBe("Hello world");
	});
});

describe("stopping", () => {
	test("stop while an approval is pending denies it and cancels the rest", async () => {
		const agent = await wordAgent();
		agent.decide = () => {
			queueMicrotask(() => agent.win.handlers.onStopAgent());
			return undefined; // never answered by the user
		};
		agent.engine.queue.push({ tool_calls: [toolCall("c1", "replaceSelection", { text: "x" }), toolCall("c2", "readDocument", {})] });
		await agent.send("Go");

		expect(agent.fake.doc.texts()[0]).toBe("Hello world");
		expect(agent.engine.requests).toHaveLength(1); // no further model round trip
		expect(agent.state.isStopped).toBe(true);
		const end = agent.win.sent("onToolCallEnd");
		expect(end.map((e) => e.id)).toEqual(["c1"]);
		expect(end[0].result.error).toBe(agent.ctx.TOOL_DECLINED_MESSAGE);
	});

	test("an 'allow' that arrives after stop is treated as deny", async () => {
		const agent = await wordAgent();
		agent.decide = (req) => {
			agent.win.handlers.onStopAgent();
			return "allow";
		};
		agent.engine.queue.push({ tool_calls: [toolCall("c1", "replaceSelection", { text: "x" })] });
		await agent.send("Go");
		expect(agent.fake.doc.texts()[0]).toBe("Hello world");
	});

	test("stop during the model request ends the loop without running tools", async () => {
		const agent = await wordAgent();
		agent.engine.queue.push(() => {
			agent.win.handlers.onStopAgent();
			return { tool_calls: [toolCall("c1", "readDocument", {})] };
		});
		await agent.send("Go");
		expect(agent.win.sent("onToolCallStart")).toEqual([]);
		expect(agent.engine.requests).toHaveLength(1);
	});

	test("a new message clears the stopped state", async () => {
		const agent = await wordAgent();
		agent.win.handlers.onStopAgent();
		agent.engine.queue.push({ content: "Hi again" });
		await agent.send("Hello");
		expect(agent.win.sent("onChatReply")).toEqual(["Hi again"]);
	});
});

describe("loop control", () => {
	test("stops after MAX_LOOP_ITERATIONS model calls and tells the user", async () => {
		const agent = await wordAgent();
		let n = 0;
		agent.engine.fallback = () => ({ tool_calls: [toolCall("c" + (++n), "readDocument", {})] });
		await agent.send("Loop forever");
		expect(agent.engine.requests).toHaveLength(agent.state.MAX_LOOP_ITERATIONS);
		expect(agent.win.sent("onChatReply")).toEqual(["Maximum iterations reached. Please try again."]);
	});

	test("an answer in the last allowed iteration is not reported as hitting the limit", async () => {
		const agent = await wordAgent();
		const max = 20;
		for (let i = 1; i < max; i++)
			agent.engine.queue.push({ tool_calls: [toolCall("c" + i, "readDocument", {})] });
		agent.engine.queue.push({ content: "Finally done." });
		await agent.send("Work");
		expect(agent.state.MAX_LOOP_ITERATIONS).toBe(max);
		expect(agent.engine.requests).toHaveLength(max);
		expect(agent.win.sent("onChatReply")).toEqual(["Finally done."]);
	});

	test("streamed answers are not repeated as a reply; stream start/end are balanced", async () => {
		const agent = await wordAgent();
		agent.engine.queue.push({ content: "Hello there", stream: ["Hello ", "there"] });
		await agent.send("Hi");
		expect(agent.win.sent("onChatStreamChunk")).toEqual(["Hello ", "there"]);
		expect(agent.win.sent("onChatStreamStart")).toHaveLength(1);
		expect(agent.win.sent("onChatReply")).toEqual([]);
		expect(agent.win.sent("onChatStreamEnd").length).toBeGreaterThanOrEqual(1);
		expect(agent.win.commands[agent.win.commands.length - 1][0]).toBe("onChatStreamEnd");
	});

	test("the editor is blocked during model calls and released afterwards", async () => {
		const agent = await wordAgent();
		agent.engine.queue.push({ tool_calls: [toolCall("c1", "readDocument", {})] }, { content: "ok" });
		await agent.send("Hi");
		const actions = agent.host.methodCalls().filter((c) => c.name === "StartAction" || c.name === "EndAction").map((c) => c.name + ":" + c.args[0]);
		expect(actions).toEqual(["StartAction:Block", "EndAction:Block", "StartAction:Block", "EndAction:Block"]);
	});

	test("a missing provider response becomes an error reply", async () => {
		const agent = await wordAgent();
		agent.engine.queue.push({ raw: null });
		await agent.send("Hi");
		expect(agent.win.sent("onChatReply")).toEqual(["Error: [provider]"]);
	});
});

describe("prompt-based tool calling (models without native tools)", () => {
	test("uses the function-calling system prompt and runs read-only calls", async () => {
		const agent = await wordAgent({ supportsTools: false });
		agent.engine.queue.push({ content: "[functionCalling (getSelection)]: {}" }, { content: "You selected Hello." });
		await agent.send("What did I select?");

		const first = agent.engine.requests[0];
		expect(first.tools).toBeUndefined();
		expect(first.messages[0].content).toContain("FUNCTION CALL FORMAT");
		expect(first.messages[0].content).toContain("CURRENT EDITOR STATE");
		const msgs = transcript(agent);
		expect(msgs[0]).toEqual({ role: "assistant", content: "[functionCalling (getSelection)]: {}" });
		expect(msgs[1].role).toBe("user");
		expect(msgs[1].content).toMatch(/^SYSTEM: Function executed successfully\n\{"hasSelection":true,"text":"Hello"/);
		expect(agent.approvals).toEqual([]);
		const start = agent.win.sent("onToolCallStart")[0];
		expect(start).toMatchObject({ type: "system_prompt", humanName: "Read Selection" });
		expect(agent.win.sent("onToolCallEnd")[0].id).toBe(start.id);
		expect(agent.win.sent("onChatReply")).toEqual(["You selected Hello."]);
	});

	test("editing calls need approval; a refusal is reported", async () => {
		const agent = await wordAgent({ supportsTools: false });
		agent.decide = "deny";
		agent.engine.queue.push({ content: '[functionCalling (replaceSelection)]: {"text": "Bye"}' }, { content: "Fine." });
		await agent.send("Change it");
		expect(agent.approvals).toHaveLength(1);
		expect(agent.approvals[0].toolCallId).toMatch(/^system_/);
		expect(agent.fake.doc.texts()[0]).toBe("Hello world");
		expect(transcript(agent)[1].content).toMatch(/^SYSTEM: The user declined this action\. Do not repeat this call/);
	});

	test("errors are fed back so the model can retry", async () => {
		const agent = await wordAgent({ supportsTools: false });
		agent.engine.queue.push({ content: "[functionCalling (readDocument)]: {startIndex: 0}" }, { content: "Hm." });
		await agent.send("Read");
		expect(transcript(agent)[1].content).toMatch(/^SYSTEM: Function execution failed with error: Error:\nArguments for "readDocument" are not valid JSON/);
	});

	test("approved calls change the document", async () => {
		const agent = await wordAgent({ supportsTools: false });
		agent.engine.queue.push({ content: '[functionCalling (editParagraph)]: {"index": 2, "action": "delete"}' }, { content: "Deleted." });
		await agent.send("Delete the second paragraph");
		expect(agent.fake.doc.texts()).toEqual(["Hello world"]);
	});
});

describe("chat window events", () => {
	test("onChatReplace inserts or replaces through the Library", async () => {
		const agent = await wordAgent();
		await agent.win.fire("onChatReplace", { type: "replace", data: "Bye" });
		expect(agent.host.methodCalls("ReplaceTextSmart")[0].args).toEqual([["Bye"]]);
	});
});

describe("request format, tool categories and history", () => {
	const toolNames = (req) => req.tools.map((t) => t.name);

	test("the legacy plain-array request still works", async () => {
		const agent = await wordAgent();
		agent.engine.queue.push({ content: "Hi" });
		await agent.send("Hello", { legacy: true });
		expect(agent.engine.requests[0].messages[1]).toEqual({ role: "user", content: "Hello" });
		expect(agent.win.sent("onChatReply")).toEqual(["Hi"]);
	});

	test("only the categories that fit the message are sent, plus loadTools and writeMacro", async () => {
		const agent = await wordAgent();
		await agent.send("Please add a comment to the introduction with suggestions");
		const names = toolNames(agent.engine.requests[0]);
		expect(names).toEqual(expect.arrayContaining(["loadTools", "writeMacro", "readDocument", "commentText"]));
		const all = new agent.ctx.EditorHelperImpl().getTools().length;
		expect(names.length).toBeLessThan(all);
	});

	test("loadTools adds tools to the following requests of the same turn only", async () => {
		const agent = await createAgent({ editorType: "cell", fake: (await import("../fakes/cell.js")).createWorkbook({ sheets: { S: [["a", 1]] } }) });
		agent.engine.queue.push(
			{ tool_calls: [toolCall("l1", "loadTools", { categories: ["conditional-formatting"] })] },
			{ content: "Loaded." }
		);
		await agent.send("Read the values in the first sheet and tell me about them");
		const [first, second] = agent.engine.requests;
		expect(toolNames(first)).not.toContain("addColorScale");
		expect(toolNames(second)).toContain("addColorScale");
		expect(agent.approvals).toEqual([]); // loadTools is read-only
		expect(JSON.parse(second.messages.find((m) => m.tool_call_id === "l1").content.split("\n")[1])).toMatchObject({ loaded: ["conditional-formatting"] });

		agent.engine.queue.push({ content: "ok" });
		await agent.send("Read the values in the first sheet again please");
		expect(toolNames(agent.lastRequest())).not.toContain("addColorScale");
	});

	test("tools used earlier in the chat keep their category selected", async () => {
		const agent = await wordAgent();
		await agent.send("Make it better for the reader please", { usedTools: ["commentText"] });
		expect(toolNames(agent.lastRequest())).toContain("commentText");
	});

	test("the turn's tool exchange is sent back to the chat as a transcript", async () => {
		const agent = await wordAgent();
		agent.engine.queue.push({ tool_calls: [toolCall("c1", "readDocument", {})] }, { content: "Done reading." });
		const turnId = await agent.send("Read it");
		const [t] = agent.win.sent("onAgentTranscript");
		expect(t.turnId).toBe(turnId);
		expect(t.hasFinalReply).toBe(true);
		expect(t.messages.map((m) => m.role)).toEqual(["assistant", "tool"]);
		expect(t.messages[1].tool_call_id).toBe("c1");

		const plain = await wordAgent();
		plain.engine.queue.push({ content: "Just text" });
		await plain.send("Hi");
		expect(plain.win.sent("onAgentTranscript")).toEqual([]);
	});

	test("history with earlier tool calls is kept for tool-capable models and flattened otherwise", async () => {
		const history = [
			{ role: "user", content: "Read it" },
			{ role: "assistant", content: null, tool_calls: [toolCall("old1", "readDocument", {})] },
			{ role: "tool", tool_call_id: "old1", content: "Function executed successfully\n{}" },
			{ role: "assistant", content: "It says hello." },
			{ role: "user", content: "And now?" }
		];
		const native = await wordAgent();
		await native.send(JSON.parse(JSON.stringify(history)));
		expect(native.engine.requests[0].messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);

		const prompt = await wordAgent({ supportsTools: false });
		await prompt.send(JSON.parse(JSON.stringify(history)));
		const msgs = prompt.engine.requests[0].messages;
		expect(msgs.some((m) => m.role === "tool" || m.tool_calls)).toBe(false);
		expect(msgs.map((m) => m.content).join("\n")).toContain("[functionCalling (readDocument)]");
	});

	test("an orphan tool message in the history is dropped before sending", async () => {
		const agent = await wordAgent();
		await agent.send([{ role: "tool", tool_call_id: "x", content: "stray" }, { role: "user", content: "Hi" }]);
		expect(agent.engine.requests[0].messages.map((m) => m.role)).toEqual(["system", "user"]);
	});
});

describe("citations: onNavigate", () => {
	test("paragraph and find links select in the document", async () => {
		const agent = await wordAgent({ doc: { body: ["First", "Net 30 days apply", "Third"], selection: undefined } });
		await agent.win.fire("onNavigate", { href: "eo://word/paragraph/3" });
		expect(agent.fake.doc.selectedText()).toBe("Third");
		await agent.win.fire("onNavigate", "eo://word/find?text=net%2030");
		expect(agent.fake.doc.selectedText()).toBe("Net 30");
	});

	test("invalid links and links for another editor are ignored", async () => {
		const agent = await wordAgent();
		const before = agent.host.calls.length;
		for (const href of ["javascript:alert(1)", "eo://cell/Sheet1!A1", "eo://word/paragraph/0", null, { href: 5 }])
			await agent.win.fire("onNavigate", href);
		expect(agent.host.calls.length).toBe(before);
		expect(agent.fake.doc.selectedText()).toBe("Hello");
	});

	test("a range link activates the sheet and selects the range", async () => {
		const { createWorkbook } = await import("../fakes/cell.js");
		const fake = createWorkbook({ sheets: { Data: [[1]], "Q1 Data": [[2]] } });
		const agent = await createAgent({ editorType: "cell", fake });
		await agent.win.fire("onNavigate", { href: "eo://cell/Q1%20Data!B2:C4" });
		expect(fake.wb.active.name).toBe("Q1 Data");
		expect(fake.wb.selection.GetAddress(false, false)).toBe("B2:C4");
	});

	test("a slide link goes to the slide", async () => {
		const { createPresentation } = await import("../fakes/slide.js");
		const fake = createPresentation({ slides: [{ shapes: ["a"] }, { shapes: ["b"] }, { shapes: ["c"] }] });
		const agent = await createAgent({ editorType: "slide", fake });
		await agent.win.fire("onNavigate", { href: "eo://slide/3/shape/1" });
		expect(agent.host.methodCalls("GoToSlide")[0].args).toEqual([3]);
		expect(fake.pres.current).toBe(2);
	});
});

describe("AI edits: tracked changes and undo (aiEdits.js)", () => {
	test("an approved edit is tracked under the AI's name and can be undone as one step", async () => {
		const agent = await wordAgent();
		agent.engine.queue.push({ tool_calls: [toolCall("c1", "replaceSelection", { text: "Howdy" })] }, { content: "Changed." });
		await agent.send("Make it casual");
		const doc = agent.fake.doc;
		expect(Object.keys(doc.revisions)).toEqual(["AI (Fake model)"]);
		expect(doc.revisions["AI (Fake model)"][0]).toMatchObject({ Type: "TextAdd", Value: "Howdy" });
		expect([doc.trackRevisions, doc.user]).toEqual([false, "User"]); // restored

		const [summary] = agent.win.sent("onAIEditsSummary");
		expect(summary).toMatchObject({ steps: 1, revisionCount: 1, canUndo: true });
		await agent.win.fire("onAIEditsAction", { turnId: summary.turnId, action: "undo" });
		expect(agent.win.sent("onAIEditsActionResult")[0]).toMatchObject({ ok: true });
		expect(doc.undone).toBe(1);
	});

	test("read-only turns produce no edit summary", async () => {
		const agent = await wordAgent();
		agent.engine.queue.push({ tool_calls: [toolCall("c1", "readDocument", {})] }, { content: "ok" });
		await agent.send("Read");
		expect(agent.win.sent("onAIEditsSummary")).toEqual([]);
		expect(agent.fake.doc.undoDepth).toBe(0);
	});

	test("approvals are refused while the chat window has not loaded", async () => {
		const { createWordDocument: make } = await import("../fakes/word.js");
		const agent = await createAgent({ editorType: "word", fake: make({ body: ["Hello world"], selection: { paragraph: 1, start: 0, end: 5 } }) });
		agent.ctx.chatWindow = null;
		agent.ctx.chatWindowShow(); // new window, onWindowReady not fired yet
		const { FakePluginWindow } = await import("../lib/agent.js");
		const win = FakePluginWindow.last;
		agent.engine.queue.push({ tool_calls: [toolCall("c1", "replaceSelection", { text: "x" })] }, { content: "ok" });
		await win.fire("onChatMessage", { messages: [{ role: "user", content: "Go" }], usedTools: [], turnId: "t1" });
		expect(win.sent("onToolApprovalRequest")).toEqual([]);
		expect(agent.fake.doc.texts()[0]).toBe("Hello world");
	});
});
