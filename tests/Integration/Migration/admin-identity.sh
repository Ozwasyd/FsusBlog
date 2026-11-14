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
site_ticket=$("${migrate[@]}" operator identity-fixture)
unset site_ticket
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

# These state fixtures exercise the offline revocation commands without pretending to prove WebAuthn.
"${query[@]}" "INSERT INTO public.admin_passkey_credential
    SELECT decode('01','hex'), id, decode('02','hex'), 0, false, false FROM public.admin_principal;
    INSERT INTO public.admin_session
    SELECT decode(repeat('ab',32),'hex'), id, generation, now()+interval '1 minute' FROM public.admin_principal;
    INSERT INTO public.admin_challenge(digest,principal_id,generation,binding_digest,kind,options,expires_at)
    SELECT decode(repeat('cd',32),'hex'), id, generation, decode(repeat('ef',32),'hex'), 2, '{}', now()+interval '1 minute'
    FROM public.admin_principal;"
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
"${migrate[@]}" admin-identity revoke-all identity-fixture
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_passkey_credential') == 1 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_invitation') == 0 ]]
"${migrate[@]}" admin-identity disable identity-fixture
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_passkey_credential') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_principal WHERE NOT enabled AND generation=4') == 1 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.blog_user WHERE enabled AND can_author AND generation=1') == 1 ]]
audit=$("${query[@]}" "SELECT string_agg(action, ',' ORDER BY id) FROM public.admin_identity_audit WHERE actor=session_user::text")
[[ "$audit" == 'bootstrap,rotate-passkey,revoke-all,disable' ]]
printf '%s\n' 'Verified independent schema upgrade, explicit permissions, one-use invitation issuance, credential rotation, revocation, and database actor audit.'
