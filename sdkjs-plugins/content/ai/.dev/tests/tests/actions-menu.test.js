// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Context menu and toolbar built by registerButtons(): the menu structure
// (labels, editors, checkers, icons, separators, submenus) per editor, and
// what each one-shot action does when clicked: which request type it
// creates, what it sends to the model and which Asc.Library method inserts
// the answer, with which provenance metadata.

import { describe, test, expect } from "vitest";
import { createAgent } from "../lib/agent.js";

const EDITORS = ["word", "cell", "slide", "pdf"];
const NEW_EDITOR = { GetVersion: () => "9.3.0" };

const roots = (buttons) => buttons.filter((b) => !b.parent);

// One line per button, indented by depth:
//   text {editors} [checkers] icon=… data=… sep split toggle menu=(…) click
function outline(buttons) {
	const lines = [];
	const icon = (s) => (s ? " icon=" + s.replace(/^.*\/(?:big\/)?([^/%]+)%scale.*$/, "$1") : "");
	function walk(b, depth) {
		let line = "  ".repeat(depth) + b.text;
		if (b.editors) line += " {" + b.editors.join(",") + "}";
		if (b.checkers.length) line += " [" + b.checkers.join(",") + "]";
		line += icon(b.icons);
		if (b.data) line += " data=" + b.data;
		if (b.separator) line += " sep";
		if (b.split) line += " split";
		if (b.enableToggle) line += " toggle";
		if (Array.isArray(b.menu)) line += " menu=(" + b.menu.map((m) => m.text).join("|") + ")";
		if (b.clicks.length) line += " click";
		lines.push(line);
		for (const c of b.childs || []) walk(c, depth + 1);
	}
	buttons.forEach((b) => walk(b, 0));
	return lines.join("\n");
}

async function agentFor(editorType, opts = {}) {
	const agent = await createAgent({ editorType, fake: { methods: opts.oldEditor ? {} : NEW_EDITOR }, localStorage: opts.localStorage });
	const ctx = agent.ctx;
	ctx.onOpenSummarizationModal = () => agent.log.push(["onOpenSummarizationModal"]);
	ctx.onCheckGrammarSpelling = (current) => agent.log.push(["onCheckGrammarSpelling", current]);
	return agent;
}

// Replaces the request engine and the Asc.Library methods the actions use
// with recorders. The library is looked up at call time, so aiEdits'
// wrappers (installed on the same object) see these calls too.
function instrument(agent, { selectedText = "Selected text", currentWord = "", image = "data:image/png;base64,AAAA", reply = "Model\n\nreply" } = {}) {
	const ctx = agent.ctx;
	const log = [];
	agent.log = log;
	ctx.AI.Request.create = (type) => {
		log.push(["create", type]);
		const engine = {
			modelUI: { name: "Fake", provider: "FakeProvider", id: "fake-1" },
			model: { id: "fake-1" },
			async chatRequest(prompt) { log.push(["chatRequest", prompt]); return typeof reply === "function" ? reply(prompt) : reply; },
			async imageGenerationRequest(prompt) { log.push(["imageGenerationRequest", prompt]); return "data:image/png;base64,GEN"; },
			async imageOCRRequest(img) { log.push(["imageOCRRequest", img]); return "# OCR"; },
			async imageVisionRequest(data) { log.push(["imageVisionRequest", data]); return "An image"; }
		};
		return engine;
	};
	const lib = ctx.Asc.Library;
	const readers = {
		GetSelectedText: async () => selectedText,
		GetCurrentWord: async () => currentWord,
		GetSelectedImage: async () => image
	};
	for (const [name, f] of Object.entries(readers))
		lib[name] = async (...args) => { log.push([name]); return f(...args); };
	for (const name of ["PasteText", "InsertAsText", "InsertAsComment", "InsertAsHyperlink", "ReplaceTextSmart", "InsertAsMD", "AddOleObject", "AddGeneratedImage"]) {
		lib[name] = async (...args) => {
			// Markdown plugins are functions: record their names.
			log.push([name, ...args.map((a) => (Array.isArray(a) ? a.map((x) => (typeof x === "function" ? "fn" : x)) : a))]);
		};
	}
	return log;
}

function find(buttons, ...path) {
	let list = buttons.filter((b) => !b.parent);
	let found = null;
	for (const text of path) {
		found = list.find((b) => b.text === text);
		if (!found) throw new Error("no button " + path.join(" > "));
		list = found.childs || [];
	}
	return found;
}

async function click(button) {
	await button.clicks[0](button.data);
}

describe("menu structure", () => {
	for (const editorType of EDITORS) {
		test(editorType + " (editor 9.3)", async () => {
			const agent = await agentFor(editorType);
			expect(outline(roots(agent.contextMenu))).toMatchSnapshot("context menu");
			expect(outline(roots(agent.toolbar))).toMatchSnapshot("toolbar");
		});
	}

	test("older editors have no grammar submenu and no custom assistants", async () => {
		const agent = await agentFor("word", { oldEditor: true });
		expect(outline(roots(agent.contextMenu))).not.toContain("Grammar & Spelling");
		expect(agent.toolbar.map((b) => b.text)).not.toContain("Create AI assistant");
	});

	test("saved custom assistants get a toolbar button each", async () => {
		const agent = await createAgent({
			editorType: "word",
			fake: { methods: NEW_EDITOR },
			localStorage: { onlyoffice_ai_saved_assistants: JSON.stringify([{ id: "a1", name: "Reviewer" }]) }
		});
		const b = agent.toolbar.find((x) => x.text === "Reviewer");
		expect(outline([b])).toBe("Reviewer {word,cell,slide} icon=written-plugin split toggle menu=(Edit|Delete) click");
	});
});

describe("one-shot actions", () => {
	const meta = (action) => ({ action, provider: "FakeProvider", model: "fake-1" });

	test.each([
		[["Summarization"], "Summarization", "InsertAsText", ["Summary:\n\nModel\n\nreply", meta("summarization")]],
		[["Text analysis", "Rewrite differently"], "TextAnalyze", "PasteText", ["Model\nreply", meta("rewrite")]],
		[["Text analysis", "Make longer"], "TextAnalyze", "PasteText", ["Model\nreply", meta("makeLonger")]],
		[["Text analysis", "Make shorter"], "TextAnalyze", "PasteText", ["Model\nreply", meta("makeShorter")]],
		[["Text analysis", "Explain text in comment"], "TextAnalyze", "InsertAsComment", ["Model\nreply", meta("explainComment")]],
		[["Text analysis", "Explain text in hyperlink"], "TextAnalyze", "InsertAsHyperlink", ["Model\nreply", undefined, meta("explainHyperlink")]],
		[["Text analysis", "Fix spelling & grammar"], "TextAnalyze", "ReplaceTextSmart", [["Model\n\nreply"], meta("fixSpellingGrammar")]],
		[["Text analysis", "Keywords"], "TextAnalyze", "InsertAsText", ["Model\n\nreply", meta("keywords")]]
	])("%j", async (path, actionType, method, args) => {
		const agent = await agentFor("word");
		const log = instrument(agent);
		await click(find(agent.contextMenu, "AI", ...path));
		expect(log[0]).toEqual(["create", actionType]);
		expect(log[1]).toEqual(["GetSelectedText"]);
		expect(log[2][0]).toBe("chatRequest");
		expect(log[2][1]).toContain("Selected text");
		expect(log.slice(3)).toEqual([[method, ...args]]);
	});

	test("prompts are the library prompts for the selected text", async () => {
		const agent = await agentFor("word");
		const P = agent.ctx.Asc.Prompts;
		const cases = [
			[["Summarization"], P.getSummarizationPrompt("Selected text")],
			[["Text analysis", "Rewrite differently"], P.getTextRewritePrompt("Selected text")],
			[["Text analysis", "Make longer"], P.getTextLongerPrompt("Selected text")],
			[["Text analysis", "Make shorter"], P.getTextShorterPrompt("Selected text")],
			[["Text analysis", "Explain text in comment"], P.getExplainPrompt("Selected text")],
			[["Text analysis", "Explain text in hyperlink"], P.getExplainAsLinkPrompt("Selected text")],
			[["Text analysis", "Fix spelling & grammar"], P.getFixAndSpellPrompt("Selected text")],
			[["Text analysis", "Keywords"], P.getTextKeywordsPrompt("Selected text")],
			[["Translate", "German"], P.getTranslatePrompt("Selected text", "German")]
		];
		for (const [path, prompt] of cases) {
			const log = instrument(agent);
			await click(find(agent.contextMenu, "AI", ...path));
			expect(log.find((e) => e[0] === "chatRequest")[1], path.join(" > ")).toBe(prompt);
		}
	});

	test("explain in comment falls back to the current word and stops without text", async () => {
		const agent = await agentFor("word");
		let log = instrument(agent, { selectedText: "", currentWord: "word" });
		const button = find(agent.contextMenu, "AI", "Text analysis", "Explain text in comment");
		await click(button);
		expect(log.map((e) => e[0])).toEqual(["create", "GetSelectedText", "GetCurrentWord", "chatRequest", "InsertAsComment"]);
		expect(log[3][1]).toBe(agent.ctx.Asc.Prompts.getExplainPrompt("word"));

		log = instrument(agent, { selectedText: "", currentWord: "" });
		await click(button);
		expect(log.map((e) => e[0])).toEqual(["create", "GetSelectedText", "GetCurrentWord"]);
	});

	test("fix spelling leaves correct text alone", async () => {
		const agent = await agentFor("word");
		const log = instrument(agent, { reply: "The text is correct, there are no errors in it." });
		await click(find(agent.contextMenu, "AI", "Text analysis", "Fix spelling & grammar"));
		expect(log.map((e) => e[0])).toEqual(["create", "GetSelectedText", "chatRequest"]);
	});

	test("an empty model answer inserts nothing", async () => {
		const agent = await agentFor("word");
		const log = instrument(agent, { reply: "" });
		await click(find(agent.contextMenu, "AI", "Summarization"));
		expect(log.map((e) => e[0])).toEqual(["create", "GetSelectedText", "chatRequest"]);
	});

	test("no request engine: nothing is read or inserted", async () => {
		const agent = await agentFor("word");
		const log = instrument(agent);
		agent.ctx.AI.Request.create = (type) => { log.push(["create", type]); return null; };
		await click(find(agent.contextMenu, "AI", "Text analysis", "Keywords"));
		await click(find(agent.contextMenu, "AI", "Image", "OCR"));
		expect(log).toEqual([["create", "TextAnalyze"], ["create", "OCR"]]);
	});

	test.each(["English", "French", "German", "Chinese", "Japanese", "Russian", "Korean", "Spanish", "Italian"])("translate to %s", async (lang) => {
		const agent = await agentFor("cell");
		const log = instrument(agent, { reply: "Übersetzt" });
		await click(find(agent.contextMenu, "AI", "Translate", lang));
		expect(log).toEqual([
			["create", "Translation"],
			["GetSelectedText"],
			["chatRequest", agent.ctx.Asc.Prompts.getTranslatePrompt("Selected text", lang)],
			["PasteText", agent.ctx.Asc.Library.getTranslateResult("Übersetzt", "Selected text"), meta("translate")]
		]);
	});

	test("translate without a selection does nothing", async () => {
		const agent = await agentFor("word");
		const log = instrument(agent, { selectedText: "" });
		await click(find(agent.contextMenu, "AI", "Translate", "English"));
		expect(log).toEqual([["create", "Translation"], ["GetSelectedText"]]);
	});

	test("toolbar translation uses the saved language", async () => {
		const agent = await agentFor("word", { localStorage: { onlyoffice_ai_plugin_translate_lang: "Dutch" } });
		const log = instrument(agent);
		await click(agent.toolbar.find((b) => b.text === "Translation"));
		expect(log).toEqual([
			["create", "Translation"],
			["GetSelectedText"],
			["chatRequest", agent.ctx.Asc.Prompts.getTranslatePrompt("Selected text", "Dutch")],
			["PasteText", agent.ctx.Asc.Library.getTranslateResult("Model\n\nreply", "Selected text"), meta("translate")]
		]);

		const agent2 = await agentFor("word");
		const log2 = instrument(agent2);
		await click(agent2.toolbar.find((b) => b.text === "Translation"));
		expect(log2[2]).toEqual(["chatRequest", agent2.ctx.Asc.Prompts.getTranslatePrompt("Selected text", "english")]);
	});

	test("text to image: OLE object, or a plain image in PDF", async () => {
		for (const [editorType, expected] of [
			["word", ["AddOleObject", "data:image/png;base64,GEN", "Selected text", meta("textToImage")]],
			["pdf", ["AddGeneratedImage", "data:image/png;base64,GEN", meta("textToImage")]]
		]) {
			const agent = await agentFor(editorType);
			const log = instrument(agent);
			await click(find(agent.contextMenu, "AI", "Image", "Text to Image"));
			expect(log).toEqual([["create", "ImageGeneration"], ["GetSelectedText"], ["imageGenerationRequest", "Selected text"], expected]);
		}
	});

	test("OCR and image to text insert markdown", async () => {
		const agent = await agentFor("slide");
		let log = instrument(agent);
		await click(find(agent.contextMenu, "AI", "Image", "OCR"));
		expect(log).toEqual([["create", "OCR"], ["GetSelectedImage"], ["imageOCRRequest", "data:image/png;base64,AAAA"], ["InsertAsMD", "# OCR", ["fn", "fn"], meta("ocr")]]);

		log = instrument(agent);
		await click(find(agent.contextMenu, "AI", "Image", "Image to Text"));
		expect(log).toEqual([
			["create", "Vision"],
			["GetSelectedImage"],
			["imageVisionRequest", { prompt: agent.ctx.Asc.Prompts.getImageDescription(), image: "data:image/png;base64,AAAA" }],
			["InsertAsMD", "An image", undefined, meta("imageToText")]
		]);

		log = instrument(agent, { image: "" });
		await click(find(agent.contextMenu, "AI", "Image", "OCR"));
		await click(find(agent.contextMenu, "AI", "Image", "Image to Text"));
		await click(find(agent.contextMenu, "AI", "Image", "Text to Image"));
		expect(log.map((e) => e[0])).toEqual(["create", "GetSelectedImage", "create", "GetSelectedImage", "create", "GetSelectedText", "imageGenerationRequest", "AddOleObject"]);
	});

	test("grammar, summarization and smart action buttons", async () => {
		const agent = await agentFor("word");
		instrument(agent);
		await click(find(agent.contextMenu, "AI", "Grammar & Spelling", "Check all"));
		await click(find(agent.contextMenu, "AI", "Grammar & Spelling", "Check current text"));
		await click(agent.toolbar.find((b) => b.text === "Summarization"));
		expect(agent.log).toEqual([
			["onCheckGrammarSpelling", false],
			["onCheckGrammarSpelling", true],
			["create", "Summarization"],
			["onOpenSummarizationModal"]
		]);

		const smart = find(agent.contextMenu, "AI", "Smart actions");
		const SA = agent.ctx.SmartActions;
		const first = SA.all("word")[0];
		await click(smart.childs[0]);
		await click(smart.childs[smart.childs.length - 1]);
		await click(find(agent.contextMenu, "AI", "Chatbot"));
		expect(agent.win.sent("onAttachedText")).toEqual([
			{ text: first.prompt + SA.LANG_HINT, forceSend: true },
			{ text: "About the selection: ", forceSend: false },
			{ text: "Selected text", forceSend: false }
		]);
	});
});
