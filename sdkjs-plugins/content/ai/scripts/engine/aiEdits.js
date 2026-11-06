// SPDX-License-Identifier: AGPL-3.0-only

// Review and undo of document changes made by the AI.
//
// 1. One undo step per write. Every tool call that is not readOnly (chat
//    agent and "ai_onCallTool") and every one-shot write through Asc.Library
//    (context menu, chat insert/replace buttons, summarization window) runs
//    inside StartAction/EndAction "GroupActions", so it is a single undo
//    step. A whole agent turn is NOT one group: startGroupActions sets a
//    global lock on the document (sdkjs common/apiBase.js,
//    baseEditorsApi.prototype.startGroupActions: CollaborativeEditing.
//    Set_GlobalLock(true)) and the turn spans model requests and approval
//    prompts, which would freeze the editor for the user for that long.
//    A turn therefore consists of N grouped steps and "Undo AI changes"
//    undoes exactly those N steps. For the same reason a tool's model request
//    releases the open groups while it waits (AI.Request._wrapRequest).
//
// 2. Tracked changes (text documents only). With "Record AI edits as tracked
//    changes" on (default; localStorage, or AI.serverSettings.review, see
//    below) track revisions are switched on for each AI write if they were
//    off, and switched back afterwards (try/finally, also on errors and when
//    the agent is stopped: a running tool is always finished first).
//    Revisions are attributed to the author "AI (model)" with
//    ApiDocument.SetAssistantTrackRevisions where it exists (word/apiBuilder.js),
//    but only if tracking was off before: that method keeps the previous
//    state in a single global buffer and restores the *global* tracking flag,
//    so using it while the user already tracks changes (possibly only locally)
//    could leave tracking switched on for every co-author. In that case, and
//    for tools that switch tracking themselves (checkSpelling), the changes are
//    tracked under the user's name.
//
// 3. Per-turn review. Before the first write of a turn and after the turn the
//    tracked changes are snapshotted (ApiDocument.GetReviewReport); the
//    difference identifies the revisions created in that turn. "Accept all" /
//    "Reject all" select each paragraph/table holding only such revisions and
//    call the plugin methods AcceptReviewChanges/RejectReviewChanges(false)
//    (by selection). There is no API to accept a single revision, so
//    revisions that share a paragraph with other tracked changes are left for
//    the review pane and reported.
//
// 4. "Undo AI changes" uses the plugin methods CanUndo/Undo (word only:
//    word/api_plugins.js, since 8.2.0). Spreadsheet and presentation editors
//    do not expose Undo to plugins, so the chat shows how many Ctrl+Z steps the
//    turn took instead. User edits cannot be detected via the plugin API:
//    there is no document-changed event or undo-stack position for plugins
//    (sdkjs word/api_plugins.js CanUndo/Undo only, common/plugins.js events;
//    "onKeyDown" misses mouse, toolbar and co-author edits). The document
//    stays editable during a turn, so Undo may also undo what the user typed
//    DURING or after the turn. Undo is refused when the plugin itself wrote
//    something afterwards, and the button tooltip warns about the rest;
//    Accept/Reject (scoped by the revision snapshot) is the safer path.
//
// Server settings (read only):
//   "review": { "trackChanges": true|false, "force": true|false }
// "trackChanges" is the default for users; with "force": true it is enforced
// and the user setting is ignored.
(function(root) {

	const STORAGE_KEY = "onlyoffice_ai_review_track_changes";
	const DEFAULT_AUTHOR = "AI";
	// Tools that switch track changes / the revision author themselves.
	const OWN_TRACKING_TOOLS = { "checkSpelling": true };

	// Asc.Library methods that write AI text into the document. Wrapped so
	// that each call is one undo step and recorded as tracked changes.
	const LIBRARY_TRACKED = ["ReplaceTextSmart", "InsertAsText", "InsertAsHTML", "InsertAsMD", "PasteText", "InsertAsHyperlink"];
	// Already inserts as a tracked change itself: grouped only.
	const LIBRARY_GROUP_ONLY = ["InsertAsReview"];

	let depth = 0;
	let writeSeq = 0;
	let turnCounter = 0;
	let turns = {};
	let currentTurn = null;
	let undoSupport = null;

	// ── Settings ───────────────────────────────────────────────────────────

	function serverConfig() {
		let AI = root.AI;
		let cfg = AI && AI.serverSettings ? AI.serverSettings.review : null;
		return (cfg && typeof cfg === "object") ? cfg : null;
	}

	function isLocked() {
		let cfg = serverConfig();
		return !!(cfg && cfg.force === true && typeof cfg.trackChanges === "boolean");
	}

	function readUserSetting() {
		try {
			let value = root.localStorage.getItem(STORAGE_KEY);
			if (value === "true")
				return true;
			if (value === "false")
				return false;
		} catch (e) {}
		return null;
	}

	function isTrackChangesEnabled() {
		let cfg = serverConfig();
		if (isLocked())
			return cfg.trackChanges;
		let user = readUserSetting();
		if (user !== null)
			return user;
		if (cfg && typeof cfg.trackChanges === "boolean")
			return cfg.trackChanges;
		return true;
	}

	function setUserTrackChanges(value) {
		try {
			root.localStorage.setItem(STORAGE_KEY, value ? "true" : "false");
		} catch (e) {}
	}

	// ── Editor access ──────────────────────────────────────────────────────

	function editorType() {
		try {
			return root.Asc.Editor.getType();
		} catch (e) {
			return "";
		}
	}

	function isTrackingSupported() {
		return editorType() === "word";
	}

	function callCommand(fn) {
		return root.Asc.Editor.callCommand(fn);
	}

	function callMethod(name, args) {
		return root.Asc.Editor.callMethod(name, args || []);
	}

	function scope() {
		root.Asc.scope = root.Asc.scope || {};
		return root.Asc.scope;
	}

	// Plugin methods that do not exist in an editor return undefined
	// (common/plugins.js, callMethodInternal), so a boolean means "supported".
	async function detectUndoSupport() {
		if (undoSupport !== null)
			return undoSupport;
		try {
			let can = await callMethod("CanUndo");
			undoSupport = (typeof can === "boolean");
		} catch (e) {
			undoSupport = false;
		}
		return undoSupport;
	}

	// ── Tracked changes for one write ──────────────────────────────────────

	// Returns the state needed to restore tracking, or null.
	async function enableTracking(author) {
		scope().aiEditsAuthor = author || "";
		return await callCommand(function() {
			let doc = Api.GetDocument();
			if (!doc || typeof doc.IsTrackRevisions !== "function" || typeof doc.SetTrackRevisions !== "function")
				return { supported: false };
			if (doc.IsTrackRevisions())
				return { supported: true, mode: "none" };
			let author = Asc.scope.aiEditsAuthor;
			if (author && typeof doc.SetAssistantTrackRevisions === "function") {
				doc.SetAssistantTrackRevisions(true, author);
				return { supported: true, mode: "assistant" };
			}
			doc.SetTrackRevisions(true);
			return { supported: true, mode: "plain" };
		});
	}

	async function restoreTracking(state) {
		if (!state || !state.supported || state.mode === "none")
			return;
		scope().aiEditsRestoreMode = state.mode;
		await callCommand(function() {
			let doc = Api.GetDocument();
			if (Asc.scope.aiEditsRestoreMode === "assistant")
				doc.SetAssistantTrackRevisions(false);
			else
				doc.SetTrackRevisions(false);
		});
	}

	// ── Revision snapshots ─────────────────────────────────────────────────

	// Signatures "author␟type␟value␟date" of every tracked change, or null if
	// GetReviewReport is not available.
	async function snapshotRevisions() {
		if (!isTrackingSupported())
			return null;
		try {
			return await callCommand(function() {
				let doc = Api.GetDocument();
				if (!doc || typeof doc.GetReviewReport !== "function")
					return null;
				let report = doc.GetReviewReport() || {};
				let out = [];
				for (let author in report) {
					let list = report[author];
					if (list && !Array.isArray(list) && typeof list === "object")
						list = list.reviews;
					if (!Array.isArray(list))
						continue;
					for (let i = 0; i < list.length; i++) {
						let r = list[i] || {};
						out.push([author, r.Type || "", r.Value === undefined || r.Value === null ? "" : String(r.Value), r.Date === undefined || r.Date === null ? "" : String(r.Date)].join("\u001f"));
					}
				}
				return out;
			});
		} catch (e) {
			console.warn("Could not read the tracked changes:", e);
			return null;
		}
	}

	// Multiset difference after - before.
	function diffSignatures(after, before) {
		let counts = Object.create(null);
		(before || []).forEach(function(s) { counts[s] = (counts[s] || 0) + 1; });
		let added = [];
		(after || []).forEach(function(s) {
			if (counts[s] > 0)
				counts[s]--;
			else
				added.push(s);
		});
		return added;
	}

	// Multiset intersection: the signatures of `wanted` still present in `current`.
	function intersectSignatures(wanted, current) {
		let counts = Object.create(null);
		(current || []).forEach(function(s) { counts[s] = (counts[s] || 0) + 1; });
		let present = [];
		(wanted || []).forEach(function(s) {
			if (counts[s] > 0) {
				counts[s]--;
				present.push(s);
			}
		});
		return present;
	}

	// ── Writes ─────────────────────────────────────────────────────────────

	// Runs one AI write as a single undo step, recorded as tracked changes if
	// enabled. Nested calls (e.g. a tool using Asc.Library) join the outer one.
	// opts: { turn, author, track: false (no tracking), ownTracking: true }
	async function runWrite(fn, opts) {
		opts = opts || {};
		if (depth > 0)
			return await fn();

		depth++;
		let turn = opts.turn || null;
		let grouped = false;
		let tracking = null;
		let track = false;
		try {
			track = opts.track !== false && isTrackingSupported() && isTrackChangesEnabled();
			if (turn && track && turn.before === undefined)
				turn.before = await snapshotRevisions();

			try {
				await callMethod("StartAction", ["GroupActions"]);
				grouped = true;
			} catch (e) {
				console.warn("GroupActions not available:", e);
			}

			if (track) {
				try {
					tracking = await enableTracking(opts.ownTracking ? "" : (opts.author || DEFAULT_AUTHOR));
				} catch (e) {
					console.warn("Could not enable track changes for the AI edit:", e);
				}
			}

			return await fn();
		} finally {
			if (tracking) {
				try {
					await restoreTracking(tracking);
				} catch (e) {
					console.error("Could not restore the track changes mode:", e);
				}
			}
			if (grouped) {
				try {
					await callMethod("EndAction", ["GroupActions"]);
				} catch (e) {
					console.error("Could not end the AI undo group:", e);
				}
			}
			depth--;
			noteStep(turn, track);
		}
	}

	function noteStep(turn, tracked) {
		writeSeq++;
		if (!turn)
			return;
		if (!turn.steps)
			turn.firstSeq = writeSeq;
		turn.lastSeq = writeSeq;
		turn.steps++;
		if (tracked)
			turn.trackedWrites++;
	}

	function authorFor(engine) {
		let name = engine && engine.modelUI ? (engine.modelUI.name || engine.modelUI.id || "") : "";
		return name ? DEFAULT_AUTHOR + " (" + name + ")" : DEFAULT_AUTHOR;
	}

	// Runs a tool: readOnly tools directly, all others via runWrite in the
	// current chat turn (if any). opts: { engine, author, turn, noTurn }
	// noTurn: the write does not belong to the chat (editor-initiated calls).
	function runTool(name, readOnly, fn, opts) {
		if (readOnly)
			return fn();
		opts = opts || {};
		let func = root.EditorHelper && root.EditorHelper.names2funcs ? root.EditorHelper.names2funcs[name] : null;
		return runWrite(fn, {
			turn: opts.noTurn ? null : (opts.turn || currentTurn),
			author: opts.author || authorFor(opts.engine),
			ownTracking: OWN_TRACKING_TOOLS[name] === true || !!(func && func.managesTrackChanges === true)
		});
	}

	// ── Turns ──────────────────────────────────────────────────────────────

	function beginTurn() {
		let turn = {
			id: "aiturn_" + (++turnCounter) + "_" + Date.now(),
			steps: 0,
			trackedWrites: 0,
			firstSeq: 0,
			lastSeq: 0,
			before: undefined,
			revisions: [],
			state: "active"
		};
		currentTurn = turn;
		return turn;
	}

	// Returns the summary for the chat, or null if nothing was written.
	async function endTurn(turn) {
		if (!turn)
			return null;
		if (currentTurn === turn)
			currentTurn = null;
		turn.state = "done";
		if (!turn.steps)
			return null;

		if (turn.trackedWrites > 0 && Array.isArray(turn.before)) {
			let after = await snapshotRevisions();
			if (Array.isArray(after))
				turn.revisions = diffSignatures(after, turn.before);
		}
		turn.canUndo = await detectUndoSupport();
		turns[turn.id] = turn;
		return summary(turn);
	}

	function isLatest(turn) {
		return !!turn && turn.steps > 0 && turn.lastSeq === writeSeq && (turn.lastSeq - turn.firstSeq + 1) === turn.steps;
	}

	function summary(turn) {
		return {
			turnId: turn.id,
			editorType: editorType(),
			steps: turn.steps,
			canUndo: !!turn.canUndo,
			undoAvailable: !!turn.canUndo && turn.state === "done" && isLatest(turn),
			revisionCount: turn.revisions.length,
			state: turn.state
		};
	}

	// Wraps the chat agent's "onChatMessage" handler: one turn per call, the
	// summary is sent to the chat window when the turn changed the document.
	function wrapChatHandler(getWindow, handler) {
		return async function() {
			let turn = beginTurn();
			try {
				return await handler.apply(this, arguments);
			} finally {
				let info = null;
				try {
					info = await endTurn(turn);
				} catch (e) {
					console.error("AI edits summary failed:", e);
				}
				let win = getWindow();
				if (info && win) {
					try {
						win.command("onAIEditsSummary", info);
					} catch (e) {}
				}
			}
		};
	}

	// ── Actions from the chat ("Undo AI changes", "Accept all", "Reject all") ──

	async function undoTurn(turn) {
		if (!turn.canUndo)
			return { ok: false, reason: "unsupported" };
		if (turn.state !== "done" || !isLatest(turn))
			return { ok: false, reason: "stale" };
		let undone = 0;
		for (let i = 0; i < turn.steps; i++) {
			let can = await callMethod("CanUndo");
			if (can !== true)
				break;
			await callMethod("Undo");
			undone++;
		}
		writeSeq++;
		turn.state = "undone";
		turn.revisions = [];
		return { ok: undone === turn.steps, reason: undone === turn.steps ? "" : "partial", undone: undone };
	}

	// Picks the next paragraph/table that holds only revisions of this turn,
	// selects it and reports which of the turn's revisions still exist.
	async function selectNextBlock(wanted, skipIds) {
		let s = scope();
		s.aiEditsWanted = wanted;
		s.aiEditsSkip = skipIds;
		return await callCommand(function() {
			let doc = Api.GetDocument();
			if (!doc || typeof doc.GetReviewReport !== "function")
				return null;
			let want = {};
			Asc.scope.aiEditsWanted.forEach(function(sig) { want[sig] = (want[sig] || 0) + 1; });
			let skip = Asc.scope.aiEditsSkip || [];
			let report = doc.GetReviewReport() || {};
			let blocks = {};
			let order = [];
			let present = [];
			for (let author in report) {
				let list = report[author];
				if (list && !Array.isArray(list) && typeof list === "object")
					list = list.reviews;
				if (!Array.isArray(list))
					continue;
				for (let i = 0; i < list.length; i++) {
					let r = list[i] || {};
					let sig = [author, r.Type || "", r.Value === undefined || r.Value === null ? "" : String(r.Value), r.Date === undefined || r.Date === null ? "" : String(r.Date)].join("\u001f");
					let ours = want[sig] > 0;
					if (ours) {
						want[sig]--;
						present.push(sig);
					}
					let el = r.ReviewedElement;
					let id = el && typeof el.GetInternalId === "function" ? el.GetInternalId() : null;
					if (!id)
						continue;
					if (!blocks[id]) {
						blocks[id] = { el: el, ours: 0, foreign: 0 };
						order.push(id);
					}
					if (ours)
						blocks[id].ours++;
					else
						blocks[id].foreign++;
				}
			}
			let shared = 0;
			for (let i = 0; i < order.length; i++) {
				let b = blocks[order[i]];
				if (!b.ours)
					continue;
				if (b.foreign) {
					shared += b.ours;
					continue;
				}
				if (skip.indexOf(order[i]) !== -1 || typeof b.el.Select !== "function")
					continue;
				b.el.Select();
				return { present: present, selected: order[i], shared: shared };
			}
			return { present: present, selected: null, shared: shared };
		});
	}

	async function resolveRevisions(turn, accept) {
		let total = turn.revisions.length;
		if (!total)
			return { ok: true, processed: 0, left: 0, shared: 0 };

		let remaining = turn.revisions.slice();
		let skipIds = [];
		let shared = 0;
		let guard = total + 5;
		while (remaining.length && guard-- > 0) {
			let pick = await selectNextBlock(remaining, skipIds);
			if (!pick)
				return { ok: false, reason: "unsupported", processed: total - remaining.length, left: remaining.length, shared: 0 };
			remaining = pick.present;
			shared = pick.shared;
			if (!pick.selected)
				break;
			skipIds.push(pick.selected);
			await callMethod(accept ? "AcceptReviewChanges" : "RejectReviewChanges", [false]);
		}

		let current = await snapshotRevisions();
		if (Array.isArray(current))
			remaining = intersectSignatures(turn.revisions, current);
		turn.revisions = remaining;
		// Accepting/rejecting adds undo steps of its own.
		writeSeq++;
		return { ok: remaining.length === 0, processed: total - remaining.length, left: remaining.length, shared: shared };
	}

	// action: "undo" | "accept" | "reject"
	async function performAction(turnId, action) {
		let turn = turns[turnId];
		let res;
		if (!turn) {
			res = { ok: false, reason: "unknown" };
		} else {
			try {
				if (action === "undo")
					res = await undoTurn(turn);
				else if (action === "accept" || action === "reject")
					res = await resolveRevisions(turn, action === "accept");
				else
					res = { ok: false, reason: "unknown" };
			} catch (e) {
				console.error("AI edits action failed:", e);
				res = { ok: false, reason: "error", message: (e && e.message) ? e.message : String(e) };
			}
		}
		res.turnId = turnId;
		res.action = action;
		if (turn)
			res.summary = summary(turn);
		return res;
	}

	// ── One-shot writes through Asc.Library ────────────────────────────────

	function patchLibrary(lib) {
		if (!lib || lib.__aiEditsPatched)
			return;
		function wrap(name, track) {
			let original = lib[name];
			if (typeof original !== "function")
				return;
			lib[name] = function() {
				let self = this;
				let args = arguments;
				return runWrite(function() {
					return original.apply(self, args);
				}, { track: track });
			};
		}
		LIBRARY_TRACKED.forEach(function(name) { wrap(name, true); });
		LIBRARY_GROUP_ONLY.forEach(function(name) { wrap(name, false); });
		lib.__aiEditsPatched = true;
	}

	if (root.Asc && root.Asc.Library)
		patchLibrary(root.Asc.Library);

	root.AIEdits = {
		STORAGE_KEY: STORAGE_KEY,
		DEFAULT_AUTHOR: DEFAULT_AUTHOR,

		isLocked: isLocked,
		isTrackChangesEnabled: isTrackChangesEnabled,
		setUserTrackChanges: setUserTrackChanges,
		isTrackingSupported: isTrackingSupported,

		runWrite: runWrite,
		runTool: runTool,
		beginTurn: beginTurn,
		endTurn: endTurn,
		wrapChatHandler: wrapChatHandler,
		performAction: performAction,
		patchLibrary: patchLibrary,

		snapshotRevisions: snapshotRevisions,
		diffSignatures: diffSignatures,
		intersectSignatures: intersectSignatures,
		detectUndoSupport: detectUndoSupport,
		authorFor: authorFor,

		_reset: function() {
			depth = 0;
			writeSeq = 0;
			turns = {};
			currentTurn = null;
			undoSupport = null;
		}
	};

})(typeof window !== "undefined" ? window : globalThis);
