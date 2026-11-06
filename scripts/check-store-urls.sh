#!/bin/sh
# SPDX-FileCopyrightText: Euro-Office contributors
# SPDX-License-Identifier: Apache-2.0
#
# Fails if the plugin store loads anything from ONLYOFFICE services.
# Docs (*.md) and third-party code (vendor/, licenses/) are not checked.
cd "$(dirname "$0")/.." || exit 1
if grep -rnE 'onlyoffice\.github\.io|plugins-services\.onlyoffice\.com|github\.com/ONLYOFFICE' store \
	--exclude-dir=vendor --exclude-dir=licenses --exclude='*.md'; then
	echo 'store/ references ONLYOFFICE services, see above' >&2
	exit 1
fi
