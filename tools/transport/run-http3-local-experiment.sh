#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${FSUSBLOG_HTTP3_EVIDENCE_DIR:-${ROOT_DIR}/.tmp/http3-local-evidence}"
LAB_PROJECT="${ROOT_DIR}/tools/transport/FsusBlog.Http3Lab/FsusBlog.Http3Lab.csproj"
LAB_DLL="${ROOT_DIR}/tools/transport/FsusBlog.Http3Lab/bin/Release/net10.0/FsusBlog.Http3Lab.dll"
CURL_H3_IMAGE="ghcr.io/macbre/curl-http3@sha256:c3a360869a4e132180f458f83af2ce67b873b2302739eda27274dad4f62155f8"
HTTP3_PORT="${FSUSBLOG_HTTP3_PORT:-5443}"
CERT_PASSWORD="http3-local-ephemeral"
CERT_DIR="$(mktemp -d /tmp/fsusblog-http3-cert.XXXXXX)"
SERVER_PID=""

cleanup() {
    if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
        kill "${SERVER_PID}" 2>/dev/null || true
        wait "${SERVER_PID}" 2>/dev/null || true
    fi
    find "${CERT_DIR}" -type f -delete 2>/dev/null || true
    rmdir "${CERT_DIR}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

mkdir -p "${OUTPUT_DIR}"
dotnet build "${LAB_PROJECT}" -c Release --nologo >"${OUTPUT_DIR}/build.log"

if [[ -n "${FSUSBLOG_MSQUIC_LIB_DIR:-}" ]]; then
    export LD_LIBRARY_PATH="${FSUSBLOG_MSQUIC_LIB_DIR}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
fi

set +e
dotnet "${LAB_DLL}" preflight >"${OUTPUT_DIR}/preflight.json"
PREFLIGHT_EXIT=$?
set -e
if [[ ${PREFLIGHT_EXIT} -ne 0 ]]; then
    echo "HTTP/3 preflight failed; see ${OUTPUT_DIR}/preflight.json" >&2
    exit 3
fi

command -v openssl >/dev/null
command -v docker >/dev/null
DOCKER_BRIDGE_IP="${FSUSBLOG_HTTP3_DOCKER_BRIDGE_IP:-$(ip -4 addr show docker0 | awk '/inet / { split($2, address, "/"); print address[1]; exit }')}"
if [[ -z "${DOCKER_BRIDGE_IP}" ]]; then
    echo "docker0 IPv4 address is required for the isolated curl/h3 client" >&2
    exit 3
fi

openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
    -subj '/CN=FsusBlog Local HTTP3 CA' \
    -keyout "${CERT_DIR}/ca.key" -out "${CERT_DIR}/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -sha256 -nodes \
    -subj '/CN=fsusblog.test' \
    -addext "subjectAltName=DNS:fsusblog.test,DNS:localhost,IP:127.0.0.1,IP:${DOCKER_BRIDGE_IP}" \
    -keyout "${CERT_DIR}/server.key" -out "${CERT_DIR}/server.csr" >/dev/null 2>&1
openssl x509 -req -sha256 -days 2 -in "${CERT_DIR}/server.csr" \
    -CA "${CERT_DIR}/ca.crt" -CAkey "${CERT_DIR}/ca.key" -CAcreateserial \
    -copy_extensions copy -out "${CERT_DIR}/server.crt" >/dev/null 2>&1
openssl pkcs12 -export -out "${CERT_DIR}/server.pfx" \
    -inkey "${CERT_DIR}/server.key" -in "${CERT_DIR}/server.crt" \
    -certfile "${CERT_DIR}/ca.crt" -passout "pass:${CERT_PASSWORD}" >/dev/null 2>&1

export RuntimeTuning__Http3__Enabled=true
export RuntimeTuning__Http3__Port="${HTTP3_PORT}"
export RuntimeTuning__Http3__CertificatePath="${CERT_DIR}/server.pfx"
export RuntimeTuning__Http3__CertificatePassword="${CERT_PASSWORD}"

dotnet "${LAB_DLL}" serve \
    --https-port "${HTTP3_PORT}" \
    --listen-host "${DOCKER_BRIDGE_IP}" \
    --allow-non-loopback true >"${OUTPUT_DIR}/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 40); do
    if curl --http2 --cacert "${CERT_DIR}/ca.crt" -fsS \
        "https://${DOCKER_BRIDGE_IP}:${HTTP3_PORT}/transport/public-aot" >/dev/null; then
        break
    fi
    sleep 0.25
done
kill -0 "${SERVER_PID}"

run_probe() {
    local output_name="$1"
    shift
    dotnet "${LAB_DLL}" probe \
        --ca-cert "${CERT_DIR}/ca.crt" \
        --server-pid "${SERVER_PID}" \
        "$@" >"${OUTPUT_DIR}/${output_name}.json"
}

run_expected_failure_probe() {
    local output_name="$1"
    shift
    set +e
    dotnet "${LAB_DLL}" probe "$@" >"${OUTPUT_DIR}/${output_name}.json"
    local exit_code=$?
    set -e
    if [[ ${exit_code} -ne 4 ]]; then
        echo "expected partial probe ${output_name} to exit 4, got ${exit_code}" >&2
        exit 4
    fi
}

BASE_URL="https://${DOCKER_BRIDGE_IP}:${HTTP3_PORT}"
run_probe h2-public-reuse --url "${BASE_URL}/transport/public-aot" --version 2 --policy exact --requests 12 --concurrency 2 --connection-mode reuse
run_probe h3-public-reuse --url "${BASE_URL}/transport/public-aot" --version 3 --policy exact --requests 12 --concurrency 2 --connection-mode reuse
run_probe h3-large-cold --url "${BASE_URL}/transport/large" --version 3 --policy exact --requests 8 --concurrency 4 --connection-mode cold
run_probe h3-wasm --url "${BASE_URL}/transport/static/decoder.wasm" --version 3 --policy exact --requests 8 --concurrency 4 --connection-mode reuse
run_probe h3-search --url "${BASE_URL}/transport/search" --version 3 --policy exact --requests 8 --concurrency 4 --connection-mode reuse
run_probe h3-aeds --url "${BASE_URL}/transport/aeds" --version 3 --policy exact --requests 8 --concurrency 4 --connection-mode reuse
run_probe h3-upload --url "${BASE_URL}/transport/upload" --method PUT --body-bytes 1048576 --version 3 --policy exact --requests 4 --concurrency 2 --connection-mode reuse
run_probe h2-notification --url "${BASE_URL}/transport/notification" --version 2 --policy exact --requests 4 --concurrency 1 --connection-mode reuse
run_expected_failure_probe h3-cancel --url "${BASE_URL}/transport/large" --version 3 --policy exact --requests 2 --concurrency 1 --connection-mode cold --cancel-after-ms 1 --ca-cert "${CERT_DIR}/ca.crt"
run_expected_failure_probe h3-timeout --url "${BASE_URL}/transport/large" --version 3 --policy exact --requests 2 --concurrency 1 --connection-mode cold --timeout-ms 1 --ca-cert "${CERT_DIR}/ca.crt"
run_expected_failure_probe tls-rejected --url "${BASE_URL}/transport/public-aot" --version 3 --policy exact --requests 1 --concurrency 1 --connection-mode cold --timeout-ms 5000

docker run --rm --add-host fsusblog.test:host-gateway \
    -v "${CERT_DIR}/ca.crt:/tmp/ca.crt:ro" \
    --entrypoint /usr/local/bin/curl "${CURL_H3_IMAGE}" \
    --http3-only --cacert /tmp/ca.crt -sS -o /dev/null \
    -w '{"schema":"fsusblog.http3-curl-probe.v1","status":"complete","http_version":"%{http_version}","status_code":%{http_code}}\n' \
    "https://fsusblog.test:${HTTP3_PORT}/transport/public-aot" >"${OUTPUT_DIR}/curl-h3.json"

docker run --rm --user 0 --cap-add NET_ADMIN --add-host fsusblog.test:host-gateway \
    -v "${CERT_DIR}/ca.crt:/tmp/ca.crt:ro" \
    --entrypoint /bin/sh "${CURL_H3_IMAGE}" -lc \
    "apk add --no-cache iptables >/dev/null && iptables -A OUTPUT -p udp --dport ${HTTP3_PORT} -j REJECT && /usr/local/bin/curl --http3 --happy-eyeballs-timeout-ms 100 --connect-timeout 5 --cacert /tmp/ca.crt -sS -o /dev/null -w '{\"schema\":\"fsusblog.http3-udp-fallback.v1\",\"status\":\"complete\",\"udp\":\"blocked\",\"http_version\":\"%{http_version}\",\"status_code\":%{http_code}}\\n' https://fsusblog.test:${HTTP3_PORT}/transport/public-aot" \
    >"${OUTPUT_DIR}/udp-fallback.json"

docker run --rm --user 0 --cap-add NET_ADMIN --add-host fsusblog.test:host-gateway \
    -v "${CERT_DIR}/ca.crt:/tmp/ca.crt:ro" \
    -v "${OUTPUT_DIR}:/evidence" \
    --entrypoint /bin/sh "${CURL_H3_IMAGE}" -lc \
    "apk add --no-cache iproute2 >/dev/null; printf 'condition,delay_ms,loss_percent,round,requested,http_version,status,time_total,exit_code\\n' > /evidence/netem.csv; for condition in baseline:0:0 rtt40:40:0 rtt100:100:0 rtt200:200:0 loss1:0:1 loss3:0:3 loss5:0:5; do name=\${condition%%:*}; rest=\${condition#*:}; delay=\${rest%%:*}; loss=\${rest##*:}; tc qdisc replace dev eth0 root netem delay \"\${delay}ms\" loss \"\${loss}%\"; for round in 1 2 3; do for protocol in h2 h3; do if [ \"\${protocol}\" = h2 ]; then version_flag=--http2; else version_flag=--http3-only; fi; output=\$(/usr/local/bin/curl \"\${version_flag}\" --connect-timeout 10 --max-time 30 --cacert /tmp/ca.crt -sS -o /dev/null -w '%{http_version},%{http_code},%{time_total}' https://fsusblog.test:${HTTP3_PORT}/transport/aeds 2>/dev/null); exit_code=\$?; printf '%s,%s,%s,%s,%s,%s,%s\\n' \"\${name}\" \"\${delay}\" \"\${loss}\" \"\${round}\" \"\${protocol}\" \"\${output}\" \"\${exit_code}\" >> /evidence/netem.csv; done; done; done; tc qdisc del dev eth0 root"

kill "${SERVER_PID}"
wait "${SERVER_PID}" 2>/dev/null || true
SERVER_PID=""

if env -u LD_LIBRARY_PATH dotnet "${LAB_DLL}" preflight >/dev/null 2>&1; then
    printf '%s\n' '{"schema":"fsusblog.http3-msquic-missing-fallback.v1","status":"skipped","reason":"quic_available_without_injected_library"}' \
        >"${OUTPUT_DIR}/missing-msquic-fallback.json"
else
    env -u LD_LIBRARY_PATH dotnet "${LAB_DLL}" serve --https-port "${HTTP3_PORT}" \
        >"${OUTPUT_DIR}/fallback-server.log" 2>&1 &
    SERVER_PID=$!
    for _ in $(seq 1 40); do
        if curl --http2 --cacert "${CERT_DIR}/ca.crt" -fsS "https://localhost:${HTTP3_PORT}/transport/public-aot" >/dev/null; then
            break
        fi
        sleep 0.25
    done
    curl --http2 --cacert "${CERT_DIR}/ca.crt" -sS -o /dev/null \
        -w '{"schema":"fsusblog.http3-msquic-missing-fallback.v1","status":"complete","quic_supported":false,"http_version":"%{http_version}","status_code":%{http_code}}\n' \
        "https://localhost:${HTTP3_PORT}/transport/public-aot" \
        >"${OUTPUT_DIR}/missing-msquic-fallback.json"
fi

node "${ROOT_DIR}/tools/transport/summarize-http3-local-evidence.mjs" \
    --input "${OUTPUT_DIR}" \
    --output "${OUTPUT_DIR}/summary.json"
echo "HTTP/3 local evidence: ${OUTPUT_DIR}/summary.json"
