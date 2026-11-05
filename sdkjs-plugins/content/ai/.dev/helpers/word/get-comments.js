(function(){
	let func = new RegisteredFunction({
		"name": "getComments",
		"readOnly": true,
		"text": "Read Comments",
		"description": "Lists the comments of the text document in document order. For each comment returns its id (pass it to replyToComment/resolveComment), author, creation time (ISO 8601, UTC), comment text, the quoted document text it is anchored to, whether it is resolved, and its replies (author, text). Use it to summarise review feedback or to decide which comments to answer or resolve.",
		"parameters": {
			"type": "object",
			"properties": {
				"includeResolved": {
					"type": "boolean",
					"description": "Also return comments that are already marked as resolved.",
					"default": true
				},
				"maxResults": {
					"type": "number",
					"description": "Maximum number of comments to return (1-200).",
					"default": 100
				}
			},
			"required": []
		},
		"examples": [
			{
				"prompt": "Summarize the open review comments",
				"arguments": { "includeResolved": false }
			}
		]
	});

	func.call = async function(params) {
		let max = params.maxResults === undefined || params.maxResults === null ? 100 : params.maxResults;
		if (typeof max !== 'number' || max < 1)
			throw new window.AgentState.ToolError('Parameter "maxResults" must be a number >= 1. Got: ' + JSON.stringify(params.maxResults));

		Asc.scope.commentParams = {
			includeResolved: params.includeResolved !== false,
			max: Math.min(200, Math.floor(max))
		};

		return await Asc.Editor.callCommand(function(){
			let p = Asc.scope.commentParams;
			let all = Api.GetDocument().GetAllComments() || [];
			let comments = [];
			let open = 0;
			for (let i = 0; i < all.length; i++) {
				let c = all[i];
				let solved = !!c.IsSolved();
				if (!solved)
					open++;
				if (solved && !p.includeResolved)
					continue;
				if (comments.length >= p.max)
					continue;
				let item = {
					id: c.GetId(),
					author: c.GetAuthorName(),
					text: c.GetText(),
					quotedText: c.GetQuoteText() || "",
					resolved: solved,
					replies: []
				};
				try {
					let t = c.GetTimeUTC();
					if (t)
						item.time = new Date(Number(t)).toISOString();
				} catch (e) {}
				let n = c.GetRepliesCount() || 0;
				for (let r = 0; r < n; r++) {
					let reply = c.GetReply(r);
					if (reply)
						item.replies.push({ author: reply.GetAuthorName(), text: reply.GetText() });
				}
				comments.push(item);
			}
			return {
				totalComments: all.length,
				openComments: open,
				returned: comments.length,
				comments: comments
			};
		});
	};

	return func;
})();
