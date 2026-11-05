(function(){
	let func = new RegisteredFunction({
		"name": "setNumberFormat",
		"text": "Set Number Format",
		"description": "Applies a number format code to a cell range without changing the stored values. Use standard Excel format codes, e.g. 'General', '0', '0.00', '#,##0.00', '0%', '0.0%', '#,##0.00 \"€\"', '[$$-409]#,##0.00', 'dd.mm.yyyy', 'yyyy-mm-dd', 'hh:mm', '@' (text). Use it to show values as currency, percentages, dates or with a fixed number of decimals.",
		"parameters": {
			"type": "object",
			"properties": {
				"range": {
					"type": "string",
					"description": "A1-style address, e.g. 'C2:C50'. Defaults to the current selection."
				},
				"sheet": {
					"type": "string",
					"description": "Sheet name. Defaults to the active sheet."
				},
				"format": {
					"type": "string",
					"description": "Number format code, e.g. '#,##0.00'."
				}
			},
			"required": ["format"]
		},
		"examples": [
			{
				"prompt": "Show column D as percentages with one decimal",
				"arguments": { "range": "D2:D100", "format": "0.0%" }
			},
			{
				"prompt": "Format the selection as euro amounts",
				"arguments": { "format": "#,##0.00 \"€\"" }
			}
		]
	});

	func.call = async function(params) {
		if (typeof params.format !== 'string' || params.format === "")
			throw new window.AgentState.ToolError('Parameter "format" must be a non-empty number format code, e.g. "#,##0.00".');
		if (params.range !== undefined && params.range !== null && typeof params.range !== 'string')
			throw new window.AgentState.ToolError('Parameter "range" must be an A1-style string. Got: ' + JSON.stringify(params.range));
		if (params.sheet !== undefined && params.sheet !== null && typeof params.sheet !== 'string')
			throw new window.AgentState.ToolError('Parameter "sheet" must be a string. Got: ' + JSON.stringify(params.sheet));

		Asc.scope.formatParams = { range: params.range || null, sheet: params.sheet || null, format: params.format };

		let result = await Asc.Editor.callCommand(function(){
			let p = Asc.scope.formatParams;
			let ws = p.sheet ? Api.GetSheet(p.sheet) : Api.GetActiveSheet();
			if (!ws)
				return { error: "Sheet \"" + p.sheet + "\" not found. Available sheets: " + Api.GetSheets().map(function(s){ return s.GetName(); }).join(", ") };
			let range = p.range ? ws.GetRange(p.range) : Api.GetSelection();
			if (!range)
				return { error: p.range ? "Invalid range \"" + p.range + "\"." : "No range selected. Pass \"range\"." };
			range.SetNumberFormat(p.format);
			let sample = null;
			try {
				let cell = ws.GetRangeByNumber(range.GetRow() - 1, range.GetCol() - 1);
				sample = { address: cell.GetAddress(false, false), displayed: cell.GetText() };
			} catch (e) {}
			let res = { sheet: ws.GetName(), range: range.GetAddress(false, false), format: p.format };
			if (sample)
				res.sample = sample;
			return res;
		});

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	return func;
})();
