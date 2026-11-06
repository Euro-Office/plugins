/*
 * SPDX-FileCopyrightText: Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function(){
	let func = new RegisteredFunction({
		"name": "findAIContent",
		"category": "comments-review",
		"readOnly": true,
		"text": "Find AI-Generated Content",
		"description": "Lists the parts of the text document that were marked as AI-generated (content controls tagged 'ai-generated', added when AI text is inserted) together with the document-level AI provenance properties (AIGenerated, AIGeneratedModels, AIGeneratedLastUpdate). For each marked part returns its 1-based number in document order, kind (inline/block), the 1-based index of the top-level element that contains it (same numbering as readDocument; omitted when it is nested in a table or another container), the model and date, the character count and a text snippet. Use it to answer questions like 'What in this document was written by AI?'. Text that was edited by the user afterwards stays inside the mark.",
		"parameters": {
			"type": "object",
			"properties": {
				"maxResults": {
					"type": "number",
					"description": "Maximum number of marked parts to return (1-200).",
					"default": 50
				},
				"maxChars": {
					"type": "number",
					"description": "Truncate each snippet to this many characters (20-2000).",
					"default": 200
				}
			},
			"required": []
		},
		"examples": [
			{
				"prompt": "What in this document was AI-generated?",
				"arguments": {}
			}
		]
	});

	func.call = async function(params) {
		let max = params.maxResults === undefined || params.maxResults === null ? 50 : params.maxResults;
		let maxChars = params.maxChars === undefined || params.maxChars === null ? 200 : params.maxChars;
		if (typeof max !== 'number' || max < 1)
			throw new window.AgentState.ToolError('Parameter "maxResults" must be a number >= 1. Got: ' + JSON.stringify(params.maxResults));
		if (typeof maxChars !== 'number' || maxChars < 1)
			throw new window.AgentState.ToolError('Parameter "maxChars" must be a number >= 1. Got: ' + JSON.stringify(params.maxChars));

		Asc.scope.findAIParams = {
			tag: window.AIProvenance ? window.AIProvenance.TAG : "ai-generated",
			max: Math.min(200, Math.floor(max)),
			maxChars: Math.max(20, Math.min(2000, Math.floor(maxChars)))
		};

		return await Asc.Editor.callCommand(function(){
			let p = Asc.scope.findAIParams;
			let doc = Api.GetDocument();

			let fileLevel = null;
			if (typeof doc.GetCustomProperties === "function") {
				let props = doc.GetCustomProperties();
				fileLevel = {
					AIGenerated: props.Get("AIGenerated"),
					AIGeneratedModels: props.Get("AIGeneratedModels"),
					AIGeneratedLastUpdate: props.Get("AIGeneratedLastUpdate"),
					AIGeneratedPolicy: props.Get("AIGeneratedPolicy")
				};
			}

			let list = [];
			if (typeof doc.GetContentControlsByTag === "function") {
				list = doc.GetContentControlsByTag(p.tag) || [];
			} else {
				let all = doc.GetAllContentControls() || [];
				for (let i = 0; i < all.length; i++) {
					if (all[i].GetTag && all[i].GetTag() === p.tag)
						list.push(all[i]);
				}
			}

			// Top-level index of the element holding the mark, if it is not nested.
			function topLevelIndex(el) {
				if (!el || typeof el.GetPosInParent !== "function")
					return undefined;
				if (typeof el.GetParentTableCell === "function" && el.GetParentTableCell())
					return undefined;
				if (typeof el.GetParentContentControl === "function" && el.GetParentContentControl())
					return undefined;
				let pos = el.GetPosInParent();
				return (typeof pos === "number" && pos >= 0) ? pos + 1 : undefined;
			}

			let items = [];
			let totalChars = 0;
			for (let i = 0; i < list.length; i++) {
				let cc = list[i];
				let kind = cc.GetClassType() === "blockLvlSdt" ? "block" : "inline";
				let content = "";
				try {
					let range = cc.GetRange();
					content = range ? (range.GetText() || "") : "";
				} catch (e) {}
				content = content.replace(/\r/g, "");
				totalChars += content.length;
				if (items.length >= p.max)
					continue;

				let alias = typeof cc.GetAlias === "function" ? (cc.GetAlias() || "") : "";
				let item = { number: i + 1, kind: kind, label: alias, characters: content.length };
				let m = /^AI-generated \((.*), (\d{4}-\d{2}-\d{2})\)$/.exec(alias);
				if (m) {
					item.model = m[1];
					item.date = m[2];
				}

				let holder = kind === "block" ? cc : (typeof cc.GetParentParagraph === "function" ? cc.GetParentParagraph() : null);
				let index = topLevelIndex(holder);
				if (index !== undefined)
					item.index = index;

				item.snippet = content.length > p.maxChars ? content.substring(0, p.maxChars) + "…" : content;
				items.push(item);
			}

			return {
				fileLevel: fileLevel,
				markedParts: list.length,
				markedCharacters: totalChars,
				returned: items.length,
				parts: items,
				note: list.length ? undefined : "No marked AI-generated text found. Text inserted before marking was enabled, or edited outside the AI plugin, is not marked."
			};
		});
	};

	return func;
})();
