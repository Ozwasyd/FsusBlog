#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$repo"
if [[ -z ${FSUSBLOG_TEST_DB:-} || -z ${PGHOST:-} || -z ${PGPORT:-} || -z ${PGUSER:-} ]]; then
  echo 'Set FSUSBLOG_TEST_DB to a scratch PostgreSQL maintenance DSN and set matching PGHOST, PGPORT and PGUSER.' >&2
  exit 2
fi
dotnet=${DOTNET_BIN:-dotnet}
caddy=${CADDY_BIN:-caddy}
pg=${PG_TOOLS_DIR:+"$PG_TOOLS_DIR/"}
for executable in "$dotnet" "$caddy" "${pg}psql" "${pg}createdb" "${pg}dropdb" openssl curl python3 node; do
  command -v "$executable" >/dev/null || { printf 'Missing executable: %s\n' "$executable" >&2; exit 2; }
done
server=${FSUSBLOG_NATIVE_SERVER_BUILD:-$repo/src/Server/bin/Release/net10.0}/FsusBlog.V2.Server.dll
migrate=${FSUSBLOG_NATIVE_MIGRATE_BUILD:-$repo/src/Migrate/bin/Release/net10.0}/FsusBlogV2.Migrate.dll
export FSUSBLOG_WEB_DIST=${FSUSBLOG_WEB_DIST:-$repo/src/Web/dist}
export FSUSBLOG_TEST_CHROME=${FSUSBLOG_TEST_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
for path in "$server" "$migrate" "$FSUSBLOG_WEB_DIST/index.html"; do
  [[ -f "$path" ]] || { printf 'Missing built artifact: %s\n' "$path" >&2; exit 2; }
done
[[ -x "$FSUSBLOG_TEST_CHROME" ]] || { echo 'Set FSUSBLOG_TEST_CHROME to the Chrome executable.' >&2; exit 2; }

scratch=$(mktemp -d "${TMPDIR:-/tmp}/fsus-admin-tls.XXXXXXXX")
evidence=${FSUSBLOG_TEST_EVIDENCE:-$repo/artifacts/admin-tls-$(basename "$scratch")}
server_pid=''
proxy_pid=''
created=0
public_port=''
upstream_port=''
database=fsusv2_admin_tls_$(openssl rand -hex 12)
cleanup() {
  local code=$? cleaned=yes
  trap - EXIT
  for pid in "$proxy_pid" "$server_pid"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      if kill -0 "$pid" 2>/dev/null; then cleaned=no; fi
    fi
  done
  if (( created )) && ! "${pg}dropdb" --no-password --force --maintenance-db=postgres "$database" >> "$evidence/cleanup.log" 2>&1; then
    cleaned=no
  fi
  if command -v lsof >/dev/null; then
    : > "$evidence/residual-listeners.txt"
    for port in "$public_port" "$upstream_port"; do
      if [[ -n "$port" ]] && lsof -nP -iTCP@"127.0.0.1:$port" -sTCP:LISTEN >> "$evidence/residual-listeners.txt" 2>/dev/null; then
        cleaned=no
      fi
    done
  fi
  rm -rf -- "$scratch" || cleaned=no
  if [[ "$cleaned" == no && "$code" == 0 ]]; then code=1; fi
  printf 'finish=%s\nexit=%s\ncleanup=%s\n' "$(date -u +%FT%TZ)" "$code" "$cleaned" >> "$evidence/run.txt"
  exit "$code"
}
mkdir -p "$evidence"
evidence=$(cd -- "$evidence" && pwd -P)
export FSUSBLOG_TEST_EVIDENCE="$evidence"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Hold both sockets until their distinct loopback ports have been selected.
read -r public_port upstream_port < <(python3 - <<'PY'
import socket

with socket.socket() as public, socket.socket() as upstream:
    for listener in (public, upstream):
        listener.bind(("127.0.0.1", 0))
    print(public.getsockname()[1], upstream.getsockname()[1])
PY
)
export FSUSBLOG_PUBLIC_ADDRESS="https://127.0.0.1:$public_port"
export FSUSBLOG_ADMIN_ADDRESS="https://localhost:$public_port"
export FSUSBLOG_PROXY_BIND=127.0.0.1 FSUSBLOG_UPSTREAM_PORT="$upstream_port"
export FSUSBLOG_TLS_CERTIFICATE="$scratch/public.pem" FSUSBLOG_TLS_KEY="$scratch/public.key"
export FSUSBLOG_ADMIN_TLS_CERTIFICATE="$scratch/admin.pem" FSUSBLOG_ADMIN_TLS_KEY="$scratch/admin.key"
export XDG_DATA_HOME="$scratch/caddy-data" XDG_CONFIG_HOME="$scratch/caddy-config"
export FSUSBLOG_TRUST_LOOPBACK_PROXY=true FSUSBLOG_PUBLIC_ORIGIN="$FSUSBLOG_PUBLIC_ADDRESS"
export FSUSBLOG_ADMIN_ORIGIN="$FSUSBLOG_ADMIN_ADDRESS" FSUSBLOG_ADMIN_RP_ID=localhost
export FSUSBLOG_PASSKEY_ORIGIN="$FSUSBLOG_PUBLIC_ADDRESS" FSUSBLOG_PASSKEY_RP_ID=127.0.0.1
export FSUSBLOG_TEST_SITE_URL="$FSUSBLOG_PUBLIC_ADDRESS" FSUSBLOG_TEST_ADMIN_URL="$FSUSBLOG_ADMIN_ADDRESS"
export FSUSBLOG_DB="${FSUSBLOG_TEST_DB%;};Database=$database"
export NODE_EXTRA_CA_CERTS="$scratch/ca.pem"

{
  printf 'start=%s\npublic=%s\nadmin=%s\n' "$(date -u +%FT%TZ)" "$FSUSBLOG_PUBLIC_ADDRESS" "$FSUSBLOG_ADMIN_ADDRESS"
  git rev-parse HEAD
  "$dotnet" --version
  "$caddy" version
  node --version
  "$FSUSBLOG_TEST_CHROME" --version
} > "$evidence/run.txt"

cat > "$scratch/ca.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = ca
[dn]
CN = FsusBlog isolated admin TLS fixture CA
[ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
EOF
issue_leaf() {
  local identity=$1 san=$2
  cat > "$scratch/$identity.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = FsusBlog isolated $identity TLS fixture
[leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = $san
EOF
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$scratch/$identity.key"
  openssl req -new -key "$scratch/$identity.key" -config "$scratch/$identity.cnf" -out "$scratch/$identity.csr"
  openssl x509 -req -in "$scratch/$identity.csr" -CA "$scratch/ca.pem" -CAkey "$scratch/ca.key" -CAcreateserial \
    -days 1 -sha256 -extfile "$scratch/$identity.cnf" -extensions leaf -out "$scratch/$identity.pem"
  openssl verify -CAfile "$scratch/ca.pem" "$scratch/$identity.pem"
  openssl x509 -in "$scratch/$identity.pem" -noout -subject -issuer -fingerprint -sha256
}
{
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$scratch/ca.key"
  openssl req -new -x509 -key "$scratch/ca.key" -days 1 -sha256 -config "$scratch/ca.cnf" -out "$scratch/ca.pem"
  issue_leaf public IP:127.0.0.1
  issue_leaf admin DNS:localhost
} > "$evidence/certificates.log" 2>&1
spki() {
  openssl x509 -in "$1" -noout -pubkey | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A
}
public_spki=$(spki "$FSUSBLOG_TLS_CERTIFICATE")
admin_spki=$(spki "$FSUSBLOG_ADMIN_TLS_CERTIFICATE")
[[ -n "$public_spki" && -n "$admin_spki" && "$public_spki" != "$admin_spki" ]]
export FSUSBLOG_TEST_TLS_SPKI="$public_spki,$admin_spki"

"${pg}createdb" --no-password --maintenance-db=postgres -T template0 "$database"
created=1
"$dotnet" "$migrate" plan > "$evidence/schema-plan.json"
"$dotnet" "$migrate" apply "$evidence/schema-plan.json" > "$evidence/schema.log"
"$dotnet" "$migrate" verify >> "$evidence/schema.log"
FSUSBLOG_TEST_SITE_TICKET=$("$dotnet" "$migrate" operator tls-site-fixture)
FSUSBLOG_TEST_ADMIN_TICKET=$("$dotnet" "$migrate" admin-identity bootstrap tls-admin-fixture admin.manage)
export FSUSBLOG_TEST_SITE_TICKET FSUSBLOG_TEST_ADMIN_TICKET
export FSUSBLOG_TEST_TLS_DOTNET="$dotnet" FSUSBLOG_TEST_TLS_MIGRATE="$migrate"
export FSUSBLOG_TEST_ADMIN_REVOKE="$scratch/revoke-admin"
cat > "$FSUSBLOG_TEST_ADMIN_REVOKE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
"$FSUSBLOG_TEST_TLS_DOTNET" "$FSUSBLOG_TEST_TLS_MIGRATE" admin-identity revoke-all tls-admin-fixture
EOF
chmod 700 "$FSUSBLOG_TEST_ADMIN_REVOKE"

"$caddy" validate --config deploy/Caddyfile.admin --adapter caddyfile > "$evidence/caddy-validation.log" 2>&1
"$dotnet" "$server" --urls "http://127.0.0.1:$upstream_port" > "$evidence/server.log" 2>&1 &
server_pid=$!
"$caddy" run --config deploy/Caddyfile.admin --adapter caddyfile > "$evidence/caddy.log" 2>&1 &
proxy_pid=$!
probe() {
  curl --silent --show-error --max-time 2 --noproxy '*' --cacert "$scratch/ca.pem" \
    --resolve "localhost:$public_port:127.0.0.1" --output /dev/null --write-out '%{http_code}' "$@"
}
for (( attempt=0; attempt<100; attempt++ )); do
  kill -0 "$server_pid" "$proxy_pid"
  if [[ $(probe "$FSUSBLOG_PUBLIC_ADDRESS/health/ready" 2>/dev/null) == 204 ]]; then break; fi
  sleep 0.1
done
expect() {
  local description=$1 expected=$2 observed
  shift 2
  observed=$(probe "$@")
  printf '%s %s\n' "$description" "$observed"
  [[ "$observed" == "$expected" ]]
}
{
  expect public-health 204 "$FSUSBLOG_PUBLIC_ADDRESS/health/ready"
  expect naked-upstream-denied 400 -H "Host: localhost:$public_port" \
    "http://127.0.0.1:$upstream_port/admin/identity"
  expect administrator-shell 200 "$FSUSBLOG_ADMIN_ADDRESS/admin/identity"
  expect anonymous-administrator-session 401 "$FSUSBLOG_ADMIN_ADDRESS/api/v2/admin/identity/session.aeds"
  expect public-host-administrator-denied 404 "$FSUSBLOG_PUBLIC_ADDRESS/api/v2/admin/identity/session.aeds"
  expect administrator-host-public-denied 404 "$FSUSBLOG_ADMIN_ADDRESS/"
  expect forged-forwarded-host-denied 404 -H "X-Forwarded-Host: localhost:$public_port" \
    "$FSUSBLOG_PUBLIC_ADDRESS/api/v2/admin/identity/session.aeds"
  expect administrator-authority-preserved 401 -H "X-Forwarded-Host: 127.0.0.1:$public_port" \
    -H 'X-Forwarded-Proto: http' "$FSUSBLOG_ADMIN_ADDRESS/api/v2/admin/identity/session.aeds"
  expect mismatched-tls-sni-and-host-denied 421 --http1.1 -H "Host: localhost:$public_port" \
    "$FSUSBLOG_PUBLIC_ADDRESS/admin/identity"
} > "$evidence/ingress-probes.log"

node tests/EndToEnd/admin-identity-flow.mjs
"${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" -Atc "
  select 'admin_sessions=' || count(*) from public.admin_session
  union all select 'admin_invitations=' || count(*) from public.admin_invitation
  union all select 'admin_challenges=' || count(*) from public.admin_challenge
  union all select 'offline_audit_with_actor=' || count(*) from public.admin_identity_audit where actor=session_user
" > "$evidence/after-counts.txt"
