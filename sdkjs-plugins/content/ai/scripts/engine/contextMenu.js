/*
 * (c) Copyright Ascensio System SIA 2010-2025
 *
 * This program is a free software product. You can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License (AGPL)
 * version 3 as published by the Free Software Foundation. In accordance with
 * Section 7(a) of the GNU AGPL its Section 15 shall be amended to the effect
 * that Ascensio System SIA expressly excludes the warranty of non-infringement
 * of any third-party rights.
 *
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR  PURPOSE. For
 * details, see the GNU AGPL at: http://www.gnu.org/licenses/agpl-3.0.html
 *
 * You can contact Ascensio System SIA at 20A-6 Ernesta Birznieka-Upish
 * street, Riga, Latvia, EU, LV-1050.
 *
 * The  interactive user interfaces in modified source and object code versions
 * of the Program must display Appropriate Legal Notices, as required under
 * Section 5 of the GNU AGPL version 3.
 *
 * Pursuant to Section 7(b) of the License you must retain the original Product
 * logo when distributing the program. Pursuant to Section 7(e) we decline to
 * grant you any rights under trademark law for use of our trademarks.
 *
 * All the Product's GUI elements, including illustrations and icon sets, as
 * well as technical writing content are licensed under the terms of the
 * Creative Commons Attribution-ShareAlike 4.0 International. See the License
 * terms at http://creativecommons.org/licenses/by-sa/4.0/legalcode
 *
 */

// The "AI" context menu, built from one table (CONTEXT_MENU), and the
// one-shot actions it runs: read the selection, ask the model once, insert
// the answer (runOneShotAction). The toolbar's translation button runs the
// same translate action (toolbar.js).
(function(window, undefined)
{
	// ── One-shot actions ───────────────────────────────────────────────────
	// A one-shot action reads the selection, asks the model once and inserts
	// the answer. Fields of an action (see runOneShotAction):
	//   id          provenance action name (aiProvenance.js)
	//   actionType  AI.ActionType: which model the request uses
	//   input       "text" (selected text, default), "textOrWord" (selected
	//               text, else the word at the cursor) or "image"
	//   required    do nothing when the input is empty
	//   request     ONE_SHOT_REQUESTS key, default "chat"
	//   prompt      (input, data) => prompt; data is the menu item's data
	//   transform   (answer, input) => text to insert
	//   accept      (answer) => false to insert nothing
	//   insert      ONE_SHOT_INSERTS key: how the answer goes into the file
	// The Asc.Library insert methods are looked up on every call: aiEdits.js
	// wraps them to group and track the change, and the provenance meta
	// argument marks the inserted content.

	function singleNewlines(text) {
		return text.replace(/\n\n/g, '\n');
	}

	const ONE_SHOT_REQUESTS = {
		chat   : function(engine, prompt) { return engine.chatRequest(prompt); },
		image  : function(engine, prompt, input) { return engine.imageGenerationRequest(input); },
		ocr    : function(engine, prompt, input) { return engine.imageOCRRequest(input); },
		vision : function(engine, prompt, input) { return engine.imageVisionRequest({ prompt : prompt, image : input }); }
	};

	const ONE_SHOT_INSERTS = {
		text         : function(result, meta) { return Asc.Library.InsertAsText(result, meta); },
		paste        : function(result, meta) { return Asc.Library.PasteText(result, meta); },
		comment      : function(result, meta) { return Asc.Library.InsertAsComment(result, meta); },
		hyperlink    : function(result, meta) { return Asc.Library.InsertAsHyperlink(result, undefined, meta); },
		replaceSmart : function(result, meta) { return Asc.Library.ReplaceTextSmart([result], meta); },
		md           : function(result, meta) { return Asc.Library.InsertAsMD(result, undefined, meta); },
		mdMath       : function(result, meta) { return Asc.Library.InsertAsMD(result, [Asc.PluginsMD.latex, Asc.PluginsMD.hr], meta); },
		// The generated image, as an OLE object that keeps the prompt (a
		// plain image in PDF).
		image        : function(result, meta, input) {
			if (Asc.plugin.info.editorSubType === "pdf")
				return Asc.Library.AddGeneratedImage(result, meta);
			return Asc.Library.AddOleObject(result, input, meta);
		}
	};

	async function readOneShotInput(kind) {
		switch (kind) {
			case "image":
				return await Asc.Library.GetSelectedImage();
			case "textOrWord":
				return (await Asc.Library.GetSelectedText()) || (await Asc.Library.GetCurrentWord());
			default:
				return await Asc.Library.GetSelectedText();
		}
	}

	async function runOneShotAction(action, data) {
		let requestEngine = AI.Request.create(action.actionType);
		if (!requestEngine)
			return;

		let input = await readOneShotInput(action.input);
		if (action.required && !input) {
			if (action.emptyMessage)
				console.log(action.emptyMessage);
			return;
		}

		let prompt = action.prompt ? action.prompt(input, data) : undefined;
		let result = await ONE_SHOT_REQUESTS[action.request || "chat"](requestEngine, prompt, input);
		if (!result)
			return;

		if (action.transform)
			result = action.transform(result, input);
		if (action.accept && !action.accept(result))
			return;

		await ONE_SHOT_INSERTS[action.insert](result, aiProvenanceMeta(action.id, requestEngine), input);
	}

	const TRANSLATE_ACTION = {
		id         : "translate",
		actionType : AI.ActionType.Translation,
		required   : true,
		prompt     : function(text, lang) { return Asc.Prompts.getTranslatePrompt(text, lang); },
		transform  : function(result, text) { return Asc.Library.getTranslateResult(result, text); },
		insert     : "paste"
	};

	const TEXT_IS_CORRECT = 'The text is correct, there are no errors in it.';

	function showHyperlinkContent(data) {
		let variation = {
			url : "hyperlink.html",
			description : window.Asc.plugin.tr("Hyperlink"),
			isVisual : true,
			buttons : [],
			isModal : false,
			EditorsSupport : ["word", "slide", "cell", "pdf"],
			size : [ 1000, 1000 ]
		};

		var linkWindow = new window.Asc.PluginWindow();
		linkWindow.attachEvent("onGetLink", async function(){
			let link = data;
			if (!link)
				link = await Asc.Library.GetSelectedText();
			link = link.replace(/\n/g, '');
			link = link.replace(/\r/g, '');
			linkWindow.command("onSetLink", link);
		});
		linkWindow.show(variation);
	}

	function buildContextMenu(root, entries) {
		let submenus = { "": root };
		entries.forEach(function(entry) {
			let parent = submenus[entry.parent || ""];
			if (!parent || (entry.when && !entry.when()))
				return;
			let button = new Asc.ButtonContextMenu(parent);
			button.text = entry.text;
			if (entry.icon)
				button.icons = getContextMenuButtonIcons(entry.icon);
			if (entry.editors)
				button.editors = entry.editors;
			if (entry.separator)
				button.separator = true;
			if (entry.data)
				button.data = entry.data;
			button.addCheckers.apply(button, entry.checkers);
			if (entry.onShowExtend)
				button.onContextMenuShowExtendItem = entry.onShowExtend;
			if (entry.actionType)
				button.attachOnClick(function(data) { return runOneShotAction(entry, data); });
			else if (entry.onClick)
				button.attachOnClick(entry.onClick);
			if (entry.submenu)
				submenus[entry.submenu] = button;
		});
	}

	// Builds the context menu under the "AI" root button. editorVersion is
	// Asc.Library.GetEditorVersion() (some items need a newer editor).
	function register(editorVersion) {
		let editorType = Asc.Editor.getType();

		let root = new Asc.ButtonContextMenu();
		root.text = "AI";
		root.icons = getContextMenuButtonIcons("general-ai");
		root.addCheckers("All");

		// ── Context menu ───────────────────────────────────────────────────────
		// Built in this order. An entry with `submenu` is a submenu that later
		// entries name as `parent`. An entry with `actionType` runs as a one-shot
		// action; other entries have their own `onClick`. `when` skips an entry
		// (and so its items). Without `editors` a button keeps the SDK default
		// (word, cell, slide).
		const isNotPdf = function() { return editorType !== "pdf"; };

		const CONTEXT_MENU = [
			{ submenu: "grammar", text: "Grammar & Spelling", icon: "grammar", editors: ["word"], checkers: ["Target", "Selection"],
				when: function() { return editorVersion >= 9002000 && isNotPdf(); } },
			{ parent: "grammar", text: "Check all", editors: ["word"], checkers: ["Target", "Selection"],
				onClick: function() { onCheckGrammarSpelling(false); } },
			{ parent: "grammar", text: "Check current text", editors: ["word"], checkers: ["Target", "Selection"],
				onClick: function() { onCheckGrammarSpelling(true); } },

			{ id: "summarization", text: "Summarization", icon: "summarization", editors: ["word"], checkers: ["Selection"], when: isNotPdf,
				actionType: AI.ActionType.Summarization,
				prompt: function(text) { return Asc.Prompts.getSummarizationPrompt(text); },
				transform: function(result) { return "Summary:\n\n" + result; },
				insert: "text" },

			{ submenu: "textAnalysis", text: "Text analysis", icon: "text-analysis-ai", editors: ["word"], checkers: ["Target", "Selection"] },
			{ parent: "textAnalysis", id: "rewrite", text: "Rewrite differently", editors: ["word"], checkers: ["Selection"],
				actionType: AI.ActionType.TextAnalyze,
				prompt: function(text) { return Asc.Prompts.getTextRewritePrompt(text); },
				transform: singleNewlines, insert: "paste" },
			{ parent: "textAnalysis", id: "makeLonger", text: "Make longer", editors: ["word"], checkers: ["Selection"],
				actionType: AI.ActionType.TextAnalyze,
				prompt: function(text) { return Asc.Prompts.getTextLongerPrompt(text); },
				transform: singleNewlines, insert: "paste" },
			{ parent: "textAnalysis", id: "makeShorter", text: "Make shorter", editors: ["word"], checkers: ["Selection"],
				actionType: AI.ActionType.TextAnalyze,
				prompt: function(text) { return Asc.Prompts.getTextShorterPrompt(text); },
				transform: singleNewlines, insert: "paste" },
			{ parent: "textAnalysis", id: "explainComment", text: "Explain text in comment", separator: true, editors: ["word"], checkers: ["Target", "Selection"],
				actionType: AI.ActionType.TextAnalyze, input: "textOrWord", required: true,
				prompt: function(text) { return Asc.Prompts.getExplainPrompt(text); },
				transform: singleNewlines, insert: "comment" },
			{ parent: "textAnalysis", id: "explainHyperlink", text: "Explain text in hyperlink", separator: true, editors: ["word"], checkers: ["Selection"],
				actionType: AI.ActionType.TextAnalyze,
				prompt: function(text) { return Asc.Prompts.getExplainAsLinkPrompt(text); },
				transform: singleNewlines, insert: "hyperlink" },
			// "fixSpellingGrammar" is an assistive edit: AIProvenance.EXEMPT_ACTIONS
			// keeps it unmarked (Art. 50(2) standard-editing exception).
			{ parent: "textAnalysis", id: "fixSpellingGrammar", text: "Fix spelling & grammar", separator: true, editors: ["word"], checkers: ["Selection"],
				actionType: AI.ActionType.TextAnalyze,
				prompt: function(text) { return Asc.Prompts.getFixAndSpellPrompt(text); },
				accept: function(result) {
					if (result !== TEXT_IS_CORRECT)
						return true;
					console.log(TEXT_IS_CORRECT);
					return false;
				},
				insert: "replaceSmart" },
			{ parent: "textAnalysis", id: "keywords", text: "Keywords", editors: ["word"], checkers: ["Selection"],
				actionType: AI.ActionType.TextAnalyze,
				prompt: function(text) { return Asc.Prompts.getTextKeywordsPrompt(text); },
				insert: "text" },

			{ submenu: "translate", text: "Translate", icon: "translation", editors: ["word", "slide", "cell"], checkers: ["Selection"] }
		].concat(["English", "French", "German", "Chinese", "Japanese", "Russian", "Korean", "Spanish", "Italian"].map(function(lang) {
			return Object.assign({ parent: "translate", text: lang, data: lang, editors: ["word", "slide", "cell"], checkers: ["Selection"] }, TRANSLATE_ACTION);
		}), [
			{ text: "Show hyperlink content", checkers: ["Hyperlink"],
				onShowExtend: function(options, item) { item.data = options.value; },
				onClick: showHyperlinkContent },

			{ submenu: "image", text: "Image", icon: "image-ai", checkers: ["Selection", "Image", "OleObject"] },
			{ parent: "image", id: "textToImage", text: "Text to Image", checkers: ["Selection"],
				actionType: AI.ActionType.ImageGeneration, required: true, request: "image", insert: "image" },
			{ parent: "image", id: "ocr", text: "OCR", checkers: ["Image", "OleObject"],
				actionType: AI.ActionType.OCR, input: "image", required: true, emptyMessage: "you need to select an image to use ocr",
				request: "ocr", insert: "mdMath" },
			{ parent: "image", id: "imageToText", text: "Image to Text", checkers: ["Image", "OleObject"],
				actionType: AI.ActionType.Vision, input: "image", required: true,
				prompt: function() { return Asc.Prompts.getImageDescription(); },
				request: "vision", insert: "md" }
		], smartActionsMenu(), [
			{ text: "Chatbot", separator: true, icon: "ask-ai", checkers: ["All"],
				onClick: async function() {
					let selectedText = await Asc.Library.GetSelectedText();
					window.AIChatWindow.show(selectedText);
				} }
		]);

		// Smart actions: context-aware agent tasks for the current selection.
		// Each one hands a prompt to the chat agent, which sees the selection
		// (see DocumentContext) and can read/modify the document through tools.
		// Their table is scripts/helpers/smartActions.js (shared with the chat
		// chips); only the menu items are built here.
		function smartActionsMenu() {
			let actions = (isNotPdf() && window.SmartActions) ? window.SmartActions.all(editorType) : [];
			if (!actions.length)
				return [];
			let entries = [{ submenu: "smart", text: "Smart actions", icon: "ask-ai", editors: [editorType], checkers: ["Selection"] }];
			actions.forEach(function(action) {
				entries.push({ parent: "smart", text: action.text, editors: [editorType], checkers: ["Selection"],
					onClick: function() { window.AIChatWindow.show(action.prompt + window.SmartActions.LANG_HINT, true); } });
			});
			entries.push({ parent: "smart", text: "Ask about selection...", separator: true, editors: [editorType], checkers: ["Selection"],
				onClick: function() { window.AIChatWindow.show(Asc.plugin.tr("About the selection:") + " ", false); } });
			return entries;
		}

		buildContextMenu(root, CONTEXT_MENU);
	}

	window.AIContextMenu = {
		register         : register,
		runOneShotAction : runOneShotAction,
		TRANSLATE_ACTION : TRANSLATE_ACTION
	};

})(window);
