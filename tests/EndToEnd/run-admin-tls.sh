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
public_host=127.0.0.1
admin_host=localhost
public_san=IP:127.0.0.1
admin_san=DNS:localhost
if [[ ${FSUSBLOG_TEST_SITE_RECOVERY:-0} == 1 || ${FSUSBLOG_TEST_SITE_REFRESH:-0} == 1 ]]; then
  public_host=localhost
  admin_host=127.0.0.1
  public_san=DNS:localhost
  admin_san=IP:127.0.0.1
fi
export FSUSBLOG_PUBLIC_ADDRESS="https://$public_host:$public_port"
export FSUSBLOG_ADMIN_ADDRESS="https://$admin_host:$public_port"
export FSUSBLOG_PROXY_BIND=127.0.0.1 FSUSBLOG_UPSTREAM_PORT="$upstream_port"
export FSUSBLOG_TLS_CERTIFICATE="$scratch/public.pem" FSUSBLOG_TLS_KEY="$scratch/public.key"
export FSUSBLOG_ADMIN_TLS_CERTIFICATE="$scratch/admin.pem" FSUSBLOG_ADMIN_TLS_KEY="$scratch/admin.key"
export XDG_DATA_HOME="$scratch/caddy-data" XDG_CONFIG_HOME="$scratch/caddy-config"
export FSUSBLOG_TRUST_LOOPBACK_PROXY=true FSUSBLOG_PUBLIC_ORIGIN="$FSUSBLOG_PUBLIC_ADDRESS"
export FSUSBLOG_ADMIN_ORIGIN="$FSUSBLOG_ADMIN_ADDRESS" FSUSBLOG_ADMIN_RP_ID="$admin_host"
export FSUSBLOG_PASSKEY_ORIGIN="$FSUSBLOG_PUBLIC_ADDRESS" FSUSBLOG_PASSKEY_RP_ID="$public_host"
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
  issue_leaf public "$public_san"
  issue_leaf admin "$admin_san"
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
if [[ ${FSUSBLOG_TEST_ADMIN_INBOX:-0} == 1 ]]; then
  "${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" -f tests/EndToEnd/admin-inbox-fixture.sql > "$evidence/admin-inbox-fixture.log"
  shasum -a 256 tests/EndToEnd/admin-inbox-fixture.sql >> "$evidence/run.txt"
  if [[ ${FSUSBLOG_TEST_ADMIN_INBOX_REPLY:-0} == 1 ]]; then
    export FSUSBLOG_ADMIN_INBOX_REPLIES=true
  else
    export FSUSBLOG_ADMIN_INBOX_REPLIES=false
  fi
fi
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
permission_fixture() {
  local path=$1 action=$2 capability=$3
  cat > "$path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
"\$FSUSBLOG_TEST_TLS_DOTNET" "\$FSUSBLOG_TEST_TLS_MIGRATE" admin-identity $action tls-admin-fixture $capability
EOF
  chmod 700 "$path"
}
if [[ ${FSUSBLOG_TEST_SITE_RECOVERY:-0} == 1 ]]; then
  export FSUSBLOG_RECOVERY_KEY_PEPPER_HEX="$(openssl rand -hex 32)" FSUSBLOG_TOTP_KEY_HEX="$(openssl rand -hex 32)"
  FSUSBLOG_TEST_SITE_RECOVERY_PEER_TICKET=$("$dotnet" "$migrate" operator tls-site-recovery-peer)
  export FSUSBLOG_TEST_SITE_RECOVERY_PEER_TICKET
  export FSUSBLOG_TEST_SITE_RECOVERY_DATABASE="$database"
  export FSUSBLOG_TEST_SITE_RECOVERY_PROBE="$scratch/recovery-reservation"
  cat > "$FSUSBLOG_TEST_SITE_RECOVERY_PROBE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ $FSUSBLOG_TEST_SITE_RECOVERY_DATABASE =~ ^fsusv2_admin_tls_[a-f0-9]{24}$ ]]
exec "${PG_TOOLS_DIR:+"$PG_TOOLS_DIR/"}psql" -X -w -v ON_ERROR_STOP=1 -d "$FSUSBLOG_TEST_SITE_RECOVERY_DATABASE" -Atc "
  select count(*) from public.site_recovery_key k
  join public.blog_user u on u.id=k.user_id
  join public.site_recovery_rebind r on r.user_id=u.id
  where u.name='tls-site-fixture' and k.version=2 and k.used_at is null
    and r.completed_at is null and u.generation=r.generation
"
EOF
  chmod 700 "$FSUSBLOG_TEST_SITE_RECOVERY_PROBE"
elif [[ ${FSUSBLOG_TEST_SITE_REFRESH:-0} == 1 ]]; then
  export FSUSBLOG_SITE_PERSISTENT_REFRESH=true FSUSBLOG_TOTP_KEY_HEX="$(openssl rand -hex 32)"
  FSUSBLOG_TEST_SITE_REFRESH_PEER_TICKET=$("$dotnet" "$migrate" operator tls-site-refresh-peer)
  export FSUSBLOG_TEST_SITE_REFRESH_PEER_TICKET
  export FSUSBLOG_TEST_SITE_REFRESH_DATABASE="$database"
  export FSUSBLOG_TEST_SITE_REFRESH_PROBE="$scratch/refresh-boundary"
  cat > "$FSUSBLOG_TEST_SITE_REFRESH_PROBE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ $FSUSBLOG_TEST_SITE_REFRESH_DATABASE =~ ^fsusv2_admin_tls_[a-f0-9]{24}$ ]]
case $1 in
  expire-access)
    statement="
      with expired as (
        update public.user_session s set expires_at=clock_timestamp()-interval '1 second'
        from public.blog_user u, public.site_session_refresh r
        where u.name='tls-site-fixture' and s.user_id=u.id and s.digest=r.access_digest
        returning 1
      )
      select count(*) from expired
    " ;;
  expire-grace)
    statement="
      with aged as (
        update public.site_session_refresh r set rotated_at=clock_timestamp()-interval '6 seconds'
        from public.user_session s, public.blog_user u
        where r.access_digest=s.digest and s.user_id=u.id and u.name='tls-site-fixture'
        returning r.family_id
      ), tombstoned as (
        update public.site_session_refresh_tombstone t set used_at=clock_timestamp()-interval '6 seconds'
        from aged where t.family_id=aged.family_id
        returning 1
      )
      select count(*) from tombstoned
    " ;;
  *) exit 2 ;;
esac
exec "${PG_TOOLS_DIR:+"$PG_TOOLS_DIR/"}psql" -X -w -v ON_ERROR_STOP=1 \
  -d "$FSUSBLOG_TEST_SITE_REFRESH_DATABASE" -Atc "$statement"
EOF
  chmod 700 "$FSUSBLOG_TEST_SITE_REFRESH_PROBE"
elif [[ ${FSUSBLOG_TEST_ADMIN_SITE_PAGES:-0} == 1 ]]; then
  unset FSUSBLOG_TEST_ADMIN_AUDIT_GRANT FSUSBLOG_TEST_ADMIN_AUDIT_REVOKE
  export FSUSBLOG_TEST_ADMIN_SITE_PAGES_GRANT="$scratch/grant-system-config" FSUSBLOG_TEST_ADMIN_SITE_PAGES_REVOKE="$scratch/revoke-system-config"
  permission_fixture "$FSUSBLOG_TEST_ADMIN_SITE_PAGES_GRANT" grant system.config
  permission_fixture "$FSUSBLOG_TEST_ADMIN_SITE_PAGES_REVOKE" revoke system.config
  mkdir "$scratch/pages"
  export FSUSBLOG_SITE_PAGES=$(cd "$scratch/pages" && pwd -P)
  printf '# Verified about\n\n<script>literal</script>\n' > "$FSUSBLOG_SITE_PAGES/about.md"
  for slug in privacy guidelines copyright; do printf '# Verified %s\n' "$slug" > "$FSUSBLOG_SITE_PAGES/$slug.md"; done
elif [[ ${FSUSBLOG_TEST_ADMIN_TAXONOMY:-0} == 1 ]]; then
  unset FSUSBLOG_TEST_ADMIN_AUDIT_GRANT FSUSBLOG_TEST_ADMIN_AUDIT_REVOKE
  unset FSUSBLOG_TEST_ADMIN_MODERATOR_GRANT FSUSBLOG_TEST_ADMIN_MODERATOR_REVOKE \
    FSUSBLOG_TEST_ADMIN_MODERATOR_SEED FSUSBLOG_TEST_ADMIN_MODERATOR_BODY
  export FSUSBLOG_TEST_ADMIN_TAXONOMY_GRANT="$scratch/grant-taxonomy"
  export FSUSBLOG_TEST_ADMIN_TAXONOMY_REVOKE="$scratch/revoke-taxonomy"
  export FSUSBLOG_TEST_ADMIN_TAXONOMY_SEED="$scratch/seed-taxonomy"
  export FSUSBLOG_TEST_ADMIN_TAXONOMY_DATABASE="$database"
  permission_fixture "$FSUSBLOG_TEST_ADMIN_TAXONOMY_GRANT" grant article.write
  permission_fixture "$FSUSBLOG_TEST_ADMIN_TAXONOMY_REVOKE" revoke article.write
  cat > "$FSUSBLOG_TEST_ADMIN_TAXONOMY_SEED" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ $FSUSBLOG_TEST_ADMIN_TAXONOMY_DATABASE =~ ^fsusv2_admin_tls_[a-f0-9]{24}$ ]]
exec "${PG_TOOLS_DIR:+"$PG_TOOLS_DIR/"}psql" -X -w -v ON_ERROR_STOP=1 -d "$FSUSBLOG_TEST_ADMIN_TAXONOMY_DATABASE" \
  -f tests/EndToEnd/admin-taxonomy-fixture.sql
EOF
  chmod 700 "$FSUSBLOG_TEST_ADMIN_TAXONOMY_SEED"
elif [[ ${FSUSBLOG_TEST_ADMIN_MODERATION:-0} == 1 ]]; then
  unset FSUSBLOG_TEST_ADMIN_AUDIT_GRANT FSUSBLOG_TEST_ADMIN_AUDIT_REVOKE
  export FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS=true
  FSUSBLOG_TEST_ADMIN_MODERATOR_SITE_TICKET=$("$dotnet" "$migrate" operator tls-moderation-fixture)
  export FSUSBLOG_TEST_ADMIN_MODERATOR_SITE_TICKET
  export FSUSBLOG_TEST_ADMIN_MODERATOR_DATABASE="$database"
  export FSUSBLOG_TEST_ADMIN_MODERATOR_GRANT="$scratch/grant-comment-moderate"
  export FSUSBLOG_TEST_ADMIN_MODERATOR_REVOKE="$scratch/revoke-comment-moderate"
  export FSUSBLOG_TEST_ADMIN_MODERATOR_SEED="$scratch/create-pending-comment"
  export FSUSBLOG_TEST_ADMIN_MODERATOR_BODY='Moderation fixture <strong data-moderation-fixture="1">literal</strong>'
  permission_fixture "$FSUSBLOG_TEST_ADMIN_MODERATOR_GRANT" grant comment.moderate
  permission_fixture "$FSUSBLOG_TEST_ADMIN_MODERATOR_REVOKE" revoke comment.moderate
  cat > "$FSUSBLOG_TEST_ADMIN_MODERATOR_SEED" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec node tests/EndToEnd/admin-moderation-seed.mjs
EOF
  chmod 700 "$FSUSBLOG_TEST_ADMIN_MODERATOR_SEED"
else
  unset FSUSBLOG_TEST_ADMIN_MODERATOR_GRANT FSUSBLOG_TEST_ADMIN_MODERATOR_REVOKE \
    FSUSBLOG_TEST_ADMIN_MODERATOR_SEED FSUSBLOG_TEST_ADMIN_MODERATOR_BODY
  export FSUSBLOG_TEST_ADMIN_AUDIT_GRANT="$scratch/grant-admin-audit-read"
  export FSUSBLOG_TEST_ADMIN_AUDIT_REVOKE="$scratch/revoke-admin-audit-read"
  permission_fixture "$FSUSBLOG_TEST_ADMIN_AUDIT_GRANT" grant audit.read
  permission_fixture "$FSUSBLOG_TEST_ADMIN_AUDIT_REVOKE" revoke audit.read
fi

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
  expect naked-upstream-denied 400 -H "Host: $admin_host:$public_port" \
    "http://127.0.0.1:$upstream_port/admin/identity"
  expect public-host-administrator-denied 404 "$FSUSBLOG_PUBLIC_ADDRESS/api/v2/admin/identity/session.aeds"
  expect forged-forwarded-host-denied 404 -H "X-Forwarded-Host: $admin_host:$public_port" \
    "$FSUSBLOG_PUBLIC_ADDRESS/api/v2/admin/identity/session.aeds"
  if [[ ${FSUSBLOG_TEST_SITE_RECOVERY:-0} != 1 && ${FSUSBLOG_TEST_SITE_REFRESH:-0} != 1 ]]; then
    expect administrator-shell 200 "$FSUSBLOG_ADMIN_ADDRESS/admin/identity"
    expect anonymous-administrator-session 401 "$FSUSBLOG_ADMIN_ADDRESS/api/v2/admin/identity/session.aeds"
    expect administrator-host-public-denied 404 "$FSUSBLOG_ADMIN_ADDRESS/"
    expect administrator-authority-preserved 401 -H "X-Forwarded-Host: $public_host:$public_port" \
      -H 'X-Forwarded-Proto: http' "$FSUSBLOG_ADMIN_ADDRESS/api/v2/admin/identity/session.aeds"
    expect mismatched-tls-sni-and-host-denied 421 --http1.1 -H "Host: $admin_host:$public_port" \
      "$FSUSBLOG_PUBLIC_ADDRESS/admin/identity"
  fi
} > "$evidence/ingress-probes.log"

if [[ ${FSUSBLOG_TEST_SITE_RECOVERY:-0} == 1 ]]; then
  node tests/EndToEnd/site-recovery-flow.mjs
  "${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" -Atc "
    select 'own_key_rotated_and_spent=' || count(*) from public.site_recovery_key k
      join public.blog_user u on u.id=k.user_id
      where u.name='tls-site-fixture' and k.version=2 and k.used_at is not null
    union all select 'own_rebind_completed=' || count(*) from public.site_recovery_rebind r
      join public.blog_user u on u.id=r.user_id
      where u.name='tls-site-fixture' and r.completed_at is not null and u.generation=r.generation+1
    union all select 'own_replacement_credential=' || count(*) from public.passkey_credential c
      join public.blog_user u on u.id=c.user_id where u.name='tls-site-fixture'
    union all select 'own_totp_preserved=' || count(*) from public.mfa_totp t
      join public.blog_user u on u.id=t.user_id where u.name='tls-site-fixture'
  " > "$evidence/site-recovery-counts.txt"
  for check in own_key_rotated_and_spent own_rebind_completed own_replacement_credential own_totp_preserved; do
    grep -Fxq "$check=1" "$evidence/site-recovery-counts.txt"
  done
elif [[ ${FSUSBLOG_TEST_SITE_REFRESH:-0} == 1 ]]; then
  node tests/EndToEnd/site-refresh-flow.mjs
else
  node tests/EndToEnd/admin-identity-flow.mjs
fi
"${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" -Atc "
  select 'admin_sessions=' || count(*) from public.admin_session
  union all select 'admin_invitations=' || count(*) from public.admin_invitation
  union all select 'admin_challenges=' || count(*) from public.admin_challenge
  union all select 'offline_audit_with_actor=' || count(*) from public.admin_identity_audit where actor=session_user
  union all select 'offline_ops_permission_changes=' || count(*) from public.admin_identity_audit
    where actor=session_user and action in ('grant:audit.read','revoke:audit.read')
  union all select 'offline_moderation_permission_changes=' || count(*) from public.admin_identity_audit
    where actor=session_user and action in ('grant:comment.moderate','revoke:comment.moderate')
  union all select 'offline_taxonomy_permission_changes=' || count(*) from public.admin_identity_audit
    where actor=session_user and action in ('grant:article.write','revoke:article.write')
" > "$evidence/after-counts.txt"
if [[ ${FSUSBLOG_TEST_ADMIN_MODERATION:-0} == 1 ]]; then
  "${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" -Atc "
    select 'approved=' || count(*) from public.admin_comment_moderation where next_status=1
    union all select 'rejected=' || count(*) from public.admin_comment_moderation where next_status=2
    union all select 'attributed_decisions=' || count(*)
      from public.admin_comment_moderation m
      join public.admin_principal p on p.id=m.principal_id
      join public.comment c on c.article_id=m.article_id and c.id=m.comment_id
      join public.admin_comment_claim claim on claim.article_id=m.article_id and claim.comment_id=m.comment_id
      where p.handle='tls-admin-fixture' and m.reason='Moderation integration fixture'
        and m.previous_status=0 and c.moderation_status=m.next_status
        and claim.principal_id=p.id and claim.state=3
    union all select 'active_claims=' || count(*) from public.admin_comment_claim where state=1
  " > "$evidence/moderation-audit-counts.txt"
  grep -Fxq 'approved=1' "$evidence/moderation-audit-counts.txt"
  grep -Fxq 'rejected=1' "$evidence/moderation-audit-counts.txt"
  grep -Fxq 'attributed_decisions=2' "$evidence/moderation-audit-counts.txt"
  grep -Fxq 'active_claims=0' "$evidence/moderation-audit-counts.txt"
fi
