// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Document location links ("citations") in chat answers.
//
// The tools system prompts ask the model to cite places in the document as
// markdown links with a private scheme:
//   eo://word/paragraph/<n>                 n: 1-based top-level element index
//   eo://word/find?text=<urlencoded text>   short verbatim snippet
//   eo://cell/<urlencoded sheet>!<A1 range> e.g. eo://cell/Q1%20Data!B2:D10
//   eo://slide/<n>[/shape/<i>]              1-based slide / drawing index
//
// parse() validates a link strictly and returns a plain location object, or
// null for anything else. It is used by the chat (to decide what becomes a
// clickable chip) and again by the plugin before navigating, so a crafted
// link can never do more than select a place in the open file.
//
// Pure logic, loaded in sidebar/index.html and index.html and testable in Node.
(function(root) {

	const MAX_HREF_LENGTH = 1000;
	const MAX_INDEX = 1000000;
	const MAX_FIND_TEXT = 200;
	const MAX_SHEET_NAME = 31; // spreadsheet limit

	const RE_WORD_PARAGRAPH = /^eo:\/\/word\/paragraph\/([1-9][0-9]{0,6})\/?$/;
	const RE_WORD_FIND = /^eo:\/\/word\/find\?text=([^&#\s]+)$/;
	const RE_CELL = /^eo:\/\/cell\/([^!\/?#\s]+)!([A-Za-z0-9$:]+)$/;
	const RE_SLIDE = /^eo:\/\/slide\/([1-9][0-9]{0,4})(?:\/shape\/([1-9][0-9]{0,4}))?\/?$/;

	// A1, A1:C10, A:C (whole columns), 3:7 (whole rows); "$" allowed.
	const RE_CELL_REF = /^\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}$/;
	const RE_COL_REF = /^\$?[A-Za-z]{1,3}$/;
	const RE_ROW_REF = /^\$?[1-9][0-9]{0,6}$/;

	// Characters a sheet name can not contain, plus control characters.
	const RE_BAD_SHEET_CHARS = /[\[\]:*?\/\\\u0000-\u001f\u007f]/;
	const RE_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

	function safeDecode(s) {
		try {
			return decodeURIComponent(s);
		} catch (e) {
			return null;
		}
	}

	function parseRange(range) {
		let parts = range.split(":");
		if (parts.length === 1)
			return RE_CELL_REF.test(parts[0]) ? range.replace(/\$/g, "").toUpperCase() : null;
		if (parts.length !== 2)
			return null;
		let ok = (RE_CELL_REF.test(parts[0]) && RE_CELL_REF.test(parts[1])) ||
			(RE_COL_REF.test(parts[0]) && RE_COL_REF.test(parts[1])) ||
			(RE_ROW_REF.test(parts[0]) && RE_ROW_REF.test(parts[1]));
		return ok ? range.replace(/\$/g, "").toUpperCase() : null;
	}

	function parse(href) {
		if (typeof href !== "string" || href.length === 0 || href.length > MAX_HREF_LENGTH)
			return null;
		// The scheme and editor are case-insensitive (markdown-it may
		// normalize them); everything after is matched as is.
		let m = /^eo:\/\/(word|cell|slide)\//i.exec(href);
		if (!m)
			return null;
		href = "eo://" + m[1].toLowerCase() + "/" + href.substring(m[0].length);

		if ((m = RE_WORD_PARAGRAPH.exec(href))) {
			let n = parseInt(m[1], 10);
			if (n > MAX_INDEX)
				return null;
			return { editor: "word", type: "paragraph", index: n };
		}

		if ((m = RE_WORD_FIND.exec(href))) {
			let text = safeDecode(m[1].replace(/\+/g, "%20"));
			if (text === null)
				return null;
			text = text.trim();
			if (text.length === 0 || text.length > MAX_FIND_TEXT || RE_CONTROL_CHARS.test(text))
				return null;
			return { editor: "word", type: "find", text: text };
		}

		if ((m = RE_CELL.exec(href))) {
			let sheet = safeDecode(m[1]);
			if (sheet === null)
				return null;
			// Tolerate the spreadsheet quoting style 'My Sheet'!A1.
			if (sheet.length >= 2 && sheet.charAt(0) === "'" && sheet.charAt(sheet.length - 1) === "'")
				sheet = sheet.substring(1, sheet.length - 1).replace(/''/g, "'");
			if (sheet.trim().length === 0 || sheet.length > MAX_SHEET_NAME || RE_BAD_SHEET_CHARS.test(sheet))
				return null;
			let range = parseRange(m[2]);
			if (!range)
				return null;
			return { editor: "cell", type: "range", sheet: sheet, range: range };
		}

		if ((m = RE_SLIDE.exec(href))) {
			let loc = { editor: "slide", type: "slide", slide: parseInt(m[1], 10) };
			if (m[2])
				loc.shape = parseInt(m[2], 10);
			return loc;
		}

		return null;
	}

	// Short label for tooltips, e.g. "Sales!B2:D10" or "Slide 3".
	// tr: optional translation function for the word "Slide".
	function describe(loc, tr) {
		if (!loc)
			return "";
		tr = tr || function(s) { return s; };
		switch (loc.type) {
			case "paragraph": return "¶ " + loc.index;
			case "find":      return "“" + loc.text + "”";
			case "range":     return loc.sheet + "!" + loc.range;
			case "slide":     return tr("Slide") + " " + loc.slide + (loc.shape ? " / " + loc.shape : "");
		}
		return "";
	}

	function isLocationHref(href) {
		return typeof href === "string" && /^eo:/i.test(href);
	}

	let api = {
		parse: parse,
		describe: describe,
		isLocationHref: isLocationHref
	};

	root.EOLinks = api;
	if (typeof module === "object" && module.exports)
		module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
