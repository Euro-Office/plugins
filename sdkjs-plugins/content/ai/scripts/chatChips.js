// SPDX-License-Identifier: AGPL-3.0-only

// Selection suggestion chips (chat side). The background plugin sends
// "onSelectionSuggestions" { key, summary, actions: [{id, text}] } (labels
// already translated) whenever the selection changes; a click answers with
// "onSmartActionChip" { id }. Chips are hidden while the agent runs and can
// be dismissed until the selection (key) changes. Not persisted.
(function(window, undefined) {

	let current = null;      // last payload from the plugin
	let dismissedKey = null; // payload.key the user dismissed
	let busy = false;

	function tr(text) {
		return window.Asc.plugin.tr(text);
	}

	function container() {
		return $('#selection_chips');
	}

	function isVisible() {
		return !!current && current.actions && current.actions.length > 0 &&
			!busy && current.key !== dismissedKey;
	}

	function render() {
		let $box = container();
		if (!$box.length)
			return;

		// Keep keyboard focus inside the row when it is re-rendered.
		let hadFocus = $box[0].contains(document.activeElement);
		$box.empty();

		if (!isVisible()) {
			$box.addClass('hidden');
			if (hadFocus)
				$('#input_message').focus();
			return;
		}

		$box.attr('role', 'group');
		$box.attr('aria-label', tr('Suggested actions'));

		let $summary = $('<div class="selection_chips_summary"></div>');
		$summary.append($('<span class="selection_chips_summary_text"></span>').text(current.summary || ''));
		let $dismiss = $('<button type="button" class="selection_chips_dismiss">×</button>');
		$dismiss.attr('title', tr('Dismiss suggestions'));
		$dismiss.attr('aria-label', tr('Dismiss suggestions'));
		$dismiss.on('click', dismiss);
		$summary.append($dismiss);
		$box.append($summary);

		current.actions.forEach(function(action) {
			let $chip = $('<button type="button" class="selection_chip btn-text-default noselect"></button>');
			$chip.text(action.text);
			$chip.on('click', function() {
				// Hide right away; the agent run keeps them hidden until it ends.
				setBusy(true, true);
				window.Asc.plugin.sendToPlugin("onSmartActionChip", { id: action.id });
			});
			$box.append($chip);
		});

		$box.removeClass('hidden');
		if (hadFocus) {
			let first = $box.find('.selection_chip')[0];
			first && first.focus();
		}
	}

	function dismiss() {
		if (current)
			dismissedKey = current.key;
		render();
		$('#input_message').focus();
	}

	// isLocal: do not notify the plugin (it already knows, e.g. chip click).
	function setBusy(isBusy, isLocal) {
		isBusy = !!isBusy;
		if (busy === isBusy)
			return;
		busy = isBusy;
		if (!isLocal)
			window.Asc.plugin.sendToPlugin("onSelectionSuggestionsBusy", busy);
		render();
	}

	window.Asc.plugin.attachEvent("onSelectionSuggestions", function(data) {
		if (!data || typeof data !== 'object')
			return;
		current = {
			key: String(data.key || ''),
			summary: String(data.summary || ''),
			actions: Array.isArray(data.actions) ? data.actions.filter(function(a) {
				return a && a.id && a.text;
			}) : []
		};
		if (current.key !== dismissedKey)
			dismissedKey = null;
		render();
	});

	$(document).on('keydown', '#selection_chips', function(e) {
		if (e.key === 'Escape') {
			e.preventDefault();
			dismiss();
		}
	});

	window.ChatChips = {
		setBusy: function(isBusy) { setBusy(isBusy, false); }
	};

})(window);
