(function(){
	let func = new RegisteredFunction({
		"name": "getSelection",
		"category": "core",
		"readOnly": true,
		"text": "Read Selection",
		"description": "Returns the text currently selected by the user in the document, together with the 1-based indexes of the top-level elements (paragraphs, or the table / content control holding the selected text) the selection covers. If nothing is selected, returns the paragraph at the cursor. Use this whenever the user refers to 'this', 'the selection', 'the selected text' or 'here'.",
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
			// Top-level element index (1-based) of a paragraph. A paragraph in a
			// table cell or block content control reports the table / control
			// that holds it in the document body; GetPosInParent() alone is the
			// position inside the innermost container. Paragraphs outside the
			// body (headers, shapes) get no index. ApiParagraph has no
			// GetParent(): candidates are the paragraph and every table and
			// content control around it, and the one found at its own position
			// in the document (same internal id) is the top-level element.
			function topLevelIndex(par) {
				let candidates = [];
				let seen = {};
				let queue = [par];
				while (queue.length && candidates.length < 32) {
					let el = queue.shift();
					let id = el.GetInternalId ? el.GetInternalId() : null;
					if (!id || seen[id])
						continue;
					seen[id] = true;
					candidates.push(el);
					let table = el.GetParentTable ? el.GetParentTable() : null;
					let control = el.GetParentContentControl ? el.GetParentContentControl() : null;
					if (table)
						queue.push(table);
					if (control)
						queue.push(control);
				}
				for (let k = 0; k < candidates.length; k++) {
					let pos = candidates[k].GetPosInParent ? candidates[k].GetPosInParent() : -1;
					let top = (typeof pos === "number" && pos >= 0) ? doc.GetElement(pos) : null;
					if (top && top.GetInternalId && top.GetInternalId() === candidates[k].GetInternalId())
						return pos + 1;
				}
				return -1;
			}

			let indexes = [];
			for (let j = 0; j < paragraphs.length; j++) {
				let index = -1;
				try {
					index = topLevelIndex(paragraphs[j]);
				} catch (e) {
					index = -1;
				}
				if (index > 0 && indexes.indexOf(index) === -1)
					indexes.push(index);
			}
			if (indexes.length)
				result.paragraphIndexes = indexes;
			return result;
		});
	};

	return func;
})();
