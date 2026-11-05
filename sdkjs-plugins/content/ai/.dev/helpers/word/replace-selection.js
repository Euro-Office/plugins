(function(){
	let func = new RegisteredFunction({
		"name": "replaceSelection",
		"text": "Replace Selection",
		"description": "Replaces the text the user has selected with new text, keeping the surrounding formatting as far as possible. Use it to apply rewritten, translated, corrected or summarized text back to the selection. Requires a non-empty selection; call getSelection first if unsure. Set 'trackChanges' to true to make the change visible as a tracked revision.",
		"parameters": {
			"type": "object",
			"properties": {
				"text": {
					"type": "string",
					"description": "The replacement text. Use \\n to separate paragraphs."
				},
				"trackChanges": {
					"type": "boolean",
					"description": "Record the replacement as a tracked change so the user can review it.",
					"default": false
				}
			},
			"required": ["text"]
		},
		"examples": [
			{
				"prompt": "Make the selected sentence more formal",
				"arguments": { "text": "We would be pleased to assist you with this request." }
			}
		]
	});

	func.call = async function(params) {
		if (typeof params.text !== 'string')
			throw new window.AgentState.ToolError('Parameter "text" is required and must be a string.');

		let selected = await Asc.Library.GetSelectedText();
		if (!selected || !selected.trim())
			throw new window.AgentState.ToolError('Nothing is selected. Ask the user to select text, or use writeMacro/editParagraph to edit by paragraph index.');

		let turnOffTrackChanges = false;
		if (params.trackChanges) {
			let isTrack = await Asc.Editor.callCommand(function(){
				return Api.GetDocument().IsTrackRevisions();
			});
			if (!isTrack) {
				await Asc.Editor.callCommand(function(){
					Api.GetDocument().SetTrackRevisions(true);
				});
				turnOffTrackChanges = true;
			}
		}

		// Provenance: wrap the new text in "ai-generated" content controls.
		let provenanceAnchor = window.AIProvenance ? await window.AIProvenance.captureAnchor(window.AIProvenance.scopeMeta("replaceSelection")) : null;
		try {
			await Asc.Library.ReplaceTextSmart(params.text.split("\n"));
			if (provenanceAnchor)
				await window.AIProvenance.markInsertion(provenanceAnchor, { text: params.text });
		} finally {
			if (turnOffTrackChanges) {
				await Asc.Editor.callCommand(function(){
					Api.GetDocument().SetTrackRevisions(false);
				});
			}
		}

		return { replacedCharacters: selected.length };
	};

	return func;
})();
