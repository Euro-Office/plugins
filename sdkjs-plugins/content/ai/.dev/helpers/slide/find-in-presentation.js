(function(){
	let func = new RegisteredFunction({
		"name": "findInPresentation",
		"readOnly": true,
		"text": "Find in Presentation",
		"description": "Searches the text of all slides (text boxes, placeholders and shapes; optionally speaker notes) for a plain-text string. Returns, per match, the 1-based slide number, the 1-based shape index on that slide (same numbering as readPresentation; null for speaker notes), where it was found ('shape' or 'notes') and a snippet of surrounding text. Case-insensitive unless matchCase is true. Use goToSlide to show a result to the user.",
		"parameters": {
			"type": "object",
			"properties": {
				"query": {
					"type": "string",
					"description": "Text to search for (plain text)."
				},
				"matchCase": {
					"type": "boolean",
					"description": "Case-sensitive search.",
					"default": false
				},
				"includeNotes": {
					"type": "boolean",
					"description": "Also search the speaker notes.",
					"default": true
				},
				"maxResults": {
					"type": "number",
					"description": "Maximum number of matches to return (1-200).",
					"default": 50
				}
			},
			"required": ["query"]
		},
		"examples": [
			{
				"prompt": "On which slide do we talk about pricing?",
				"arguments": { "query": "pricing" }
			}
		]
	});

	func.call = async function(params) {
		if (typeof params.query !== 'string' || params.query === "")
			throw new window.AgentState.ToolError('Parameter "query" must be a non-empty string. Got: ' + JSON.stringify(params.query));
		let max = params.maxResults === undefined || params.maxResults === null ? 50 : params.maxResults;
		if (typeof max !== 'number' || max < 1)
			throw new window.AgentState.ToolError('Parameter "maxResults" must be a number >= 1. Got: ' + JSON.stringify(params.maxResults));

		Asc.scope.findParams = {
			query: params.query,
			matchCase: params.matchCase === true,
			includeNotes: params.includeNotes !== false,
			max: Math.min(200, Math.floor(max)),
			context: 50
		};

		return await Asc.Editor.callCommand(function(){
			let p = Asc.scope.findParams;
			let pres = Api.GetPresentation();
			let total = pres.GetSlidesCount();
			let needle = p.matchCase ? p.query : p.query.toLowerCase();
			let matches = [];
			let count = 0;

			function scan(text, slideNumber, shapeIndex, where) {
				if (!text)
					return;
				text = String(text).replace(/\r\n?/g, "\n");
				let hay = p.matchCase ? text : text.toLowerCase();
				let pos = hay.indexOf(needle);
				while (pos !== -1) {
					count++;
					if (matches.length < p.max) {
						let start = Math.max(0, pos - p.context);
						let end = Math.min(text.length, pos + needle.length + p.context);
						matches.push({
							slideNumber: slideNumber,
							shapeIndex: shapeIndex,
							where: where,
							snippet: (start > 0 ? "…" : "") + text.substring(start, end).replace(/\n/g, " ") + (end < text.length ? "…" : "")
						});
					}
					pos = hay.indexOf(needle, pos + needle.length);
				}
			}

			for (let i = 0; i < total; i++) {
				let slide = pres.GetSlideByIndex(i);
				if (!slide)
					continue;
				let drawings = slide.GetAllDrawings ? slide.GetAllDrawings() : slide.GetAllShapes();
				for (let d = 0; d < drawings.length; d++) {
					let text = "";
					try {
						let content = drawings[d].GetDocContent ? drawings[d].GetDocContent() : null;
						if (content) {
							let lines = [];
							for (let j = 0; j < content.GetElementsCount(); j++) {
								let el = content.GetElement(j);
								if (el && el.GetText)
									lines.push(el.GetText());
							}
							text = lines.join("\n");
						}
					} catch (e) {}
					scan(text, i + 1, d + 1, "shape");
				}
				if (p.includeNotes) {
					try {
						let notes = slide.GetNotesPage ? slide.GetNotesPage() : null;
						if (notes)
							scan(notes.GetBodyShapeText(), i + 1, null, "notes");
					} catch (e) {}
				}
			}
			return { query: p.query, totalMatches: count, returned: matches.length, truncated: count > matches.length, matches: matches };
		});
	};

	return func;
})();
