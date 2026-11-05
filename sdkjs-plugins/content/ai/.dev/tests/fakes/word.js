// SPDX-License-Identifier: AGPL-3.0-only
//
// Small in-memory model of the ONLYOFFICE Document Builder API (word editor),
// covering the methods the AI tools use. Method names, return types and edge
// semantics follow sdkjs word/apiBuilder.js:
//  - ApiDocument.GetElement(i) returns null past the end
//  - ApiParagraph.GetStyle() returns the paragraph style or null
//  - ApiTable has no GetText() (tools must cope)
//  - ApiParaPr.GetOutlineLvl() is 1-based or undefined
//  - ApiParagraph.Search() returns ApiRange[]
//  - GetReviewReport() returns { author: [{ Type, Value, Date, ReviewedElement }] }
//  - ApiComment.GetId() returns a string
//  - content controls (ApiInlineLvlSdt / ApiBlockLvlSdt) with tag, alias and
//    appearance, as used by the AI-content marking (aiProvenance.js)
// Simplification: editing a paragraph's text (_replace/_wrap) flattens its
// runs, so earlier inline content controls in that paragraph are dropped.

let commentSeq = 0;
let idSeq = 0;

class Style {
	constructor(name, outlineLvl) {
		this.name = name;
		this.outlineLvl = outlineLvl;
	}
	GetClassType() { return "style"; }
	GetName() { return this.name; }
	GetParaPr() {
		const lvl = this.outlineLvl;
		return { GetOutlineLvl: () => lvl };
	}
}

class Run {
	constructor(text = "", textPr = {}) {
		this.text = text;
		this.textPr = { ...textPr };
	}
	GetClassType() { return "run"; }
	GetText() { return this.text; }
	AddText(t) { this.text += t; return true; }
	GetTextPr() { return { _pr: { ...this.textPr } }; }
	SetTextPr(pr) { this.textPr = { ...(pr && pr._pr ? pr._pr : pr) }; return this; }
}

class Paragraph {
	constructor(text = "", opts = {}) {
		this.runs = text === "" ? [] : [new Run(text, opts.textPr)];
		this.style = opts.style || null;   // Style instance
		this.numbering = !!opts.list;
		this.outlineLvl = opts.outlineLvl; // paragraph-level override
		this.parent = null;
		this.id = "para_" + (++idSeq);
	}
	GetClassType() { return "paragraph"; }
	GetInternalId() { return this.id; }
	// children: ApiRun or ApiInlineLvlSdt
	GetText() { return this.runs.map((r) => r.GetText()).join(""); }
	GetElementsCount() { return this.runs.length; }
	GetElement(i) { return this.runs[i] || null; }
	RemoveAllElements() { this.runs = []; return true; }
	AddElement(run, pos) {
		if (pos === undefined) this.runs.push(run);
		else this.runs.splice(pos, 0, run);
		run.parent = this;
		return true;
	}
	AddText(t) { const r = new Run(t); this.runs.push(r); return r; }
	GetStyle() { return this.style; }
	SetStyle(style) { this.style = style; return true; }
	GetNumbering() { return this.numbering ? { GetClassType: () => "numberingLevel" } : null; }
	GetParaPr() {
		const lvl = this.outlineLvl;
		return { GetOutlineLvl: () => lvl };
	}
	GetPosInParent() { return this.parent ? this.parent.elements.indexOf(this) : -1; }
	GetRange(start, end) {
		const len = this.GetText().length;
		return new Range(this, start === undefined ? 0 : start, end === undefined ? len : end);
	}
	Search(text, matchCase) {
		if (!text) return [];
		const hay = matchCase ? this.GetText() : this.GetText().toLowerCase();
		const needle = matchCase ? text : text.toLowerCase();
		const res = [];
		let pos = hay.indexOf(needle);
		while (pos !== -1) {
			res.push(new Range(this, pos, pos + needle.length));
			pos = hay.indexOf(needle, pos + needle.length);
		}
		return res;
	}
	// test helper: replace [start, end) with text, keeping the first run's formatting
	_replace(start, end, text) {
		const full = this.GetText();
		const pr = this.runs[0] && this.runs[0].textPr ? this.runs[0].textPr : {};
		const next = full.substring(0, start) + text + full.substring(end);
		this.runs = next === "" ? [] : [new Run(next, pr)];
	}
	// test helper: put [start, end) into the given inline content control
	_wrap(start, end, sdt) {
		const full = this.GetText();
		const pr = this.runs[0] && this.runs[0].textPr ? this.runs[0].textPr : {};
		sdt.runs = [new Run(full.substring(start, end), pr)];
		sdt.parent = this;
		this.runs = [];
		if (start > 0) this.runs.push(new Run(full.substring(0, start), pr));
		this.runs.push(sdt);
		if (end < full.length) this.runs.push(new Run(full.substring(end), pr));
	}
	_controls() { return this.runs.filter((r) => r instanceof InlineSdt); }
}

class InlineSdt {
	constructor() {
		this.id = "sdt_" + (++idSeq);
		this.tag = "";
		this.alias = "";
		this.appearance = null;
		this.runs = [];
		this.parent = null;
	}
	GetClassType() { return "inlineLvlSdt"; }
	GetInternalId() { return this.id; }
	GetTag() { return this.tag; }
	SetTag(t) { this.tag = t; return true; }
	GetAlias() { return this.alias; }
	SetAlias(a) { this.alias = a; return true; }
	SetAppearance(a) { this.appearance = a; return true; }
	GetText() { return this.runs.map((r) => r.GetText()).join(""); }
	GetElementsCount() { return this.runs.length; }
	GetElement(i) { return this.runs[i] || null; }
	AddElement(run, pos) { this.runs.splice(pos === undefined ? this.runs.length : pos, 0, run); return true; }
	GetRange() { return { GetText: () => this.GetText() }; }
	GetParentParagraph() { return this.parent; }
	GetParentTableCell() { return null; }
	GetParentContentControl() { return null; }
	MoveCursorOutside() { return true; }
}

class BlockSdt {
	constructor() {
		this.id = "sdt_" + (++idSeq);
		this.tag = "";
		this.alias = "";
		this.appearance = null;
		this.paragraphs = [];
		this.parent = null;
	}
	GetClassType() { return "blockLvlSdt"; }
	GetInternalId() { return this.id; }
	GetTag() { return this.tag; }
	SetTag(t) { this.tag = t; return true; }
	GetAlias() { return this.alias; }
	SetAlias(a) { this.alias = a; return true; }
	SetAppearance(a) { this.appearance = a; return true; }
	AddElement(par, pos) { this.paragraphs.splice(pos === undefined ? this.paragraphs.length : pos, 0, par); par._doc = this.parent; return true; }
	GetText() { return this.paragraphs.map((p) => p.GetText()).join("\r\n"); }
	GetRange() { return { GetText: () => this.GetText() }; }
	GetPosInParent() { return this.parent ? this.parent.elements.indexOf(this) : -1; }
	MoveCursorOutside() { return true; }
}

class Table {
	constructor(rows) {
		// rows: string[][]; each cell holds one paragraph
		this.rows = rows.map((r) => r.map((t) => new Paragraph(t)));
		this.parent = null;
	}
	GetClassType() { return "table"; }
	GetRowsCount() { return this.rows.length; }
	Search(text, matchCase) {
		return this.rows.flat().flatMap((p) => p.Search(text, matchCase));
	}
	// Note: the real ApiTable has no GetText().
}

class Range {
	constructor(para, start, end) {
		this.para = para;
		this.start = start;
		this.end = end;
	}
	GetClassType() { return "range"; }
	GetText() { return this.para.GetText().substring(this.start, this.end); }
	GetParagraph(i) { return i === 0 ? this.para : null; }
	GetAllParagraphs() { return [this.para]; }
	Select() {
		const doc = findDocument(this.para);
		if (doc) doc.selection = [{ para: this.para, start: this.start, end: this.end }];
		return true;
	}
}

// A selection spanning several paragraphs (built by the test fixture).
class MultiRange {
	constructor(parts) { this.parts = parts; }
	GetClassType() { return "range"; }
	GetText() { return this.parts.map((p) => p.para.GetText().substring(p.start, p.end)).join("\r\n"); }
	GetAllParagraphs() { return this.parts.map((p) => p.para); }
}

function findDocument(para) {
	let p = para;
	while (p && !(p instanceof Document)) p = p.parent;
	return p || para._doc || null;
}

class Comment {
	constructor({ id, author = "Alice", text = "", quote = "", solved = false, time = 1700000000000, replies = [] }) {
		this.id = id !== undefined ? String(id) : String(++commentSeq);
		this.author = author;
		this.text = text;
		this.quote = quote;
		this.solved = solved;
		this.time = time;
		this.replies = replies.map((r) => ({ author: r.author || "Bob", text: r.text, userId: r.userId || "" }));
	}
	GetClassType() { return "comment"; }
	GetId() { return this.id; }
	GetAuthorName() { return this.author; }
	GetText() { return this.text; }
	GetQuoteText() { return this.quote; }
	IsSolved() { return this.solved; }
	SetSolved(v) { this.solved = !!v; return this; }
	GetTimeUTC() { return this.time; }
	GetRepliesCount() { return this.replies.length; }
	GetReply(i) {
		if (typeof i !== "number" || i < 0 || i >= this.replies.length) i = 0;
		const r = this.replies[i];
		return r ? { GetAuthorName: () => r.author, GetText: () => r.text } : null;
	}
	AddReply(text, author, userId) {
		if (typeof text !== "string" || text === "") return null;
		this.replies.push({ author, text, userId });
		return this;
	}
}

class Document {
	constructor() {
		this.elements = [];
		this.styles = new Map();
		this.comments = [];
		this.revisions = {};    // author -> [{ Type, Value, Date, ReviewedElement }]
		this.trackRevisions = false;
		this.selection = null;  // null | [{ para, start, end }]
		this.cursor = null;     // paragraph holding the cursor when nothing is selected
		this.customProperties = {};
		this.user = "User";       // current author for tracked changes
		this.undoDepth = 0;       // grouped undo steps (GroupActions)
		this.undone = 0;
	}
	_adopt(el) {
		el.parent = this;
		if (el.rows) el.rows.flat().forEach((p) => { p._doc = this; });
		if (el.paragraphs) el.paragraphs.forEach((p) => { p._doc = this; });
		return el;
	}
	GetClassType() { return "document"; }
	GetElementsCount() { return this.elements.length; }
	GetElement(i) { return (i >= 0 && i < this.elements.length) ? this.elements[i] : null; }
	AddElement(pos, el) { this.elements.splice(pos, 0, this._adopt(el)); return true; }
	Push(el) { this.elements.push(this._adopt(el)); return true; }
	RemoveElement(pos) {
		if (pos < 0 || pos >= this.elements.length) return false;
		const [el] = this.elements.splice(pos, 1);
		el.parent = null;
		return true;
	}
	GetStyle(name) { return this.styles.get(name) || null; }
	GetRangeBySelect() {
		if (!this.selection || !this.selection.length) return null;
		if (this.selection.length === 1) {
			const s = this.selection[0];
			return new Range(s.para, s.start, s.end);
		}
		return new MultiRange(this.selection);
	}
	GetCurrentParagraph() { return this.cursor; }
	RemoveSelection() { this.selection = null; return true; }
	MoveCursorToEnd() {
		this.selection = null;
		this.cursor = this.elements[this.elements.length - 1] || null;
		return true;
	}
	GetAllParagraphs() {
		return this.elements.flatMap((e) => e instanceof Paragraph ? [e] : e.rows ? e.rows.flat() : e.paragraphs || []);
	}
	GetAllContentControls() {
		return this.elements.flatMap((e) => e instanceof BlockSdt ? [e] : []).concat(this.GetAllParagraphs().flatMap((p) => p._controls()));
	}
	GetContentControlsByTag(tag) { return this.GetAllContentControls().filter((c) => c.GetTag() === tag); }
	GetCustomProperties() {
		const props = this.customProperties;
		return { Get: (n) => (n in props ? props[n] : null), Add: (n, v) => { props[n] = v; return true; } };
	}
	GetAllComments() { return this.comments.slice(); }
	GetCommentById(id) { return this.comments.find((c) => c.id === String(id)) || null; }
	IsTrackRevisions() { return this.trackRevisions; }
	SetTrackRevisions(v) { this.trackRevisions = !!v; return true; }
	// Euro-Office sdkjs: turns tracking on under another author name and
	// restores the previous state (one global buffer) when called with false.
	SetAssistantTrackRevisions(v, name) {
		if (v) {
			this._assistantBuffer = { track: this.trackRevisions, user: this.user };
			this.trackRevisions = true;
			this.user = name;
		} else if (this._assistantBuffer) {
			this.trackRevisions = this._assistantBuffer.track;
			this.user = this._assistantBuffer.user;
			this._assistantBuffer = null;
		}
		return true;
	}
	GetReviewReport() {
		const res = {};
		for (const a in this.revisions) res[a] = this.revisions[a].map((r) => ({ ...r }));
		return res;
	}
	// test helpers
	texts() { return this.elements.map((e) => e instanceof Paragraph ? e.GetText() : e instanceof BlockSdt ? e.GetText() : "[table]"); }
	controls() { return this.GetAllContentControls(); }
	selectedText() { const r = this.GetRangeBySelect(); return r ? r.GetText() : ""; }
}

/**
 * Builds a fake word document.
 * @param {object} spec
 * @param {Array<string|{text, style?, list?, outlineLvl?, textPr?}|{table: string[][]}>} spec.body
 * @param {Array<string|[string, number]>} [spec.styles] extra style names; "Heading N" get outline level N
 * @param {{ paragraph: number, start?: number, end?: number } | Array} [spec.selection] 1-based paragraph index
 * @param {number} [spec.cursor] 1-based paragraph index of the cursor
 * @param {Array<object>} [spec.comments]
 * @param {object} [spec.revisions] author -> [{ Type, Value, paragraph }]
 */
export function createWordDocument(spec = {}) {
	const doc = new Document();
	const styleNames = ["Normal", "Heading 1", "Heading 2", "Heading 3", "Title", "List Paragraph", ...(spec.styles || [])];
	for (const s of styleNames) {
		const m = /^Heading ([1-9])$/.exec(s);
		doc.styles.set(s, new Style(s, m ? Number(m[1]) : undefined));
	}
	for (const item of spec.body || []) {
		if (typeof item === "string") {
			doc.Push(new Paragraph(item, { style: doc.styles.get("Normal") }));
		} else if (item.table) {
			doc.Push(new Table(item.table));
		} else {
			doc.Push(new Paragraph(item.text, {
				style: doc.styles.get(item.style || "Normal") || new Style(item.style),
				list: item.list,
				outlineLvl: item.outlineLvl,
				textPr: item.textPr
			}));
		}
	}
	const sel = spec.selection ? (Array.isArray(spec.selection) ? spec.selection : [spec.selection]) : null;
	if (sel) {
		doc.selection = sel.map((s) => {
			const para = doc.elements[s.paragraph - 1];
			return { para, start: s.start || 0, end: s.end === undefined ? para.GetText().length : s.end };
		});
	}
	if (spec.cursor) doc.cursor = doc.elements[spec.cursor - 1];
	doc.comments = (spec.comments || []).map((c) => new Comment(c));
	for (const author in spec.revisions || {}) {
		doc.revisions[author] = spec.revisions[author].map((r) => ({
			Type: r.Type, Value: r.Value, Date: r.Date,
			ReviewedElement: r.paragraph ? doc.elements[r.paragraph - 1] : undefined
		}));
	}

	const Api = {
		GetDocument: () => doc,
		CreateParagraph: () => { const p = new Paragraph(""); return p; },
		CreateRun: () => new Run(""),
		CreateInlineLvlSdt: () => new InlineSdt(),
		CreateBlockLvlSdt: () => new BlockSdt()
	};

	// executeMethod handlers (plugin methods), see sdkjs word/api_plugins.js
	const methods = {
		GetSelectedText: () => doc.selectedText(),
		GetSelectedContent: () => doc.selectedText(),
		ReplaceTextSmart: (lines) => {
			if (!doc.selection) return false;
			const text = Array.isArray(lines) ? lines.join("\n") : String(lines);
			const s = doc.selection[0];
			s.para._replace(s.start, s.end, text);
			if (doc.trackRevisions) {
				(doc.revisions[doc.user] = doc.revisions[doc.user] || []).push({ Type: "TextAdd", Value: text, Date: Date.now(), ReviewedElement: s.para });
			}
			doc.selection = [{ para: s.para, start: s.start, end: s.start + text.length }];
			return true;
		},
		PasteText: (text) => methods.ReplaceTextSmart([text]),
		// Pastes each block element as a paragraph after the cursor paragraph.
		PasteHtml: (html) => {
			const lines = String(html).replace(/<\/(p|h[1-6]|li|div|pre|blockquote|tr)>|<br\s*\/?>/gi, "\n")
				.replace(/<[^>]+>/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
			let at = doc.cursor ? doc.elements.indexOf(doc.cursor) + 1 : doc.elements.length;
			for (const line of lines) doc.AddElement(at++, new Paragraph(line));
			doc.cursor = doc.elements[at - 1] || doc.cursor;
			return true;
		},
		// AddContentControl(2 = inline, { Tag, Alias, Appearance }) wraps the selection
		AddContentControl: (type, pr) => {
			if (type !== 2 || !doc.selection || doc.selection.length !== 1) return null;
			const s = doc.selection[0];
			const sdt = new InlineSdt();
			sdt.tag = pr.Tag || "";
			sdt.alias = pr.Alias || "";
			sdt.appearance = pr.Appearance;
			s.para._wrap(s.start, s.end, sdt);
			return { InternalId: sdt.id, Tag: sdt.tag };
		},
		AddComment: (data) => {
			doc.comments.push(new Comment({ author: data.UserName, text: data.Text || "" }));
			return true;
		},
		StartAction: () => undefined,
		EndAction: (type) => { if (type === "GroupActions") doc.undoDepth++; },
		CanUndo: () => doc.undoDepth > 0,
		Undo: () => { if (doc.undoDepth > 0) { doc.undoDepth--; doc.undone++; } return true; },
		AcceptReviewChanges: (isAll) => reviewChanges(isAll),
		RejectReviewChanges: (isAll) => reviewChanges(isAll)
	};

	function reviewChanges(isAll) {
		const selected = new Set((doc.selection || []).map((s) => s.para));
		for (const a in doc.revisions) {
			doc.revisions[a] = doc.revisions[a].filter((r) => !(isAll || selected.has(r.ReviewedElement)));
			if (!doc.revisions[a].length) delete doc.revisions[a];
		}
	}

	return { Api, doc, methods };
}

export { Paragraph, Table, Comment, Style, InlineSdt, BlockSdt };
