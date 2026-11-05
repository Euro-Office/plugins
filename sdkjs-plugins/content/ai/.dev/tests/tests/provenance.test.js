// SPDX-License-Identifier: AGPL-3.0-only
//
// Layer 8: AI-content provenance (scripts/helpers/aiProvenance.js): image
// XMP marking, document properties, inline content-control marking, and its
// integration with the Library insert methods, tools and the agent loop.

import { describe, test, expect, beforeEach } from "vitest";
import zlib from "node:zlib";
import { JSDOM } from "jsdom";
import { createToolEnv } from "../lib/plugin.js";
import { createAgent, toolCall } from "../lib/agent.js";
import { createWordDocument } from "../fakes/word.js";
import { createWorkbook } from "../fakes/cell.js";
import { createPresentation } from "../fakes/slide.js";

const META = { action: "textToImage", provider: "OpenAI", model: "gpt-image-1" };
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const STORAGE_KEY = "onlyoffice_ai_provenance_enabled";

// Word env with a DOM (aiProvenance turns HTML into lines with it).
function env(editorType = "word", fake = createWordDocument({ body: ["x"] })) {
	const dom = new JSDOM("<!doctype html><body></body>");
	const e = createToolEnv(editorType, fake, { document: dom.window.document });
	return { ...e, P: e.ctx.AIProvenance, doc: fake.doc };
}

// ── image helpers ────────────────────────────────────────────────────────

function pngChunk(type, data) {
	const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
	const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
	return Buffer.concat([len, td, crc]);
}

const W = 4, H = 3;
const RAW = (() => {
	const raw = [];
	for (let y = 0; y < H; y++) {
		raw.push(0);
		for (let x = 0; x < W; x++) raw.push(x * 60, y * 80, 200, 255);
	}
	return Buffer.from(raw);
})();

function makePng(extra = []) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
	ihdr[8] = 8; ihdr[9] = 6;
	return Buffer.concat([PNG_SIG, pngChunk("IHDR", ihdr), ...extra,
		pngChunk("tEXt", Buffer.from("Comment\0existing metadata", "latin1")),
		pngChunk("IDAT", zlib.deflateSync(RAW)), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunks(buf) {
	expect(buf.subarray(0, 8).equals(PNG_SIG)).toBe(true);
	const chunks = [];
	let pos = 8;
	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString("latin1", pos + 4, pos + 8);
		const data = buf.subarray(pos + 8, pos + 8 + len);
		const crcOk = buf.readUInt32BE(pos + 8 + len) === zlib.crc32(buf.subarray(pos + 4, pos + 8 + len));
		chunks.push({ type, data, crcOk, start: pos, end: pos + 12 + len });
		pos += 12 + len;
	}
	expect(pos).toBe(buf.length);
	return chunks;
}

function seg(marker, payload) {
	const p = Buffer.from(payload);
	return Buffer.concat([Buffer.from([0xFF, marker, (p.length + 2) >> 8, (p.length + 2) & 0xFF]), p]);
}

// Structurally valid baseline JPEG (JFIF APP0 + Exif APP1 + tables + scan).
function makeJpeg(extraAfterSoi = []) {
	const tiff = Buffer.from([0x4D, 0x4D, 0x00, 0x2A, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0]);
	return Buffer.concat([
		Buffer.from([0xFF, 0xD8]),
		...extraAfterSoi,
		seg(0xE0, Buffer.concat([Buffer.from("JFIF\0", "latin1"), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])])),
		seg(0xE1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff])),
		seg(0xDB, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
		seg(0xC0, Buffer.from([8, 0, 6, 0, 8, 1, 1, 0x11, 0])),
		seg(0xC4, Buffer.concat([Buffer.from([0]), Buffer.from([1, ...Array(15).fill(0)]), Buffer.from([0])])),
		seg(0xDA, Buffer.from([1, 1, 0, 0, 0x3F, 0])),
		Buffer.from([0x00, 0x00, 0xFF, 0xD9])
	]);
}

function jpegSegments(buf) {
	expect(buf[0] === 0xFF && buf[1] === 0xD8).toBe(true);
	const segs = [];
	let pos = 2;
	while (pos < buf.length) {
		expect(buf[pos]).toBe(0xFF);
		const marker = buf[pos + 1];
		if (marker === 0xDA || marker === 0xD9) { segs.push({ marker, start: pos }); break; }
		const len = buf.readUInt16BE(pos + 2);
		segs.push({ marker, start: pos, len, data: buf.subarray(pos + 4, pos + 2 + len) });
		pos += 2 + len;
	}
	return segs;
}

const DST = 'Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"';

describe("markImage: PNG", () => {
	test("adds an XMP iTXt chunk after IHDR without touching anything else", () => {
		const { P } = env();
		const png = makePng();
		const res = P.markImageDetailed("data:image/png;base64," + png.toString("base64"), META);
		expect(res.status).toBe("marked");
		expect(res.data.startsWith("data:image/png;base64,")).toBe(true);
		const out = Buffer.from(res.data.slice(22), "base64");
		const chunks = pngChunks(out);
		expect(chunks.every((c) => c.crcOk)).toBe(true);
		expect(chunks.map((c) => c.type)).toEqual(["IHDR", "iTXt", "tEXt", "IDAT", "IEND"]);

		const itxt = chunks[1];
		const kwEnd = itxt.data.indexOf(0);
		expect(itxt.data.toString("latin1", 0, kwEnd)).toBe("XML:com.adobe.xmp");
		expect([...itxt.data.subarray(kwEnd, kwEnd + 5)]).toEqual([0, 0, 0, 0, 0]);
		const xmp = itxt.data.subarray(kwEnd + 5).toString("utf8");
		expect(xmp).toContain(DST);
		expect(xmp).toContain("OpenAI/gpt-image-1");
		expect(xmp.startsWith("<?xpacket")).toBe(true);

		// byte-identical once the new chunk is removed, pixels unchanged
		expect(Buffer.concat([out.subarray(0, itxt.start), out.subarray(itxt.end)]).equals(png)).toBe(true);
		expect(zlib.inflateSync(chunks.find((c) => c.type === "IDAT").data).equals(RAW)).toBe(true);
	});

	test("keeps bare base64 bare and is idempotent", () => {
		const { P } = env();
		const b64 = makePng().toString("base64");
		const bare = P.markImageDetailed(b64, META);
		expect(bare.status).toBe("marked");
		expect(bare.data.startsWith("data:")).toBe(false);
		const again = P.markImageDetailed(bare.data, META);
		expect(again).toEqual({ status: "skipped-existing-xmp", data: bare.data });
	});

	test("leaves images with a C2PA manifest untouched", () => {
		const { P } = env();
		const c2pa = makePng([pngChunk("caBX", Buffer.from("jumbf c2pa manifest"))]).toString("base64");
		expect(P.markImageDetailed(c2pa, META)).toEqual({ status: "skipped-c2pa", data: c2pa });
	});

	test("PNGs without a complete IHDR are not changed", () => {
		const { P } = env();
		const broken = makePng().subarray(0, 30).toString("base64");
		expect(P.markImageDetailed(broken, META)).toEqual({ status: "unsupported", data: broken });
		const noIhdr = Buffer.concat([PNG_SIG, pngChunk("tEXt", Buffer.from("a\0b".repeat(10), "latin1"))]).toString("base64");
		expect(P.markImageDetailed(noIhdr, META)).toEqual({ status: "invalid", data: noIhdr });
	});

	test("the CRC implementation matches zlib", () => {
		const { P } = env();
		for (const s of ["", "IEND", "iTXtXML:com.adobe.xmp", "x".repeat(1000)])
			expect(P._crc32(new Uint8Array(Buffer.from(s, "latin1"))) >>> 0).toBe(zlib.crc32(Buffer.from(s, "latin1")));
	});
});

describe("markImage: JPEG", () => {
	test("adds an XMP APP1 segment after JFIF and Exif", () => {
		const { P } = env();
		const jpg = makeJpeg();
		const res = P.markImageDetailed("data:image/jpeg;base64," + jpg.toString("base64"), META);
		expect(res.status).toBe("marked");
		const out = Buffer.from(res.data.split(",")[1], "base64");
		const segs = jpegSegments(out);
		expect(segs.map((s) => s.marker.toString(16))).toEqual(["e0", "e1", "e1", "db", "c0", "c4", "da"]);
		const xmpSeg = segs[2];
		expect(xmpSeg.data.toString("latin1", 0, 29)).toBe("http://ns.adobe.com/xap/1.0/\0");
		expect(xmpSeg.len).toBe(xmpSeg.data.length + 2);
		expect(xmpSeg.data.subarray(29).toString("utf8")).toContain(DST);
		expect(Buffer.concat([out.subarray(0, xmpSeg.start), out.subarray(xmpSeg.start + 2 + xmpSeg.len)]).equals(jpg)).toBe(true);
		expect(P.markImageDetailed(res.data, META).status).toBe("skipped-existing-xmp");
	});

	test("without leading APP segments the XMP goes right after SOI", () => {
		const { P } = env();
		const jpg = Buffer.concat([Buffer.from([0xFF, 0xD8]), seg(0xDB, Buffer.alloc(65)), Buffer.from([0xFF, 0xD9])]);
		const out = Buffer.from(P.markImage(jpg.toString("base64"), META), "base64");
		expect(jpegSegments(out).map((s) => s.marker.toString(16))).toEqual(["e1", "db", "d9"]);
	});

	test("leaves JPEGs with C2PA (APP11 JUMBF) untouched", () => {
		const { P } = env();
		const jpg = makeJpeg([seg(0xEB, Buffer.from("JP\0\0\0\0\0\0jumbc2pa", "latin1"))]).toString("base64");
		expect(P.markImageDetailed(jpg, META)).toEqual({ status: "skipped-c2pa", data: jpg });
	});
});

describe("markImage: other input", () => {
	test("GIF, SVG, URLs and non-base64 data URLs are returned unchanged", () => {
		const { P } = env();
		for (const input of [
			"data:image/gif;base64,R0lGODlhAQABAAAAACw=",
			"https://example.com/a.png",
			"data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64"),
			"data:image/png,%89PNG"
		])
			expect(P.markImage(input, META)).toBe(input);
		expect(P.markImageDetailed("", META).status).toBe("unsupported");
	});

	test("switched off -> untouched", () => {
		const { P, ctx } = env();
		ctx.localStorage.setItem(STORAGE_KEY, "false");
		expect(P.markImageDetailed(makePng().toString("base64"), META).status).toBe("disabled");
	});
});

describe("settings", () => {
	test("user switch, server default and server force", () => {
		const { P, ctx } = env();
		expect(P.isEnabled()).toBe(true);
		P.setUserEnabled(false);
		expect(P.isEnabled()).toBe(false);
		ctx.AI.serverSettings = { provenance: { enabled: true, force: true } };
		expect(P.isEnabled()).toBe(true);
		expect(P.isLocked()).toBe(true);
		ctx.AI.serverSettings = { provenance: { enabled: false } };
		ctx.localStorage.removeItem(STORAGE_KEY);
		expect(P.isEnabled()).toBe(false);
		P.setUserEnabled(true);
		expect(P.isEnabled()).toBe(true);
		expect(P.isLocked()).toBe(false);
		ctx.AI.serverSettings = { provenance: { enabled: false, force: true } };
		expect(P.isEnabled()).toBe(false);
	});

	test("spelling/grammar fixes are exempt, translations are not", () => {
		const { P } = env();
		for (const a of ["checkSpelling", "fixSpellingGrammar", "spellingAnnotation", "grammarAnnotation"])
			expect(P.isExempt(a)).toBe(true);
		for (const a of ["translate", "rewrite", "", undefined])
			expect(P.isExempt(a)).toBe(false);
	});

	test("labels, comment authors and alt text", () => {
		const { P } = env();
		expect(P.modelLabel({ provider: "OpenAI", model: "gpt-4o" })).toBe("OpenAI/gpt-4o");
		expect(P.modelLabel({ model: "local" })).toBe("local");
		expect(P.modelLabel({})).toBe("");
		expect(P.meta("rewrite", { modelUI: { provider: "Anthropic", id: "x", name: "X" }, model: { id: "claude-y" } })).toEqual({ action: "rewrite", provider: "Anthropic", model: "claude-y" });
		expect(P.commentAuthor({ model: "gpt-4o" })).toBe("AI Assistant (gpt-4o)");
		expect(P.commentAuthor(null)).toBe("AI Assistant");
		expect(P.altText({ model: "dall-e-3" })).toBe("AI-generated image (dall-e-3)");
		expect(P.altText({ action: "checkSpelling" })).toBeNull();
		expect(P.mergeModels("a; b", ["c", "A", " ", "d"])).toBe("a; b; c; d");
		const merged = P.mergeModels("", Array.from({ length: 40 }, (_, i) => "m" + i)).split("; ");
		expect(merged).toHaveLength(32);
		expect(merged[31]).toBe("m39");
	});
});

describe("record(): document properties through the editor", () => {
	test("word: properties written via callCommand, models deduplicated", async () => {
		const { P, doc, host } = env();
		doc.customProperties.Title = "kept";
		expect(await P.record({ action: "rewrite", provider: "OpenAI", model: "gpt-4o" })).toEqual({ ok: true });
		await P.record({ action: "translate", provider: "OpenAI", model: "gpt-4o" });
		await P.record({ action: "addImage", provider: "Anthropic", model: "claude-x", models: [{ provider: "OpenAI", model: "gpt-image-1" }, { provider: "openai", model: "GPT-4O" }] });
		expect(doc.customProperties).toMatchObject({
			Title: "kept",
			AIGenerated: true,
			AIGeneratedModels: "OpenAI/gpt-4o; Anthropic/claude-x; OpenAI/gpt-image-1",
			AIGeneratedPolicy: "EU AI Act Art. 50; machine-readable marking"
		});
		expect(doc.customProperties.AIGeneratedLastUpdate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(host.commandErrors).toEqual([]);
	});

	test("exempt and disabled actions write nothing", async () => {
		const { P, doc, ctx } = env();
		expect((await P.record({ action: "checkSpelling", model: "y" })).reason).toBe("exempt");
		ctx.localStorage.setItem(STORAGE_KEY, "false");
		expect((await P.record({ action: "rewrite", model: "y" })).reason).toBe("disabled");
		expect(doc.customProperties).toEqual({});
	});

	test("cell and slide use their own property owners", async () => {
		const wbFake = createWorkbook({ sheets: { S: [] } });
		wbFake.wb.customProperties.AIGeneratedModels = "Mistral/large";
		const cell = env("cell", wbFake);
		await cell.P.record({ action: "tool:writeRange", provider: "Mistral", model: "large" });
		expect(wbFake.wb.customProperties).toMatchObject({ AIGenerated: true, AIGeneratedModels: "Mistral/large" });

		const presFake = createPresentation({ slides: [{ shapes: [] }] });
		const slide = env("slide", presFake);
		await slide.P.record({ action: "setSpeakerNotes", provider: "", model: "local-model" });
		expect(presFake.pres.customProperties.AIGeneratedModels).toBe("local-model");
	});

	test("editors without custom properties are reported, not failed", async () => {
		const e = env("word", { Api: { GetDocument: () => ({}) } });
		expect(await e.P.record({ action: "rewrite", model: "b" })).toEqual({ ok: false, reason: "unsupported" });
		expect(e.sandbox.logs.some((l) => l.level === "warn" && /9\.0/.test(String(l.args[0])))).toBe(true);
	});

	test("runTool records non-readOnly tools with every model used inside", async () => {
		const { P, doc } = env();
		const chat = { modelUI: { provider: "OpenAI", id: "gpt-4o", name: "GPT-4o" }, model: { id: "gpt-4o" } };
		const img = { modelUI: { provider: "OpenAI", id: "dall-e-3", name: "DALL-E 3" }, model: null };
		await P.runTool("readDocument", true, chat, async () => { P.noteRequest(chat); });
		expect(doc.customProperties.AIGenerated).toBeUndefined();
		let inner;
		await P.runTool("addImage", false, chat, async () => { inner = P.scopeMeta("x"); P.noteRequest(img); });
		expect(inner).toEqual({ action: "addImage", provider: "OpenAI", model: "gpt-4o" });
		expect(doc.customProperties.AIGeneratedModels).toBe("OpenAI/gpt-4o; OpenAI/dall-e-3");
		expect(P.scopeMeta("outside")).toEqual({ action: "outside", provider: "", model: "" });
		await expect(P.runTool("editParagraph", false, chat, async () => { throw new Error("tool failed"); })).rejects.toThrow("tool failed");
		expect(P.scopeMeta("x").action).toBe("x"); // scope closed after a failure
	});
});

describe("text marking (captureAnchor / markInsertion)", () => {
	const M = { action: "rewrite", provider: "OpenAI", model: "gpt-4o" };
	const marks = (doc) => doc.controls().map((c) => c.GetText());

	test("partial replacement inside a paragraph marks only the new words", async () => {
		const { P, doc } = env("word", createWordDocument({ body: ["Intro", "Hello world foo", "End"], selection: { paragraph: 2, start: 6, end: 11 } }));
		const anchor = await P.captureAnchor(M);
		doc.elements[1]._replace(6, 11, "planet");
		const r = await P.markInsertion(anchor, { text: "planet" });
		expect(r).toEqual({ marked: 1, skipped: 0 });
		expect(marks(doc)).toEqual(["planet"]);
		expect(doc.controls()[0].GetAlias()).toMatch(/^AI-generated \(gpt-4o, \d{4}-\d{2}-\d{2}\)$/);
		expect(doc.texts()).toEqual(["Intro", "Hello planet foo", "End"]);
		expect(doc.selection).toBeNull();
	});

	test("a whole paragraph replaced by three marks each new paragraph", async () => {
		const fake = createWordDocument({ body: ["Intro", "Old text", "End"], selection: { paragraph: 2 } });
		const { P, doc } = env("word", fake);
		const anchor = await P.captureAnchor(M);
		const { Paragraph } = await import("../fakes/word.js");
		doc.elements[1]._replace(0, 8, "One");
		doc.AddElement(2, new Paragraph("Two"));
		doc.AddElement(3, new Paragraph("Three"));
		expect(await P.markInsertion(anchor, { text: "One\nTwo\nThree" })).toEqual({ marked: 3, skipped: 0 });
		expect(marks(doc)).toEqual(["One", "Two", "Three"]);
		expect(marks(doc).includes("Intro") || marks(doc).includes("End")).toBe(false);
	});

	test("an HTML insertion at the cursor skips the unchanged cursor paragraph and empty lines", async () => {
		const { P, doc, call } = env("word", createWordDocument({ body: ["Title", "Existing"], cursor: 2 }));
		// insertMarkdown pastes after the cursor paragraph (PasteHtml in the fake)
		await call("insertMarkdown", { markdown: "Heading\n\nBody text" });
		expect(doc.texts()).toEqual(["Title", "Existing", "Heading", "Body text"]);
		expect(marks(doc)).toEqual(["Heading", "Body text"]);
	});

	test("ambiguous matches are left unmarked and reported", async () => {
		const { P, doc } = env("word", createWordDocument({ body: ["the cat and the dog"], selection: { paragraph: 1, start: 16, end: 19 } }));
		const anchor = await P.captureAnchor(M);
		doc.elements[0]._replace(16, 19, "the");
		expect(await P.markInsertion(anchor, { text: "the" })).toEqual({ marked: 0, skipped: 1 });
		expect(marks(doc)).toEqual([]);
	});

	test("no anchor for exempt actions, form generation, other editors or when disabled", async () => {
		const { P, ctx } = env("word", createWordDocument({ body: ["a"], cursor: 1 }));
		expect(await P.captureAnchor({ action: "fixSpellingGrammar" })).toBeNull();
		expect(await P.captureAnchor({ action: "generateForm" })).toBeNull();
		expect(P.cc({ action: "checkSpelling" })).toBeNull();
		ctx.localStorage.setItem(STORAGE_KEY, "false");
		expect(await P.captureAnchor(M)).toBeNull();
		expect(await P.markInsertion(null, { text: "x" })).toEqual({ marked: 0, skipped: 0, reason: "no-anchor" });
		const cell = env("cell", createWorkbook({ sheets: { S: [] } }));
		expect(await cell.P.captureAnchor(M)).toBeNull();
		expect(cell.P.cc(M)).toBeNull();
	});
});

describe("Library insert methods with provenance metadata", () => {
	const M = { action: "summarization", provider: "OpenAI", model: "gpt-4o" };

	test("InsertAsText appends a hidden block control and records the action", async () => {
		const { ctx, doc } = env("word", createWordDocument({ body: ["Text"] }));
		await ctx.Asc.Library.InsertAsText("Summary:\n\nPoint one", M);
		expect(doc.texts()).toEqual(["Text", "Summary:\r\nPoint one"]);
		const block = doc.elements[1];
		expect([block.GetClassType(), block.GetTag(), block.appearance]).toEqual(["blockLvlSdt", "ai-generated", "hidden"]);
		expect(doc.customProperties.AIGeneratedModels).toBe("OpenAI/gpt-4o");
	});

	test("without metadata nothing is marked or recorded", async () => {
		const { ctx, doc } = env("word", createWordDocument({ body: ["Text"], selection: { paragraph: 1 } }));
		await ctx.Asc.Library.InsertAsText("Plain");
		await ctx.Asc.Library.ReplaceTextSmart(["New"]);
		expect(doc.controls()).toEqual([]);
		expect(doc.customProperties).toEqual({});
	});

	test("ReplaceTextSmart marks the replacement and records it", async () => {
		const { ctx, doc } = env("word", createWordDocument({ body: ["Hello world"], selection: { paragraph: 1, start: 6, end: 11 } }));
		await ctx.Asc.Library.ReplaceTextSmart(["there"], { action: "chat:replace", provider: "P", model: "m" });
		expect(doc.controls().map((c) => c.GetText())).toEqual(["there"]);
		expect(doc.customProperties.AIGeneratedModels).toBe("P/m");
	});

	test("InsertAsComment authors the comment as the AI with its model", async () => {
		const { ctx, doc } = env("word", createWordDocument({ body: ["x"] }));
		await ctx.Asc.Library.InsertAsComment("Looks good", { action: "chat:comment", provider: "P", model: "m" });
		expect(doc.comments[0].GetAuthorName()).toBe("AI Assistant (m)");
		expect(doc.customProperties.AIGenerated).toBe(true);
	});
});

describe("findAIContent tool", () => {
	test("lists marked parts with model, date and element index plus file-level properties", async () => {
		const e = env("word", createWordDocument({ body: ["Keep", "Old one", "Old two"] }));
		const chat = { modelUI: { provider: "OpenAI", id: "gpt-4o", name: "GPT-4o" }, model: { id: "gpt-4o" } };
		await e.P.runTool("editParagraph", false, chat, () => e.call("editParagraph", { index: 3, action: "replace", text: "New two" }));
		const r = await e.call("findAIContent");
		expect(r.fileLevel).toMatchObject({ AIGenerated: true, AIGeneratedModels: "OpenAI/gpt-4o" });
		expect(r).toMatchObject({ markedParts: 1, markedCharacters: 7, returned: 1 });
		expect(r.parts[0]).toMatchObject({ number: 1, kind: "inline", model: "gpt-4o", index: 3, snippet: "New two", characters: 7 });
		expect(r.parts[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(r.note).toBeUndefined();
	});

	test("explains when nothing is marked", async () => {
		const r = await env("word", createWordDocument({ body: ["x"] })).call("findAIContent");
		expect(r).toMatchObject({ markedParts: 0, parts: [], fileLevel: { AIGenerated: null } });
		expect(r.note).toMatch(/No marked AI-generated text found/);
	});
});

describe("agent loop records AI edits", () => {
	let agent;
	beforeEach(async () => {
		agent = await createAgent({ editorType: "word", fake: createWordDocument({ body: ["Hello world", "Second"], selection: { paragraph: 1, start: 0, end: 5 } }) });
	});

	test("read-only tools leave the file unmarked", async () => {
		agent.engine.queue.push({ tool_calls: [toolCall("c1", "readDocument", {}), toolCall("c2", "findAIContent", {})] });
		await agent.send("Read");
		expect(agent.fake.doc.customProperties).toEqual({});
	});

	test("editing tools mark the text and record the agent's model", async () => {
		agent.engine.queue.push({ tool_calls: [toolCall("c1", "replaceSelection", { text: "Howdy" }), toolCall("c2", "replyToComment", { commentId: "x", text: "y" })] });
		await agent.send("Change");
		const doc = agent.fake.doc;
		expect(doc.texts()[0]).toBe("Howdy world");
		expect(doc.controls().map((c) => [c.GetText(), c.GetAlias().replace(/\d{4}-\d{2}-\d{2}/, "DATE")])).toEqual([["Howdy", "AI-generated (fake-1, DATE)"]]);
		expect(doc.customProperties.AIGeneratedModels).toBe("FakeProvider/fake-1");
	});

	test("prompt-based calls are recorded too", async () => {
		const a = await createAgent({ editorType: "word", supportsTools: false, fake: createWordDocument({ body: ["one", "two"] }) });
		a.engine.queue.push({ content: '[functionCalling (editParagraph)]: {"index": 2, "action": "replace", "text": "zwei"}' });
		await a.send("Translate");
		expect(a.fake.doc.controls().map((c) => c.GetText())).toEqual(["zwei"]);
		expect(a.fake.doc.customProperties.AIGeneratedModels).toBe("FakeProvider/fake-1");
	});

	test("chat 'replace' button marks and records with the chat model", async () => {
		await agent.win.fire("onChatReplace", { type: "replace", data: "Bye" });
		expect(agent.fake.doc.controls().map((c) => c.GetText())).toEqual(["Bye"]);
		expect(agent.fake.doc.customProperties.AIGeneratedModels).toBe("FakeProvider/fake-1");
	});
});
