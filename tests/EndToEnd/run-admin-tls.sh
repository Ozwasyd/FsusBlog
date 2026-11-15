#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$repo"
if [[ -z ${FSUSBLOG_TEST_DB:-} || -z ${PGHOST:-} || -z ${PGPORT:-} || -z ${PGUSER:-} ]]; then
  echo 'Set FSUSBLOG_TEST_DB to a scratch PostgreSQL maintenance DSN and set matching PGHOST, PGPORT and PGUSER.' >&2
  exit 2
fi
comment_edit=${FSUSBLOG_TEST_COMMENT_EDIT:-0}
comment_report=${FSUSBLOG_TEST_COMMENT_REPORT:-0}
if [[ ( $comment_edit != 0 && $comment_edit != 1 ) || ( $comment_report != 0 && $comment_report != 1 ) ]]; then
  echo 'Set FSUSBLOG_TEST_COMMENT_EDIT and FSUSBLOG_TEST_COMMENT_REPORT to 0 or 1.' >&2
  exit 2
fi
if [[ ( $comment_edit == 1 || $comment_report == 1 ) &&
  ( ${FSUSBLOG_TEST_ADMIN_MODERATION:-0} != 1 || ${FSUSBLOG_TEST_COMMENT_REPLY:-0} != 1 ) ]]; then
  echo 'The comment edit and report fixtures require the moderation and comment reply fixtures.' >&2
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
if [[ ${FSUSBLOG_TEST_WIDE_SEARCH:-0} == 1 ]]; then
  FSUSBLOG_TEST_SITE_TICKET=$("$dotnet" "$migrate" operator browser-author)
  export FSUSBLOG_WIDE_SEARCH_CORPUS=true
  "${pg}psql" -X -w -v ON_ERROR_STOP=1 -v fixture_count=26002 -d "$database" \
    -f tests/EndToEnd/public-fixture.sql -f tests/Fixtures/publication-rights.sql > "$evidence/wide-search-fixture.log"
  shasum -a 256 tests/EndToEnd/public-fixture.sql tests/Fixtures/publication-rights.sql >> "$evidence/run.txt"
else
  FSUSBLOG_TEST_SITE_TICKET=$("$dotnet" "$migrate" operator tls-site-fixture)
fi
if [[ ${FSUSBLOG_TEST_ARTICLE_READ_PROOF:-0} == 1 ]]; then
  export FSUSBLOG_ARTICLE_READ_PROOF=true FSUSBLOG_TEST_READ_PROOF_DATABASE="$database"
  export FSUSBLOG_RUNTIME_EVIDENCE_CONTROL="$scratch" FSUSBLOG_RUNTIME_EVIDENCE_OUTPUT="$evidence/article-read-proof-runtime.ndjson"
  "${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" \
    -c "ALTER DATABASE $database SET log_parameter_max_length = 0" \
    -c "ALTER DATABASE $database SET log_parameter_max_length_on_error = 0" > "$evidence/article-read-proof-postgres.log"
  "$dotnet" "$migrate" article read-proof-schema >> "$evidence/article-read-proof-postgres.log"
fi
if [[ ${FSUSBLOG_TEST_ADMIN_INBOX:-0} == 1 ]]; then
  "${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" -f tests/EndToEnd/admin-inbox-fixture.sql > "$evidence/admin-inbox-fixture.log"
  shasum -a 256 tests/EndToEnd/admin-inbox-fixture.sql >> "$evidence/run.txt"
  if [[ ${FSUSBLOG_TEST_ADMIN_INBOX_REPLY:-0} == 1 ]]; then
    export FSUSBLOG_ADMIN_INBOX_REPLIES=true
  else
    export FSUSBLOG_ADMIN_INBOX_REPLIES=false
  fi
  if [[ ${FSUSBLOG_TEST_ADMIN_INBOX_STATUS:-0} == 1 ]]; then
    export FSUSBLOG_ADMIN_INBOX_STATUS=true
  else
    export FSUSBLOG_ADMIN_INBOX_STATUS=false
  fi
  if [[ ${FSUSBLOG_TEST_ADMIN_INBOX_NOTICE:-0} == 1 ]]; then
    export FSUSBLOG_ADMIN_INBOX_NOTICE=true
  else
    export FSUSBLOG_ADMIN_INBOX_NOTICE=false
  fi
  if [[ ${FSUSBLOG_TEST_ADMIN_INBOX_SHARED:-0} == 1 ]]; then
    export FSUSBLOG_ADMIN_INBOX_SHARED_READ=true
  else
    export FSUSBLOG_ADMIN_INBOX_SHARED_READ=false
  fi
  if [[ ${FSUSBLOG_TEST_ADMIN_INBOX_ACTIVITY:-0} == 1 ]]; then
    export FSUSBLOG_ADMIN_INBOX_ACTIVITY_ORDER=true
  else
    export FSUSBLOG_ADMIN_INBOX_ACTIVITY_ORDER=false
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
elif [[ ${FSUSBLOG_TEST_ADMIN_ARTICLE_ROLLBACK:-0} == 1 || ${FSUSBLOG_TEST_ADMIN_ARTICLE_ARCHIVE:-0} == 1 ]]; then
  unset FSUSBLOG_TEST_ADMIN_AUDIT_GRANT FSUSBLOG_TEST_ADMIN_AUDIT_REVOKE
  export FSUSBLOG_ADMIN_ARTICLE_ROLLBACK=true
  export FSUSBLOG_TEST_ADMIN_ARTICLE_ROLLBACK_GRANT="$scratch/grant-article-rollback"
  permission_fixture "$FSUSBLOG_TEST_ADMIN_ARTICLE_ROLLBACK_GRANT" grant article.write
  "$dotnet" "$migrate" admin-article-rollback schema > "$evidence/admin-article-rollback-migration.log"
  "${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" -f tests/EndToEnd/admin-article-rollback-fixture.sql > "$evidence/admin-article-rollback-fixture.log"
  printf '%s\n' '{"responsibleParty":"Historical publisher","basis":"Recorded original publication approval","reference":"fixture-review-2026-001"}' |
    "$dotnet" "$migrate" article-responsibility record 1 1 >> "$evidence/admin-article-rollback-migration.log"
  "$dotnet" "$migrate" verify >> "$evidence/admin-article-rollback-migration.log"
  shasum -a 256 tests/EndToEnd/admin-article-rollback-fixture.sql >> "$evidence/run.txt"
elif [[ ${FSUSBLOG_TEST_ADMIN_APPEARANCE:-0} == 1 ]]; then
  unset FSUSBLOG_TEST_ADMIN_AUDIT_GRANT FSUSBLOG_TEST_ADMIN_AUDIT_REVOKE
  export FSUSBLOG_TEST_APPEARANCE_GRANT="$scratch/grant-appearance" FSUSBLOG_TEST_APPEARANCE_REVOKE="$scratch/revoke-appearance"
  permission_fixture "$FSUSBLOG_TEST_APPEARANCE_GRANT" grant system.config
  permission_fixture "$FSUSBLOG_TEST_APPEARANCE_REVOKE" revoke system.config
  export FSUSBLOG_APPEARANCE_ROOT=$(cd "$scratch" && pwd -P)/appearance FSUSBLOG_APPEARANCE_ACTIVATION=true
  fontsource=src/Web/node_modules/@fontsource/google-sans
  font_fixture="$fontsource/files/google-sans-latin-400-normal.woff2"
  font_format=zip theme_format=zip
  if [[ ${FSUSBLOG_TEST_ADMIN_APPEARANCE_FSFONT:-0} == 1 ]]; then font_format=fsfont-v1; fi
  if [[ ${FSUSBLOG_TEST_ADMIN_APPEARANCE_FSTHEME:-0} == 1 ]]; then theme_format=fstheme-v1-palette; fi
  python3 tests/EndToEnd/appearance-fixture.py "$FSUSBLOG_APPEARANCE_ROOT" "$font_fixture" "$fontsource/LICENSE" online "$font_format" "$theme_format" > "$evidence/appearance-baseline.log"
  if [[ ${FSUSBLOG_TEST_ADMIN_APPEARANCE_FSTHEME:-0} == 1 ]]; then
    theme_archives=("$FSUSBLOG_APPEARANCE_ROOT"/*.fstheme)
    [[ ${#theme_archives[@]} == 1 && -f "${theme_archives[0]}" ]]
    legacy_theme_name=${theme_archives[0]##*/}
    export FSUSBLOG_TEST_ADMIN_APPEARANCE_FSTHEME_SHA256=${legacy_theme_name%.fstheme}
  fi
  "$dotnet" "$migrate" appearance schema > "$evidence/appearance-schema.log"
  "$dotnet" "$migrate" appearance schema >> "$evidence/appearance-schema.log"
  appearance_before=$(shasum -a 256 "$FSUSBLOG_APPEARANCE_ROOT/appearance.json")
elif [[ ${FSUSBLOG_TEST_ADMIN_SITE_PAGES:-0} == 1 ]]; then
  unset FSUSBLOG_TEST_ADMIN_AUDIT_GRANT FSUSBLOG_TEST_ADMIN_AUDIT_REVOKE
  export FSUSBLOG_TEST_ADMIN_SITE_PAGES_GRANT="$scratch/grant-system-config" FSUSBLOG_TEST_ADMIN_SITE_PAGES_REVOKE="$scratch/revoke-system-config"
  permission_fixture "$FSUSBLOG_TEST_ADMIN_SITE_PAGES_GRANT" grant system.config
  permission_fixture "$FSUSBLOG_TEST_ADMIN_SITE_PAGES_REVOKE" revoke system.config
  mkdir "$scratch/pages"
  export FSUSBLOG_SITE_PAGES=$(cd "$scratch/pages" && pwd -P)
  printf '# Verified about\n\n<script>literal</script>\n' > "$FSUSBLOG_SITE_PAGES/about.md"
  for slug in privacy guidelines copyright; do printf '# Verified %s\n' "$slug" > "$FSUSBLOG_SITE_PAGES/$slug.md"; done
  if [[ -n ${FSUSBLOG_TEST_ADMIN_RISK_CASE:-} ]]; then
    export FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS=false FSUSBLOG_SIGNED_IN_COMMENT_REPLIES=false
    risk_root=0 risk_reply=0
    case "$FSUSBLOG_TEST_ADMIN_RISK_CASE" in
      disabled) ;;
      reply-only) FSUSBLOG_SIGNED_IN_COMMENT_REPLIES=true ;;
      root-only) FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS=true; risk_root=1 ;;
      notice-absent|notice-present)
        FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS=true FSUSBLOG_SIGNED_IN_COMMENT_REPLIES=true
        risk_root=1 risk_reply=2
        if [[ $FSUSBLOG_TEST_ADMIN_RISK_CASE == notice-absent ]]; then
          "${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" -c 'drop table public.comment_reply_notice' > "$evidence/risk-legacy-notice-table.log"
          risk_reply=1
        fi
        ;;
      *) printf 'Unknown administrator risk fixture: %s\n' "$FSUSBLOG_TEST_ADMIN_RISK_CASE" >&2; exit 2 ;;
    esac
    export FSUSBLOG_TEST_ADMIN_RISK_EXPECTED="{\"publicReadMode\":1,\"rootWriteMode\":$risk_root,\"replyWriteMode\":$risk_reply,\"forwardingMode\":1,\"dynamicRisk\":0,\"strongAnonymous\":0}"
  fi
  if [[ ${FSUSBLOG_TEST_ADMIN_SITE_PAGE_EDITOR:-0} == 1 ]]; then
    export FSUSBLOG_SITE_PAGE_EDITOR=true
    "$dotnet" "$migrate" site-page-editor schema > "$evidence/site-page-editor-migration.log"
    "$dotnet" "$migrate" site-page-editor schema >> "$evidence/site-page-editor-migration.log"
    sha_before=$(shasum -a 256 "$FSUSBLOG_SITE_PAGES/about.md")
  fi
elif [[ ${FSUSBLOG_TEST_ADMIN_TAXONOMY:-0} == 1 ]]; then
  if [[ ${FSUSBLOG_TEST_ADMIN_TAG_METADATA:-0} == 1 ]]; then export FSUSBLOG_ADMIN_TAG_METADATA=true; fi
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
  if [[ ${FSUSBLOG_TEST_ADMIN_COMMENT_BATCH:-0} == 1 ]]; then
    export FSUSBLOG_ADMIN_COMMENT_BATCH=true
  fi
  if [[ ${FSUSBLOG_TEST_COMMENT_REPLY:-0} == 1 ]]; then
    export FSUSBLOG_SIGNED_IN_COMMENT_REPLIES=true
    reply_operator=(operator tls-comment-reply-fixture)
    if [[ $comment_edit == 1 || $comment_report == 1 ]]; then reply_operator+=(--reader); fi
    FSUSBLOG_TEST_REPLY_AUTHOR_TICKET=$("$dotnet" "$migrate" "${reply_operator[@]}")
    export FSUSBLOG_TEST_REPLY_AUTHOR_TICKET
    export FSUSBLOG_TEST_REPLY_PARENT_TICKET="$scratch/issue-reply-parent-ticket"
    cat > "$FSUSBLOG_TEST_REPLY_PARENT_TICKET" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "$FSUSBLOG_TEST_TLS_DOTNET" "$FSUSBLOG_TEST_TLS_MIGRATE" ticket tls-moderation-fixture
EOF
    chmod 700 "$FSUSBLOG_TEST_REPLY_PARENT_TICKET"
  fi
  if [[ ${FSUSBLOG_TEST_COMMENT_APPEAL:-0} == 1 ]]; then
    "$dotnet" "$migrate" admin-identity bootstrap tls-appeal-reviewer admin.manage > /dev/null
    "$dotnet" "$migrate" admin-identity grant tls-appeal-reviewer comment.moderate > "$evidence/appeal-reviewer-grant.log"
    FSUSBLOG_TEST_APPEAL_REVIEWER_TICKET=$("$dotnet" "$migrate" admin-identity rotate-passkey tls-appeal-reviewer)
    export FSUSBLOG_TEST_APPEAL_REVIEWER_TICKET
    export FSUSBLOG_TEST_APPEAL_OWNER_TICKET="$scratch/issue-appeal-owner-ticket"
    cat > "$FSUSBLOG_TEST_APPEAL_OWNER_TICKET" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "$FSUSBLOG_TEST_TLS_DOTNET" "$FSUSBLOG_TEST_TLS_MIGRATE" ticket tls-moderation-fixture
EOF
    chmod 700 "$FSUSBLOG_TEST_APPEAL_OWNER_TICKET"
  fi
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

if [[ ${FSUSBLOG_TEST_PUBLICATION_HEAD:-0} == 1 ]]; then
  "$dotnet" "$migrate" publication-transparency enable >> "$evidence/schema.log"
  export FSUSBLOG_TEST_PUBLICATION_PROOF=1 IntegrityProof__Signing__NativeV2PublicHeadAnchor=genesis
fi
if [[ ${FSUSBLOG_TEST_PUBLICATION_PROOF:-0} == 1 ]]; then
  mkdir -m 700 "$scratch/publication-proof"
  proof_key=$(cd -- "$scratch/publication-proof" && pwd -P)/fixture.pkcs8
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:prime256v1 -pkeyopt ec_param_enc:named_curve |
    openssl pkcs8 -topk8 -nocrypt -outform DER -out "$proof_key"
  chmod 400 "$proof_key"
  proof_spki=$(openssl pkey -inform DER -in "$proof_key" -pubout -outform DER | openssl base64 -A | tr '/+' '_-' | tr -d '=')
  export IntegrityProof__Signing__NativeV2Enabled=true
  export IntegrityProof__Signing__NativeV2PrivateKeyFile="$proof_key"
  export IntegrityProof__Signing__CurrentKeyId=browser_fixture
  export IntegrityProof__Signing__Keys__browser_fixture__PublicKey="$proof_spki"
  export IntegrityProof__Signing__Keys__browser_fixture__Version=1
  export IntegrityProof__Signing__Keys__browser_fixture__Algorithm=ECDSA_P256_SHA256
  export IntegrityProof__Signing__Keys__browser_fixture__NotBeforeUtc=2020-01-01T00:00:00.000000Z
  export IntegrityProof__Signing__Keys__browser_fixture__NotAfterUtc=2099-01-01T00:00:00.000000Z
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
elif [[ ${FSUSBLOG_TEST_PUBLICATION_PROOF:-0} == 1 ]]; then
  node tests/EndToEnd/publication-proof-flow.mjs
elif [[ ${FSUSBLOG_TEST_ARTICLE_READ_PROOF:-0} == 1 ]]; then
  node tests/EndToEnd/article-read-proof-flow.mjs
elif [[ ${FSUSBLOG_TEST_WIDE_SEARCH:-0} == 1 ]]; then
  node tests/EndToEnd/wide-search-worker-flow.mjs
else
  node tests/EndToEnd/admin-identity-flow.mjs
fi
if [[ ${FSUSBLOG_TEST_ADMIN_APPEARANCE:-0} == 1 ]]; then
  [[ "$appearance_before" == "$(shasum -a 256 "$FSUSBLOG_APPEARANCE_ROOT/appearance.json")" ]]
  "${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" -Atc "
    select 'attributed_changes=' || count(*) from public.appearance_activation_audit a
      join public.admin_principal p on p.id=a.principal_id where p.handle='tls-admin-fixture'
    union all select 'exact_rollback=' || count(*) from public.appearance_activation_audit restore
      join public.appearance_activation_audit change on change.revision=1
      join public.appearance_activation active on active.revision=restore.revision
      where restore.rollback and restore.revision=2 and active.theme_digest=change.previous_theme_digest
        and active.font_digest=change.previous_font_digest and restore.previous_theme_digest=change.theme_digest
  " > "$evidence/appearance-counts.txt"
  grep -Fxq 'attributed_changes=2' "$evidence/appearance-counts.txt"
  grep -Fxq 'exact_rollback=1' "$evidence/appearance-counts.txt"
  kill "$server_pid"
  wait "$server_pid" 2>/dev/null || true
  restart_appearance() {
    "$dotnet" "$server" --urls "http://127.0.0.1:$upstream_port" > "$evidence/$1.log" 2>&1 &
    server_pid=$!
    for (( attempt=0; attempt<120; attempt++ )); do
      if curl --silent --fail --cacert "$scratch/ca.pem" "$FSUSBLOG_PUBLIC_ADDRESS/health/ready" >/dev/null; then return; fi
      kill -0 "$server_pid"
      sleep 0.2
    done
    return 1
  }
  restart_appearance appearance-restart
  css="$FSUSBLOG_PUBLIC_ADDRESS/site-appearance/current.css"
  curl --silent --fail --location --cacert "$scratch/ca.pem" "$css" > "$evidence/appearance-restarted.css"
  grep -Fq '#225533' "$evidence/appearance-restarted.css"
  kill "$server_pid"
  wait "$server_pid" 2>/dev/null || true
  python3 - "$FSUSBLOG_APPEARANCE_ROOT/appearance.json" <<'PY'
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import os
import sys

config = Path(sys.argv[1])
value = json.loads(config.read_text())
value['Keys'][0]['RevokedAt'] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
temporary = config.with_name('appearance.next')
temporary.write_text(json.dumps(value))
temporary.chmod(0o400)
os.replace(temporary, config)
PY
  restart_appearance appearance-revoked
  curl --silent --fail --location --cacert "$scratch/ca.pem" "$css" > "$evidence/appearance-revoked.css"
  [[ ! -s "$evidence/appearance-revoked.css" ]]
  stale_url=$(cat "$evidence/appearance-rollback-url.txt")
  [[ "$stale_url" == /site-appearance/2/*.css ]]
  [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --cacert "$scratch/ca.pem" +    "$FSUSBLOG_PUBLIC_ADDRESS$stale_url")" == 404 ]]
fi
if [[ ${FSUSBLOG_SITE_PAGE_EDITOR:-false} == true ]]; then
  [[ "$sha_before" == "$(shasum -a 256 "$FSUSBLOG_SITE_PAGES/about.md")" ]]
  "${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" -Atc "
    select 'audited_published_pages=' || count(*) from public.site_page_publish_audit a
      join public.site_page_content p on p.slug=a.slug and p.revision=a.revision
      join public.admin_principal admin on admin.id=a.principal_id
      where a.slug='about' and a.revision=1 and admin.handle='tls-admin-fixture'
        and a.previous_digest<>a.next_digest and a.next_digest=sha256(convert_to(p.markdown,'UTF8'))
    union all select 'consumed_site_page_step_up=' || count(*) from public.admin_site_page_step_up
  " > "$evidence/site-page-publication-counts.txt"
  grep -Fxq 'audited_published_pages=1' "$evidence/site-page-publication-counts.txt"
  grep -Fxq 'consumed_site_page_step_up=0' "$evidence/site-page-publication-counts.txt"
  kill "$server_pid"
  wait "$server_pid" 2>/dev/null || true
  "$dotnet" "$server" --urls "http://127.0.0.1:$upstream_port" > "$evidence/server-restarted.log" 2>&1 &
  server_pid=$!
  for (( attempt=0; attempt<120; attempt++ )); do
    if curl --silent --fail --cacert "$scratch/ca.pem" "$FSUSBLOG_PUBLIC_ADDRESS/about" > "$evidence/restarted-site-page.html"; then break; fi
    kill -0 "$server_pid"
    sleep 0.2
  done
  grep -Fq 'Published by authorized editor' "$evidence/restarted-site-page.html"
fi
if [[ ${FSUSBLOG_TEST_ADMIN_ARTICLE_ROLLBACK:-0} == 1 && ${FSUSBLOG_TEST_ADMIN_ARTICLE_ARCHIVE:-0} != 1 ]]; then
  "${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" -Atc "
    select 'exact_admin_rollback=' || count(*) from public.admin_article_rollback r
      join public.admin_principal p on p.id=r.principal_id
      join public.article a on a.id=r.article_id
      join public.blog_user u on u.id=a.owner_id
      join public.article_publication_history h on h.article_id=r.article_id and h.revision=r.revision
        and h.publication_id=r.publication_id and h.kind='replace'
      join public.article_revision_responsibility n on n.id=r.responsibility_snapshot_id
      join public.article_revision_responsibility s on s.id=n.source_snapshot_id
      join public.article_revision restored on restored.article_id=r.article_id and restored.revision=r.revision
      join public.article_revision source on source.article_id=r.article_id and source.revision=r.source_revision
      where p.handle='tls-admin-fixture' and u.name='tls-site-fixture'
        and h.admin_actor_id=p.id and h.admin_command_id=r.command_id and h.actor_id is null
        and n.responsible_party=s.responsible_party and n.basis=s.basis and n.reference=s.reference
        and r.destination=2 and r.source_revision=1 and r.previous_revision=2 and r.revision=3 and restored.body=source.body
        and exists (
          select from public.article_publication_canonical c join public.blog_outbox e on e.id=c.outbox_id
          where c.article_id=r.article_id and c.revision=r.revision and c.publication_id=r.publication_id
            and c.transition='replace' and c.rights_snapshot_id=r.rights_snapshot_id and e.kind='publish'
        )
    union all
    select 'one_publish_event=' || count(*) from public.blog_outbox where article_id=1 and revision=3 and kind='publish'
    union all
    select 'exact_admin_draft_rollback=' || count(*) from public.admin_article_rollback r
      join public.admin_principal p on p.id=r.principal_id
      join public.article a on a.id=r.article_id and a.revision=r.revision and a.published_revision is null
      join public.blog_user u on u.id=a.owner_id
      join public.admin_article_rollback prior on prior.article_id=r.article_id and prior.publication_id=r.previous_publication_id
      join public.article_publication_history h on h.article_id=r.article_id and h.revision=r.revision
        and h.publication_id is null and h.supersedes_id=r.previous_publication_id
        and h.kind='retract' and h.reason='administrator-rollback-draft'
      join public.article_revision_responsibility n on n.id=r.responsibility_snapshot_id
      join public.article_revision_responsibility s on s.id=n.source_snapshot_id
      join public.article_revision source on source.article_id=r.article_id and source.revision=r.source_revision
      join public.article_publication_rights w on w.id=r.rights_snapshot_id and w.article_id=r.article_id
        and w.revision=r.revision and w.publication_id=r.publication_id
      join public.article_revision_rights policy on policy.article_id=w.article_id and policy.revision=w.revision
      where p.handle='tls-admin-fixture' and u.name='tls-site-fixture'
        and h.admin_actor_id=p.id and h.admin_command_id=r.command_id and h.actor_id is null
        and n.responsible_party=s.responsible_party and n.basis=s.basis and n.reference=s.reference
        and policy.copyright_holder='Historical fixture rights' and a.title=source.title and a.body=source.body
        and r.destination=0 and prior.destination=2 and r.source_revision=1 and r.previous_revision=3 and r.revision=4
        and r.publication_no=4 and h.publication_no=r.publication_no and a.publication_count=r.publication_no
        and not exists (select from public.article_publication active where active.article_id=r.article_id)
        and not exists (select from public.article_publication_canonical c where c.article_id=r.article_id and c.revision=r.revision)
    union all
    select 'one_retract_event=' || count(*) from public.blog_outbox
      where article_id=1 and revision=4 and kind='retract' and processed_at is not null
  " > "$evidence/admin-article-rollback-counts.txt"
  grep -Fxq 'exact_admin_rollback=1' "$evidence/admin-article-rollback-counts.txt"
  grep -Fxq 'one_publish_event=1' "$evidence/admin-article-rollback-counts.txt"
  grep -Fxq 'exact_admin_draft_rollback=1' "$evidence/admin-article-rollback-counts.txt"
  grep -Fxq 'one_retract_event=1' "$evidence/admin-article-rollback-counts.txt"
  "$dotnet" "$migrate" verify > "$evidence/admin-article-rollback-schema-verify.log" 2>&1
fi
if [[ ${FSUSBLOG_TEST_ADMIN_ARTICLE_ARCHIVE:-0} == 1 ]]; then
  "${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" -Atc "
    select 'exact_admin_archive=' || count(*) from public.admin_article_rollback r
      join public.admin_principal p on p.id=r.principal_id
      join public.article_publication_history h on h.article_id=r.article_id and h.revision=r.revision
        and h.admin_actor_id=r.principal_id and h.admin_command_id=r.command_id
        and h.kind='retract' and h.reason='administrator-rollback-archived' and h.publication_id is null
        and h.supersedes_id=r.previous_publication_id and h.publication_no=r.publication_no and h.happened_at=r.published_at
      join public.article_revision archived on archived.article_id=r.article_id and archived.revision=r.revision
      join public.article_revision source on source.article_id=r.article_id and source.revision=r.source_revision
      where p.handle='tls-admin-fixture' and r.destination=3 and not r.from_archive
        and r.article_id=1 and r.source_revision=1 and r.source_publication_id=1
        and r.previous_revision=2 and r.previous_publication_id=2 and r.revision=3 and r.publication_no=3
        and (archived.title,archived.body)=(source.title,source.body)
        and not exists (select from public.article_publication active where active.publication_id=r.publication_id)
        and not exists (select from public.article_publication_canonical c where c.article_id=r.article_id and c.revision=r.revision)
    union all
    select 'exact_admin_republication=' || count(*) from public.admin_article_rollback r
      join public.admin_principal p on p.id=r.principal_id
      join public.article a on a.id=r.article_id and a.revision=r.revision and a.published_revision=r.revision
      join public.blog_user u on u.id=a.owner_id
      join public.article_publication active on active.article_id=r.article_id and active.revision=r.revision
        and active.publication_id=r.publication_id and active.publication_no=r.publication_no
      join public.admin_article_rollback archived on archived.article_id=r.article_id and archived.revision=r.previous_revision
        and archived.publication_id=r.previous_publication_id and archived.destination=3 and not archived.from_archive
      join public.article_revision archived_source on archived_source.article_id=archived.article_id and archived_source.revision=archived.revision
      join public.article_revision_responsibility inherited on inherited.id=r.responsibility_snapshot_id
        and inherited.source_snapshot_id=archived.responsibility_snapshot_id
      join public.article_publication_history h on h.article_id=r.article_id and h.revision=r.revision
        and h.admin_actor_id=r.principal_id and h.admin_command_id=r.command_id and h.kind='publish'
        and h.reason='administrator-archive-republished' and h.publication_id=r.publication_id and h.supersedes_id is null
      join public.article_publication_canonical c on c.article_id=r.article_id and c.revision=r.revision
        and c.publication_id=r.publication_id and c.rights_snapshot_id=r.rights_snapshot_id and c.transition='publish'
      join public.blog_outbox e on e.id=c.outbox_id and e.kind='publish' and e.processed_at is not null
      where p.handle='tls-admin-fixture' and u.name='tls-site-fixture' and r.destination=2 and r.from_archive
        and r.article_id=1 and r.previous_revision=3 and r.revision=4 and a.publication_count=4
        and r.source_revision=archived.source_revision and r.source_publication_id=archived.source_publication_id
        and (a.title,a.body)=(archived_source.title,archived_source.body)
    union all
    select 'one_archive_retract_event=' || count(*) from public.blog_outbox
      where article_id=1 and revision=3 and kind='retract' and processed_at is not null
    union all
    select 'one_archive_publish_event=' || count(*) from public.blog_outbox
      where article_id=1 and revision=4 and kind='publish' and processed_at is not null
  " > "$evidence/admin-article-archive-counts.txt"
  for check in exact_admin_archive exact_admin_republication one_archive_retract_event one_archive_publish_event; do
    grep -Fxq "$check=1" "$evidence/admin-article-archive-counts.txt"
  done
  "$dotnet" "$migrate" verify > "$evidence/admin-article-archive-schema-verify.log" 2>&1
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
        and m.previous_status=0 and (c.moderation_status=m.next_status or exists (
            select 1 from public.comment_appeal a join public.comment_appeal_decision d on d.appeal_id=a.id
            where a.adverse_id=m.id and d.granted and c.moderation_status=1))
        and claim.principal_id=p.id and claim.state=3
    union all select 'active_claims=' || count(*) from public.admin_comment_claim where state=1
  " > "$evidence/moderation-audit-counts.txt"
  expected_reply=${FSUSBLOG_TEST_COMMENT_REPLY:-0}
  expected_batch=${FSUSBLOG_TEST_ADMIN_COMMENT_BATCH:-0}
  grep -Fxq "approved=$(( 1 + expected_reply + 2 * comment_edit + 2 * expected_batch ))" "$evidence/moderation-audit-counts.txt"
  grep -Fxq "rejected=$(( 1 + 2 * expected_batch ))" "$evidence/moderation-audit-counts.txt"
  grep -Fxq "attributed_decisions=$(( 2 + expected_reply + 2 * comment_edit ))" "$evidence/moderation-audit-counts.txt"
  grep -Fxq 'active_claims=0' "$evidence/moderation-audit-counts.txt"
  if [[ $expected_batch == 1 ]]; then
    "${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" -Atc "
      select 'batch_audit_' || b.decision || '=' || count(*) from public.admin_comment_batch b
      join public.admin_principal principal on principal.id=b.principal_id
      join public.admin_comment_batch_item item on item.batch_id=b.id
      join public.admin_comment_moderation m on m.id=item.moderation_id
      join public.comment c on (c.article_id,c.id)=(m.article_id,m.comment_id)
      join public.admin_comment_claim claim on (claim.article_id,claim.comment_id)=(c.article_id,c.id)
      where b.item_count=2 and principal.handle='tls-admin-fixture' and m.principal_id=b.principal_id and claim.principal_id=b.principal_id
        and m.previous_status=0 and m.next_status=b.decision and c.moderation_status=b.decision
        and c.moderation_version=m.comment_version+1 and claim.state=3
      group by b.decision order by b.decision
    " > "$evidence/comment-batch-audit.txt"
    grep -Fxq 'batch_audit_1=2' "$evidence/comment-batch-audit.txt"
    grep -Fxq 'batch_audit_2=2' "$evidence/comment-batch-audit.txt"
  fi
  if [[ $expected_reply == 1 ]]; then
    "${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" -Atc "
      select 'attributed_reply_deliveries=' || count(*) from public.comment_reply_notice n
      join public.comment c on (c.article_id,c.id)=(n.article_id,n.reply_id)
      join public.comment_account_owner t on (t.article_id,t.comment_id,t.user_id)=(c.article_id,c.reply_to_id,n.recipient_id)
      join public.blog_user u on u.id=t.user_id
      join public.admin_comment_moderation d on (d.article_id,d.comment_id)=(n.article_id,n.reply_id)
      where u.name='tls-moderation-fixture' and d.next_status=1 and n.moderation_version=d.comment_version+1
        and (select array_agg(e.kind order by e.sequence) from public.inbox_event e
             where (e.account_id,e.conversation_id,e.message_id)=(n.recipient_id,n.conversation_id,n.message_id))=array[12,13]::smallint[]
    " > "$evidence/comment-reply-audit.txt"
    grep -Fxq 'attributed_reply_deliveries=1' "$evidence/comment-reply-audit.txt"
  fi
  if [[ $comment_report == 1 ]]; then
    "${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" -Atc "
      select 'signed_in_report_receipts=' || count(*) from public.comment_report r
      join public.blog_user u on u.id=r.reporter_id
      join public.comment c on (c.article_id,c.id)=(r.article_id,r.comment_id)
      join public.article_publication p on (p.article_id,p.publication_id)=(r.article_id,r.publication_id)
      where u.name='tls-comment-reply-fixture' and not u.can_author and c.moderation_status=1 and not c.deleted
        and r.reason_code='spam' and r.detail='Private report detail for a real visible native comment.';
      select 'total_reports=' || count(*) from public.comment_report
    " > "$evidence/comment-report-audit.txt"
    grep -Fxq 'signed_in_report_receipts=1' "$evidence/comment-report-audit.txt"
    grep -Fxq 'total_reports=1' "$evidence/comment-report-audit.txt"
  fi
  if [[ $comment_edit == 1 ]]; then
    "${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" -Atc "
      select 'edited_reply_reapproved=' || count(*) from public.comment_author_edited e
      join public.comment c on (c.article_id,c.id)=(e.article_id,e.comment_id)
      join public.blog_user u on u.id=e.user_id
      join public.comment_author_edit_outbox o
        on (o.article_id,o.comment_id,o.comment_version)=(e.article_id,e.comment_id,e.comment_version)
      join public.comment_reply_notice n on (n.article_id,n.reply_id)=(e.article_id,e.comment_id)
      join public.admin_comment_moderation approved on (approved.article_id,approved.comment_id,approved.comment_version)
        =(e.article_id,e.comment_id,e.comment_version) and approved.previous_status=0 and approved.next_status=1
      where u.name='tls-comment-reply-fixture' and not u.can_author and c.moderation_status=1
        and c.moderation_version=e.comment_version+1 and c.body=e.body and c.edited_at=e.happened_at
        and c.parent_id=c.reply_to_id and e.previous_status=1 and e.moderation_status=0 and e.previous_body<>e.body
        and e.previous_body_digest=pg_catalog.sha256(convert_to(e.previous_body,'UTF8'))
        and e.body_digest=pg_catalog.sha256(convert_to(e.body,'UTF8'))
        and o.event_type='CommentEdited' and n.moderation_version=e.previous_version
        and not exists(select 1 from public.comment_author_edit_challenge q
          where (q.article_id,q.comment_id)=(e.article_id,e.comment_id))
    " > "$evidence/comment-edit-audit.txt"
    grep -Fxq 'edited_reply_reapproved=1' "$evidence/comment-edit-audit.txt"
  fi
  if [[ ${FSUSBLOG_TEST_COMMENT_APPEAL:-0} == 1 ]]; then
    "${pg}psql" -X -w -v ON_ERROR_STOP=1 -d "$database" -Atc "
      select 'independent_grant=' || count(*) from public.comment_appeal a
      join public.comment_appeal_decision d on d.appeal_id=a.id
      join public.admin_comment_moderation m on m.id=a.adverse_id
      join public.admin_principal reviewer on reviewer.id=d.principal_id
      join public.comment_appeal_event e on e.appeal_id=a.id and e.kind=2
      where d.granted and d.principal_id<>m.principal_id and reviewer.handle='tls-appeal-reviewer'
        and e.previous_status=2 and e.next_status=1
    " > "$evidence/comment-appeal-audit.txt"
    grep -Fxq 'independent_grant=1' "$evidence/comment-appeal-audit.txt"
  fi
fi
