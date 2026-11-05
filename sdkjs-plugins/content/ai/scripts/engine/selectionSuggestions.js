// SPDX-License-Identifier: AGPL-3.0-only

// Selection suggestion chips (background side).
//
// While the chat window exists, watches the editor selection and pushes
// "onSelectionSuggestions" { key, summary, actions: [{id, text}] } to the
// chat, which shows them as chips above the input. A chip click comes back
// as "onSmartActionChip" { id } and runs the same path as the context menu
// "Smart actions" (prompt + LANG_HINT, sent to the agent right away).
//
// Change detection:
// - word/slide: the plugin event "onTargetPositionChanged" (listed in
//   config.json) triggers a debounced check right away.
// - The editors have no plugin event for selection changes as such (the
//   target event follows the caret, and spreadsheets only report cell
//   *content* changes via onWorksheetChange), so a lightweight probe also
//   runs every POLL_MS while the chat is open and the agent is idle. The
//   probe is a single cheap call (selected address / selected text); the
//   full DocumentContext snapshot is only read once the probe has changed
//   and stayed stable for DEBOUNCE_MS.
(function(window) {

	const POLL_MS = 1500;
	const DEBOUNCE_MS = 400;

	let state = {
		win: null,
		run: null,
		busy: false,
		inFlight: false,
		pendingProbe: null,
		sentProbe: null,
		sentKey: null,
		pollTimer: null,
		debounceTimer: null,
		editorEventAttached: false
	};

	function editorType() {
		return Asc.Editor.getType();
	}

	function isSupported() {
		return !!(window.SmartActions && window.DocumentContext) && window.SmartActions.all(editorType()).length > 0;
	}

	function isAlive() {
		return !!state.win && window.chatWindow === state.win;
	}

	function stop() {
		clearInterval(state.pollTimer);
		clearTimeout(state.debounceTimer);
		state.pollTimer = null;
		state.debounceTimer = null;
		state.win = null;
		state.busy = false;
	}

	function schedule(ms) {
		clearTimeout(state.debounceTimer);
		state.debounceTimer = setTimeout(check, ms);
	}

	function callCommandNoCalc(func) {
		return new Promise(function(resolve) {
			Asc.plugin.callCommand(func, false, false, resolve);
		});
	}

	// Cheap fingerprint of the current selection.
	async function probe() {
		if (editorType() === "cell") {
			return await callCommandNoCalc(function() {
				let sel = Api.GetSelection();
				return Api.GetActiveSheet().GetName() + "!" + (sel ? sel.GetAddress(false, false) : "");
			});
		}
		let text = (await Asc.Library.GetSelectedText()) || "";
		return text.length + ":" + window.SmartActions.hash(text);
	}

	function tr(text) {
		return window.Asc.plugin.tr(text);
	}

	function buildPayload(ctx) {
		let type = editorType();
		let actions = window.SmartActions.get(type, ctx);
		let key = window.SmartActions.selectionKey(ctx);
		if (!actions.length)
			return { key: key, summary: "", actions: [] };

		let summary;
		if (ctx.editor === "cell")
			summary = tr("Selection: %1").replace("%1", ctx.selection);
		else
			summary = tr("Selected text (%1 chars)").replace("%1", String(ctx.selectionText.trim().length));

		return {
			key: key,
			summary: summary,
			actions: actions.map(function(a) { return { id: a.id, text: tr(a.text) }; })
		};
	}

	async function check() {
		if (!isAlive()) {
			stop();
			return;
		}
		if (state.busy || state.inFlight)
			return;

		state.inFlight = true;
		try {
			let p = await probe();
			if (!isAlive() || state.busy)
				return;
			if (p !== state.pendingProbe) {
				// Changed: wait until it is stable (e.g. the user is still dragging).
				state.pendingProbe = p;
				schedule(DEBOUNCE_MS);
				return;
			}
			if (p === state.sentProbe)
				return;
			state.sentProbe = p;

			let ctx = await window.DocumentContext.get();
			if (!isAlive() || state.busy) {
				state.sentProbe = null;
				return;
			}
			let payload = buildPayload(ctx);
			if (payload.key === state.sentKey)
				return;
			state.sentKey = payload.key;
			state.win.command("onSelectionSuggestions", payload);
		} catch (e) {
			console.warn("[AI] selection suggestions:", e);
		} finally {
			state.inFlight = false;
		}
	}

	function resetSent() {
		state.pendingProbe = null;
		state.sentProbe = null;
		state.sentKey = null;
	}

	// Called from the chat window's "onWindowReady" (also after re-docking,
	// which reloads the chat page): (re)binds the window and sends the
	// current suggestions once.
	function attach(win, run) {
		if (!isSupported())
			return;

		if (state.win !== win) {
			stop();
			state.win = win;

			win.attachEvent("onSmartActionChip", function(data) {
				let action = data && window.SmartActions.byId(editorType(), data.id);
				if (!action || !state.run)
					return;
				state.busy = true;
				state.run(action.prompt + window.SmartActions.LANG_HINT, true);
			});

			win.attachEvent("onSelectionSuggestionsBusy", function(isBusy) {
				state.busy = !!isBusy;
				if (!state.busy) {
					// The agent may have changed the selection or its content.
					state.pendingProbe = null;
					state.sentProbe = null;
					schedule(DEBOUNCE_MS);
				}
			});
		}
		state.run = run;
		state.busy = false;
		resetSent();

		if (!state.editorEventAttached && editorType() !== "cell") {
			state.editorEventAttached = true;
			window.Asc.plugin.attachEditorEvent("onTargetPositionChanged", function() {
				if (isAlive() && !state.busy)
					schedule(DEBOUNCE_MS);
			});
		}

		if (!state.pollTimer)
			state.pollTimer = setInterval(check, POLL_MS);
		schedule(0);
	}

	window.SelectionSuggestions = {
		attach: attach,
		stop: stop
	};

})(window);
