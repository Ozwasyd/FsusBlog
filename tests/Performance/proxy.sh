# Sourced by run.sh after creating a private per-attempt directory.
# shellcheck shell=bash disable=SC2154
own_child() {
  [[ -n "$1" && "$(ps -o ppid= -p "$1" 2>/dev/null | tr -d ' ')" == "$$" ]]
}

wait_child_exit() {
  local pid=$1 ticks=${2:-50} i
  for ((i = 0; i < ticks; i++)); do
    own_child "$pid" || return 0
    sleep 0.1
  done
}

choose_loopback_port() {
  python3 -c 'import socket
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])'
}

verify_proxy_identity() {
  node --input-type=module - "$1" "$2" <<'JS'
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

const [certificate, origin] = process.argv.slice(2);
const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
const leaf = new X509Certificate(readFileSync(certificate));
const matched = host === 'localhost' ? leaf.checkHost(host, { subject: 'never' }) : leaf.checkIP(host);
if (!matched) {
  console.error('Generated TLS leaf does not cover the expected proxy host.');
  process.exitCode = 1;
}
JS
}

start_proxy() {
  local port=${target##*:} ready config=${1:-$run/source/deploy/Caddyfile}
  local san=IP:127.0.0.1
  if [[ $target == https://localhost:* ]]; then san=DNS:localhost; fi
  proxy_ca="$run/ca.pem"
  export FSUSBLOG_PUBLIC_ADDRESS="$target" FSUSBLOG_PROXY_BIND=127.0.0.1
  export FSUSBLOG_UPSTREAM_PORT="${origin##*:}"
  export FSUSBLOG_TLS_CERTIFICATE="$run/leaf.pem" FSUSBLOG_TLS_KEY="$run/leaf.key"
  export XDG_DATA_HOME="$run/caddy-data" XDG_CONFIG_HOME="$run/caddy-config"
  cat > "$run/cert.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = FsusBlogV2 isolated benchmark
[ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
[leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = $san
EOF
  {
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$run/ca.key"
    openssl req -new -x509 -key "$run/ca.key" -days 1 -sha256 -config "$run/cert.cnf" -extensions ca -out "$proxy_ca"
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$FSUSBLOG_TLS_KEY"
    openssl req -new -key "$FSUSBLOG_TLS_KEY" -subj '/CN=FsusBlogV2 benchmark endpoint' -out "$run/leaf.csr"
    openssl x509 -req -in "$run/leaf.csr" -CA "$proxy_ca" -CAkey "$run/ca.key" -CAcreateserial \
      -days 1 -sha256 -extfile "$run/cert.cnf" -extensions leaf -out "$FSUSBLOG_TLS_CERTIFICATE"
    openssl verify -CAfile "$proxy_ca" "$FSUSBLOG_TLS_CERTIFICATE"
    verify_proxy_identity "$FSUSBLOG_TLS_CERTIFICATE" "$target" || return 1
    openssl x509 -in "$FSUSBLOG_TLS_CERTIFICATE" -noout -subject -issuer -fingerprint -sha256
  } > "$evidence/proxy-certificate.log" 2>&1
  curl_flags+=(--cacert "$proxy_ca")
  load_flags+=(-ca "$proxy_ca")
  if [[ "${FSUSBLOG_PERF_PRECONNECT_TLS:-}" == 1 ]]; then
    load_flags+=(-preconnect-tls)
  fi
  "$caddy" adapt --config "$config" --adapter caddyfile --validate --pretty \
    > "$evidence/proxy-config.json" 2> "$evidence/proxy-validation.log"
  "$caddy" run --config "$config" --adapter caddyfile > "$evidence/proxy.log" 2>&1 &
  proxy_pid=$!
  for _ in {1..100}; do
    own_child "$proxy_pid" || { echo 'Owned Caddy exited before readiness.' >&2; return 1; }
    ready=$(readiness 2>/dev/null) || ready=
    if [[ "$ready" == 204 ]] && lsof -n -P -a -p "$proxy_pid" -iTCP@127.0.0.1:"$port" -sTCP:LISTEN >/dev/null; then
      return
    fi
    sleep 0.1
  done
  echo 'Owned Caddy did not become ready.' >&2
  return 1
}

readiness() {
  curl -sS --max-time 1 --noproxy '*' "${curl_flags[@]}" -o /dev/null -w '%{http_code}' "$target/health/ready"
}
