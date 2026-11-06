/*
 * SPDX-FileCopyrightText: Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function(){
	let func = new RegisteredFunction({
		"name": "setSpeakerNotes",
		"category": "notes",
		"text": "Write Speaker Notes",
		"description": "Writes the speaker notes of a slide. mode 'replace' (default) replaces the existing notes, 'append' adds the text as new paragraphs after them. Line breaks (\\n) start new paragraphs. Defaults to the current slide. Slide numbers are 1-based.",
		"parameters": {
			"type": "object",
			"properties": {
				"slideNumber": {
					"type": "number",
					"description": "1-based slide number. Defaults to the current slide."
				},
				"text": {
					"type": "string",
					"description": "The notes text (plain text)."
				},
				"mode": {
					"type": "string",
					"enum": ["replace", "append"],
					"description": "Replace the existing notes or append to them.",
					"default": "replace"
				}
			},
			"required": ["text"]
		},
		"examples": [
			{
				"prompt": "Write speaker notes for slide 2",
				"arguments": { "slideNumber": 2, "text": "Welcome everyone.\nToday we look at the Q3 results." }
			}
		]
	});

	func.call = async function(params) {
		if (params.slideNumber !== undefined && params.slideNumber !== null && (typeof params.slideNumber !== 'number' || params.slideNumber < 1))
			throw new window.AgentState.ToolError('Parameter "slideNumber" must be a number >= 1. Got: ' + JSON.stringify(params.slideNumber));
		if (typeof params.text !== 'string')
			throw new window.AgentState.ToolError('Parameter "text" must be a string.');
		let mode = params.mode === undefined || params.mode === null ? "replace" : params.mode;
		if (mode !== "replace" && mode !== "append")
			throw new window.AgentState.ToolError('Parameter "mode" must be "replace" or "append". Got: ' + JSON.stringify(params.mode));

		Asc.scope.notesParams = {
			slideNumber: params.slideNumber ? Math.floor(params.slideNumber) : null,
			lines: params.text.replace(/\r\n?/g, "\n").split("\n"),
			mode: mode
		};

		let result;
		await Asc.Editor.callMethod("StartAction", ["GroupActions"]);
		try {
			result = await Asc.Editor.callCommand(function(){
				let p = Asc.scope.notesParams;
				let pres = Api.GetPresentation();
				let total = pres.GetSlidesCount();
				let slide;
				let number = p.slideNumber;
				if (number) {
					slide = pres.GetSlideByIndex(number - 1);
					if (!slide)
						return { error: "Slide " + number + " does not exist. The presentation has " + total + " slides." };
				} else {
					slide = pres.GetCurrentSlide();
					if (!slide)
						return { error: "No current slide. Pass \"slideNumber\"." };
					number = slide.GetSlideIndex() + 1;
				}
				let notes = slide.GetNotesPage();
				if (!notes)
					return { error: "Slide " + number + " has no notes page." };
				let body = notes.GetBodyShape();
				let content = body ? body.GetDocContent() : null;
				if (!content)
					return { error: "The notes of slide " + number + " cannot be edited." };

				let lines = p.lines;
				let start = 0;
				if (p.mode === "replace") {
					content.RemoveAllElements();
					// RemoveAllElements leaves one empty paragraph
					let first = content.GetElementsCount() > 0 ? content.GetElement(0) : null;
					if (first && first.AddText) {
						first.AddText(lines[0]);
						start = 1;
					}
				} else {
					let existing = String(notes.GetBodyShapeText() || "").replace(/[\r\n]/g, "");
					if (existing === "" && content.GetElementsCount() === 1) {
						content.GetElement(0).AddText(lines[0]);
						start = 1;
					}
				}
				for (let i = start; i < lines.length; i++) {
					let par = Api.CreateParagraph();
					par.AddText(lines[i]);
					content.Push(par);
				}
				return { slideNumber: number, mode: p.mode, notes: String(notes.GetBodyShapeText() || "") };
			});
		} finally {
			await Asc.Editor.callMethod("EndAction", ["GroupActions"]);
		}

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	func.describe = function(args, result) {
		let n = result ? result.slideNumber : args.slideNumber;
		return {
			start: typeof n === "number" ? toolText("Write the speaker notes of slide %1", n) : toolText("Write the speaker notes of the current slide"),
			done: result && toolText("Wrote the speaker notes of slide %1", n),
			phrase: toolText("wrote speaker notes")
		};
	};

	return func;
})();
