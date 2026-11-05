(function(){
	let func = new RegisteredFunction({
		"name": "getTrackedChanges",
		"category": "comments-review",
		"readOnly": true,
		"text": "Read Tracked Changes",
		"description": "Lists the tracked changes (review mode revisions) in the text document, grouped as a flat list. Each change has its author, type (TextAdd = inserted text, TextRem = deleted text, ParaAdd/ParaRem = added/removed paragraph mark, TextPr/ParaPr = formatting change, RowsAdd/RowsRem/TablePr = table changes), the inserted/deleted text when available, the date (ISO 8601) and the text of the affected paragraph. Also reports whether track changes is currently switched on. Use reviewTrackedChanges to accept or reject them.",
		"parameters": {
			"type": "object",
			"properties": {
				"maxResults": {
					"type": "number",
					"description": "Maximum number of changes to return (1-500).",
					"default": 200
				}
			},
			"required": []
		},
		"examples": [
			{
				"prompt": "What did the reviewers change?",
				"arguments": {}
			}
		]
	});

	func.call = async function(params) {
		let max = params.maxResults === undefined || params.maxResults === null ? 200 : params.maxResults;
		if (typeof max !== 'number' || max < 1)
			throw new window.AgentState.ToolError('Parameter "maxResults" must be a number >= 1. Got: ' + JSON.stringify(params.maxResults));
		Asc.scope.revParams = { max: Math.min(500, Math.floor(max)) };

		return await Asc.Editor.callCommand(function(){
			let p = Asc.scope.revParams;
			let doc = Api.GetDocument();
			let report = doc.GetReviewReport() || {};
			let changes = [];
			let total = 0;
			let authors = {};
			for (let author in report) {
				if (author === "ToJSON" || typeof report[author] === "function")
					continue;
				let list = report[author];
				if (list && !Array.isArray(list))
					list = list.reviews || [];
				if (!Array.isArray(list))
					continue;
				authors[author] = list.length;
				for (let i = 0; i < list.length; i++) {
					total++;
					if (changes.length >= p.max)
						continue;
					let ch = list[i] || {};
					let item = { author: author, type: ch.Type || "Unknown" };
					if (ch.Value !== undefined && ch.Value !== null && ch.Value !== "")
						item.value = typeof ch.Value === "string" ? ch.Value : String(ch.Value);
					if (ch.Date)
						item.date = new Date(Number(ch.Date)).toISOString();
					try {
						let el = ch.ReviewedElement;
						if (el && el.GetText) {
							let t = (el.GetText() || "").replace(/\r/g, "");
							item.paragraph = t.length > 200 ? t.substring(0, 200) + "…" : t;
						}
					} catch (e) {}
					changes.push(item);
				}
			}
			return {
				trackChangesOn: doc.IsTrackRevisions ? !!doc.IsTrackRevisions() : null,
				totalChanges: total,
				byAuthor: authors,
				returned: changes.length,
				changes: changes
			};
		});
	};

	return func;
})();
