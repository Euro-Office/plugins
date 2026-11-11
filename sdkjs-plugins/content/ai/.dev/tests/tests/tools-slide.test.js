// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Layer 2 (slide): presentation tools against the in-memory Presentation API fake.

import { describe, test, expect } from "vitest";
import { createToolEnv, expectToolError } from "../lib/plugin.js";
import { createPresentation } from "../fakes/slide.js";

function slide(spec) {
	const fake = createPresentation(spec);
	const env = createToolEnv("slide", fake);
	return { ...env, pres: fake.pres, state: fake.state };
}

const DECK = {
	slides: [
		{ shapes: [{ text: "Welcome", placeholder: "title" }, { text: "Agenda\nBudget review" }], notes: "Say hello\nIntroduce team" },
		{ shapes: [{ text: "Budget 2026", placeholder: "title" }, { type: "image" }, "Costs are up"], notes: "" },
		{ shapes: ["Thanks"], notes: "Mention the budget again" }
	],
	current: 2
};

describe("readPresentation", () => {
	test("reads all slides with shapes, placeholders and text", async () => {
		const r = await slide(DECK).call("readPresentation");
		expect(r).toMatchObject({ totalSlides: 3, currentSlide: 2, hasMore: false });
		expect(r.slides[0]).toEqual({
			slideNumber: 1,
			shapes: [
				{ index: 1, type: "shape", placeholder: "title", text: "Welcome" },
				{ index: 2, type: "shape", text: "Agenda\nBudget review" }
			]
		});
		expect(r.slides[1].shapes[1]).toEqual({ index: 2, type: "image" });
	});

	test("currentSlideOnly, slideNumber and maxSlides", async () => {
		const env = slide(DECK);
		const cur = await env.call("readPresentation", { currentSlideOnly: true });
		expect(cur.slides.map((s) => s.slideNumber)).toEqual([2]);
		const one = await env.call("readPresentation", { slideNumber: 3 });
		expect(one.slides).toEqual([{ slideNumber: 3, shapes: [{ index: 1, type: "shape", text: "Thanks" }] }]);
		const capped = await env.call("readPresentation", { maxSlides: 2 });
		expect(capped.slides).toHaveLength(2);
		expect(capped.hasMore).toBe(true);
	});

	test("errors", async () => {
		const env = slide(DECK);
		await expectToolError(env.call("readPresentation", { slideNumber: 4 }), /Slide 4 not found\. The presentation has 3 slides/);
		await expectToolError(env.call("readPresentation", { slideNumber: 0 }), /"slideNumber" must be a number >= 1/);
	});
});

describe("replaceSelection (slide)", () => {
	test("pastes over the selected text", async () => {
		const env = slide({ ...DECK, selectedText: "Costs are up" });
		expect(await env.call("replaceSelection", { text: "Costs rose 4%" })).toEqual({ replacedCharacters: 12 });
		expect(env.state.pasted).toEqual(["Costs rose 4%"]);
	});

	test("requires a selection and a string", async () => {
		await expectToolError(slide(DECK).call("replaceSelection", { text: "x" }), /No text is selected/);
		await expectToolError(slide({ ...DECK, selectedText: "a" }).call("replaceSelection", { text: 1 }), /"text" is required/);
	});
});

describe("navigation", () => {
	test("goToSlide calls the GoToSlide plugin method", async () => {
		const env = slide(DECK);
		expect(await env.call("goToSlide", { slideNumber: 3 })).toEqual({ slideNumber: 3, totalSlides: 3 });
		expect(env.host.methodCalls("GoToSlide")[0].args).toEqual([3]);
		await expectToolError(env.call("goToSlide", { slideNumber: 4 }), /Slide 4 does not exist/);
		await expectToolError(env.call("goToSlide", {}), /"slideNumber"/);
	});

});
