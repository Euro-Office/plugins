(function(){
	let func = new RegisteredFunction({
		"name": "selectText",
		"category": "core",
		"readOnly": true,
		"text": "Select Text",
		"description": "Selects the n-th occurrence of a text in the main body of the document and moves the view to it, so the user can see it or so a selection-based tool (e.g. replaceSelection, rewriteText, commentText, insertMarkdown with position 'replaceSelection') can act on it. Does not change the content. Occurrences are numbered from 1 in document order, exactly as returned by findText.",
		"parameters": {
			"type": "object",
			"properties": {
				"query": {
					"type": "string",
					"description": "Text to search for (plain text)."
				},
				"occurrence": {
					"type": "number",
					"description": "1-based number of the match to select.",
					"default": 1
				},
				"matchCase": {
					"type": "boolean",
					"description": "Case-sensitive search. Use the same value as in findText.",
					"default": false
				}
			},
			"required": ["query"]
		},
		"examples": [
			{
				"prompt": "Show me where 'Termination' is mentioned the second time",
				"arguments": { "query": "Termination", "occurrence": 2 }
			}
		]
	});

	func.call = async function(params) {
		if (typeof params.query !== 'string' || params.query === "")
			throw new window.AgentState.ToolError('Parameter "query" must be a non-empty string. Got: ' + JSON.stringify(params.query));
		let occurrence = params.occurrence === undefined || params.occurrence === null ? 1 : params.occurrence;
		if (typeof occurrence !== 'number' || occurrence < 1)
			throw new window.AgentState.ToolError('Parameter "occurrence" must be a number >= 1. Got: ' + JSON.stringify(params.occurrence));

		Asc.scope.selectParams = {
			query: params.query,
			matchCase: params.matchCase === true,
			occurrence: Math.floor(occurrence)
		};

		let result = await Asc.Editor.callCommand(function(){
			let p = Asc.scope.selectParams;
			let doc = Api.GetDocument();
			let total = doc.GetElementsCount();
			let count = 0;
			let found = null;
			for (let i = 0; i < total; i++) {
				let el = doc.GetElement(i);
				if (!el || typeof el.Search !== "function")
					continue;
				let ranges = el.Search(p.query, p.matchCase) || [];
				for (let k = 0; k < ranges.length; k++) {
					count++;
					if (!found && count === p.occurrence)
						found = { range: ranges[k], index: i + 1 };
				}
			}
			if (!found) {
				if (count === 0)
					return { error: "No match for \"" + p.query + "\"." };
				return { error: "Occurrence " + p.occurrence + " does not exist; there are only " + count + " matches for \"" + p.query + "\"." };
			}
			found.range.Select();
			return {
				selected: found.range.GetText ? found.range.GetText() : p.query,
				occurrence: p.occurrence,
				index: found.index,
				totalMatches: count
			};
		});

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	return func;
})();
