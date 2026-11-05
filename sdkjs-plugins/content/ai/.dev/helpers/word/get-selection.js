(function(){
	let func = new RegisteredFunction({
		"name": "getSelection",
		"readOnly": true,
		"text": "Read Selection",
		"description": "Returns the text currently selected by the user in the document, together with the 1-based indexes of the paragraphs the selection covers. If nothing is selected, returns the paragraph at the cursor. Use this whenever the user refers to 'this', 'the selection', 'the selected text' or 'here'.",
		"parameters": {
			"type": "object",
			"properties": {},
			"required": []
		},
		"examples": [
			{
				"prompt": "Translate the selected text",
				"arguments": {}
			}
		]
	});

	func.call = async function() {
		return await Asc.Editor.callCommand(function(){
			let doc = Api.GetDocument();
			let range = doc.GetRangeBySelect();
			let result = { hasSelection: false, text: "" };
			let paragraphs = [];
			if (range) {
				result.text = range.GetText() || "";
				result.hasSelection = result.text.length > 0;
				try {
					paragraphs = range.GetAllParagraphs ? range.GetAllParagraphs() : [];
				} catch (e) {}
			}
			if (!result.hasSelection) {
				let par = doc.GetCurrentParagraph();
				if (par) {
					paragraphs = [par];
					result.currentParagraphText = par.GetText();
				}
			}
			let indexes = [];
			let total = doc.GetElementsCount();
			for (let j = 0; j < paragraphs.length; j++) {
				let pos = -1;
				try {
					pos = paragraphs[j].GetPosInParent ? paragraphs[j].GetPosInParent() : -1;
					let parent = paragraphs[j].GetParent ? paragraphs[j].GetParent() : null;
					if (parent && parent.GetClassType && parent.GetClassType() !== "document")
						pos = -1;
				} catch (e) {
					pos = -1;
				}
				if (pos >= 0 && pos < total)
					indexes.push(pos + 1);
			}
			if (indexes.length)
				result.paragraphIndexes = indexes;
			return result;
		});
	};

	return func;
})();
