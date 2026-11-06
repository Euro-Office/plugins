// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// eo:// document citations (scripts/helpers/citations.js)
// (ported from the standalone node:test suite that came with the feature).

import { test } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";
import path from "node:path";
import { PLUGIN_DIR as AI_DIR } from "../lib/sandbox.js";

const require = createRequire(import.meta.url);
const L = require(path.join(AI_DIR, "scripts/helpers/citations.js"));
const markdownit = require(path.join(AI_DIR, "vendor/md/markdown-it.js"));

test("valid links parse", () => {
	assert.deepStrictEqual(L.parse("eo://word/paragraph/12"), { editor: "word", type: "paragraph", index: 12 });
	assert.deepStrictEqual(L.parse("eo://word/find?text=net%2030%20days"), { editor: "word", type: "find", text: "net 30 days" });
	assert.deepStrictEqual(L.parse("eo://cell/Sales!B2:D10"), { editor: "cell", type: "range", sheet: "Sales", range: "B2:D10" });
	assert.deepStrictEqual(L.parse("eo://cell/Q1%20Data!c5"), { editor: "cell", type: "range", sheet: "Q1 Data", range: "C5" });
	assert.deepStrictEqual(L.parse("eo://cell/'My%20Sheet'!$A$1:$B$2"), { editor: "cell", type: "range", sheet: "My Sheet", range: "A1:B2" });
	assert.deepStrictEqual(L.parse("eo://cell/Daten!A:C"), { editor: "cell", type: "range", sheet: "Daten", range: "A:C" });
	assert.deepStrictEqual(L.parse("eo://cell/%C3%9Cbersicht!3:7"), { editor: "cell", type: "range", sheet: "Übersicht", range: "3:7" });
	assert.deepStrictEqual(L.parse("eo://slide/3"), { editor: "slide", type: "slide", slide: 3 });
	assert.deepStrictEqual(L.parse("eo://slide/3/shape/2"), { editor: "slide", type: "slide", slide: 3, shape: 2 });
	assert.deepStrictEqual(L.parse("EO://Word/paragraph/1"), { editor: "word", type: "paragraph", index: 1 });
});

test("invalid links are rejected", () => {
	const bad = [
		null, undefined, 42, "", "eo:", "eo://", "eo://pdf/page/1", "javascript:alert(1)", "https://example.com",
		"eo://word/paragraph/0", "eo://word/paragraph/-1", "eo://word/paragraph/1.5", "eo://word/paragraph/12345678",
		"eo://word/paragraph/1?x=1", "eo://word/paragraph/1#frag",
		"eo://word/find?text=", "eo://word/find?text=%E0%A4%A", "eo://word/find?text=a&b=c", "eo://word/find?q=a",
		"eo://word/find?text=" + "a".repeat(201), "eo://word/find?text=%00x",
		"eo://cell/Sales", "eo://cell/!A1", "eo://cell/Sales!", "eo://cell/Sales!A0", "eo://cell/Sales!ABCD1",
		"eo://cell/Sales!A1:B", "eo://cell/Sales!A1:B2:C3", "eo://cell/Sa%5Bles!A1", "eo://cell/" + "x".repeat(32) + "!A1",
		"eo://cell/Sales!A1;alert(1)", "eo://cell/Sales Data!A1", "eo://cell/a%2Fb!A1",
		"eo://slide/0", "eo://slide/x", "eo://slide/1/shape/0", "eo://slide/1/shape", "eo://slide/1/other/2",
		"eo://word/paragraph/1" + "1".repeat(1000)
	];
	for (const href of bad)
		assert.strictEqual(L.parse(href), null, String(href));
});

test("isLocationHref only matches the eo scheme", () => {
	assert.ok(L.isLocationHref("eo://word/paragraph/1"));
	assert.ok(L.isLocationHref("EO:whatever"));
	assert.ok(!L.isLocationHref("https://x"));
	assert.ok(!L.isLocationHref(null));
});

test("markdown-it keeps eo:// links and they parse after rendering", () => {
	const md = markdownit();
	const src = "See [§12](eo://word/paragraph/12), [“net 30”](eo://word/find?text=net%2030), " +
		"[Q1 Data!C5](eo://cell/Q1%20Data!C5), [Ü](eo://cell/%C3%9Cbersicht!A1:B2) and [slide 3](eo://slide/3/shape/1).";
	const html = md.render(src);
	const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
	assert.strictEqual(hrefs.length, 5, html);
	const parsed = hrefs.map(L.parse);
	assert.ok(parsed.every(Boolean), JSON.stringify(hrefs));
	assert.strictEqual(parsed[1].text, "net 30");
	assert.strictEqual(parsed[2].sheet, "Q1 Data");
	assert.strictEqual(parsed[3].sheet, "Übersicht");
	assert.strictEqual(parsed[4].shape, 1);
});

test("markdown-it still blocks javascript: links", () => {
	const html = markdownit().render("[x](javascript:alert(1))");
	assert.ok(!/href=/.test(html));
});

test("describe gives a short label", () => {
	assert.strictEqual(L.describe(L.parse("eo://cell/Sales!B2")), "Sales!B2");
	assert.strictEqual(L.describe(L.parse("eo://slide/3"), (s) => s === "Slide" ? "Folie" : s), "Folie 3");
	assert.strictEqual(L.describe(null), "");
});
