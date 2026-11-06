/*
 * SPDX-FileCopyrightText: Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function(){
	let func = new RegisteredFunction({
		"name": "getComments",
		"category": "comments-review",
		"readOnly": true,
		"text": "Read Comments",
		"description": "Lists the comments in the workbook. For each comment returns its id (pass it to replyToComment), the sheet and cell address it belongs to (address is omitted when it cannot be determined, e.g. for comments on cells outside the used range), the cell value, author, comment text, whether it is resolved, and its replies.",
		"parameters": {
			"type": "object",
			"properties": {
				"sheet": {
					"type": "string",
					"description": "Only return comments of this sheet. Defaults to all sheets."
				},
				"includeResolved": {
					"type": "boolean",
					"description": "Also return resolved comments.",
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
				"prompt": "What do the comments in this workbook say?",
				"arguments": {}
			}
		]
	});

	func.call = async function(params) {
		if (params.sheet !== undefined && params.sheet !== null && typeof params.sheet !== 'string')
			throw new window.AgentState.ToolError('Parameter "sheet" must be a string. Got: ' + JSON.stringify(params.sheet));
		let max = params.maxResults === undefined || params.maxResults === null ? 100 : params.maxResults;
		if (typeof max !== 'number' || max < 1)
			throw new window.AgentState.ToolError('Parameter "maxResults" must be a number >= 1. Got: ' + JSON.stringify(params.maxResults));

		Asc.scope.commentParams = {
			sheet: params.sheet || null,
			includeResolved: params.includeResolved !== false,
			max: Math.min(200, Math.floor(max)),
			maxScanCells: 20000
		};

		let result = await Asc.Editor.callCommand(function(){
			let p = Asc.scope.commentParams;
			let sheets;
			if (p.sheet) {
				let ws = Api.GetSheet(p.sheet);
				if (!ws)
					return { error: "Sheet \"" + p.sheet + "\" not found. Available sheets: " + Api.GetSheets().map(function(s){ return s.GetName(); }).join(", ") };
				sheets = [ws];
			} else {
				sheets = Api.GetSheets();
			}

			function describe(c, sheetName, address) {
				let item = {
					id: c.GetId(),
					sheet: sheetName,
					author: c.GetAuthorName(),
					text: c.GetText(),
					resolved: !!c.IsSolved(),
					replies: []
				};
				if (address)
					item.address = address;
				let q = c.GetQuoteText();
				if (q !== null && q !== undefined && q !== "")
					item.cellValue = q;
				let n = c.GetRepliesCount() || 0;
				for (let r = 0; r < n; r++) {
					let reply = c.GetReply(r);
					if (reply)
						item.replies.push({ author: reply.GetAuthorName(), text: reply.GetText() });
				}
				return item;
			}

			let comments = [];
			let total = 0;
			for (let s = 0; s < sheets.length; s++) {
				let ws = sheets[s];
				let list = ws.GetComments() || [];
				if (!list.length)
					continue;
				// Map comment ids to cell addresses by scanning the used range (bounded).
				let addresses = {};
				let used = ws.GetUsedRange();
				if (used) {
					let rows = used.GetRowsCount(), cols = used.GetColumnsCount();
					if (rows * cols <= p.maxScanCells) {
						let r0 = used.GetRow() - 1, c0 = used.GetCol() - 1;
						for (let r = 0; r < rows; r++) {
							for (let c = 0; c < cols; c++) {
								let cell = ws.GetRangeByNumber(r0 + r, c0 + c);
								let cm = cell.GetComment();
								if (cm)
									addresses[cm.GetId()] = cell.GetAddress(false, false);
							}
						}
					}
				}
				for (let i = 0; i < list.length; i++) {
					let c = list[i];
					total++;
					if (!p.includeResolved && c.IsSolved())
						continue;
					if (comments.length < p.max)
						comments.push(describe(c, ws.GetName(), addresses[c.GetId()]));
				}
			}
			return { totalComments: total, returned: comments.length, comments: comments };
		});

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	func.describe = function(args, result) {
		return {
			start: toolText("Read the comments"),
			done: result && toolText("Read the comments (%1)", result.totalComments),
			phrase: toolText("read the comments")
		};
	};

	return func;
})();
