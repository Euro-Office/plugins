(function(){
	let func = new RegisteredFunction({
		"name": "moveSlide",
		"category": "structure",
		"text": "Move Slide",
		"description": "Moves a slide to a new position. 'from' is the current 1-based slide number, 'to' is the 1-based number the slide should have afterwards (other slides shift accordingly). Example: from 5 to 1 makes slide 5 the first slide.",
		"parameters": {
			"type": "object",
			"properties": {
				"from": {
					"type": "number",
					"description": "Current 1-based slide number."
				},
				"to": {
					"type": "number",
					"description": "Target 1-based slide number."
				}
			},
			"required": ["from", "to"]
		},
		"examples": [
			{
				"prompt": "Move the last slide (slide 12) to position 2",
				"arguments": { "from": 12, "to": 2 }
			}
		]
	});

	func.call = async function(params) {
		if (typeof params.from !== 'number' || params.from < 1)
			throw new window.AgentState.ToolError('Parameter "from" must be a number >= 1. Got: ' + JSON.stringify(params.from));
		if (typeof params.to !== 'number' || params.to < 1)
			throw new window.AgentState.ToolError('Parameter "to" must be a number >= 1. Got: ' + JSON.stringify(params.to));

		Asc.scope.moveParams = { from: Math.floor(params.from), to: Math.floor(params.to) };

		let result = await Asc.Editor.callCommand(function(){
			let p = Asc.scope.moveParams;
			let pres = Api.GetPresentation();
			let total = pres.GetSlidesCount();
			if (p.from > total || p.to > total)
				return { error: "Slide numbers must be between 1 and " + total + " (the presentation has " + total + " slides)." };
			if (p.from === p.to)
				return { from: p.from, to: p.to, totalSlides: total, note: "Slide is already at that position." };
			let slide = pres.GetSlideByIndex(p.from - 1);
			if (!slide || !slide.MoveTo(p.to - 1))
				return { error: "Could not move slide " + p.from + "." };
			return { from: p.from, to: slide.GetSlideIndex() + 1, totalSlides: total };
		});

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	return func;
})();
