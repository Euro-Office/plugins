(function(){
	let func = new RegisteredFunction({
		"name": "manageSheet",
		"category": "structure",
		"text": "Manage Sheets",
		"description": "Adds, renames, deletes or activates a worksheet. 'add' creates a new sheet called 'name' (it becomes the active sheet); 'rename' renames sheet 'name' to 'newName'; 'delete' removes sheet 'name' and all its data (the last remaining sheet cannot be deleted); 'activate' switches to sheet 'name'. Sheet names must be 1-31 characters and must not contain : \\ / ? * [ ]. Returns the resulting list of sheets and the active sheet.",
		"parameters": {
			"type": "object",
			"properties": {
				"action": {
					"type": "string",
					"enum": ["add", "rename", "delete", "activate"],
					"description": "What to do."
				},
				"name": {
					"type": "string",
					"description": "Name of the sheet to add, or of the existing sheet to rename/delete/activate."
				},
				"newName": {
					"type": "string",
					"description": "New sheet name (required for 'rename')."
				}
			},
			"required": ["action", "name"]
		},
		"examples": [
			{
				"prompt": "Add a sheet called Summary",
				"arguments": { "action": "add", "name": "Summary" }
			},
			{
				"prompt": "Rename Sheet1 to Data 2025",
				"arguments": { "action": "rename", "name": "Sheet1", "newName": "Data 2025" }
			}
		]
	});

	func.call = async function(params) {
		const actions = ["add", "rename", "delete", "activate"];
		if (!actions.includes(params.action))
			throw new window.AgentState.ToolError('Parameter "action" must be one of ' + JSON.stringify(actions) + '. Got: ' + JSON.stringify(params.action));
		if (typeof params.name !== 'string' || params.name.trim() === "")
			throw new window.AgentState.ToolError('Parameter "name" must be a non-empty string.');

		function checkName(n, field) {
			if (n.length > 31)
				throw new window.AgentState.ToolError('Parameter "' + field + '" is too long (' + n.length + ' characters); sheet names have at most 31 characters.');
			if (/[:\\\/?*\[\]]/.test(n))
				throw new window.AgentState.ToolError('Parameter "' + field + '" contains a character that is not allowed in sheet names (: \\ / ? * [ ]).');
			if (/^'|'$/.test(n))
				throw new window.AgentState.ToolError('Sheet names cannot start or end with an apostrophe.');
		}

		if (params.action === "add")
			checkName(params.name, "name");
		if (params.action === "rename") {
			if (typeof params.newName !== 'string' || params.newName.trim() === "")
				throw new window.AgentState.ToolError('Parameter "newName" is required for action "rename".');
			checkName(params.newName, "newName");
		}

		Asc.scope.sheetParams = { action: params.action, name: params.name, newName: params.newName || null };

		let result;
		await Asc.Editor.callMethod("StartAction", ["GroupActions"]);
		try {
			result = await Asc.Editor.callCommand(function(){
				let p = Asc.scope.sheetParams;
				function names() {
					return Api.GetSheets().map(function(s){ return s.GetName(); });
				}
				function find(n) {
					let list = Api.GetSheets();
					for (let i = 0; i < list.length; i++) {
						if (list[i].GetName().toLowerCase() === String(n).toLowerCase())
							return list[i];
					}
					return null;
				}
				let ws = find(p.name);
				switch (p.action) {
					case "add":
						if (ws)
							return { error: "A sheet named \"" + p.name + "\" already exists." };
						Api.AddSheet(p.name);
						break;
					case "rename":
						if (!ws)
							return { error: "Sheet \"" + p.name + "\" not found. Available sheets: " + names().join(", ") };
						let other = find(p.newName);
						if (other && other.GetName() !== ws.GetName())
							return { error: "A sheet named \"" + p.newName + "\" already exists." };
						ws.SetName(p.newName);
						break;
					case "delete":
						if (!ws)
							return { error: "Sheet \"" + p.name + "\" not found. Available sheets: " + names().join(", ") };
						if (Api.GetSheets().length <= 1)
							return { error: "Cannot delete the only sheet of the workbook." };
						ws.Delete();
						break;
					case "activate":
						if (!ws)
							return { error: "Sheet \"" + p.name + "\" not found. Available sheets: " + names().join(", ") };
						ws.SetActive();
						break;
				}
				let active = Api.GetActiveSheet();
				return { action: p.action, sheets: names(), activeSheet: active ? active.GetName() : null };
			});
		} finally {
			await Asc.Editor.callMethod("EndAction", ["GroupActions"]);
		}

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	return func;
})();
