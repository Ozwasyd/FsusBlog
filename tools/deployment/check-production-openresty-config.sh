#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
openRestyImage="docker.io/openresty/openresty@sha256:427d94fea0c24b099e7891e8d1b7976f6d008e2d427e56bab725c8b8b293795b"
containerName="fsusblog-openresty-config-$PPID-$$"
workRoot="$(mktemp -d "${TMPDIR:-/tmp}/fsusblog-openresty-config.XXXXXX")"

Cleanup() {
    docker rm -f -v "$containerName" >/dev/null 2>&1 || true
    rm -r -- "$workRoot"
}

trap Cleanup EXIT INT TERM

command -v docker >/dev/null 2>&1 || {
    printf '%s\n' '[production-openresty] Docker is required' >&2
    exit 1
}
command -v openssl >/dev/null 2>&1 || {
    printf '%s\n' '[production-openresty] OpenSSL is required' >&2
    exit 1
}

mkdir -p "$workRoot/fsusblog" "$workRoot/certificates"
printf '%s\n' 'server 127.0.0.1:8081;' >"$workRoot/fsusblog/active-upstream.conf"
printf '%s\n' 'fsusblog:x:1654:1654:FsusBlog gateway:/nonexistent:/sbin/nologin' >"$workRoot/passwd"
printf '%s\n' 'fsusblog:x:1654:' >"$workRoot/group"
openssl req \
    -x509 \
    -nodes \
    -newkey rsa:2048 \
    -days 1 \
    -subj '/CN=fsus.blog' \
    -keyout "$workRoot/certificates/privkey.pem" \
    -out "$workRoot/certificates/fullchain.pem" \
    >/dev/null 2>&1

docker run \
    --rm \
    --name "$containerName" \
    --network none \
    --read-only \
    --tmpfs /usr/local/openresty/nginx/client_body_temp:rw,noexec,nosuid,size=2m \
    --tmpfs /usr/local/openresty/nginx/fastcgi_temp:rw,noexec,nosuid,size=2m \
    --tmpfs /usr/local/openresty/nginx/logs:rw,noexec,nosuid,size=2m \
    --tmpfs /usr/local/openresty/nginx/proxy_temp:rw,noexec,nosuid,size=2m \
    --tmpfs /usr/local/openresty/nginx/scgi_temp:rw,noexec,nosuid,size=2m \
    --tmpfs /usr/local/openresty/nginx/uwsgi_temp:rw,noexec,nosuid,size=2m \
    --tmpfs /var/run:rw,noexec,nosuid,size=1m \
    --mount "type=bind,src=$root/ops/gateway/production-openresty.conf,dst=/etc/openresty/nginx.conf,readonly" \
    --mount "type=bind,src=$workRoot/fsusblog,dst=/etc/openresty/fsusblog,readonly" \
    --mount "type=bind,src=$workRoot/certificates,dst=/etc/letsencrypt/live/fsus.blog,readonly" \
    --mount "type=bind,src=$workRoot/passwd,dst=/etc/passwd,readonly" \
    --mount "type=bind,src=$workRoot/group,dst=/etc/group,readonly" \
    --entrypoint openresty \
    "$openRestyImage" \
    -t \
    -c /etc/openresty/nginx.conf

printf '[production-openresty] ok image=%s config=%s\n' \
    "$openRestyImage" \
    'ops/gateway/production-openresty.conf'
