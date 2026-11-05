#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Starts a Document Server for the e2e test with this plugin mounted and the
# example app (test documents) enabled. Port 80 is used on purpose: the
# example app builds document URLs from the browser's host, and the document
# service fetches them from inside the container, so host and container port
# must match.
#
#   E2E_IMAGE  image to use (default onlyoffice/documentserver:9.1; the
#              Euro-Office image ghcr.io/euro-office/documentserver works too)
#   E2E_NAME   container name (default ai-plugin-e2e)
set -eu

IMAGE="${E2E_IMAGE:-onlyoffice/documentserver:9.1}"
NAME="${E2E_NAME:-ai-plugin-e2e}"
GUID="{9DC93CDB-B576-4F0C-B55E-FCC9C48DD007}"
PLUGIN_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"

# Euro-Office keeps its files under /var/www/euro-office, ONLYOFFICE under /var/www/onlyoffice.
case "$IMAGE" in
	*euro-office*) WWW=/var/www/euro-office; ETC=/etc/euro-office ;;
	*) WWW=/var/www/onlyoffice; ETC=/etc/onlyoffice ;;
esac

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p 80:80 \
	-e JWT_ENABLED=false \
	-e ALLOW_PRIVATE_IP_ADDRESS=true \
	-e EXAMPLE_ENABLED=true \
	--add-host=host.docker.internal:host-gateway \
	-v "$PLUGIN_DIR:$WWW/documentserver/sdkjs-plugins/$GUID:ro" \
	"$IMAGE" >/dev/null

echo "waiting for the document service..."
until curl -fsS -m 3 http://localhost/healthcheck 2>/dev/null | grep -q true; do sleep 3; done

# Register the mounted plugin with the example app and make sure it runs.
docker exec "$NAME" sh -c "
	f=$ETC/documentserver-example/default.json
	sed -i 's#\"pluginsData\": \[\]#\"pluginsData\": [\"http://localhost/sdkjs-plugins/$GUID/config.json\"]#' \$f
	supervisorctl restart ds:example >/dev/null 2>&1 || supervisorctl start ds:example >/dev/null 2>&1 || true
"
until [ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://localhost/example/)" = 200 ]; do sleep 2; done
echo "ready: http://localhost/example/"
