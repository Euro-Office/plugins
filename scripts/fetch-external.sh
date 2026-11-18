#!/bin/sh
# SPDX-FileCopyrightText: Euro-Office contributors
# SPDX-License-Identifier: Apache-2.0
#
# Downloads the plugins listed in external.json from the GitHub releases of their
# own repositories into sdkjs-plugins/content/<name>, so bundling, packing and the
# store treat them like plugins kept in this repository.
#
# external.json: [{ "name": "a11ycheck", "repo": "Euro-Office/plugin-a11ycheck", "tag": "v0.1.0" }]
# Needs gh and jq. Private repositories need GH_TOKEN.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
manifest=${1:-$root/external.json}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

jq -r '.[] | [.name, .repo, .tag] | @tsv' "$manifest" | while IFS="$(printf '\t')" read -r name repo tag; do
	dest=$root/sdkjs-plugins/content/$name
	if [ -n "$(git -C "$root" ls-files "sdkjs-plugins/content/$name")" ]; then
		echo "fetch-external.sh: $name is also kept in this repository, remove one of them" >&2
		exit 1
	fi
	gh release download "$tag" --repo "$repo" --pattern "$name.plugin" --dir "$tmp"
	rm -rf "$dest"
	mkdir -p "$dest"
	unzip -q "$tmp/$name.plugin" -d "$dest"
	if [ ! -f "$dest/config.json" ]; then
		echo "fetch-external.sh: $repo $tag $name.plugin has no config.json at its root" >&2
		exit 1
	fi
	echo "$name $tag from $repo"
done
