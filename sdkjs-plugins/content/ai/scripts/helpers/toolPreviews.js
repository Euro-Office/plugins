// SPDX-FileCopyrightText: Euro-Office contributors
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
			writeRange: previewWriteRange
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
		buildWriteRangeTable: buildWriteRangeTable,
		colName: colName
	};

})(typeof window !== "undefined" ? window : globalThis);
