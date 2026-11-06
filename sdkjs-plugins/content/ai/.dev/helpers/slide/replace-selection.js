/*
 * SPDX-FileCopyrightText: Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function(){
	let func = new RegisteredFunction({
		"name": "replaceSelection",
		"category": "edit-text",
		"text": "Replace Selection",
		"description": "Replaces the text the user has selected on the slide (inside a text box, placeholder or table cell) with new text. Use it to apply rewritten, shortened, translated or corrected text back to the selection. Requires a non-empty text selection.",
		"parameters": {
			"type": "object",
			"properties": {
				"text": {
					"type": "string",
					"description": "The replacement text. Use \\n to separate paragraphs/bullets."
				}
			},
			"required": ["text"]
		},
		"examples": [
			{
				"prompt": "Make the selected bullet shorter",
				"arguments": { "text": "Revenue up 12% year over year" }
			}
		]
	});

	func.call = async function(params) {
		if (typeof params.text !== 'string')
			throw new window.AgentState.ToolError('Parameter "text" is required and must be a string.');

		let selected = await Asc.Library.GetSelectedText();
		if (!selected || !selected.trim())
			throw new window.AgentState.ToolError('No text is selected on the slide. Ask the user to select the text to replace, or use writeMacro.');

		await Asc.Library.PasteText(params.text);
		return { replacedCharacters: selected.length };
	};

	func.describe = function() {
		return { start: toolText("Replace the selected text"), done: toolText("Replaced the selected text"), phrase: toolText("replaced the selected text") };
	};

	return func;
})();
