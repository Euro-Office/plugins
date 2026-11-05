// SPDX-License-Identifier: AGPL-3.0-only
//
// AI edits as tracked changes, per-turn accept/reject and undo (scripts/engine/aiEdits.js)
// (ported from the mock tests that came with the feature).

import { test } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../fakes/aiedits/mocks.cjs");


function setup(opts) {
	opts = opts || {};
	const ctx = M.baseContext(opts.editorType || "word");
	const doc = M.wordApi(ctx, opts.doc);
	const stack = M.undoStack(ctx, opts.undo !== false);
	return { ctx, doc, stack, E: ctx.AIEdits };
}


	test("success: tracking on for the write with AI author, restored afterwards", async () => {
		const { doc, E } = setup();
		await E.runTool("writeThing", false, async () => doc.write(1, "a"), { engine: { modelUI: { name: "gpt-x" } } });
		assert.strictEqual(doc.track, false);
		assert.strictEqual(doc.user, "User");
		assert.strictEqual(doc.revisions[0].author, "AI (gpt-x)");
		assert.deepStrictEqual(doc.calls, ["SetAssistantTrackRevisions:true:AI (gpt-x)", "SetAssistantTrackRevisions:false"]);
	});

	test("error: restored and the error propagates; group still ended", async () => {
		const { doc, stack, E } = setup();
		await assert.rejects(E.runTool("w", false, async () => { doc.write(1, "a"); throw new Error("x"); }), /x/);
		assert.strictEqual(doc.track, false);
		assert.strictEqual(doc.user, "User");
		assert.strictEqual(stack.groups, 1);
		assert.strictEqual(stack.depth, 1);
	});

	test("stop: a turn whose handler aborts still restores tracking and reports the summary", async () => {
		const { ctx, doc, E } = setup();
		const win = { commands: [], command(n, d) { this.commands.push([n, d]); } };
		const handler = E.wrapChatHandler(() => win, async function() {
			await E.runTool("w", false, async () => doc.write(1, "a"));
			throw new Error("stopped");
		});
		await assert.rejects(handler([]), /stopped/);
		assert.strictEqual(doc.track, false);
		const s = win.commands.find((c) => c[0] === "onAIEditsSummary");
		assert.ok(s, "summary sent");
		assert.strictEqual(s[1].steps, 1);
		assert.strictEqual(s[1].revisionCount, 1);
	});

	test("tracking already on: left untouched, revisions under the user's name", async () => {
		const { doc, E } = setup({ doc: { track: true } });
		await E.runTool("w", false, async () => doc.write(1, "a"));
		assert.deepStrictEqual(doc.calls, []);
		assert.strictEqual(doc.track, true);
		assert.strictEqual(doc.revisions[0].author, "User");
	});

	test("tool that switches tracking itself (checkSpelling): plain SetTrackRevisions", async () => {
		const { doc, E } = setup();
		await E.runTool("checkSpelling", false, async () => doc.write(1, "a"));
		assert.deepStrictEqual(doc.calls, ["SetTrackRevisions:true", "SetTrackRevisions:false"]);
		assert.strictEqual(doc.user, "User");
	});

	test("no SetAssistantTrackRevisions (older editor): plain SetTrackRevisions", async () => {
		const { doc, E } = setup({ doc: { noAssistant: true } });
		await E.runTool("w", false, async () => doc.write(1, "a"));
		assert.deepStrictEqual(doc.calls, ["SetTrackRevisions:true", "SetTrackRevisions:false"]);
	});

	test("setting off / server force / non-word editors: no tracking", async () => {
		let s = setup();
		s.E.setUserTrackChanges(false);
		await s.E.runTool("w", false, async () => s.doc.write(1, "a"));
		assert.deepStrictEqual(s.doc.calls, []);

		s = setup();
		s.ctx.AI = { serverSettings: { review: { trackChanges: false, force: true } } };
		s.E.setUserTrackChanges(true);
		assert.strictEqual(s.E.isLocked(), true);
		assert.strictEqual(s.E.isTrackChangesEnabled(), false);
		s.ctx.AI.serverSettings.review = { trackChanges: false };
		assert.strictEqual(s.E.isTrackChangesEnabled(), true, "user choice wins without force");
		s.ctx.localStorage.removeItem(s.E.STORAGE_KEY);
		assert.strictEqual(s.E.isTrackChangesEnabled(), false, "server default without user choice");

		s = setup({ editorType: "cell" });
		await s.E.runTool("w", false, async () => {});
		assert.deepStrictEqual(s.doc.calls, []);
		assert.strictEqual(s.stack.groups, 1, "still one undo step");
	});

	test("readOnly tools are neither grouped nor tracked; nested writes join the outer group", async () => {
		const { ctx, doc, stack, E } = setup();
		await E.runTool("r", true, async () => {});
		assert.strictEqual(stack.groups, 0);
		await E.runTool("w", false, async () => { await ctx.Asc.Library.PasteText("x"); doc.write(1, "a"); });
		assert.strictEqual(stack.groups, 1, "patched Library.PasteText joined the tool's group");
		assert.strictEqual(doc.calls.length, 2);
	});


	test("diffSignatures / intersectSignatures are multiset operations", async () => {
		const { E } = setup();
		const j = (v) => JSON.stringify(v);
		assert.strictEqual(j(E.diffSignatures(["a", "a", "b", "c"], ["a", "b"])), j(["a", "c"]));
		assert.strictEqual(j(E.diffSignatures(["a"], null)), j(["a"]));
		assert.strictEqual(j(E.intersectSignatures(["a", "a", "x"], ["a", "b"])), j(["a"]));
	});

	test("turn summary counts only the revisions created in the turn", async () => {
		const { doc, E } = setup({ doc: { revisions: [{ author: "Bob", Type: "TextAdd", Value: "old", Date: 1, para: 9 }] } });
		const turn = E.beginTurn();
		await E.runTool("w", false, async () => { doc.write(1, "a"); doc.write(2, "b"); });
		await E.runTool("w", false, async () => doc.write(3, "c"));
		const info = await E.endTurn(turn);
		assert.strictEqual(info.steps, 2);
		assert.strictEqual(info.revisionCount, 3);
		assert.strictEqual(info.canUndo, true);
		assert.strictEqual(info.undoAvailable, true);
	});

	test("reject all: only paragraphs with this turn's revisions; shared paragraphs are reported", async () => {
		const { doc, E } = setup({ doc: { revisions: [
			{ author: "Bob", Type: "TextAdd", Value: "bob1", Date: 1, para: 9 },
			{ author: "Bob", Type: "TextAdd", Value: "bob2", Date: 2, para: 2 }
		] } });
		const turn = E.beginTurn();
		await E.runTool("w", false, async () => { doc.write(1, "a"); doc.write(2, "b"); doc.write(3, "c"); });
		await E.endTurn(turn);
		const res = await E.performAction(turn.id, "reject");
		assert.strictEqual(res.processed, 2);
		assert.strictEqual(res.left, 1, "paragraph 2 also holds Bob's change");
		assert.ok(doc.calls.includes("reject:1") && doc.calls.includes("reject:3"));
		assert.ok(!doc.calls.includes("reject:2") && !doc.calls.includes("reject:9"));
		assert.deepStrictEqual(doc.revisions.map((r) => r.Value).sort(), ["b", "bob1", "bob2"]);
		assert.strictEqual(res.summary.undoAvailable, false, "accept/reject adds undo steps: undo disabled");
	});

	test("accept all when nothing is shared", async () => {
		const { doc, E } = setup();
		const turn = E.beginTurn();
		await E.runTool("w", false, async () => { doc.write(1, "a"); doc.write(1, "b"); });
		await E.endTurn(turn);
		const res = await E.performAction(turn.id, "accept");
		assert.strictEqual(res.ok, true);
		assert.strictEqual(res.left, 0);
		assert.deepStrictEqual(doc.revisions, []);
	});


	test("undo runs Undo once per grouped step of the turn", async () => {
		const { doc, stack, E } = setup();
		stack.depth = 3; // earlier user actions
		const turn = E.beginTurn();
		await E.runTool("w", false, async () => doc.write(1, "a"));
		await E.runTool("w", false, async () => doc.write(1, "b"));
		await E.endTurn(turn);
		const res = await E.performAction(turn.id, "undo");
		assert.strictEqual(res.ok, true);
		assert.strictEqual(stack.undone, 2);
		assert.strictEqual(stack.depth, 3, "user steps untouched");
	});

	test("undo refused after a later AI write (one-shot Library write)", async () => {
		const { ctx, doc, stack, E } = setup();
		const turn = E.beginTurn();
		await E.runTool("w", false, async () => doc.write(1, "a"));
		await E.endTurn(turn);
		await ctx.Asc.Library.PasteText("later");
		const res = await E.performAction(turn.id, "undo");
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.reason, "stale");
		assert.strictEqual(stack.undone, 0);
	});

	test("spreadsheet: no Undo plugin method -> canUndo false (Ctrl+Z hint)", async () => {
		const { E } = setup({ editorType: "cell", undo: false });
		const turn = E.beginTurn();
		await E.runTool("w", false, async () => {});
		const info = await E.endTurn(turn);
		assert.strictEqual(info.canUndo, false);
		assert.strictEqual(info.steps, 1);
		const res = await E.performAction(turn.id, "undo");
		assert.strictEqual(res.reason, "unsupported");
	});

	test("turn without writes: no summary", async () => {
		const { E } = setup();
		const turn = E.beginTurn();
		await E.runTool("r", true, async () => {});
		assert.strictEqual(await E.endTurn(turn), null);
	});

