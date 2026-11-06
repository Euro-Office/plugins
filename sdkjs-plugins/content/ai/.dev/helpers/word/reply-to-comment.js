/*
 * SPDX-FileCopyrightText: Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function(){
	let func = new RegisteredFunction({
		"name": "replyToComment",
		"category": "comments-review",
		"text": "Reply to Comment",
		"description": "Adds a reply to an existing comment in the text document. The reply is appended after existing replies and is authored as 'AI Assistant (model)'. Get comment ids from getComments.",
		"parameters": {
			"type": "object",
			"properties": {
				"commentId": {
					"type": "string",
					"description": "Id of the comment to reply to, as returned by getComments."
				},
				"text": {
					"type": "string",
					"description": "Reply text."
				}
			},
			"required": ["commentId", "text"]
		},
		"examples": [
			{
				"prompt": "Answer the comment about the budget that it was updated",
				"arguments": { "commentId": "3", "text": "Done - the budget table now uses the Q3 figures." }
			}
		]
	});

	func.call = async function(params) {
		if ((typeof params.commentId !== 'string' && typeof params.commentId !== 'number') || String(params.commentId) === "")
			throw new window.AgentState.ToolError('Parameter "commentId" is required. Call getComments to get comment ids.');
		if (typeof params.text !== 'string' || params.text.trim() === "")
			throw new window.AgentState.ToolError('Parameter "text" must be a non-empty string.');

		Asc.scope.replyParams = { author: window.AIProvenance ? window.AIProvenance.commentAuthor(window.AIProvenance.scopeMeta("replyToComment")) : "AI", id: String(params.commentId), text: params.text };

		let result = await Asc.Editor.callCommand(function(){
			let p = Asc.scope.replyParams;
			let comment = Api.GetDocument().GetCommentById(p.id);
			if (!comment)
				return { error: "Comment \"" + p.id + "\" not found. Call getComments to get valid ids." };
			comment.AddReply(p.text, p.author, "uid-ai");
			return { commentId: p.id, replies: comment.GetRepliesCount() };
		});

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	func.describe = function() {
		return { start: toolText("Reply to a comment"), done: toolText("Replied to a comment"), phrase: toolText("replied to a comment") };
	};

	return func;
})();
