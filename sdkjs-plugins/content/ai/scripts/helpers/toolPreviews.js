// SPDX-License-Identifier: AGPL-3.0-only

// Before/after previews for writing tools, shown in the approval card
// (mainly for spreadsheets and presentations, which have no tracked changes).
//
// A preview is an optional async hook on RegisteredFunction:
//   func.preview = async function(params) -> Preview | null
// It only reads the document. It is attached here by tool name so the tool
// files in .dev/helpers stay untouched; a tool may also define its own
// `preview`, which wins. Like `readOnly`, it is never sent to the model
// (EditorHelperImpl.getTools only serializes the schema fields).
//
// Preview (plain data, rendered by the chat sidebar as text only):
//   {
//     items?: [{ label, value }],               // key facts
//     table?: { columns: [..], rows: [{ label, cells: [{ before, after }] }],
//               truncated: bool },              // cell grid, capped
//     text?:  { before, after },                // old vs new text
//     note?:  string
//   }
(function(root) {

	const MAX_ROWS = 10;
	const MAX_COLS = 6;
	const MAX_TEXT = 600;

	function tr(text) {
		try {
			if (root.Asc && root.Asc.plugin && typeof root.Asc.plugin.tr === "function")
				return root.Asc.plugin.tr(text);
		} catch (e) {}
		return text;
	}

	function callCommand(fn) {
		return root.Asc.Editor.callCommand(fn);
	}

	function scope() {
		root.Asc.scope = root.Asc.scope || {};
		return root.Asc.scope;
	}

	function clip(value, max) {
		let s = (value === undefined || value === null) ? "" : String(value);
		max = max || MAX_TEXT;
		return s.length > max ? s.substring(0, max - 1) + "…" : s;
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

	function colNumber(letters) {
		let n = 0;
		for (let i = 0; i < letters.length; i++)
			n = n * 26 + (letters.charCodeAt(i) - 64);
		return n;
	}

	// The rows/columns address a deleteRowsColumns/insertRowsColumns call
	// targets ("5:7", "C:D"), or null when the arguments are invalid (the tool
	// itself reports the error).
	function rowsColumnsAddress(params) {
		if (!params || (params.type !== "rows" && params.type !== "columns"))
			return null;
		let count = params.count === undefined || params.count === null ? 1 : params.count;
		if (typeof count !== "number" || count < 1 || count > 1000)
			return null;
		count = Math.floor(count);
		let first;
		if (params.type === "rows") {
			first = typeof params.at === "string" && /^\s*\d+\s*$/.test(params.at) ? parseInt(params.at, 10) : params.at;
			if (typeof first !== "number" || !isFinite(first) || first < 1)
				return null;
			first = Math.floor(first);
			return { type: "rows", first: first, last: first + count - 1, address: first + ":" + (first + count - 1) };
		}
		if (typeof params.at === "number")
			first = Math.floor(params.at);
		else if (typeof params.at === "string" && /^\s*\d+\s*$/.test(params.at))
			first = parseInt(params.at, 10);
		else if (typeof params.at === "string" && /^\s*[A-Za-z]{1,3}\s*$/.test(params.at))
			first = colNumber(params.at.trim().toUpperCase());
		else
			return null;
		if (!isFinite(first) || first < 1)
			return null;
		return { type: "columns", first: first, last: first + count - 1, address: colName(first) + ":" + colName(first + count - 1) };
	}

	function cellText(v) {
		if (v === undefined || v === null)
			return null;
		if (typeof v === "object")
			return JSON.stringify(v);
		return String(v);
	}

	// ── Spreadsheet ────────────────────────────────────────────────────────

	// Reads up to rows x cols cells from a start cell (formula if any, else the
	// displayed text). Also returns the column letters and the row numbers.
	async function readGrid(sheet, startCell, rows, cols) {
		scope().aiPreviewGrid = { sheet: sheet || null, startCell: startCell || null, rows: rows, cols: cols };
		return await callCommand(function() {
			let p = Asc.scope.aiPreviewGrid;
			let ws = p.sheet ? Api.GetSheet(p.sheet) : Api.GetActiveSheet();
			if (!ws)
				return { error: "sheet" };
			let start = p.startCell ? ws.GetRange(p.startCell) : Api.GetSelection();
			if (!start)
				return { error: "cell" };
			let r0 = start.GetRow() - 1;
			let c0 = start.GetCol() - 1;
			let values = [];
			for (let r = 0; r < p.rows; r++) {
				let row = [];
				for (let c = 0; c < p.cols; c++) {
					let cell = ws.GetRangeByNumber(r0 + r, c0 + c);
					let f = cell.GetFormula();
					let t = (typeof f === "string" && f.charAt(0) === "=") ? f : cell.GetText();
					row.push(t === undefined || t === null ? "" : String(t));
				}
				values.push(row);
			}
			let columns = [];
			for (let c = 0; c < p.cols; c++)
				columns.push(ws.GetRangeByNumber(0, c0 + c).GetAddress(false, false).replace(/[0-9]+$/, ""));
			return { sheet: ws.GetName(), row0: r0, col0: c0, values: values, columns: columns };
		});
	}

	// Builds the before/after table for writeRange from the current values.
	function buildWriteRangeTable(newValues, current) {
		let rows = [];
		let changed = 0;
		for (let r = 0; r < current.values.length; r++) {
			let source = Array.isArray(newValues[r]) ? newValues[r] : [];
			let cells = [];
			for (let c = 0; c < current.values[r].length; c++) {
				let before = current.values[r][c];
				let next = c < source.length ? cellText(source[c]) : null;
				// null/undefined in "values" leaves the cell unchanged
				let after = next === null ? before : next;
				if (after !== before)
					changed++;
				cells.push({ before: clip(before, 80), after: clip(after, 80) });
			}
			rows.push({ label: String(current.row0 + r + 1), cells: cells });
		}
		return { rows: rows, changed: changed };
	}

	async function previewWriteRange(params) {
		if (!params || !Array.isArray(params.values) || params.values.length === 0)
			return null;
		let width = 0;
		for (let i = 0; i < params.values.length; i++) {
			if (!Array.isArray(params.values[i]))
				return null;
			width = Math.max(width, params.values[i].length);
		}
		if (!width)
			return null;
		let rows = Math.min(params.values.length, MAX_ROWS);
		let cols = Math.min(width, MAX_COLS);
		let current = await readGrid(params.sheet, params.startCell, rows, cols);
		if (!current || current.error)
			return null;

		let table = buildWriteRangeTable(params.values, current);
		let first = current.columns[0] + (current.row0 + 1);
		let last = colName(current.col0 + width) + (current.row0 + params.values.length);
		let truncated = params.values.length > MAX_ROWS || width > MAX_COLS;
		let preview = {
			items: [
				{ label: tr("Sheet"), value: current.sheet },
				{ label: tr("Range"), value: first === last ? first : first + ":" + last }
			],
			table: { columns: current.columns, rows: table.rows, truncated: truncated }
		};
		if (truncated)
			preview.note = tr("Only the first cells are shown.");
		return preview;
	}

	async function readRangeInfo(sheet, range) {
		scope().aiPreviewRange = { sheet: sheet || null, range: range || null };
		return await callCommand(function() {
			let p = Asc.scope.aiPreviewRange;
			let ws = p.sheet ? Api.GetSheet(p.sheet) : Api.GetActiveSheet();
			if (!ws)
				return null;
			let range = p.range ? ws.GetRange(p.range) : Api.GetSelection();
			if (!range)
				return null;
			let cell = ws.GetRangeByNumber(range.GetRow() - 1, range.GetCol() - 1);
			let res = { sheet: ws.GetName(), address: range.GetAddress(false, false), sample: cell.GetText(), sampleAddress: cell.GetAddress(false, false) };
			try {
				res.format = cell.GetNumberFormat();
			} catch (e) {}
			try {
				let v = cell.GetValidation();
				res.validation = v ? (v.GetType() || null) : null;
				if (res.validation) {
					res.validationFormula1 = v.GetFormula1 ? v.GetFormula1() : null;
					res.validationFormula2 = v.GetFormula2 ? v.GetFormula2() : null;
				}
			} catch (e) {}
			return res;
		});
	}

	async function previewSetNumberFormat(params) {
		if (!params || typeof params.format !== "string" || !params.format)
			return null;
		let info = await readRangeInfo(params.sheet, params.range);
		if (!info)
			return null;
		let items = [
			{ label: tr("Sheet"), value: info.sheet },
			{ label: tr("Range"), value: info.address },
			{ label: tr("Current format"), value: clip(info.format === undefined || info.format === null || info.format === "" ? "General" : info.format, 120) },
			{ label: tr("New format"), value: clip(params.format, 120) }
		];
		if (info.sample !== undefined && info.sample !== null && String(info.sample) !== "")
			items.push({ label: tr("Example") + " (" + info.sampleAddress + ")", value: clip(info.sample, 80) });
		return { items: items };
	}

	function describeValidation(params) {
		if (params.type === "none")
			return tr("None (remove the rule)");
		let text = params.type;
		if (params.type === "list") {
			if (Array.isArray(params.values) && params.values.length)
				text += ": " + params.values.map(String).join(", ");
			else if (params.source)
				text += ": " + params.source;
		} else if (params.type === "custom") {
			text += ": " + (params.min || "");
		} else {
			let op = params.operator || "between";
			text += ", " + op + " " + (params.min === undefined ? "" : params.min);
			if (op === "between" || op === "notBetween")
				text += " … " + (params.max === undefined ? "" : params.max);
		}
		return clip(text, 200);
	}

	async function previewSetDataValidation(params) {
		if (!params || typeof params.range !== "string" || !params.range.trim() || typeof params.type !== "string")
			return null;
		let info = await readRangeInfo(params.sheet, params.range.trim());
		if (!info)
			return null;
		let current = tr("None");
		if (info.validation) {
			current = String(info.validation);
			if (info.validationFormula1)
				current += ": " + info.validationFormula1 + (info.validationFormula2 ? " … " + info.validationFormula2 : "");
		}
		let items = [
			{ label: tr("Sheet"), value: info.sheet },
			{ label: tr("Range"), value: info.address },
			{ label: tr("Current rule"), value: clip(current, 200) + (info.validation ? " (" + info.sampleAddress + ")" : "") },
			{ label: tr("New rule"), value: describeValidation(params) }
		];
		if (params.alertStyle)
			items.push({ label: tr("Invalid entries"), value: String(params.alertStyle) });
		return { items: items };
	}

	// Non-empty cells in the rows/columns that would be deleted, limited to
	// the used range, with a small sample.
	async function readAffectedContent(sheet, target) {
		scope().aiPreviewAffected = { sheet: sheet || null, type: target.type, first: target.first, last: target.last, maxRows: 5, maxCols: MAX_COLS, maxScan: 5000 };
		return await callCommand(function() {
			let p = Asc.scope.aiPreviewAffected;
			let ws = p.sheet ? Api.GetSheet(p.sheet) : Api.GetActiveSheet();
			if (!ws)
				return null;
			let used = ws.GetUsedRange();
			let res = { sheet: ws.GetName(), nonEmpty: 0, scanLimited: false, sample: [], columns: [], rowLabels: [] };
			if (!used)
				return res;
			let ur0 = used.GetRow() - 1;
			let uc0 = used.GetCol() - 1;
			let addr = used.GetAddress(false, false);
			let parts = String(addr).split(":");
			let endCell = parts.length > 1 ? ws.GetRange(parts[1]) : used;
			let ur1 = endCell.GetRow() - 1;
			let uc1 = endCell.GetCol() - 1;
			let r0 = ur0, r1 = ur1, c0 = uc0, c1 = uc1;
			if (p.type === "rows") {
				r0 = Math.max(ur0, p.first - 1);
				r1 = Math.min(ur1, p.last - 1);
			} else {
				c0 = Math.max(uc0, p.first - 1);
				c1 = Math.min(uc1, p.last - 1);
			}
			if (r0 > r1 || c0 > c1)
				return res;
			let scanned = 0;
			for (let r = r0; r <= r1; r++) {
				for (let c = c0; c <= c1; c++) {
					if (++scanned > p.maxScan) {
						res.scanLimited = true;
						break;
					}
					let t = ws.GetRangeByNumber(r, c).GetText();
					if (t !== undefined && t !== null && String(t) !== "")
						res.nonEmpty++;
				}
				if (res.scanLimited)
					break;
			}
			let rows = Math.min(r1 - r0 + 1, p.maxRows);
			let cols = Math.min(c1 - c0 + 1, p.maxCols);
			for (let c = 0; c < cols; c++)
				res.columns.push(ws.GetRangeByNumber(0, c0 + c).GetAddress(false, false).replace(/[0-9]+$/, ""));
			for (let r = 0; r < rows; r++) {
				let row = [];
				for (let c = 0; c < cols; c++) {
					let t = ws.GetRangeByNumber(r0 + r, c0 + c).GetText();
					row.push(t === undefined || t === null ? "" : String(t));
				}
				res.sample.push(row);
				res.rowLabels.push(String(r0 + r + 1));
			}
			res.truncated = (r1 - r0 + 1) > rows || (c1 - c0 + 1) > cols;
			return res;
		});
	}

	function targetLabel(target) {
		return (target.type === "rows" ? tr("Rows") : tr("Columns")) + " " + target.address;
	}

	async function previewDeleteRowsColumns(params) {
		let target = rowsColumnsAddress(params);
		if (!target)
			return null;
		let info = await readAffectedContent(params.sheet, target);
		if (!info)
			return null;
		let preview = {
			items: [
				{ label: tr("Sheet"), value: info.sheet },
				{ label: tr("Will be deleted"), value: targetLabel(target) },
				{ label: tr("Cells with content"), value: String(info.nonEmpty) + (info.scanLimited ? "+" : "") }
			],
			note: target.type === "rows" ? tr("Rows below move up.") : tr("Columns to the right move left.")
		};
		if (info.sample.length) {
			preview.table = {
				columns: info.columns,
				rows: info.sample.map(function(row, i) {
					return { label: info.rowLabels[i], cells: row.map(function(v) { return { before: clip(v, 80), after: "" }; }) };
				}),
				truncated: !!info.truncated
			};
		}
		return preview;
	}

	async function previewInsertRowsColumns(params) {
		let target = rowsColumnsAddress(params);
		if (!target)
			return null;
		let sheetName = await activeSheetName(params.sheet);
		return {
			items: [
				{ label: tr("Sheet"), value: sheetName || params.sheet || "" },
				{ label: tr("Will be inserted"), value: targetLabel(target) }
			],
			note: target.type === "rows" ? tr("Existing rows from here move down.") : tr("Existing columns from here move right.")
		};
	}

	async function activeSheetName(sheet) {
		scope().aiPreviewSheet = sheet || null;
		try {
			return await callCommand(function() {
				let ws = Asc.scope.aiPreviewSheet ? Api.GetSheet(Asc.scope.aiPreviewSheet) : Api.GetActiveSheet();
				return ws ? ws.GetName() : null;
			});
		} catch (e) {
			return null;
		}
	}

	async function previewManageSheet(params) {
		if (!params || typeof params.name !== "string" || !params.name.trim())
			return null;
		if (params.action === "activate")
			return null;
		if (params.action === "add")
			return { items: [{ label: tr("New sheet"), value: clip(params.name, 60) }] };
		if (params.action === "rename")
			return { items: [{ label: tr("Sheet"), value: clip(params.name, 60) }, { label: tr("New name"), value: clip(params.newName || "", 60) }] };
		if (params.action !== "delete")
			return null;
		scope().aiPreviewSheetDelete = params.name;
		let info = await callCommand(function() {
			let name = String(Asc.scope.aiPreviewSheetDelete).toLowerCase();
			let list = Api.GetSheets();
			for (let i = 0; i < list.length; i++) {
				if (list[i].GetName().toLowerCase() !== name)
					continue;
				let used = list[i].GetUsedRange();
				return { name: list[i].GetName(), used: used ? used.GetAddress(false, false) : "" };
			}
			return null;
		});
		if (!info)
			return null;
		return {
			items: [
				{ label: tr("Will be deleted"), value: tr("Sheet") + " " + info.name },
				{ label: tr("Used range"), value: info.used || tr("Empty") }
			]
		};
	}

	// ── Text (presentation and text document) ──────────────────────────────

	async function previewReplaceSelection(params) {
		if (!params || typeof params.text !== "string")
			return null;
		let selected = "";
		try {
			selected = await root.Asc.Library.GetSelectedText();
		} catch (e) {
			return null;
		}
		if (!selected || !String(selected).trim())
			return null;
		return { text: { before: clip(selected), after: clip(params.text) } };
	}

	const HOOKS = {
		cell: {
			writeRange: previewWriteRange,
			setNumberFormat: previewSetNumberFormat,
			setDataValidation: previewSetDataValidation,
			deleteRowsColumns: previewDeleteRowsColumns,
			insertRowsColumns: previewInsertRowsColumns,
			manageSheet: previewManageSheet
		},
		slide: {
			replaceSelection: previewReplaceSelection
		},
		word: {
			replaceSelection: previewReplaceSelection
		}
	};

	// Attaches the hooks to the editor's tools (EditorHelperImpl constructor).
	function attach(editorType, names2funcs) {
		let hooks = HOOKS[editorType];
		if (!hooks || !names2funcs)
			return;
		for (let name in hooks) {
			let func = names2funcs[name];
			if (func && typeof func.preview !== "function")
				func.preview = hooks[name];
		}
	}

	root.ToolPreviews = {
		MAX_ROWS: MAX_ROWS,
		MAX_COLS: MAX_COLS,
		HOOKS: HOOKS,
		attach: attach,
		rowsColumnsAddress: rowsColumnsAddress,
		buildWriteRangeTable: buildWriteRangeTable,
		colName: colName
	};

})(typeof window !== "undefined" ? window : globalThis);
