(function(){
	let func = new RegisteredFunction({
		"name": "readPresentation",
		"readOnly": true,
		"text": "Read Presentation",
		"description": "Reads the open presentation: total slide count, the current slide number, and for each requested slide the text of every shape (with shape index, type and placeholder type when available). Use it to understand or summarise the deck, find a slide by content, or decide where to make changes. Slide numbers are 1-based.",
		"parameters": {
			"type": "object",
			"properties": {
				"slideNumber": {
					"type": "number",
					"description": "Read only this slide (1-based). Omit to read all slides (up to 'maxSlides')."
				},
				"currentSlideOnly": {
					"type": "boolean",
					"description": "Read only the slide currently shown in the editor.",
					"default": false
				},
				"maxSlides": {
					"type": "number",
					"description": "Maximum number of slides to return when reading all slides (1-100).",
					"default": 30
				}
			},
			"required": []
		},
		"examples": [
			{
				"prompt": "Summarize this presentation",
				"arguments": {}
			},
			{
				"prompt": "What is on this slide?",
				"arguments": { "currentSlideOnly": true }
			}
		]
	});

	func.call = async function(params) {
		if (params.slideNumber !== undefined && params.slideNumber !== null && (typeof params.slideNumber !== 'number' || params.slideNumber < 1))
			throw new window.AgentState.ToolError('Parameter "slideNumber" must be a number >= 1. Got: ' + JSON.stringify(params.slideNumber));

		Asc.scope.readParams = {
			slideNumber: params.slideNumber ? Math.floor(params.slideNumber) : null,
			current: !!params.currentSlideOnly,
			maxSlides: Math.max(1, Math.min(100, Math.floor(params.maxSlides || 30)))
		};

		let result = await Asc.Editor.callCommand(function(){
			let p = Asc.scope.readParams;
			let pres = Api.GetPresentation();
			let total = pres.GetSlidesCount();
			let current = pres.GetCurrentSlide();
			let currentNumber = null;
			if (current && current.GetSlideIndex)
				currentNumber = current.GetSlideIndex() + 1;

			function readSlide(slide, number) {
				let shapes = [];
				let drawings = slide.GetAllDrawings ? slide.GetAllDrawings() : slide.GetAllShapes();
				for (let i = 0; i < drawings.length; i++) {
					let d = drawings[i];
					let item = { index: i + 1, type: d.GetClassType ? d.GetClassType() : "drawing" };
					try {
						let ph = d.GetPlaceholder ? d.GetPlaceholder() : null;
						if (ph && ph.GetType)
							item.placeholder = ph.GetType();
					} catch (e) {}
					try {
						let content = d.GetDocContent ? d.GetDocContent() : null;
						if (content) {
							let lines = [];
							for (let j = 0; j < content.GetElementsCount(); j++) {
								let el = content.GetElement(j);
								if (el && el.GetText)
									lines.push(el.GetText());
							}
							item.text = lines.join("\n");
						}
					} catch (e) {}
					shapes.push(item);
				}
				return { slideNumber: number, shapes: shapes };
			}

			let slides = [];
			if (p.current) {
				if (current)
					slides.push(readSlide(current, currentNumber));
			} else if (p.slideNumber) {
				let s = pres.GetSlideByIndex(p.slideNumber - 1);
				if (!s)
					return { error: "Slide " + p.slideNumber + " not found. The presentation has " + total + " slides." };
				slides.push(readSlide(s, p.slideNumber));
			} else {
				let n = Math.min(total, p.maxSlides);
				for (let i = 0; i < n; i++)
					slides.push(readSlide(pres.GetSlideByIndex(i), i + 1));
			}

			return {
				totalSlides: total,
				currentSlide: currentNumber,
				hasMore: !p.current && !p.slideNumber && total > p.maxSlides,
				slides: slides
			};
		});

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	return func;
})();
