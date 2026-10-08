#!/usr/bin/env bash
# Build the sdkjs-plugins directory for Euro-Office DocumentServer from bundle.txt.
set -euo pipefail

dest=${1:?usage: bundle.sh <dest>}
root=$(cd "$(dirname "$0")/.." && pwd)
content=$root/sdkjs-plugins/content
helper_url='https://onlyoffice.github.io/sdkjs-plugins/'

mkdir -p "$dest/v1"
cp "$root"/sdkjs-plugins/v1/{plugins.js,plugins-ui.js,plugins.css} "$dest/v1/"

while read -r name || [ -n "$name" ]; do
	case $name in '' | '#'*) continue ;; esac
	src=$content/$name
	if [ ! -f "$src/config.json" ] && [ -f "$src/src/config.json" ]; then
		src=$src/src
	fi
	if [ ! -f "$src/config.json" ]; then
		echo "bundle.sh: plugin '$name' not found in $content" >&2
		exit 1
	fi

	out=$dest/$name
	rm -rf "$out"
	mkdir -p "$out"
	cp -R "$src/." "$out/"
	# package.json marks a plugin with a build step: its committed dist/ is the runtime copy
	if [ -f "$out/package.json" ]; then
		rm -rf "$out/src"
	fi
	rm -rf "$out"/{.dev,.git*,node_modules,deploy,package.json,package-lock.json,vite.config.*,postcss.config.*}
	# store screenshots are only shown by the marketplace, which is not shipped
	rm -rf "$out/resources/store/screenshots"
	find "$out" \( -name '*.map' -o -name '.DS_Store' \) -delete

	(cd "$out" && find . -name '*.html') | while read -r html; do
		depth=$(printf '%s' "${html#./}" | tr -cd / | wc -c)
		up=../
		for ((i = 0; i < depth; i++)); do up=../$up; done
		sed "s#$helper_url#$up#g" "$out/$html" >"$out/$html.tmp"
		mv "$out/$html.tmp" "$out/$html"
	done
done <"$root/bundle.txt"
