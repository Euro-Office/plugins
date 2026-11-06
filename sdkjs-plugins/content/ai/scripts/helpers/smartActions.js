// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Smart actions: context-aware agent tasks for the current selection.
// Each action hands a prompt to the chat agent, which sees the selection
// (see DocumentContext) and can read/modify the document through tools.
//
// Shared by the right-click "Smart actions" submenu (all actions of the
// editor) and the selection suggestion chips in the chat (a short list
// picked from the selection snapshot by get(editorType, ctx)).
(function(root) {

	const LANG_HINT = " Reply in the language of the selected content.";
	const MAX_CHIPS = 4;

	// Thresholds for the text heuristics (characters).
	const LONG_TEXT = 400;
	const SHORTEN_MIN = 120;

	const ACTIONS = {
		word: [
			{ id: "improve", text: "Improve writing", prompt: "Improve the clarity, grammar and style of the selected text while keeping its meaning, tone and language. Apply the result to the document with replaceSelection and trackChanges set to true, then briefly say what you changed." },
			{ id: "shorten", text: "Make shorter", prompt: "Shorten the selected text by roughly half without losing key information. Apply it with replaceSelection (trackChanges true)." },
			{ id: "summarize", text: "Summarize in chat", prompt: "Summarize the selected text in 3-5 bullet points. Answer in the chat only; do not modify the document." },
			{ id: "actionItems", text: "Extract action items", prompt: "List all action items, decisions and deadlines found in the selected text as a checklist. Answer in the chat only; do not modify the document." },
			{ id: "toTable", text: "Convert to table", prompt: "Convert the selected text into a well-structured table in the document, replacing the selection. Use writeMacro if needed." },
			{ id: "continue", text: "Continue writing", prompt: "Continue writing one paragraph after the selected text, matching its style and language. Insert it as a new paragraph directly after the last selected paragraph (use getSelection to find its index and editParagraph with insertAfter)." }
		],
		cell: [
			{ id: "explainData", text: "Explain this data", prompt: "Explain the selected data: what it represents, its structure, and the key patterns, trends or outliers. Use readRange if the preview is truncated. Answer in the chat only; do not modify the sheet." },
			{ id: "insights", text: "Summarize & insights", prompt: "Analyse the selected data and give a short summary with the 3-5 most important insights, including relevant totals, averages or changes. Answer in the chat only; do not modify the sheet." },
			{ id: "cleanUp", text: "Clean up data", prompt: "Clean the selected data: trim extra spaces, make capitalization consistent, convert numbers and dates stored as text, and normalize obvious inconsistencies. Do not change formulas. Read it with readRange, write the cleaned values back to the same range with writeRange, then list what you changed." },
			{ id: "fillMissing", text: "Fill missing values", prompt: "Fill the empty cells in the selected data with sensible values inferred from the surrounding data, then explain what you filled." },
			{ id: "calcColumn", text: "Add calculated column", prompt: "Look at the selected table and add one useful calculated column directly to its right (e.g. total, difference, growth or ratio) with a header and real spreadsheet formulas, using writeRange. Explain the formula." },
			{ id: "chart", text: "Create chart", prompt: "Create the most suitable chart for the selected data and briefly explain why you chose that chart type." },
			{ id: "anomalies", text: "Highlight anomalies", prompt: "Find and highlight anomalies or outliers in the selected data, then explain what you found." },
			{ id: "explainFormula", text: "Explain formula", prompt: "Explain the formulas in the selected cells in plain language (read them with readRange and includeFormulas true) and point out possible errors. Answer in the chat only." }
		],
		slide: [
			{ id: "improve", text: "Improve text", prompt: "Improve the selected slide text: clearer, more concise and more engaging, keeping the meaning and language. Replace the selection with the result using replaceSelection." },
			{ id: "concise", text: "Make concise", prompt: "Rewrite the selected slide text as short, punchy bullet points suitable for a slide and replace the selection with replaceSelection." },
			{ id: "summarizeSlide", text: "Summarize this slide", prompt: "Summarize the current slide (use readPresentation with currentSlideOnly) in 2-3 sentences that could be used as speaker notes. Answer in the chat only." }
		]
	};

	function copy(action) {
		return { id: action.id, text: action.text, prompt: action.prompt };
	}

	function all(editorType) {
		return (ACTIONS[editorType] || []).map(copy);
	}

	function byId(editorType, id) {
		let list = ACTIONS[editorType] || [];
		for (let i = 0; i < list.length; i++) {
			if (list[i].id === id)
				return copy(list[i]);
		}
		return null;
	}

	function pick(editorType, ids) {
		let res = [];
		for (let i = 0; i < ids.length && res.length < MAX_CHIPS; i++) {
			if (res.some(function(a) { return a.id === ids[i]; }))
				continue;
			let action = byId(editorType, ids[i]);
			if (action)
				res.push(action);
		}
		return res;
	}

	function selectedText(ctx) {
		return (ctx && ctx.hasSelection && typeof ctx.selectionText === "string") ? ctx.selectionText.trim() : "";
	}

	function hasSelection(ctx) {
		if (!ctx)
			return false;
		if (ctx.editor === "cell")
			return !!ctx.selection && ctx.selectionRows > 0 && ctx.selectionColumns > 0;
		return selectedText(ctx).length > 0;
	}

	// Text that looks like a table: several lines, each with a tab.
	function looksTabular(text) {
		let lines = text.split(/\r?\n|\r/).filter(function(l) { return l.trim().length > 0; });
		return lines.length >= 2 && lines.every(function(l) { return l.indexOf("\t") !== -1; });
	}

	function isNumeric(value) {
		let v = String(value).trim().replace(/[\s ]/g, "").replace(/[%€$£¥]/g, "");
		if (!v)
			return false;
		// Accept 1234, -1.5, 1,234.5 and 1.234,5
		return /^[-+]?(\d+|\d{1,3}([.,]\d{3})+)([.,]\d+)?([eE][-+]?\d+)?$/.test(v);
	}

	// Parses DocumentContext's cell preview ("value {=formula}" cells, tab
	// separated rows) into simple statistics.
	function cellStats(ctx) {
		let rows = String(ctx.preview || "").split("\n").map(function(line) {
			return line.split("\t").map(function(cell) {
				return cell.replace(/\s\{=.*\}$/, "");
			});
		});
		let stats = { cells: 0, empty: 0, numeric: 0, text: 0, numericColumns: 0 };
		let width = rows.reduce(function(m, r) { return Math.max(m, r.length); }, 0);
		let colNumeric = [];
		let colFilled = [];
		for (let r = 0; r < rows.length; r++) {
			for (let c = 0; c < width; c++) {
				let value = rows[r][c] === undefined ? "" : rows[r][c];
				stats.cells++;
				if (!String(value).trim()) {
					stats.empty++;
					continue;
				}
				colFilled[c] = (colFilled[c] || 0) + 1;
				if (isNumeric(value)) {
					stats.numeric++;
					colNumeric[c] = (colNumeric[c] || 0) + 1;
				} else {
					stats.text++;
				}
			}
		}
		for (let c = 0; c < width; c++) {
			// The first row is usually a header, so a column counts as numeric
			// when all filled cells but one are numbers.
			if (colNumeric[c] && colNumeric[c] >= Math.max(1, (colFilled[c] || 0) - 1))
				stats.numericColumns++;
		}
		return stats;
	}

	function rankWord(text) {
		if (looksTabular(text))
			return ["toTable", "summarize", "improve"];
		if (text.length >= LONG_TEXT)
			return ["summarize", "shorten", "actionItems", "improve"];
		let ids = ["improve", "continue"];
		if (text.length >= SHORTEN_MIN)
			ids.push("shorten");
		return ids;
	}

	function rankCell(ctx) {
		let rows = ctx.selectionRows;
		let cols = ctx.selectionColumns;
		let hasFormulas = ctx.formulasInPreview > 0;
		let stats = cellStats(ctx);

		if (rows * cols === 1) {
			if (hasFormulas)
				return ["explainFormula"];
			return stats.text > 0 ? ["cleanUp"] : [];
		}

		let ids = [];
		if (hasFormulas)
			ids.push("explainFormula");

		let filled = stats.numeric + stats.text;
		let mostlyNumeric = filled > 0 && stats.numeric >= stats.text;
		if (mostlyNumeric && stats.numericColumns >= 1 && rows >= 2) {
			if (cols >= 2)
				ids.push("chart");
			ids.push("insights");
			if (rows >= 5)
				ids.push("anomalies");
		} else if (stats.text > 0) {
			ids.push("cleanUp");
		}
		if (stats.empty > 0 && filled > 0)
			ids.push("fillMissing");
		ids.push("explainData");
		return ids;
	}

	function rankSlide(text) {
		if (text.length >= LONG_TEXT)
			return ["concise", "improve", "summarizeSlide"];
		return ["improve", "concise", "summarizeSlide"];
	}

	// Without ctx: every action of the editor (context menu).
	// With ctx (DocumentContext snapshot): up to MAX_CHIPS actions that fit
	// the selection, best first; [] when nothing is selected.
	function get(editorType, ctx) {
		if (ctx === undefined)
			return all(editorType);
		if (!hasSelection(ctx))
			return [];

		switch (editorType) {
			case "word":  return pick("word", rankWord(selectedText(ctx)));
			case "cell":  return pick("cell", rankCell(ctx));
			case "slide": return pick("slide", rankSlide(selectedText(ctx)));
		}
		return [];
	}

	// Small cheap fingerprint of the selection, to notice changes.
	function selectionKey(ctx) {
		if (!hasSelection(ctx))
			return "";
		if (ctx.editor === "cell")
			return ["cell", ctx.activeSheet, ctx.selection, ctx.selectionRows, ctx.selectionColumns, hash(ctx.preview || "")].join("|");
		let text = selectedText(ctx);
		return [ctx.editor, text.length, hash(text)].join("|");
	}

	function hash(str) {
		let h = 0;
		for (let i = 0; i < str.length; i++)
			h = (h * 31 + str.charCodeAt(i)) | 0;
		return h.toString(16);
	}

	let SmartActions = {
		LANG_HINT: LANG_HINT,
		MAX_CHIPS: MAX_CHIPS,
		all: all,
		get: get,
		byId: byId,
		hasSelection: hasSelection,
		selectionKey: selectionKey,
		hash: hash
	};

	root.SmartActions = SmartActions;
	if (typeof module !== "undefined" && module.exports)
		module.exports = SmartActions;

})(typeof window !== "undefined" ? window : globalThis);
