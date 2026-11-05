(function(){
	let func = new RegisteredFunction({
		"name": "findFormulaErrors",
		"readOnly": true,
		"text": "Find Formula Errors",
		"description": "Scans the used range of a worksheet (or all worksheets) for cells showing an error value (#REF!, #DIV/0!, #VALUE!, #NAME?, #N/A, #NUM!, #NULL!, #SPILL!, #CALC!, #GETTING_DATA) and returns each one's sheet, address, error and formula, plus a count per error type. Use it to audit a workbook, then explain or repair the formulas (fixFormula, writeRange).",
		"parameters": {
			"type": "object",
			"properties": {
				"sheet": {
					"type": "string",
					"description": "Sheet name. Defaults to the active sheet."
				},
				"allSheets": {
					"type": "boolean",
					"description": "Scan every worksheet.",
					"default": false
				},
				"maxResults": {
					"type": "number",
					"description": "Maximum number of error cells to return (1-500).",
					"default": 200
				}
			},
			"required": []
		},
		"examples": [
			{
				"prompt": "Are there any broken formulas?",
				"arguments": { "allSheets": true }
			}
		]
	});

	func.call = async function(params) {
		if (params.sheet !== undefined && params.sheet !== null && typeof params.sheet !== 'string')
			throw new window.AgentState.ToolError('Parameter "sheet" must be a string. Got: ' + JSON.stringify(params.sheet));
		let max = params.maxResults === undefined || params.maxResults === null ? 200 : params.maxResults;
		if (typeof max !== 'number' || max < 1)
			throw new window.AgentState.ToolError('Parameter "maxResults" must be a number >= 1. Got: ' + JSON.stringify(params.maxResults));

		Asc.scope.errorParams = {
			sheet: params.sheet || null,
			allSheets: params.allSheets === true,
			max: Math.min(500, Math.floor(max)),
			maxCells: 500000
		};

		let result = await Asc.Editor.callCommand(function(){
			let p = Asc.scope.errorParams;
			const ERRORS = ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#GETTING_DATA", "#SPILL!", "#CALC!"];
			let sheets;
			if (p.allSheets) {
				sheets = Api.GetSheets();
			} else {
				let ws = p.sheet ? Api.GetSheet(p.sheet) : Api.GetActiveSheet();
				if (!ws)
					return { error: "Sheet \"" + p.sheet + "\" not found. Available sheets: " + Api.GetSheets().map(function(s){ return s.GetName(); }).join(", ") };
				sheets = [ws];
			}
			function colName(n) {
				let s = "";
				while (n > 0) {
					let m = (n - 1) % 26;
					s = String.fromCharCode(65 + m) + s;
					n = Math.floor((n - 1) / 26);
				}
				return s;
			}
			let found = [];
			let counts = {};
			let total = 0;
			let budget = p.maxCells;
			let truncatedScan = false;
			for (let s = 0; s < sheets.length && budget > 0; s++) {
				let ws = sheets[s];
				let used = ws.GetUsedRange();
				if (!used)
					continue;
				let rows = used.GetRowsCount(), cols = used.GetColumnsCount();
				let r0 = used.GetRow() - 1, c0 = used.GetCol() - 1;
				let scan = used;
				if (rows * cols > budget) {
					rows = Math.max(1, Math.floor(budget / cols));
					truncatedScan = true;
					scan = ws.GetRange(colName(c0 + 1) + (r0 + 1) + ":" + colName(c0 + cols) + (r0 + rows));
				}
				budget -= rows * cols;
				let values = scan.GetValue();
				if (!Array.isArray(values))
					values = [[values]];
				for (let r = 0; r < rows && r < values.length; r++) {
					let row = Array.isArray(values[r]) ? values[r] : [values[r]];
					for (let c = 0; c < row.length; c++) {
						let v = row[c];
						if (typeof v !== "string" || v.charAt(0) !== "#" || ERRORS.indexOf(v) === -1)
							continue;
						total++;
						counts[v] = (counts[v] || 0) + 1;
						if (found.length >= p.max)
							continue;
						let cell = ws.GetRangeByNumber(r0 + r, c0 + c);
						let item = { sheet: ws.GetName(), address: cell.GetAddress(false, false), error: v };
						let f = cell.GetFormula();
						if (typeof f === "string" && f.charAt(0) === "=")
							item.formula = "=" + f.substring(1).replace(/^\s+/, "");
						found.push(item);
					}
				}
			}
			let res = { totalErrors: total, byType: counts, returned: found.length, errors: found };
			if (total > found.length)
				res.truncated = true;
			if (truncatedScan)
				res.warning = "The workbook is very large; only the first " + p.maxCells + " cells were scanned.";
			return res;
		});

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	return func;
})();
