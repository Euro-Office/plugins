/*
 * SPDX-FileCopyrightText: Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function(){
	let func = new RegisteredFunction({
		"name": "editParagraph",
		"category": "edit-text",
		"text": "Edit Paragraph",
		"description": "Edits the document by top-level element index (as returned by readDocument). Actions: 'replace' replaces the text of a paragraph (keeps its style), 'insertBefore'/'insertAfter' add a new paragraph next to the element (optionally with a style such as 'Heading 1'), 'delete' removes the element. Indexes are 1-based; after inserting or deleting, later indexes shift, so re-read the document if you need further edits.",
		"parameters": {
			"type": "object",
			"properties": {
				"index": {
					"type": "number",
					"description": "1-based index of the target element."
				},
				"action": {
					"type": "string",
					"enum": ["replace", "insertBefore", "insertAfter", "delete"],
					"description": "What to do with the element."
				},
				"text": {
					"type": "string",
					"description": "New paragraph text (required for replace/insert)."
				},
				"style": {
					"type": "string",
					"description": "Optional paragraph style name for inserted or replaced paragraphs, e.g. 'Heading 1', 'Normal', 'List Paragraph'."
				}
			},
			"required": ["index", "action"]
		},
		"examples": [
			{
				"prompt": "Add a heading 'Summary' after paragraph 3",
				"arguments": { "index": 3, "action": "insertAfter", "text": "Summary", "style": "Heading 1" }
			},
			{
				"prompt": "Delete the second paragraph",
				"arguments": { "index": 2, "action": "delete" }
			}
		]
	});

	// Stale-read risk: "index" comes from an earlier readDocument. The document
	// stays editable during a chat turn, so paragraphs the user adds or
	// removes meanwhile shift the index and the edit may hit another paragraph.
	func.call = async function(params) {
		const actions = ["replace", "insertBefore", "insertAfter", "delete"];
		if (typeof params.index !== 'number' || params.index < 1)
			throw new window.AgentState.ToolError('Parameter "index" must be a number >= 1. Got: ' + JSON.stringify(params.index));
		if (!actions.includes(params.action))
			throw new window.AgentState.ToolError('Parameter "action" must be one of ' + JSON.stringify(actions) + '. Got: ' + JSON.stringify(params.action));
		if (params.action !== "delete" && typeof params.text !== 'string')
			throw new window.AgentState.ToolError('Parameter "text" is required for action "' + params.action + '".');
		if (params.style !== undefined && params.style !== null && typeof params.style !== 'string')
			throw new window.AgentState.ToolError('Parameter "style" must be a string.');

		Asc.scope.editParams = {
			pos: Math.floor(params.index) - 1,
			action: params.action,
			text: params.text || "",
			style: params.style || null,
			// Provenance: new text goes into an inline "ai-generated" content
			// control per paragraph (inline keeps the element indexes stable).
			cc: window.AIProvenance ? window.AIProvenance.cc(window.AIProvenance.scopeMeta("editParagraph")) : null
		};

		let result = await Asc.Editor.callCommand(function(){
			let p = Asc.scope.editParams;
			let doc = Api.GetDocument();
			let total = doc.GetElementsCount();
			if (p.pos >= total)
				return { error: "Index " + (p.pos + 1) + " is out of range. The document has " + total + " elements." };
			let el = doc.GetElement(p.pos);

			// Adds the text to the paragraph, inside an "ai-generated" content
			// control when marking is on (needs Api.CreateInlineLvlSdt).
			function addText(par, text, textPr) {
				let run = Api.CreateRun();
				if (textPr)
					run.SetTextPr(textPr);
				run.AddText(text);
				if (p.cc && text !== "" && typeof Api.CreateInlineLvlSdt === "function") {
					let sdt = Api.CreateInlineLvlSdt();
					sdt.SetTag(p.cc.tag);
					sdt.SetAlias(p.cc.alias);
					if (typeof sdt.SetAppearance === "function")
						sdt.SetAppearance("hidden");
					if (sdt.AddElement(run, 0)) {
						par.AddElement(sdt);
						return;
					}
				}
				par.AddElement(run);
			}

			function applyStyle(par) {
				if (!p.style)
					return null;
				let style = doc.GetStyle(p.style);
				if (!style)
					return "Style \"" + p.style + "\" not found; paragraph kept its current style.";
				par.SetStyle(style);
				return null;
			}

			let warning = null;
			switch (p.action) {
				case "delete": {
					doc.RemoveElement(p.pos);
					return { totalElements: doc.GetElementsCount() };
				}
				case "replace": {
					if (el.GetClassType() !== "paragraph")
						return { error: "Element " + (p.pos + 1) + " is a " + el.GetClassType() + ", not a paragraph. Use writeMacro to edit it." };
					let lines = p.text.split("\n");
					let firstRun = el.GetElementsCount() > 0 ? el.GetElement(0) : null;
					let textPr = (firstRun && firstRun.GetClassType() === "run") ? firstRun.GetTextPr() : null;
					el.RemoveAllElements();
					addText(el, lines[0], textPr);
					warning = applyStyle(el);
					let insertAt = p.pos + 1;
					for (let i = 1; i < lines.length; i++) {
						let par = Api.CreateParagraph();
						let st = el.GetStyle();
						if (st)
							par.SetStyle(st);
						addText(par, lines[i], null);
						doc.AddElement(insertAt++, par);
					}
					break;
				}
				case "insertBefore":
				case "insertAfter": {
					let insertAt = p.action === "insertBefore" ? p.pos : p.pos + 1;
					let lines = p.text.split("\n");
					for (let i = 0; i < lines.length; i++) {
						let par = Api.CreateParagraph();
						addText(par, lines[i], null);
						let w = applyStyle(par);
						if (w)
							warning = w;
						doc.AddElement(insertAt + i, par);
					}
					break;
				}
			}
			let res = { totalElements: doc.GetElementsCount() };
			if (warning)
				res.warning = warning;
			return res;
		});

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	func.describe = function(args) {
		let n = args.index;
		let heading = typeof args.style === "string" && /heading|title/i.test(args.style);
		let texts = {
			replace: [toolText("Replace paragraph %1", n), toolText("Replaced paragraph %1", n)],
			delete: [toolText("Delete paragraph %1", n), toolText("Deleted paragraph %1", n)],
			insertBefore: heading ? [toolText("Insert a heading before paragraph %1", n), toolText("Inserted a heading before paragraph %1", n)] : [toolText("Insert a paragraph before paragraph %1", n), toolText("Inserted a paragraph before paragraph %1", n)],
			insertAfter: heading ? [toolText("Insert a heading after paragraph %1", n), toolText("Inserted a heading after paragraph %1", n)] : [toolText("Insert a paragraph after paragraph %1", n), toolText("Inserted a paragraph after paragraph %1", n)]
		}[args.action];
		if (!texts)
			return null;
		return { start: texts[0], done: texts[1], phrase: toolText("edited the document") };
	};

	return func;
})();
