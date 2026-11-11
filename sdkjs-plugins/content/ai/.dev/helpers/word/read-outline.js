/*
 * SPDX-FileCopyrightText: Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function(){
	let func = new RegisteredFunction({
		"name": "readOutline",
		"category": "core",
		"readOnly": true,
		"text": "Read Outline",
		"description": "Returns the outline (table of contents) of the text document: every top-level heading paragraph with its heading level (1 = top level, up to 9), its 1-based element index (same numbering as readDocument/editParagraph) and its text. Headings are detected from the paragraph's outline level or a 'Heading N' style. Use it to understand the structure of a long document cheaply, then read or edit specific sections by index.",
		"parameters": {
			"type": "object",
			"properties": {
				"maxLevel": {
					"type": "number",
					"description": "Only return headings up to this level (1-9).",
					"default": 9
				}
			},
			"required": []
		},
		"examples": [
			{
				"prompt": "What sections does this document have?",
				"arguments": {}
			},
			{
				"prompt": "List the chapters",
				"arguments": { "maxLevel": 1 }
			}
		]
	});

	func.call = async function(params) {
		let maxLevel = params.maxLevel === undefined || params.maxLevel === null ? 9 : params.maxLevel;
		if (typeof maxLevel !== 'number' || maxLevel < 1)
			throw new window.AgentState.ToolError('Parameter "maxLevel" must be a number between 1 and 9. Got: ' + JSON.stringify(params.maxLevel));
		Asc.scope.outlineParams = { maxLevel: Math.min(9, Math.floor(maxLevel)) };

		return await Asc.Editor.callCommand(function(){
			let p = Asc.scope.outlineParams;
			let doc = Api.GetDocument();
			let total = doc.GetElementsCount();
			let headings = [];

			function levelOf(par) {
				let lvl = null;
				try {
					let pr = par.GetParaPr();
					lvl = pr && pr.GetOutlineLvl ? pr.GetOutlineLvl() : null;
				} catch (e) {}
				let style = null;
				try {
					style = par.GetStyle();
				} catch (e) {}
				if (typeof lvl !== "number" && style) {
					try {
						let spr = style.GetParaPr();
						lvl = spr && spr.GetOutlineLvl ? spr.GetOutlineLvl() : null;
					} catch (e) {}
				}
				if (typeof lvl !== "number" && style) {
					let m = /^(?:heading|überschrift|titre|título|titolo|заголовок)\s*([1-9])$/i.exec(style.GetName() || "");
					if (m)
						lvl = parseInt(m[1], 10);
				}
				return (typeof lvl === "number" && lvl >= 1 && lvl <= 9) ? lvl : null;
			}

			for (let i = 0; i < total; i++) {
				let el = doc.GetElement(i);
				if (!el || el.GetClassType() !== "paragraph")
					continue;
				let level = levelOf(el);
				if (level === null || level > p.maxLevel)
					continue;
				let text = (el.GetText() || "").replace(/[\r\n]+/g, " ").trim();
				if (text === "")
					continue;
				headings.push({ level: level, index: i + 1, text: text.length > 300 ? text.substring(0, 300) + "…" : text });
			}
			return { totalElements: total, headings: headings };
		});
	};

	func.describe = function(args, result) {
		return {
			start: toolText("Read the outline"),
			done: result && toolText("Read the outline (%1 headings)", (result.headings || []).length),
			phrase: toolText("read the outline")
		};
	};

	return func;
})();
