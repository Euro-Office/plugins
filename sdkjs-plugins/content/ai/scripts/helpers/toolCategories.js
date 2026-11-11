// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Tool categories and the per-request tool selection.
//
// Sending all ~40 tools of an editor with every request costs a lot of
// tokens and makes it harder for the model to pick the right one. Each tool
// in .dev/helpers/<editor>/*.js declares a "category"; per request we send
// the always-on categories (core + macro), the categories that the user's
// message and selection hint at, and the categories of tools used earlier in
// the conversation. The meta tool "loadTools" lets the model fetch any other
// category mid-turn, so a wrong guess never blocks a request.
//
// Pure logic (no editor API), loaded in index.html and testable in Node.
(function(root) {

	const META_TOOL = "loadTools";
	const META_CATEGORY = "meta";

	// Order is the order shown to the model in the loadTools description.
	const CATEGORIES = {
		"core":                   "read, search and select content, navigate (always loaded)",
		"edit-text":              "write, insert, replace or rewrite text / cell values",
		"format":                 "fonts, colors, bold/italic, paragraph and cell styles, table styles",
		"comments-review":        "comments, replies, tracked changes, spelling review, AI-generated content markers",
		"structure":              "sheets, rows/columns, freeze panes, slides (add/delete/move/duplicate), pages",
		"data":                   "sort, filter, data validation, number formats, fill missing values, duplicates",
		"analysis":               "summaries, statistics, anomalies, formula explanation/repair, pivot tables",
		"charts-visuals":         "charts, images, shapes, tables on slides, slide backgrounds",
		"conditional-formatting": "color scales, data bars, icon sets, highlight rules",
		"generate":               "generate a whole new document, form or presentation",
		"notes":                  "speaker notes",
		"macro":                  "writeMacro: run arbitrary editor API code (always loaded)"
	};

	// Sent with every request.
	const ALWAYS = ["core", "macro"];

	// Also sent with every request in that editor. Almost every slide edit
	// adds shapes, tables or charts, and requests rarely name them ("a box
	// with an arrow"); without these tools models fall back to writeMacro.
	const ALWAYS_FOR_EDITOR = {
		"slide": ["charts-visuals"]
	};

	// Used when the message is very short or no keyword matched, so ordinary
	// requests work without a loadTools round trip.
	const DEFAULTS = {
		"word":  ["core", "edit-text", "format"],
		"cell":  ["core", "edit-text", "format", "data", "analysis"],
		"slide": ["core", "edit-text", "structure", "charts-visuals"]
	};

	// Messages with fewer words than this are treated as uncertain.
	const MIN_WORDS_FOR_INFERENCE = 3;

	// Keyword stems (English + German), matched at the start of a word,
	// case-insensitive. Stems may contain spaces.
	const KEYWORDS = {
		"edit-text": [
			"rewrite", "rephrase", "reword", "write", "insert", "replace", "edit", "correct", "fix the text",
			"translat", "shorten", "expand", "paraphras", "proofread", "improve", "add a paragraph", "add text",
			"paragraph", "sentence", "enter ", "fill in", "type ", "fix", "typo", "spelling",
			"umschreib", "umformulier", "formulier", "schreib", "einfüg", "füge", "ersetz", "bearbeit", "korrigier",
			"übersetz", "kürz", "erweiter", "verbesser", "absatz", "satz", "eintrag", "trage",
			"tippfehler", "rechtschreib", "berichtig"
		],
		"format": [
			"format", "bold", "italic", "underline", "strikethrough", "font", "color", "colour", "style",
			"heading", "align", "indent", "spacing", "border", "highlight",
			"formatier", "fett", "kursiv", "unterstrich", "durchgestrichen", "schrift", "farbe", "farbig", "stil",
			"überschrift", "ausricht", "einzug", "abstand", "rahmen", "hervorheb", "markier"
		],
		"comments-review": [
			"comment", "review", "tracked change", "track change", "suggestion", "accept", "reject", "resolve",
			"reply", "feedback", "spelling", "spell", "typo", "grammar",
			"kommentar", "kommentier", "überarbeit", "nachverfolg", "änderungen", "vorschl", "annehm", "ablehn", "erledigt",
			"antwort", "rechtschreib", "tippfehler", "grammatik", "ai-generated", "ai generated", "written by ai", "provenance",
			"ki-generiert", "von ki", "mit ki erstellt", "herkunft"
		],
		"structure": [
			"sheet", "worksheet", "tab ", "row", "column", "freeze", "slide", "page break", "new page",
			"blank page", "section", "reorder", "move", "duplicate slide", "delete slide", "rename",
			"blatt", "tabellenblatt", "arbeitsblatt", "zeile", "spalte", "fixier", "einfrier", "folie",
			"seitenumbruch", "neue seite", "leere seite", "abschnitt", "verschieb", "umbenenn", "lösch"
		],
		"data": [
			"sort", "filter", "validation", "dropdown", "drop-down", "number format", "currency", "percent",
			"date format", "decimal", "fill", "missing", "blank", "empty cell", "clean", "duplicate", "dedup",
			"sortier", "gültigkeit", "validier", "auswahlliste", "zahlenformat", "währung", "prozent",
			"datumsformat", "dezimal", "ausfüll", "fehlend", "leere", "bereinig", "duplikat", "doppelt"
		],
		"analysis": [
			"summar", "analy", "explain", "insight", "trend", "anomal", "outlier", "statistic", "average",
			"mean", "median", "total", "pivot", "formula", "error", "why", "what does", "calculate",
			"zusammenfass", "analys", "erklär", "erkenntnis", "auswert", "ausreißer", "auffällig", "statistik",
			"durchschnitt", "mittelwert", "summe", "formel", "fehler", "warum", "berechn"
		],
		"charts-visuals": [
			"chart", "graph", "plot", "diagram", "visual", "image", "picture", "photo", "illustration", "shape",
			"background", "table", "icon", "logo",
			"diagramm", "grafik", "schaubild", "visualisier", "bild", "foto", "illustration", "formen",
			"hintergrund", "tabelle", "symbol"
		],
		"conditional-formatting": [
			"conditional", "color scale", "colour scale", "heatmap", "heat map", "data bar", "icon set",
			"top 10", "top ten", "above average", "below average", "highlight cells", "highlight values",
			"bedingt", "farbskala", "datenbalken", "symbolsatz", "über dem durchschnitt", "unter dem durchschnitt",
			"hervorheb"
		],
		"generate": [
			"generate", "draft", "from scratch", "new document", "new presentation", "create a document",
			"create a presentation", "create a deck", "create a form", "presentation about", "deck about",
			"template", "letter", "report",
			"generier", "entwurf", "entwirf", "neues dokument", "neue präsentation", "präsentation über",
			"erstelle ein dokument", "erstelle eine präsentation", "formular", "vorlage", "brief", "bericht"
		],
		"notes": [
			"speaker note", "notes", "presenter", "talking point", "script for",
			"notiz", "sprechernotiz", "rednernotiz", "vortragsnotiz", "redetext", "moderation"
		]
	};

	function escapeRegExp(s) {
		return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	// "(start or non-letter) + stem": JS \b does not treat umlauts as word
	// characters, so build the boundary explicitly.
	let keywordRegexps = null;
	function getKeywordRegexps() {
		if (keywordRegexps)
			return keywordRegexps;
		keywordRegexps = {};
		for (let cat in KEYWORDS) {
			let alternatives = KEYWORDS[cat].map(escapeRegExp).join("|");
			keywordRegexps[cat] = new RegExp("(?:^|[^\\p{L}\\p{N}])(?:" + alternatives + ")", "iu");
		}
		return keywordRegexps;
	}

	function countWords(text) {
		let words = String(text || "").trim().split(/\s+/).filter(function(w) { return w.length > 0; });
		return words.length;
	}

	// Categories hinted at by the editor selection snapshot (DocumentContext).
	function categoriesFromContext(context, editorType) {
		let result = [];
		if (!context)
			return result;
		if (editorType === "cell") {
			let cells = (context.selectionRows || 0) * (context.selectionColumns || 0);
			if (cells > 1)
				result.push("data", "format");
			if (context.formulasInPreview > 0)
				result.push("analysis");
		} else if (context.hasSelection) {
			result.push("edit-text", "format");
			if (editorType === "word")
				result.push("comments-review");
		}
		return result;
	}

	// Returns { categories, matched, fallback } for one user message.
	// available: optional list of the editor's categories; keywords for
	// categories the editor does not have do not count as a match.
	function infer(text, context, editorType, available) {
		text = String(text || "");
		let regexps = getKeywordRegexps();
		let matched = [];
		for (let cat in regexps) {
			if (regexps[cat].test(text) && (!available || available.indexOf(cat) !== -1))
				matched.push(cat);
		}
		let fromContext = categoriesFromContext(context, editorType);
		let fallback = matched.length === 0 || countWords(text) < MIN_WORDS_FOR_INFERENCE;

		let categories = ALWAYS.concat(ALWAYS_FOR_EDITOR[editorType] || [], matched, fromContext);
		if (fallback)
			categories = categories.concat(DEFAULTS[editorType] || []);
		return { categories: unique(categories), matched: matched, fallback: fallback };
	}

	function unique(list) {
		let seen = {};
		let out = [];
		for (let i = 0; i < list.length; i++) {
			if (!seen[list[i]]) {
				seen[list[i]] = true;
				out.push(list[i]);
			}
		}
		return out;
	}

	// Canonical order (as in CATEGORIES) so cache keys are stable.
	function normalize(categories, available) {
		let set = {};
		for (let i = 0; i < categories.length; i++)
			set[categories[i]] = true;
		let out = [];
		for (let cat in CATEGORIES) {
			if (set[cat] && (!available || available.indexOf(cat) !== -1))
				out.push(cat);
		}
		return out;
	}

	// options: { editorType, text, context, usedCategories, available }
	function select(options) {
		options = options || {};
		let inferred = infer(options.text, options.context, options.editorType, options.available);
		let categories = inferred.categories.concat(options.usedCategories || []);
		return normalize(categories, options.available);
	}

	// Text for the loadTools description: one line per category the editor has.
	function describe(available) {
		let lines = [];
		for (let cat in CATEGORIES) {
			if (!available || available.indexOf(cat) !== -1)
				lines.push("- " + cat + ": " + CATEGORIES[cat]);
		}
		return lines.join("\n");
	}

	let api = {
		META_TOOL: META_TOOL,
		META_CATEGORY: META_CATEGORY,
		CATEGORIES: CATEGORIES,
		ALWAYS: ALWAYS,
		DEFAULTS: DEFAULTS,
		KEYWORDS: KEYWORDS,
		MIN_WORDS_FOR_INFERENCE: MIN_WORDS_FOR_INFERENCE,
		infer: infer,
		select: select,
		normalize: normalize,
		describe: describe
	};

	root.ToolCategories = api;
	if (typeof module === "object" && module.exports)
		module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
