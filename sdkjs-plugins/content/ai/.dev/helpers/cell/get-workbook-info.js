(function(){
	let func = new RegisteredFunction({
		"name": "getWorkbookInfo",
		"category": "core",
		"readOnly": true,
		"text": "Inspect Workbook",
		"description": "Returns an overview of the open spreadsheet: all sheet names with their used ranges, the active sheet, and the address of the user's current selection. Call this first when you need to know where data lives before reading or changing cells.",
		"parameters": {
			"type": "object",
			"properties": {},
			"required": []
		},
		"examples": [
			{
				"prompt": "What sheets are in this workbook?",
				"arguments": {}
			}
		]
	});

	func.call = async function() {
		return await Asc.Editor.callCommand(function(){
			let active = Api.GetActiveSheet();
			let sheets = [];
			let all = Api.GetSheets();
			for (let i = 0; i < all.length; i++) {
				let ws = all[i];
				let item = { name: ws.GetName() };
				try {
					let used = ws.GetUsedRange();
					if (used) {
						item.usedRange = used.GetAddress(false, false);
						item.rows = used.GetRowsCount ? used.GetRowsCount() : undefined;
						item.columns = used.GetColumnsCount ? used.GetColumnsCount() : undefined;
					}
				} catch (e) {}
				sheets.push(item);
			}
			let selection = Api.GetSelection();
			return {
				activeSheet: active ? active.GetName() : null,
				selection: selection ? selection.GetAddress(false, false) : null,
				sheets: sheets
			};
		});
	};

	return func;
})();
