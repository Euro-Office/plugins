/*
 * SPDX-FileCopyrightText: Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function(){
	let func = new RegisteredFunction({
		"name": "setDataValidation",
		"category": "data",
		"text": "Set Data Validation",
		"description": "Adds a data validation rule to a cell range (replacing any existing rule there), or removes validation with type 'none'. Types: 'list' (drop-down; give 'values' as an array of items or 'source' as a range reference like '=$H$2:$H$10'), 'whole' (whole numbers), 'decimal', 'date', 'time', 'textLength' (length of the text), 'custom' (a formula that must be TRUE, in 'min'). For whole/decimal/date/time/textLength use 'operator' with 'min' and, for between/notBetween, 'max'. Dates are given as formulas such as '=DATE(2025,1,31)', times as decimals of a day such as '0.5' (12:00). Optionally set an error message shown when invalid data is entered.",
		"parameters": {
			"type": "object",
			"properties": {
				"range": {
					"type": "string",
					"description": "A1-style address, e.g. 'B2:B200'."
				},
				"sheet": {
					"type": "string",
					"description": "Sheet name. Defaults to the active sheet."
				},
				"type": {
					"type": "string",
					"enum": ["list", "whole", "decimal", "date", "time", "textLength", "custom", "none"],
					"description": "Validation type; 'none' removes existing validation."
				},
				"values": {
					"type": "array",
					"items": { "type": "string" },
					"description": "Allowed items for type 'list'. Items must not contain commas."
				},
				"source": {
					"type": "string",
					"description": "For type 'list': a range reference that holds the allowed items, e.g. '=$H$2:$H$10' or '=Lists!$A$1:$A$5'."
				},
				"operator": {
					"type": "string",
					"enum": ["between", "notBetween", "equal", "notEqual", "greater", "less", "greaterOrEqual", "lessOrEqual"],
					"description": "Comparison for whole/decimal/date/time/textLength.",
					"default": "between"
				},
				"min": {
					"type": "string",
					"description": "First value or formula (lower bound, or the compared value for single-value operators; the formula for 'custom'). Numbers can be given as text, e.g. '0'."
				},
				"max": {
					"type": "string",
					"description": "Upper bound for operators 'between' and 'notBetween'."
				},
				"alertStyle": {
					"type": "string",
					"enum": ["stop", "warning", "information"],
					"description": "How invalid entries are handled: 'stop' rejects them, 'warning'/'information' only warn.",
					"default": "stop"
				},
				"errorMessage": {
					"type": "string",
					"description": "Optional message shown when invalid data is entered."
				}
			},
			"required": ["range", "type"]
		},
		"examples": [
			{
				"prompt": "Make column C a drop-down with Open, In progress, Done",
				"arguments": { "range": "C2:C200", "type": "list", "values": ["Open", "In progress", "Done"] }
			},
			{
				"prompt": "Only allow whole numbers from 1 to 10 in B2:B50",
				"arguments": { "range": "B2:B50", "type": "whole", "operator": "between", "min": "1", "max": "10", "errorMessage": "Enter a number from 1 to 10." }
			}
		]
	});

	func.call = async function(params) {
		const types = { list: "xlValidateList", whole: "xlValidateWholeNumber", decimal: "xlValidateDecimal", date: "xlValidateDate", time: "xlValidateTime", textLength: "xlValidateTextLength", custom: "xlValidateCustom", none: null };
		const operators = { between: "xlBetween", notBetween: "xlNotBetween", equal: "xlEqual", notEqual: "xlNotEqual", greater: "xlGreater", less: "xlLess", greaterOrEqual: "xlGreaterEqual", lessOrEqual: "xlLessEqual" };
		const alerts = { stop: "xlValidAlertStop", warning: "xlValidAlertWarning", information: "xlValidAlertInformation" };

		if (typeof params.range !== 'string' || params.range.trim() === "")
			throw new window.AgentState.ToolError('Parameter "range" must be an A1-style string, e.g. "B2:B200".');
		if (params.sheet !== undefined && params.sheet !== null && typeof params.sheet !== 'string')
			throw new window.AgentState.ToolError('Parameter "sheet" must be a string. Got: ' + JSON.stringify(params.sheet));
		if (!(params.type in types))
			throw new window.AgentState.ToolError('Parameter "type" must be one of ' + JSON.stringify(Object.keys(types)) + '. Got: ' + JSON.stringify(params.type));
		let operator = params.operator === undefined || params.operator === null ? "between" : params.operator;
		if (!(operator in operators))
			throw new window.AgentState.ToolError('Parameter "operator" must be one of ' + JSON.stringify(Object.keys(operators)) + '. Got: ' + JSON.stringify(params.operator));
		let alert = params.alertStyle === undefined || params.alertStyle === null ? "stop" : params.alertStyle;
		if (!(alert in alerts))
			throw new window.AgentState.ToolError('Parameter "alertStyle" must be one of ' + JSON.stringify(Object.keys(alerts)) + '.');

		function str(v) {
			return v === undefined || v === null || v === "" ? null : String(v);
		}
		let formula1 = null, formula2 = null;
		switch (params.type) {
			case "list":
				if (Array.isArray(params.values) && params.values.length) {
					let items = params.values.map(function(v){ return String(v).trim(); }).filter(function(v){ return v !== ""; });
					if (!items.length)
						throw new window.AgentState.ToolError('Parameter "values" contains no non-empty items.');
					if (items.some(function(v){ return v.indexOf(",") !== -1; }))
						throw new window.AgentState.ToolError('List items must not contain commas. Put the items in cells and pass "source" instead.');
					formula1 = items.join(",");
					if (formula1.length > 255)
						throw new window.AgentState.ToolError('The list is too long (' + formula1.length + ' characters, max 255). Put the items in cells and pass "source" instead.');
				} else if (typeof params.source === 'string' && params.source.trim() !== "") {
					formula1 = params.source.trim();
					if (formula1.charAt(0) !== "=")
						formula1 = "=" + formula1;
				} else {
					throw new window.AgentState.ToolError('Type "list" needs "values" (array of items) or "source" (range reference such as "=$H$2:$H$10").');
				}
				break;
			case "custom":
				formula1 = str(params.min);
				if (!formula1)
					throw new window.AgentState.ToolError('Type "custom" needs the formula in "min", e.g. "=LEN(A2)<=10".');
				break;
			case "none":
				break;
			default:
				formula1 = str(params.min);
				formula2 = str(params.max);
				if (!formula1)
					throw new window.AgentState.ToolError('Type "' + params.type + '" needs "min" (the value to compare with).');
				if ((operator === "between" || operator === "notBetween") && !formula2)
					throw new window.AgentState.ToolError('Operator "' + operator + '" needs both "min" and "max".');
				if (operator !== "between" && operator !== "notBetween")
					formula2 = null;
		}
		if (params.errorMessage !== undefined && params.errorMessage !== null && typeof params.errorMessage !== 'string')
			throw new window.AgentState.ToolError('Parameter "errorMessage" must be a string.');

		Asc.scope.validationParams = {
			range: params.range.trim(),
			sheet: params.sheet || null,
			type: types[params.type],
			alert: alerts[alert],
			operator: operators[operator],
			formula1: formula1,
			formula2: formula2,
			errorMessage: params.errorMessage || null
		};

		let result;
		await Asc.Editor.callMethod("StartAction", ["GroupActions"]);
		try {
			result = await Asc.Editor.callCommand(function(){
				let p = Asc.scope.validationParams;
				let ws = p.sheet ? Api.GetSheet(p.sheet) : Api.GetActiveSheet();
				if (!ws)
					return { error: "Sheet \"" + p.sheet + "\" not found. Available sheets: " + Api.GetSheets().map(function(s){ return s.GetName(); }).join(", ") };
				let range = null;
				try {
					range = ws.GetRange(p.range); // ApiWorksheet.GetRange throws on an invalid address
				} catch (e) {}
				if (!range)
					return { error: "Invalid range \"" + p.range + "\"." };
				try {
					range.GetValidation().Delete();
				} catch (e) {}
				if (!p.type)
					return { sheet: ws.GetName(), range: range.GetAddress(false, false), removed: true };
				// GetValidation() caches per ApiRange; use a fresh range after deleting
				let fresh = ws.GetRange(p.range);
				let v;
				try {
					v = fresh.GetValidation().Add(p.type, p.alert, p.operator, p.formula1 === null ? undefined : p.formula1, p.formula2 === null ? undefined : p.formula2);
				} catch (e) {
					return { error: "The editor rejected the validation rule: " + (e && e.message ? e.message : String(e)) + ". Check min/max/source." };
				}
				if (!v)
					return { error: "The editor rejected the validation rule. Check type, min/max and source." };
				if (p.errorMessage) {
					try {
						v.SetShowError(true);
						v.SetErrorMessage(p.errorMessage);
					} catch (e) {}
				}
				return { sheet: ws.GetName(), range: fresh.GetAddress(false, false), type: p.type, operator: p.operator, formula1: p.formula1, formula2: p.formula2 };
			});
		} finally {
			await Asc.Editor.callMethod("EndAction", ["GroupActions"]);
		}

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	return func;
})();
