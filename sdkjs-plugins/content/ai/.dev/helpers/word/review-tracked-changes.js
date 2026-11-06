/*
 * SPDX-FileCopyrightText: Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function(){
	let func = new RegisteredFunction({
		"name": "reviewTrackedChanges",
		"category": "comments-review",
		"text": "Accept or Reject Changes",
		"description": "Accepts or rejects tracked changes in the text document. scope 'all' affects every tracked change in the document; scope 'selection' affects only the changes inside the user's current selection (use selectText first to select a passage). Returns the number of tracked changes before and after. Inspect the changes with getTrackedChanges first.",
		"parameters": {
			"type": "object",
			"properties": {
				"action": {
					"type": "string",
					"enum": ["accept", "reject"],
					"description": "Whether to accept or reject the changes."
				},
				"scope": {
					"type": "string",
					"enum": ["all", "selection"],
					"description": "Which changes to process.",
					"default": "selection"
				}
			},
			"required": ["action"]
		},
		"examples": [
			{
				"prompt": "Accept all tracked changes",
				"arguments": { "action": "accept", "scope": "all" }
			},
			{
				"prompt": "Reject the changes in the selected text",
				"arguments": { "action": "reject", "scope": "selection" }
			}
		]
	});

	func.call = async function(params) {
		if (params.action !== "accept" && params.action !== "reject")
			throw new window.AgentState.ToolError('Parameter "action" must be "accept" or "reject". Got: ' + JSON.stringify(params.action));
		let scope = params.scope === undefined || params.scope === null ? "selection" : params.scope;
		if (scope !== "all" && scope !== "selection")
			throw new window.AgentState.ToolError('Parameter "scope" must be "all" or "selection". Got: ' + JSON.stringify(params.scope));

		async function countChanges() {
			return await Asc.Editor.callCommand(function(){
				let report = Api.GetDocument().GetReviewReport() || {};
				let n = 0;
				for (let author in report) {
					let list = report[author];
					if (list && !Array.isArray(list) && typeof list === "object")
						list = list.reviews;
					if (Array.isArray(list))
						n += list.length;
				}
				return n;
			});
		}

		let before = await countChanges();
		if (!before)
			return { action: params.action, scope: scope, changesBefore: 0, changesAfter: 0, note: "The document has no tracked changes." };

		// Plugin methods AcceptReviewChanges/RejectReviewChanges (isAll), available since 7.2.1
		await Asc.Editor.callMethod(params.action === "accept" ? "AcceptReviewChanges" : "RejectReviewChanges", [scope === "all"]);

		let after = await countChanges();
		let res = { action: params.action, scope: scope, changesBefore: before, changesAfter: after };
		if (after === before)
			res.note = scope === "selection" ? "No tracked changes were inside the current selection. Select the passage first (selectText) or use scope 'all'." : "No changes were processed.";
		return res;
	};

	func.describe = function(args, result) {
		let reject = args.action === "reject";
		let changed = result ? Math.max(0, (result.changesBefore || 0) - (result.changesAfter || 0)) : 0;
		return {
			start: reject ? toolText("Reject tracked changes") : toolText("Accept tracked changes"),
			done: result && (reject ? toolText("Rejected %1 tracked changes", changed) : toolText("Accepted %1 tracked changes", changed)),
			phrase: toolText("reviewed tracked changes")
		};
	};

	return func;
})();
