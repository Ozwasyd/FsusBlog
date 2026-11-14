#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ -z "${FSUSBLOG_TEST_DB:-}" || -z "${PGHOST:-}" || -z "${PGUSER:-}" || -z "${FSUSBLOG_TEST_MIGRATE_DLL:-}" ]]; then
    printf '%s\n' 'Configure a native scratch PostgreSQL cluster and the built migration DLL.' >&2
    exit 2
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/fsus-admin-identity.XXXXXXXX")
database="fsusv2_admin_$(openssl rand -hex 12)"
pg=(psql -X --no-password -v ON_ERROR_STOP=1)
migrate=("${DOTNET_BIN:-dotnet}" "$FSUSBLOG_TEST_MIGRATE_DLL")
created=0
cleanup() {
    local result=$?
    trap - EXIT
    if (( created == 1 )) && ! "${pg[@]}" -d postgres -qc "DROP DATABASE \"$database\""; then result=1; fi
    if ! rm -f "$scratch/plan.json" "$scratch/rejection.log" || ! rmdir "$scratch"; then result=1; fi
    if (( result == 0 )); then printf '%s\n' 'Removed the administrator identity test database and scratch files.'; fi
    exit "$result"
}
trap cleanup EXIT

"${pg[@]}" -d postgres -qc "CREATE DATABASE \"$database\" TEMPLATE template0"
created=1
export FSUSBLOG_DB="${FSUSBLOG_TEST_DB%;};Database=$database"
query=("${pg[@]}" -d "$database" -qAtc)
"${migrate[@]}" plan > "$scratch/plan.json"
"${migrate[@]}" apply "$scratch/plan.json"
"${migrate[@]}" verify

# Retain a site account with the same name across the additive admin upgrade.
"${migrate[@]}" operator identity-fixture > /dev/null
"${query[@]}" 'DROP TABLE public.admin_identity_audit, public.admin_session, public.admin_challenge,
    public.admin_invitation, public.admin_passkey_credential, public.admin_permission, public.admin_principal,
    public.admin_identity_schema'
if "${migrate[@]}" verify > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected verification to reject the missing administrator identity component.' >&2
    exit 1
fi
rg -qF 'relation/column shape mismatch' "$scratch/rejection.log"
"${migrate[@]}" admin-identity schema
"${migrate[@]}" admin-identity schema
"${migrate[@]}" verify

first=$("${migrate[@]}" admin-identity bootstrap identity-fixture admin.manage)
[[ "$first" =~ ^[0-9a-f]{64}$ ]]
first_digest=$(printf '%s' "$first" | xxd -r -p | openssl dgst -sha256 | awk '{print $NF}')
[[ $("${query[@]}" "SELECT count(*) FROM public.admin_invitation WHERE encode(digest, 'hex') = '$first_digest'") == 1 ]]
[[ $("${query[@]}" "SELECT count(*) FROM public.login_ticket WHERE encode(digest, 'hex') = '$first_digest'") == 0 ]]
unset first
if "${migrate[@]}" admin-identity bootstrap invalid-fixture article.write > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected bootstrap to reject an unsupported administrator permission.' >&2
    exit 1
fi
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_principal') == 1 ]]

# Restore the exact v1 component contract as published before audit.read, with existing administrator state.
"${query[@]}" "ALTER TABLE public.admin_permission DROP CONSTRAINT admin_permission_permission_check;
    ALTER TABLE public.admin_permission ADD CONSTRAINT admin_permission_permission_check CHECK (permission='admin.manage');
    ALTER TABLE public.admin_identity_schema DROP CONSTRAINT admin_identity_schema_version_check;
    UPDATE public.admin_identity_schema SET version=1;
    ALTER TABLE public.admin_identity_schema ADD CONSTRAINT admin_identity_schema_version_check CHECK (version=1)"
if "${migrate[@]}" admin-identity grant identity-fixture audit.read > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected an offline grant to require the current administrator identity schema.' >&2
    exit 1
fi
rg -qF 'constraint shape mismatch' "$scratch/rejection.log"
"${query[@]}" 'ALTER TABLE public.admin_session ADD COLUMN unexpected_fixture integer'
if "${migrate[@]}" admin-identity schema > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected the upgrade to reject a drifted v1 administrator identity schema.' >&2
    exit 1
fi
rg -qF 'relation/column shape mismatch' "$scratch/rejection.log"
[[ $("${query[@]}" 'SELECT version FROM public.admin_identity_schema') == 1 ]]
"${query[@]}" 'ALTER TABLE public.admin_session DROP COLUMN unexpected_fixture'
"${migrate[@]}" admin-identity schema
"${migrate[@]}" admin-identity schema
"${migrate[@]}" verify
[[ $("${query[@]}" 'SELECT version FROM public.admin_identity_schema') == 4 ]]
[[ $("${query[@]}" "SELECT count(*) FROM public.admin_invitation WHERE encode(digest, 'hex') = '$first_digest'") == 1 ]]
[[ $("${query[@]}" "SELECT count(*) FROM public.admin_permission WHERE permission='admin.manage'") == 1 ]]

# These state fixtures exercise the offline revocation commands without pretending to prove WebAuthn.
add_pending_session_and_challenge() {
    "${query[@]}" "INSERT INTO public.admin_session
        SELECT decode(repeat('ab',32),'hex'), id, generation, now()+interval '1 minute' FROM public.admin_principal;
        INSERT INTO public.admin_challenge(digest,principal_id,generation,binding_digest,kind,options,expires_at)
        SELECT decode(repeat('cd',32),'hex'), id, generation, decode(repeat('ef',32),'hex'), 2, '{}', now()+interval '1 minute'
        FROM public.admin_principal"
}

"${query[@]}" "INSERT INTO public.admin_passkey_credential
    SELECT decode('01','hex'), id, decode('02','hex'), 0, false, false FROM public.admin_principal"
add_pending_session_and_challenge
replacement=$("${migrate[@]}" admin-identity rotate-passkey identity-fixture)
[[ "$replacement" =~ ^[0-9a-f]{64}$ ]]
replacement_digest=$(printf '%s' "$replacement" | xxd -r -p | openssl dgst -sha256 | awk '{print $NF}')
[[ "$replacement_digest" != "$first_digest" ]]
[[ $("${query[@]}" "SELECT count(*) FROM public.admin_invitation WHERE generation=2 AND encode(digest, 'hex')='$replacement_digest'") == 1 ]]
unset replacement first_digest replacement_digest
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_challenge') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_passkey_credential') == 0 ]]

"${query[@]}" "INSERT INTO public.admin_passkey_credential
    SELECT decode('03','hex'), id, decode('04','hex'), 0, false, false FROM public.admin_principal;"
add_pending_session_and_challenge
old_fence=$("${query[@]}" 'SELECT generation_changed_at FROM public.admin_principal')
"${migrate[@]}" admin-identity grant identity-fixture audit.read
[[ $("${query[@]}" "SELECT string_agg(permission, ',' ORDER BY permission) FROM public.admin_permission") == 'admin.manage,audit.read' ]]
[[ $("${query[@]}" "SELECT generation=3 AND generation_changed_at>'$old_fence'::timestamptz FROM public.admin_principal") == t ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_invitation') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_challenge') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_passkey_credential') == 1 ]]

add_pending_session_and_challenge
fence=$("${query[@]}" 'SELECT generation_changed_at FROM public.admin_principal')
"${migrate[@]}" admin-identity grant identity-fixture audit.read
[[ $("${query[@]}" "SELECT generation=3 AND generation_changed_at='$fence'::timestamptz FROM public.admin_principal") == t ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 1 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_challenge') == 1 ]]

# Recreate the exact v2 constraints while an audit grant and active administrator session exist.
"${query[@]}" "ALTER TABLE public.admin_permission DROP CONSTRAINT admin_permission_permission_check;
    ALTER TABLE public.admin_permission ADD CONSTRAINT admin_permission_permission_check CHECK (permission='admin.manage' OR permission='audit.read');
    ALTER TABLE public.admin_identity_schema DROP CONSTRAINT admin_identity_schema_version_check;
    UPDATE public.admin_identity_schema SET version=2;
    ALTER TABLE public.admin_identity_schema ADD CONSTRAINT admin_identity_schema_version_check CHECK (version=2)"
if "${migrate[@]}" admin-identity grant identity-fixture comment.moderate > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected an offline moderation grant to require the current administrator identity schema.' >&2
    exit 1
fi
rg -qF 'constraint shape mismatch' "$scratch/rejection.log"
"${migrate[@]}" admin-identity schema
"${migrate[@]}" admin-identity schema
"${migrate[@]}" verify
[[ $("${query[@]}" 'SELECT version FROM public.admin_identity_schema') == 4 ]]
[[ $("${query[@]}" "SELECT string_agg(permission, ',' ORDER BY permission) FROM public.admin_permission") == 'admin.manage,audit.read' ]]
[[ $("${query[@]}" "SELECT generation=3 AND generation_changed_at='$fence'::timestamptz FROM public.admin_principal") == t ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 1 ]]

"${migrate[@]}" admin-identity grant identity-fixture comment.moderate
[[ $("${query[@]}" "SELECT string_agg(permission, ',' ORDER BY permission) FROM public.admin_permission") == 'admin.manage,audit.read,comment.moderate' ]]
[[ $("${query[@]}" "SELECT generation=4 AND generation_changed_at>'$fence'::timestamptz FROM public.admin_principal") == t ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_challenge') == 0 ]]

add_pending_session_and_challenge
fence=$("${query[@]}" 'SELECT generation_changed_at FROM public.admin_principal')
"${migrate[@]}" admin-identity grant identity-fixture comment.moderate
[[ $("${query[@]}" "SELECT generation=4 AND generation_changed_at='$fence'::timestamptz FROM public.admin_principal") == t ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 1 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_challenge') == 1 ]]
"${migrate[@]}" admin-identity revoke identity-fixture comment.moderate
[[ $("${query[@]}" "SELECT generation=5 AND generation_changed_at>'$fence'::timestamptz FROM public.admin_principal") == t ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_challenge') == 0 ]]
[[ $("${query[@]}" "SELECT string_agg(permission, ',' ORDER BY permission) FROM public.admin_permission") == 'admin.manage,audit.read' ]]
"${migrate[@]}" admin-identity revoke identity-fixture comment.moderate
fence=$("${query[@]}" 'SELECT generation_changed_at FROM public.admin_principal')
[[ $("${query[@]}" 'SELECT generation FROM public.admin_principal') == 5 ]]

# Upgrade an exact v3 registry while an authenticated administrator generation remains unchanged.
"${query[@]}" "ALTER TABLE public.admin_permission DROP CONSTRAINT admin_permission_permission_check;
    ALTER TABLE public.admin_permission ADD CONSTRAINT admin_permission_permission_check
        CHECK (permission='admin.manage' OR permission='audit.read' OR permission='comment.moderate');
    ALTER TABLE public.admin_identity_schema DROP CONSTRAINT admin_identity_schema_version_check;
    UPDATE public.admin_identity_schema SET version=3;
    ALTER TABLE public.admin_identity_schema ADD CONSTRAINT admin_identity_schema_version_check CHECK (version=3)"
add_pending_session_and_challenge
if "${migrate[@]}" admin-identity grant identity-fixture article.write > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected an offline taxonomy grant to require the current administrator identity schema.' >&2
    exit 1
fi
rg -qF 'constraint shape mismatch' "$scratch/rejection.log"
"${migrate[@]}" admin-identity schema
"${migrate[@]}" admin-identity schema
"${migrate[@]}" verify
[[ $("${query[@]}" 'SELECT version FROM public.admin_identity_schema') == 4 ]]
[[ $("${query[@]}" "SELECT generation=5 AND generation_changed_at='$fence'::timestamptz FROM public.admin_principal") == t ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 1 ]]
[[ $("${query[@]}" "SELECT string_agg(permission, ',' ORDER BY permission) FROM public.admin_permission") == 'admin.manage,audit.read' ]]

"${migrate[@]}" admin-identity grant identity-fixture article.write
[[ $("${query[@]}" "SELECT string_agg(permission, ',' ORDER BY permission) FROM public.admin_permission") == 'admin.manage,article.write,audit.read' ]]
[[ $("${query[@]}" "SELECT generation=6 AND generation_changed_at>'$fence'::timestamptz FROM public.admin_principal") == t ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_challenge') == 0 ]]

add_pending_session_and_challenge
fence=$("${query[@]}" 'SELECT generation_changed_at FROM public.admin_principal')
"${migrate[@]}" admin-identity grant identity-fixture article.write
[[ $("${query[@]}" "SELECT generation=6 AND generation_changed_at='$fence'::timestamptz FROM public.admin_principal") == t ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 1 ]]
"${migrate[@]}" admin-identity revoke identity-fixture article.write
"${migrate[@]}" admin-identity revoke identity-fixture article.write
[[ $("${query[@]}" "SELECT generation=7 AND generation_changed_at>'$fence'::timestamptz FROM public.admin_principal") == t ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_challenge') == 0 ]]
[[ $("${query[@]}" "SELECT string_agg(permission, ',' ORDER BY permission) FROM public.admin_permission") == 'admin.manage,audit.read' ]]
fence=$("${query[@]}" 'SELECT generation_changed_at FROM public.admin_principal')

if "${migrate[@]}" admin-identity revoke identity-fixture admin.manage > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected permission management to preserve the administrator bootstrap authority.' >&2
    exit 1
fi
"${migrate[@]}" admin-identity revoke identity-fixture audit.read
"${migrate[@]}" admin-identity revoke identity-fixture audit.read
[[ $("${query[@]}" "SELECT string_agg(permission, ',' ORDER BY permission) FROM public.admin_permission") == 'admin.manage' ]]
[[ $("${query[@]}" "SELECT generation=8 AND generation_changed_at>'$fence'::timestamptz FROM public.admin_principal") == t ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_challenge') == 0 ]]
"${migrate[@]}" admin-identity revoke-all identity-fixture
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_passkey_credential') == 1 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_invitation') == 0 ]]
"${migrate[@]}" admin-identity disable identity-fixture
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_passkey_credential') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_principal WHERE NOT enabled AND generation=10') == 1 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.blog_user WHERE enabled AND can_author AND generation=1') == 1 ]]
audit=$("${query[@]}" "SELECT string_agg(action, ',' ORDER BY id) FROM public.admin_identity_audit WHERE actor=session_user::text")
[[ "$audit" == 'bootstrap,rotate-passkey,grant:audit.read,grant:comment.moderate,revoke:comment.moderate,grant:article.write,revoke:article.write,revoke:audit.read,revoke-all,disable' ]]
printf '%s\n' 'Verified v1, v2 and v3 administrator schema upgrades, independent and idempotent permission changes, isolated account authority, credential rotation, and database actor audit.'
