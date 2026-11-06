// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// ApiCustomProperties (sdkjs common/apiBase.js): Get(name) / Add(name, value).

export function createCustomProperties(store = {}) {
	return {
		store,
		api: {
			GetClassType: () => "customProperties",
			Get: (n) => (n in store ? store[n] : null),
			Add: (n, v) => { store[n] = v; return true; }
		}
	};
}
