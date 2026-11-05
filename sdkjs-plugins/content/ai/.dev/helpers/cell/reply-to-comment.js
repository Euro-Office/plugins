(function(){
	let func = new RegisteredFunction({
		"name": "replyToComment",
		"category": "comments-review",
		"text": "Reply to Comment",
		"description": "Adds a reply to an existing cell comment in the workbook, or marks it as resolved. The reply is appended after existing replies and is authored as 'AI Assistant (model)'. Get comment ids from getComments.",
		"parameters": {
			"type": "object",
			"properties": {
				"commentId": {
					"type": "string",
					"description": "Id of the comment, as returned by getComments."
				},
				"text": {
					"type": "string",
					"description": "Reply text. May be omitted when only changing 'resolved'."
				},
				"resolved": {
					"type": "boolean",
					"description": "Optionally mark the comment as resolved (true) or reopen it (false)."
				}
			},
			"required": ["commentId"]
		},
		"examples": [
			{
				"prompt": "Reply to the comment on B4 that the value was checked, and resolve it",
				"arguments": { "commentId": "1", "text": "Checked against the invoice - value is correct.", "resolved": true }
			}
		]
	});

	func.call = async function(params) {
		if ((typeof params.commentId !== 'string' && typeof params.commentId !== 'number') || String(params.commentId) === "")
			throw new window.AgentState.ToolError('Parameter "commentId" is required. Call getComments to get comment ids.');
		let hasText = typeof params.text === 'string' && params.text.trim() !== "";
		if (params.text !== undefined && params.text !== null && typeof params.text !== 'string')
			throw new window.AgentState.ToolError('Parameter "text" must be a string.');
		if (params.resolved !== undefined && params.resolved !== null && typeof params.resolved !== 'boolean')
			throw new window.AgentState.ToolError('Parameter "resolved" must be a boolean.');
		if (!hasText && typeof params.resolved !== 'boolean')
			throw new window.AgentState.ToolError('Provide a non-empty "text" for the reply and/or "resolved".');

		Asc.scope.replyParams = {
			author: window.AIProvenance ? window.AIProvenance.commentAuthor(window.AIProvenance.scopeMeta("replyToComment")) : "AI",
			id: String(params.commentId),
			text: hasText ? params.text : null,
			resolved: typeof params.resolved === 'boolean' ? params.resolved : null
		};

		let result = await Asc.Editor.callCommand(function(){
			let p = Asc.scope.replyParams;
			let comment = Api.GetCommentById(p.id);
			if (!comment)
				return { error: "Comment \"" + p.id + "\" not found. Call getComments to get valid ids." };
			if (p.text !== null)
				comment.AddReply(p.text, p.author, "uid-ai");
			if (p.resolved !== null)
				comment.SetSolved(p.resolved);
			// Re-read: ApiComment wraps a copy of the comment data.
			let fresh = Api.GetCommentById(p.id) || comment;
			return { commentId: p.id, replies: fresh.GetRepliesCount(), resolved: !!fresh.IsSolved() };
		});

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	return func;
})();
