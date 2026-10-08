#!/usr/bin/env bash
# Fail if a bundled plugin loads external assets on open or registers system/background variations.
set -euo pipefail

dest=${1:?usage: check-bundle.sh <dest>}
ext='["'"'"']?(https?:)?//'
status=0

# ponytail: line-based match, tags split across lines slip through
if find "$dest" \( -name '*.html' -o -name '*.css' \) -exec grep -HnEi \
	"<script[^>]*src=$ext|<link[^>]*href=$ext|@import[^;]*$ext|url\($ext" {} +; then
	echo "check-bundle.sh: external assets found" >&2
	status=1
fi

find "$dest" -mindepth 2 -maxdepth 2 -name config.json -exec python3 -c '
import json, sys
bad = 0
for path in sys.argv[1:]:
    for v in json.load(open(path, encoding="utf-8")).get("variations", []):
        if v.get("isSystem") is True or v.get("type") in ("system", "background"):
            print(path + ": variation " + str(v.get("url")) + " is system or background")
            bad = 1
sys.exit(bad)
' {} + || status=1

exit $status
