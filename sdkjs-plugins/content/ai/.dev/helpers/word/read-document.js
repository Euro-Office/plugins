/*
 * SPDX-FileCopyrightText: Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function(){
	let func = new RegisteredFunction({
		"name": "readDocument",
		"category": "core",
		"readOnly": true,
		"text": "Read Document",
		"description": "Reads the content of the open text document. Returns the total number of top-level elements and, for the requested window, each element's 1-based index, type (paragraph/table/blockLvlSdt), style name and text (tables: one line per row, cells separated by \" | \"). Use it to understand the document before editing it, to locate paragraphs by content, or to answer questions about the document. Call it again with a different startIndex to page through long documents.",
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
			// ApiTable and ApiBlockLvlSdt have no GetText(): a table is read
			// cell by cell (one line per row, cells separated by " | "), a
			// content control through its ApiDocumentContent.
			let cellOptions = { ParaSeparator: " ", NewLineSeparator: " ", TableCellSeparator: " | ", TableRowSeparator: " / " };
			function elementText(el, type) {
				if (type === "table") {
					let rows = [];
					let rowsCount = el.GetRowsCount();
					for (let r = 0; r < rowsCount; r++) {
						let row = el.GetRow(r);
						let cells = [];
						let cellsCount = row ? row.GetCellsCount() : 0;
						for (let c = 0; c < cellsCount; c++) {
							let cell = row.GetCell(c);
							let content = cell ? cell.GetContent() : null;
							cells.push(content ? (content.GetText(cellOptions) || "").trim() : "");
						}
						rows.push(cells.join(" | "));
					}
					return rows.join("\n");
				}
				if (type === "blockLvlSdt" && el.GetContent) {
					let content = el.GetContent();
					return content ? content.GetText({ ParaSeparator: "\n" }) : "";
				}
				return el.GetText ? el.GetText() : "";
			}

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
					text = elementText(el, type);
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

	func.describe = function(args, result) {
		let from = typeof args.startIndex === "number" ? Math.max(1, Math.floor(args.startIndex)) : 1;
		let count = typeof args.count === "number" ? Math.max(1, Math.floor(args.count)) : 50;
		let done;
		if (result && from === 1 && !result.hasMore)
			done = toolText("Read the whole document (%1 paragraphs)", result.totalElements);
		else if (result && result.returned > 0)
			done = toolText("Read paragraphs %1 to %2 of %3", from, from + result.returned - 1, result.totalElements);
		else if (result)
			done = toolText("Read the document (nothing at paragraph %1)", from);
		return {
			start: toolText("Read paragraphs %1 to %2", from, from + count - 1),
			done: done,
			phrase: toolText("read the document")
		};
	};

	return func;
})();
