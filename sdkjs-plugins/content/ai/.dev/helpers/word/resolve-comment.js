(function(){
	let func = new RegisteredFunction({
		"name": "resolveComment",
		"text": "Resolve Comment",
		"description": "Marks a comment in the text document as resolved, or reopens it with resolved=false. Get comment ids from getComments.",
		"parameters": {
			"type": "object",
			"properties": {
				"commentId": {
					"type": "string",
					"description": "Id of the comment, as returned by getComments."
				},
				"resolved": {
					"type": "boolean",
					"description": "true to resolve the comment, false to reopen it.",
					"default": true
				}
			},
			"required": ["commentId"]
		},
		"examples": [
			{
				"prompt": "Resolve comment 5",
				"arguments": { "commentId": "5", "resolved": true }
			}
		]
	});

	func.call = async function(params) {
		if ((typeof params.commentId !== 'string' && typeof params.commentId !== 'number') || String(params.commentId) === "")
			throw new window.AgentState.ToolError('Parameter "commentId" is required. Call getComments to get comment ids.');
		if (params.resolved !== undefined && params.resolved !== null && typeof params.resolved !== 'boolean')
			throw new window.AgentState.ToolError('Parameter "resolved" must be a boolean.');

		Asc.scope.resolveParams = { id: String(params.commentId), resolved: params.resolved !== false };

		let result = await Asc.Editor.callCommand(function(){
			let p = Asc.scope.resolveParams;
			let comment = Api.GetDocument().GetCommentById(p.id);
			if (!comment)
				return { error: "Comment \"" + p.id + "\" not found. Call getComments to get valid ids." };
			comment.SetSolved(p.resolved);
			return { commentId: p.id, resolved: !!comment.IsSolved() };
		});

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	return func;
})();
