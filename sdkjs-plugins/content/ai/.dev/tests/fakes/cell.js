// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Small in-memory model of the ONLYOFFICE Spreadsheet Builder API covering
// the methods the AI tools use. Semantics follow sdkjs cell/apiBuilder.js:
//  - ApiRange.GetValue() returns the displayed value as a string for one
//    cell and a 2D array of strings for several cells
//  - ApiRange.GetFormula() returns "= BODY" (note the space) for formulas
//    and the value otherwise
//  - ApiRange.SetValue("=...") enters a formula
//  - ApiWorksheet.GetUsedRange() always starts at A1 and is never null
//  - ApiWorksheet.GetRange("bad") THROWS ('Incorrect "Range1" or it is empty.')
//  - ApiWorksheet.GetRangeByNumber(row, col) is 0-based
//  - Api.GetSheet(name) returns null when missing
//  - GetAddress(false, false) of a whole column is "A:A", of a whole row "1:1"

import { createCustomProperties } from "./props.js";

export const MAX_ROW = 1048576;
export const MAX_COL = 16384;

export function colName(n) { // 1-based
	let s = "";
	while (n > 0) {
		const m = (n - 1) % 26;
		s = String.fromCharCode(65 + m) + s;
		n = Math.floor((n - 1) / 26);
	}
	return s;
}

function colNumber(letters) {
	let n = 0;
	for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n;
}

// "B2", "A1:C3", "A:C", "2:5", with optional $ -> 0-based bbox or null
export function parseAddress(addr) {
	const a = String(addr).replace(/\$/g, "").trim().toUpperCase();
	let m;
	if ((m = /^([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?$/.exec(a))) {
		const c1 = colNumber(m[1]) - 1, r1 = Number(m[2]) - 1;
		const c2 = m[3] ? colNumber(m[3]) - 1 : c1, r2 = m[4] ? Number(m[4]) - 1 : r1;
		return norm(r1, c1, r2, c2);
	}
	if ((m = /^([A-Z]{1,3}):([A-Z]{1,3})$/.exec(a)))
		return norm(0, colNumber(m[1]) - 1, MAX_ROW - 1, colNumber(m[2]) - 1);
	if ((m = /^(\d+):(\d+)$/.exec(a)))
		return norm(Number(m[1]) - 1, 0, Number(m[2]) - 1, MAX_COL - 1);
	return null;
}

function norm(r1, c1, r2, c2) {
	const b = { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
	if (b.r1 < 0 || b.c1 < 0 || b.r2 >= MAX_ROW || b.c2 >= MAX_COL) return null;
	return b;
}

const key = (r, c) => r + "," + c;

class Comment {
	constructor(sheet, { id, cell, author = "Alice", text = "", solved = false, replies = [] }) {
		const b = parseAddress(cell);
		this.sheet = sheet;
		this.id = String(id);
		this.r = b.r1;
		this.c = b.c1;
		this.author = author;
		this.text = text;
		this.solved = solved;
		this.replies = replies.map((r) => ({ author: r.author || "Bob", text: r.text }));
	}
	GetClassType() { return "comment"; }
	GetId() { return this.id; }
	GetAuthorName() { return this.author; }
	GetText() { return this.text; }
	GetQuoteText() { const c = this.sheet.cells.get(key(this.r, this.c)); return c ? c.value : ""; }
	IsSolved() { return this.solved; }
	SetSolved(v) { this.solved = !!v; }
	GetRepliesCount() { return this.replies.length; }
	GetReply(i) { const r = this.replies[i] || this.replies[0]; return r ? { GetAuthorName: () => r.author, GetText: () => r.text } : null; }
	AddReply(text, author) { if (typeof text === "string" && text) this.replies.push({ author, text }); }
}

class Validation {
	constructor(range) { this.range = range; }
	Delete() { this.range.sheet.validations = this.range.sheet.validations.filter((v) => !overlaps(v.bbox, this.range.bbox)); return true; }
	Add(type, alert, operator, formula1, formula2) {
		if (!type) return null;
		const rule = { bbox: { ...this.range.bbox }, type, alert, operator, formula1, formula2, showError: false, errorMessage: null };
		this.range.sheet.validations.push(rule);
		return {
			SetShowError: (v) => { rule.showError = !!v; },
			SetErrorMessage: (m) => { rule.errorMessage = m; }
		};
	}
}

function overlaps(a, b) {
	return a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;
}

class Range {
	constructor(sheet, bbox) { this.sheet = sheet; this.bbox = bbox; }
	GetClassType() { return "range"; }
	GetWorksheet() { return this.sheet; }
	GetRow() { return this.bbox.r1 + 1; }
	GetCol() { return this.bbox.c1 + 1; }
	GetRowsCount() { return this.bbox.r2 - this.bbox.r1 + 1; }
	GetColumnsCount() { return this.bbox.c2 - this.bbox.c1 + 1; }
	_isOneCell() { return this.bbox.r1 === this.bbox.r2 && this.bbox.c1 === this.bbox.c2; }
	GetAddress(rowAbs, colAbs) {
		const b = this.bbox;
		const R = rowAbs ? "$" : "", C = colAbs ? "$" : "";
		if (this._isOneCell()) return C + colName(b.c1 + 1) + R + (b.r1 + 1);
		if (b.c1 === b.c2 && b.r1 === 0 && b.r2 === MAX_ROW - 1) return C + colName(b.c1 + 1) + ":" + C + colName(b.c2 + 1);
		if (b.r1 === b.r2 && b.c1 === 0 && b.c2 === MAX_COL - 1) return R + (b.r1 + 1) + ":" + R + (b.r2 + 1);
		return C + colName(b.c1 + 1) + R + (b.r1 + 1) + ":" + C + colName(b.c2 + 1) + R + (b.r2 + 1);
	}
	_cell(r, c) { return this.sheet.cells.get(key(r, c)); }
	GetValue() {
		const value = (r, c) => { const cell = this._cell(r, c); return cell ? cell.value : ""; };
		if (this._isOneCell()) return value(this.bbox.r1, this.bbox.c1);
		const res = [];
		for (let r = this.bbox.r1; r <= this.bbox.r2; r++) {
			const row = [];
			for (let c = this.bbox.c1; c <= this.bbox.c2; c++) row.push(value(r, c));
			res.push(row);
		}
		return res;
	}
	GetText() { // displayed text of the first cell
		const cell = this._cell(this.bbox.r1, this.bbox.c1);
		if (!cell) return "";
		if (cell.numFmt === "0.00%" && cell.value !== "" && !isNaN(Number(cell.value))) return (Number(cell.value) * 100).toFixed(2) + "%";
		return cell.value;
	}
	GetFormula() {
		const cell = this._cell(this.bbox.r1, this.bbox.c1);
		if (cell && cell.formula) return "= " + cell.formula.substring(1);
		return cell ? cell.value : "";
	}
	SetValue(v) {
		for (let r = this.bbox.r1; r <= this.bbox.r2; r++)
			for (let c = this.bbox.c1; c <= this.bbox.c2; c++)
				this.sheet._set(r, c, v);
		return true;
	}
	SetNumberFormat(fmt) {
		for (let r = this.bbox.r1; r <= Math.min(this.bbox.r2, this.sheet._lastRow()); r++)
			for (let c = this.bbox.c1; c <= Math.min(this.bbox.c2, this.sheet._lastCol()); c++) {
				const k = key(r, c);
				const cell = this.sheet.cells.get(k) || { value: "", formula: null };
				cell.numFmt = fmt;
				this.sheet.cells.set(k, cell);
			}
		this.sheet.formats.push({ bbox: { ...this.bbox }, fmt });
	}
	GetComment() {
		if (!this._isOneCell()) return null;
		return this.sheet.comments.find((c) => c.r === this.bbox.r1 && c.c === this.bbox.c1) || null;
	}
	GetValidation() { return new Validation(this); }
	Select() { this.sheet.wb.active = this.sheet; this.sheet.wb.selection = new Range(this.sheet, { ...this.bbox }); }
	Delete(shift) { this.sheet._shift(this.bbox, shift, -1); }
	Insert(shift) { this.sheet._shift(this.bbox, shift, +1); }
}

class FreezePanes {
	constructor(sheet) { this.sheet = sheet; }
	FreezeAt(addr) { const b = parseAddress(addr); this.sheet.frozen = { rows: b.r2 + 1, cols: b.c2 + 1 }; }
	FreezeRows(n) { this.sheet.frozen = { rows: n, cols: 0 }; }
	FreezeColumns(n) { this.sheet.frozen = { rows: 0, cols: n }; }
	Unfreeze() { this.sheet.frozen = null; }
	GetLocation() {
		const f = this.sheet.frozen;
		if (!f) return null;
		const r2 = f.rows ? f.rows - 1 : MAX_ROW - 1, c2 = f.cols ? f.cols - 1 : MAX_COL - 1;
		return new Range(this.sheet, { r1: 0, c1: 0, r2, c2 });
	}
}

class Sheet {
	constructor(wb, name) {
		this.wb = wb;
		this.name = name;
		this.cells = new Map(); // "r,c" -> { value, formula, numFmt }
		this.comments = [];
		this.validations = [];
		this.formats = [];
		this.frozen = null;
	}
	GetClassType() { return "worksheet"; }
	GetName() { return this.name; }
	SetName(n) { this.name = n; }
	SetActive() { this.wb.active = this; }
	Delete() {
		const i = this.wb.sheets.indexOf(this);
		this.wb.sheets.splice(i, 1);
		if (this.wb.active === this) this.wb.active = this.wb.sheets[Math.max(0, i - 1)];
	}
	_lastRow() { let m = -1; for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(",")[0])); return m; }
	_lastCol() { let m = -1; for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(",")[1])); return m; }
	GetUsedRange() {
		return new Range(this, { r1: 0, c1: 0, r2: Math.max(0, this._lastRow()), c2: Math.max(0, this._lastCol()) });
	}
	GetRange(addr) {
		const b = typeof addr === "string" ? parseAddress(addr) : null;
		if (!b) throw new Error('Incorrect "Range1" or it is empty.');
		return new Range(this, b);
	}
	GetRangeByNumber(r, c) { return new Range(this, { r1: r, c1: c, r2: r, c2: c }); }
	// Returns null when the data reference is empty or invalid.
	AddChart(ref, inRows, type) {
		const b = typeof ref === "string" ? parseAddress(ref.replace(/\$/g, "")) : null;
		if (!b) return null;
		const chart = { ref, type, title: null, SetTitle(t) { this.title = t; } };
		(this.charts = this.charts || []).push(chart);
		return chart;
	}
	GetComments() { return this.comments.slice(); }
	GetFreezePanes() { return new FreezePanes(this); }
	_set(r, c, v) {
		const k = key(r, c);
		const prev = this.cells.get(k) || {};
		if (typeof v === "string" && v.charAt(0) === "=" && v.length > 1)
			this.cells.set(k, { ...prev, value: "", formula: v });
		else if (v === "" || v === null || v === undefined)
			this.cells.delete(k);
		else
			this.cells.set(k, { ...prev, value: String(v), formula: null });
	}
	_shift(bbox, shift, dir) {
		const byRows = shift === "up" || shift === "down";
		const count = byRows ? bbox.r2 - bbox.r1 + 1 : bbox.c2 - bbox.c1 + 1;
		const start = byRows ? bbox.r1 : bbox.c1;
		const next = new Map();
		for (const [k, v] of this.cells) {
			let [r, c] = k.split(",").map(Number);
			let p = byRows ? r : c;
			if (dir < 0) {
				if (p >= start && p < start + count) continue;
				if (p >= start + count) p -= count;
			} else if (p >= start) {
				p += count;
			}
			if (byRows) r = p; else c = p;
			next.set(key(r, c), v);
		}
		this.cells = next;
	}
	// test helpers
	value(addr) { const b = parseAddress(addr); const c = this.cells.get(key(b.r1, b.c1)); return c ? c.value : ""; }
	formula(addr) { const b = parseAddress(addr); const c = this.cells.get(key(b.r1, b.c1)); return c ? c.formula : null; }
	cell(addr) { const b = parseAddress(addr); return this.cells.get(key(b.r1, b.c1)) || null; }
}

class Workbook {
	constructor() { this.sheets = []; this.active = null; this.selection = null; }
}

/**
 * @param {object} spec
 * @param {Object<string, Array<Array<any>>|Object<string, any>>} spec.sheets  sheet name -> rows (from A1)
 *        or { "A1": value | { v, f } } map. Formula cells: { v: "3", f: "=SUM(A1:A2)" }.
 * @param {string} [spec.active]     active sheet (default: first)
 * @param {string} [spec.selection]  selected range on the active sheet (default: A1)
 * @param {Array<object>} [spec.comments]  [{ sheet, id, cell, author, text, solved, replies }]
 */
export function createWorkbook(spec = {}) {
	const wb = new Workbook();
	for (const [name, data] of Object.entries(spec.sheets || { Sheet1: [] })) {
		const ws = new Sheet(wb, name);
		const put = (r, c, v) => {
			if (v === null || v === undefined || v === "") return;
			if (typeof v === "object") ws.cells.set(key(r, c), { value: String(v.v ?? ""), formula: v.f || null });
			else ws.cells.set(key(r, c), { value: String(v), formula: null });
		};
		if (Array.isArray(data)) data.forEach((row, r) => row.forEach((v, c) => put(r, c, v)));
		else for (const [addr, v] of Object.entries(data)) { const b = parseAddress(addr); put(b.r1, b.c1, v); }
		wb.sheets.push(ws);
	}
	wb.active = wb.sheets.find((s) => s.name === spec.active) || wb.sheets[0];
	wb.selection = wb.active.GetRange(spec.selection || "A1");
	for (const c of spec.comments || []) {
		const ws = wb.sheets.find((s) => s.name === (c.sheet || wb.sheets[0].name));
		ws.comments.push(new Comment(ws, c));
	}

	const findSheet = (n) => typeof n === "number" ? wb.sheets[n] || null : wb.sheets.find((s) => s.name === n) || null;
	const props = createCustomProperties();
	wb.customProperties = props.store;
	const Api = {
		GetCustomProperties: () => props.api,
		GetActiveSheet: () => wb.active,
		GetSheets: () => wb.sheets.slice(),
		GetSheet: (n) => findSheet(n),
		GetSelection: () => wb.selection && wb.selection.sheet === wb.active ? wb.selection : wb.active.GetRange("A1"),
		AddSheet: (name) => { const ws = new Sheet(wb, name); wb.sheets.push(ws); wb.active = ws; },
		GetCommentById: (id) => {
			for (const s of wb.sheets) { const c = s.comments.find((x) => x.id === String(id)); if (c) return c; }
			return null;
		}
	};

	const methods = {};
	return { Api, wb, methods, sheet: (n) => findSheet(n) };
}
