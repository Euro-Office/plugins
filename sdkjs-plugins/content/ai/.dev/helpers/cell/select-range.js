/*
 * SPDX-FileCopyrightText: Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function(){
	let func = new RegisteredFunction({
		"name": "selectRange",
		"category": "core",
		"readOnly": true,
		"text": "Select Cells",
		"description": "Selects a cell range and scrolls to it, switching to the given sheet first if needed. Use it to show the user a result (e.g. after findInSheet) or to set the selection that selection-based tools act on. Does not change any cell content.",
		"parameters": {
			"type": "object",
			"properties": {
				"range": {
					"type": "string",
					"description": "A1-style address, e.g. 'B7' or 'A1:D20'."
				},
				"sheet": {
					"type": "string",
					"description": "Sheet name. Defaults to the active sheet."
				}
			},
			"required": ["range"]
		},
		"examples": [
			{
				"prompt": "Go to cell F120",
				"arguments": { "range": "F120" }
			},
			{
				"prompt": "Show me the totals on the Summary sheet",
				"arguments": { "range": "B2:E10", "sheet": "Summary" }
			}
		]
	});

	func.call = async function(params) {
		if (typeof params.range !== 'string' || params.range.trim() === "")
			throw new window.AgentState.ToolError('Parameter "range" must be an A1-style string, e.g. "B2:D10". Got: ' + JSON.stringify(params.range));
		if (params.sheet !== undefined && params.sheet !== null && typeof params.sheet !== 'string')
			throw new window.AgentState.ToolError('Parameter "sheet" must be a string. Got: ' + JSON.stringify(params.sheet));

		Asc.scope.selectParams = { range: params.range.trim(), sheet: params.sheet || null };

		let result = await Asc.Editor.callCommand(function(){
			let p = Asc.scope.selectParams;
			let ws = p.sheet ? Api.GetSheet(p.sheet) : Api.GetActiveSheet();
			if (!ws)
				return { error: "Sheet \"" + p.sheet + "\" not found. Available sheets: " + Api.GetSheets().map(function(s){ return s.GetName(); }).join(", ") };
			let range = null;
			try {
				range = ws.GetRange(p.range); // ApiWorksheet.GetRange throws on an invalid address
			} catch (e) {}
			if (!range)
				return { error: "Invalid range \"" + p.range + "\". Use A1 notation such as \"B2\" or \"A1:D20\"." };
			if (p.sheet)
				ws.SetActive();
			range.Select();
			return { sheet: ws.GetName(), selected: range.GetAddress(false, false) };
		});

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	func.describe = function(args, result) {
		return {
			start: toolText("Select cells %1", (args.sheet ? args.sheet + "!" : "") + (args.range || "")),
			done: result && toolText("Selected cells %1", result.sheet + "!" + result.selected),
			phrase: toolText("selected cells")
		};
	};

	return func;
})();
