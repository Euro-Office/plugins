(function(){
	let func = new RegisteredFunction({
		"name": "insertMarkdown",
		"category": "edit-text",
		"text": "Insert Formatted Text",
		"description": "Inserts rich content written in Markdown into the text document, converting headings (#, ##, ...), bold/italic, bulleted and numbered lists, links, code and tables to real document formatting. position 'cursor' inserts at the cursor (an existing selection is collapsed, not replaced), 'replaceSelection' replaces the currently selected text, 'end' appends after the last paragraph. Prefer this over editParagraph when adding several formatted paragraphs at once.",
		"parameters": {
			"type": "object",
			"properties": {
				"markdown": {
					"type": "string",
					"description": "The content in Markdown (CommonMark + tables)."
				},
				"position": {
					"type": "string",
					"enum": ["cursor", "replaceSelection", "end"],
					"description": "Where to insert the content.",
					"default": "cursor"
				}
			},
			"required": ["markdown"]
		},
		"examples": [
			{
				"prompt": "Append a summary section with three bullet points",
				"arguments": { "markdown": "## Summary\n\n- Revenue grew 12%\n- Costs were stable\n- Hiring is on track", "position": "end" }
			},
			{
				"prompt": "Replace the selection with a formatted table",
				"arguments": { "markdown": "| Item | Price |\n|---|---|\n| Apples | 2.00 |\n| Pears | 3.50 |", "position": "replaceSelection" }
			}
		]
	});

	func.call = async function(params) {
		const positions = ["cursor", "replaceSelection", "end"];
		if (typeof params.markdown !== 'string' || params.markdown.trim() === "")
			throw new window.AgentState.ToolError('Parameter "markdown" must be a non-empty string.');
		let position = params.position === undefined || params.position === null ? "cursor" : params.position;
		if (!positions.includes(position))
			throw new window.AgentState.ToolError('Parameter "position" must be one of ' + JSON.stringify(positions) + '. Got: ' + JSON.stringify(params.position));

		let html = Asc.Library.ConvertMdToHTML(params.markdown);
		if (!html || !html.trim())
			throw new window.AgentState.ToolError('The markdown produced no content.');

		let provenanceAnchor = null;
		await Asc.Editor.callMethod("StartAction", ["GroupActions"]);
		try {
			if (position === "replaceSelection") {
				let hasSelection = await Asc.Editor.callCommand(function(){
					let range = Api.GetDocument().GetRangeBySelect();
					return !!(range && range.GetText && range.GetText() !== "");
				});
				if (!hasSelection)
					throw new window.AgentState.ToolError('Nothing is selected. Select the text to replace first (e.g. with selectText) or use position "cursor" or "end".');
			} else if (position === "cursor") {
				await Asc.Editor.callCommand(function(){
					Api.GetDocument().RemoveSelection();
				}, false);
			} else {
				await Asc.Editor.callCommand(function(){
					let doc = Api.GetDocument();
					let count = doc.GetElementsCount();
					let last = count > 0 ? doc.GetElement(count - 1) : null;
					let lastEmpty = last && last.GetClassType() === "paragraph" && (last.GetText() || "").replace(/[\r\n]/g, "") === "";
					if (!lastEmpty)
						doc.Push(Api.CreateParagraph());
					doc.MoveCursorToEnd();
				});
			}
			// Provenance: wrap the inserted paragraphs in "ai-generated"
			// content controls (after the paste, outside this undo group).
			provenanceAnchor = window.AIProvenance ? await window.AIProvenance.captureAnchor(window.AIProvenance.scopeMeta("insertMarkdown")) : null;
			await Asc.Editor.callMethod("PasteHtml", [html]);
		} finally {
			await Asc.Editor.callMethod("EndAction", ["GroupActions"]);
		}
		if (provenanceAnchor)
			await window.AIProvenance.markInsertion(provenanceAnchor, { html: html });

		return { position: position, insertedCharacters: params.markdown.length };
	};

	return func;
})();
