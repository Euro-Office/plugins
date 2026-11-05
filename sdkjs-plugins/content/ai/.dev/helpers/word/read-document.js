(function(){
	let func = new RegisteredFunction({
		"name": "readDocument",
		"readOnly": true,
		"text": "Read Document",
		"description": "Reads the content of the open text document. Returns the total number of top-level elements and, for the requested window, each element's 1-based index, type (paragraph/table/blockLvlSdt), style name and text. Use it to understand the document before editing it, to locate paragraphs by content, or to answer questions about the document. Call it again with a different startIndex to page through long documents.",
		"parameters": {
			"type": "object",
			"properties": {
				"startIndex": {
					"type": "number",
					"description": "1-based index of the first element to return.",
					"default": 1
				},
				"count": {
					"type": "number",
					"description": "Maximum number of elements to return (1-200).",
					"default": 50
				},
				"maxCharsPerElement": {
					"type": "number",
					"description": "Truncate the text of each element to this many characters (50-5000).",
					"default": 1000
				}
			},
			"required": []
		},
		"examples": [
			{
				"prompt": "What is this document about?",
				"arguments": {}
			},
			{
				"prompt": "Read paragraphs 51 to 100",
				"arguments": { "startIndex": 51, "count": 50 }
			}
		]
	});

	func.call = async function(params) {
		let start = params.startIndex === undefined ? 1 : params.startIndex;
		let count = params.count === undefined ? 50 : params.count;
		let maxChars = params.maxCharsPerElement === undefined ? 1000 : params.maxCharsPerElement;
		if (typeof start !== 'number' || start < 1)
			throw new window.AgentState.ToolError('Parameter "startIndex" must be a number >= 1. Got: ' + JSON.stringify(params.startIndex));
		if (typeof count !== 'number' || count < 1)
			throw new window.AgentState.ToolError('Parameter "count" must be a positive number. Got: ' + JSON.stringify(params.count));
		if (typeof maxChars !== 'number' || maxChars < 1)
			throw new window.AgentState.ToolError('Parameter "maxCharsPerElement" must be a positive number. Got: ' + JSON.stringify(params.maxCharsPerElement));

		Asc.scope.readParams = {
			start: Math.floor(start),
			count: Math.min(200, Math.floor(count)),
			maxChars: Math.max(50, Math.min(5000, Math.floor(maxChars)))
		};

		return await Asc.Editor.callCommand(function(){
			let p = Asc.scope.readParams;
			let doc = Api.GetDocument();
			let total = doc.GetElementsCount();
			let elements = [];
			let end = Math.min(total, p.start - 1 + p.count);
			for (let i = p.start - 1; i < end; i++) {
				let el = doc.GetElement(i);
				if (!el)
					continue;
				let type = el.GetClassType();
				let item = { index: i + 1, type: type };
				try {
					if (type === "paragraph") {
						let style = el.GetStyle();
						if (style)
							item.style = style.GetName();
						let numbering = el.GetNumbering ? el.GetNumbering() : null;
						if (numbering)
							item.list = true;
					} else if (type === "table") {
						item.rows = el.GetRowsCount();
					}
				} catch (e) {}
				let text = "";
				try {
					text = el.GetText ? el.GetText() : "";
				} catch (e) {}
				text = (text || "").replace(/\r/g, "");
				if (text.length > p.maxChars) {
					item.truncated = true;
					text = text.substring(0, p.maxChars) + "…";
				}
				item.text = text;
				elements.push(item);
			}
			return {
				totalElements: total,
				returned: elements.length,
				hasMore: end < total,
				elements: elements
			};
		});
	};

	return func;
})();
