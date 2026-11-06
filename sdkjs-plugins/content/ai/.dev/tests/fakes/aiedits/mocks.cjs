// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
const { createContext, load, run } = require("./harness.cjs");

// Mock of the word builder API parts used by aiEdits.js, following the
// semantics in Euro-Office/sdkjs word/apiBuilder.js (SetAssistantTrackRevisions
// keeps one global buffer).
function wordApi(ctx, state) {
	state = Object.assign({ track: false, user: "User", revisions: [], selection: null, calls: [] }, state || {});
	let buffer = { isTrack: false, user: "" };
	// Euro-Office sdkjs 9.3 common/editorscommon.js: setUserColorById caches
	// { Light, Dark } only, getUserColorById(id, name, false, true) then
	// reads .r of the missing "Normal" colour.
	const colors = {};
	ctx.AscCommon = {
		setUserColorById: function(id, light, dark) { colors[id] = { Light: light, Dark: dark }; },
		getUserColorById: (id, name, isDark, isNumeric) => {
			let c = (colors[id] || { Normal: { r: 1, g: 2, b: 3 } }).Normal;
			return isNumeric ? (c.r << 16) | (c.g << 8) | c.b : c;
		}
	};
	function para(id) {
		return { GetInternalId: () => id, Select: () => { state.selection = id; state.calls.push("select:" + id); } };
	}
	const doc = {
		IsTrackRevisions: () => state.track,
		SetTrackRevisions: (v) => { state.calls.push("SetTrackRevisions:" + v); state.track = !!v; return true; },
		SetAssistantTrackRevisions: (v, name) => {
			state.calls.push("SetAssistantTrackRevisions:" + v + (name ? ":" + name : ""));
			if (v) {
				buffer.isTrack = state.track; buffer.user = state.user; state.track = true; state.user = name;
				ctx.AscCommon.setUserColorById("uid-" + name, { r: 8, g: 145, b: 178 }, { r: 8, g: 145, b: 178 });
			}
			else { state.track = buffer.isTrack; state.user = buffer.user; }
			return true;
		},
		GetReviewReport: () => {
			let res = {};
			state.revisions.forEach((r) => {
				(res[r.author] = res[r.author] || []).push({ Type: r.Type, Value: r.Value, Date: r.Date, ReviewedElement: para(r.para) });
			});
			res.ToJSON = function() {};
			return res;
		}
	};
	if (state.noAssistant)
		delete doc.SetAssistantTrackRevisions;
	ctx.Api = { GetDocument: () => doc };
	function resolveSelection(kind) {
		state.calls.push(kind + ":" + state.selection);
		state.revisions = state.revisions.filter((r) => r.para !== state.selection);
	}
	ctx.methodHandlers.AcceptReviewChanges = (all) => resolveSelection("accept");
	ctx.methodHandlers.RejectReviewChanges = (all) => resolveSelection("reject");
	// A write adds one revision by the current author when tracking is on.
	state.write = function(para, text) {
		if (state.track)
			state.revisions.push({ author: state.user, Type: "TextAdd", Value: text, Date: 1000 + state.revisions.length, para: para });
	};
	return state;
}

// Undo stack mock (CanUndo/Undo exist in word only: word/api_plugins.js).
function undoStack(ctx, supported) {
	const s = { depth: 0, undone: 0, groups: 0 };
	ctx.methodHandlers.StartAction = (type) => { if (type === "GroupActions") s.groups++; };
	ctx.methodHandlers.EndAction = (type) => { if (type === "GroupActions") s.depth++; };
	if (supported) {
		ctx.methodHandlers.CanUndo = () => s.depth > 0;
		ctx.methodHandlers.Undo = () => { s.depth--; s.undone++; };
	}
	return s;
}

function baseContext(editorType) {
	const ctx = createContext({ editorType: editorType });
	ctx.HELPERS = { word: [], cell: [], slide: [], names: { word: {}, cell: {}, slide: {} } };
	ctx.Asc.Library = {
		GetSelectedText: async () => ctx.selectedText || "",
		PasteText: async (t) => { ctx.log.push(["paste", t]); return true; }
	};
	load(ctx, "scripts/helpers/helperFuncs.js");
	load(ctx, "scripts/helpers/toolCategories.js");
	load(ctx, "scripts/engine/aiEdits.js");
	load(ctx, "scripts/engine/toolApproval.js");
	load(ctx, "scripts/helpers/toolPreviews.js");
	return ctx;
}

function addTool(ctx, editorType, def, impl) {
	let f = new ctx.RegisteredFunction(def);
	f.call = impl;
	ctx.HELPERS[editorType].push(f);
	return f;
}

// Chat window mock. respond(data) decides the answer to approval requests.
function chatWindow(ctx, respond) {
	const win = { commands: [], command(name, data) {
		this.commands.push([name, data]);
		if (name === "onToolApprovalRequest" && respond)
			setTimeout(() => ctx.ToolApproval.respond({ id: data.id, decision: respond(data) }, false), 0);
	} };
	return win;
}

function installChatWindowShow(ctx, respond, canOpen) {
	ctx.chatWindowShowCalls = 0;
	ctx.chatWindowShow = function() {
		ctx.chatWindowShowCalls++;
		if (ctx.chatWindow)
			return;
		if (canOpen === false)
			return; // e.g. no chat model configured
		const win = chatWindow(ctx, respond);
		ctx.ToolApproval.bindWindow(win);
		ctx.chatWindow = win;
		setTimeout(() => ctx.ToolApproval.setWindowReady(win), 5);
	};
}

module.exports = { wordApi, undoStack, baseContext, addTool, chatWindow, installChatWindowShow, run };
