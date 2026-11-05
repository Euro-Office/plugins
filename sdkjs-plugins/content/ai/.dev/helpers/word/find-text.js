(function(){
	let func = new RegisteredFunction({
		"name": "findText",
		"category": "core",
		"readOnly": true,
		"text": "Find Text",
		"description": "Searches the main body of the text document (including tables and content controls, not headers, footers or footnotes) for a plain-text string. Returns the total number of matches and, for each returned match, its 1-based occurrence number, the 1-based index of the top-level element that contains it (same numbering as readDocument/editParagraph) and a short snippet of surrounding text. Use it to locate passages before editing them; pass the occurrence number to selectText to select a match. Matching is substring-based and case-insensitive unless matchCase is true.",
		"parameters": {
			"type": "object",
			"properties": {
				"query": {
					"type": "string",
					"description": "Text to search for (plain text, not a regular expression)."
				},
				"matchCase": {
					"type": "boolean",
					"description": "Case-sensitive search.",
					"default": false
				},
				"maxResults": {
					"type": "number",
					"description": "Maximum number of matches to return (1-200). totalMatches always reports the full count.",
					"default": 50
				}
			},
			"required": ["query"]
		},
		"examples": [
			{
				"prompt": "Where does the document mention the deadline?",
				"arguments": { "query": "deadline" }
			},
			{
				"prompt": "Find all occurrences of 'GmbH'",
				"arguments": { "query": "GmbH", "matchCase": true }
			}
		]
	});

	func.call = async function(params) {
		if (typeof params.query !== 'string' || params.query === "")
			throw new window.AgentState.ToolError('Parameter "query" must be a non-empty string. Got: ' + JSON.stringify(params.query));
		if (params.matchCase !== undefined && params.matchCase !== null && typeof params.matchCase !== 'boolean')
			throw new window.AgentState.ToolError('Parameter "matchCase" must be a boolean.');
		let max = params.maxResults === undefined || params.maxResults === null ? 50 : params.maxResults;
		if (typeof max !== 'number' || max < 1)
			throw new window.AgentState.ToolError('Parameter "maxResults" must be a number >= 1. Got: ' + JSON.stringify(params.maxResults));

		Asc.scope.findParams = {
			query: params.query,
			matchCase: params.matchCase === true,
			max: Math.min(200, Math.floor(max)),
			context: 60
		};

		return await Asc.Editor.callCommand(function(){
			let p = Asc.scope.findParams;
			let doc = Api.GetDocument();
			let total = doc.GetElementsCount();
			let needle = p.matchCase ? p.query : p.query.toLowerCase();
			let matches = [];
			let count = 0;

			function snippetAt(text, pos) {
				let start = Math.max(0, pos - p.context);
				let end = Math.min(text.length, pos + p.query.length + p.context);
				return (start > 0 ? "…" : "") + text.substring(start, end) + (end < text.length ? "…" : "");
			}

			for (let i = 0; i < total; i++) {
				let el = doc.GetElement(i);
				if (!el || typeof el.Search !== "function")
					continue;
				let ranges = el.Search(p.query, p.matchCase) || [];
				if (!ranges.length)
					continue;
				let text = "";
				try {
					text = el.GetText ? (el.GetText() || "") : "";
				} catch (e) {}
				text = text.replace(/\r/g, "");
				let hay = p.matchCase ? text : text.toLowerCase();
				let from = 0;
				for (let k = 0; k < ranges.length; k++) {
					count++;
					if (matches.length >= p.max)
						continue;
					let item = { occurrence: count, index: i + 1, type: el.GetClassType() };
					let pos = hay.indexOf(needle, from);
					if (pos !== -1) {
						from = pos + needle.length;
						item.snippet = snippetAt(text, pos);
					} else {
						// Tables and other containers: fall back to the paragraph holding the match
						let paraText = "";
						try {
							let par = ranges[k].GetParagraph ? ranges[k].GetParagraph(0) : null;
							paraText = par ? (par.GetText() || "").replace(/\r/g, "") : "";
						} catch (e) {}
						let pp = (p.matchCase ? paraText : paraText.toLowerCase()).indexOf(needle);
						item.snippet = pp !== -1 ? snippetAt(paraText, pp) : (ranges[k].GetText ? ranges[k].GetText() : p.query);
					}
					matches.push(item);
				}
			}

			return {
				query: p.query,
				totalMatches: count,
				returned: matches.length,
				truncated: count > matches.length,
				matches: matches
			};
		});
	};

	return func;
})();
