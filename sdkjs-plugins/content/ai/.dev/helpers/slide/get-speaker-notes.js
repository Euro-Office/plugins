(function(){
	let func = new RegisteredFunction({
		"name": "getSpeakerNotes",
		"readOnly": true,
		"text": "Read Speaker Notes",
		"description": "Returns the speaker notes of one slide, or of all slides when slideNumber is omitted (slides without notes are listed with an empty text). Slide numbers are 1-based. Use it to review, summarise or rewrite the presenter notes.",
		"parameters": {
			"type": "object",
			"properties": {
				"slideNumber": {
					"type": "number",
					"description": "1-based slide number. Omit to read the notes of all slides."
				}
			},
			"required": []
		},
		"examples": [
			{
				"prompt": "What are my speaker notes for slide 3?",
				"arguments": { "slideNumber": 3 }
			},
			{
				"prompt": "Show all speaker notes",
				"arguments": {}
			}
		]
	});

	func.call = async function(params) {
		if (params.slideNumber !== undefined && params.slideNumber !== null && (typeof params.slideNumber !== 'number' || params.slideNumber < 1))
			throw new window.AgentState.ToolError('Parameter "slideNumber" must be a number >= 1. Got: ' + JSON.stringify(params.slideNumber));
		Asc.scope.notesParams = { slideNumber: params.slideNumber ? Math.floor(params.slideNumber) : null };

		let result = await Asc.Editor.callCommand(function(){
			let p = Asc.scope.notesParams;
			let pres = Api.GetPresentation();
			let total = pres.GetSlidesCount();
			function notesOf(slide) {
				let notes = slide.GetNotesPage ? slide.GetNotesPage() : null;
				if (!notes)
					return "";
				return String(notes.GetBodyShapeText() || "").replace(/\r\n?/g, "\n").replace(/\n$/, "");
			}
			let slides = [];
			if (p.slideNumber) {
				let slide = pres.GetSlideByIndex(p.slideNumber - 1);
				if (!slide)
					return { error: "Slide " + p.slideNumber + " does not exist. The presentation has " + total + " slides." };
				slides.push({ slideNumber: p.slideNumber, notes: notesOf(slide) });
			} else {
				for (let i = 0; i < total; i++)
					slides.push({ slideNumber: i + 1, notes: notesOf(pres.GetSlideByIndex(i)) });
			}
			return { totalSlides: total, slides: slides };
		});

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	return func;
})();
