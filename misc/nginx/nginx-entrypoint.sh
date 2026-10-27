#!/bin/sh
set -e

SSL_DIR="/etc/nginx/ssl"
CERT_FILE="$SSL_DIR/fullchain.pem"
KEY_FILE="$SSL_DIR/privkey.pem"

# Generate self-signed certificates if they don't exist
if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
    echo "SSL certificates not found. Generating self-signed certificates for development..."

    # Install openssl if not available
    if ! command -v openssl >/dev/null 2>&1; then
        apk add --no-cache openssl >/dev/null 2>&1
    fi

    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$KEY_FILE" \
        -out "$CERT_FILE" \
        -subj "/CN=localhost"

    echo "Self-signed certificates generated successfully."
fi

# Resolver for the runtime hostname lookups in site.conf. The container runtime
# already wrote the right servers into /etc/resolv.conf, so use those rather
# than guessing between Docker and Podman addresses.
if [ -z "$NGINX_RESOLVER" ]; then
    NGINX_RESOLVER=$(awk '/^nameserver/ { printf "%s ", $2 }' /etc/resolv.conf)
    [ -z "$NGINX_RESOLVER" ] && NGINX_RESOLVER="127.0.0.11"
fi
export NGINX_RESOLVER
echo "Using DNS resolver(s): $NGINX_RESOLVER"

NGINX_HTTPS_PORT="${NGINX_HTTPS_PORT:-4433}"
case "$NGINX_HTTPS_PORT" in
    ''|*[!0-9]*) echo "NGINX_HTTPS_PORT must be a port number" >&2; exit 1 ;;
esac
if [ "$NGINX_HTTPS_PORT" -lt 1 ] || [ "$NGINX_HTTPS_PORT" -gt 65535 ]; then
    echo "NGINX_HTTPS_PORT must be between 1 and 65535" >&2
    exit 1
fi
NGINX_HTTP_REDIRECT=''
if [ "${APP_MODE:-prod}" != "dev" ]; then
    NGINX_HTTP_REDIRECT="if (\$scheme = http) { return 308 https://\$host:${NGINX_HTTPS_PORT}\$request_uri; }"
fi
export NGINX_HTTP_REDIRECT
# Do not log query strings: device WebSocket URLs may contain short-lived JWTs.
export NGINX_ENVSUBST_FILTER='^(NGINX_RESOLVER|NGINX_HTTP_REDIRECT)$'

# Execute the original nginx entrypoint
exec /docker-entrypoint.sh "$@"
