#!/usr/bin/env bash
set -euo pipefail
umask 077

source "$(dirname -- "$0")/identity-schema-fixture.sh"
start_identity_fixture admin-identity admin 'administrator identity'

# Retain a site user account with the same name alongside the unified administrator principal.
"${migrate[@]}" operator identity-fixture > /dev/null
[[ $("${query[@]}" 'SELECT version FROM public.admin_identity_schema') == 8 ]]

first=$("${migrate[@]}" admin-identity bootstrap identity-fixture)
[[ "$first" =~ ^[0-9a-f]{64}$ ]]
first_digest=$(pg_fixture_sha256_hex "$first")
[[ $("${query[@]}" "SELECT count(*) FROM public.admin_invitation WHERE encode(digest, 'hex') = '$first_digest'") == 1 ]]
[[ $("${query[@]}" "SELECT count(*) FROM public.login_ticket WHERE encode(digest, 'hex') = '$first_digest'") == 0 ]]
unset first
expect_identity_rejection 'Expected bootstrap to reject an extra permission argument.' \
    "${migrate[@]}" admin-identity bootstrap invalid-fixture article.write
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_principal') == 1 ]]

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
replacement_digest=$(pg_fixture_sha256_hex "$replacement")
[[ "$replacement_digest" != "$first_digest" ]]
[[ $("${query[@]}" "SELECT count(*) FROM public.admin_invitation WHERE generation=2 AND encode(digest, 'hex')='$replacement_digest'") == 1 ]]
unset replacement first_digest replacement_digest
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_challenge') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_passkey_credential') == 0 ]]

"${query[@]}" "INSERT INTO public.admin_passkey_credential
    SELECT decode('03','hex'), id, decode('04','hex'), 0, false, false FROM public.admin_principal"

# Test step-up, moderation claim, and sign-in history constraints.
add_pending_session_and_challenge
"${query[@]}" "INSERT INTO public.admin_step_up
    SELECT decode(repeat('01',32),'hex'),principal_id,digest,generation,1,decode(repeat('ff',32),'hex'),'{}',now()+interval '2 minutes',1
    FROM public.admin_session;
    INSERT INTO public.admin_step_up
    SELECT decode(repeat('02',32),'hex'),principal_id,digest,generation,1,decode(repeat('ff',32),'hex'),NULL,now()+interval '45 seconds',2
    FROM public.admin_session"
expect_identity_rejection 'Expected independent step-up proofs to be bounded per session.' \
    "${query[@]}" "INSERT INTO public.admin_step_up
    SELECT decode(repeat('03',32),'hex'),principal_id,digest,generation,1,decode(repeat('ff',32),'hex'),NULL,now()+interval '45 seconds',2
    FROM public.admin_session"
rg -qF 'admin_step_up_session_digest_kind_key' "$scratch/rejection.log"
expect_identity_rejection 'Expected the database to reject options on a proof.' \
    "${query[@]}" "UPDATE public.admin_step_up SET options='{}' WHERE kind=2"
rg -qF 'check constraint' "$scratch/rejection.log"

"${query[@]}" "DELETE FROM public.admin_session;
    WITH sign_in AS (
        INSERT INTO public.admin_sign_in(principal_id,started_at,expires_at)
        SELECT id,statement_timestamp()-interval '1 minute',statement_timestamp()+interval '1 hour' FROM public.admin_principal
        RETURNING principal_id,id,expires_at
    )
    INSERT INTO public.admin_session(digest,principal_id,generation,expires_at,sign_in_id)
    SELECT decode(repeat('ab',32),'hex'),i.principal_id,p.generation,i.expires_at,i.id
    FROM sign_in i JOIN public.admin_principal p ON p.id=i.principal_id;
    INSERT INTO public.admin_principal(id,handle,user_handle,enabled,generation)
    VALUES('99999999-9999-9999-9999-999999999999','other-owner',decode(repeat('09',32),'hex'),false,1)"
expect_identity_rejection 'Expected sign-in history links to require the same administrator principal.' \
    "${query[@]}" "INSERT INTO public.admin_session(digest,principal_id,generation,expires_at,sign_in_id)
    SELECT decode(repeat('bc',32),'hex'),'99999999-9999-9999-9999-999999999999',1,expires_at,id
    FROM public.admin_sign_in"
rg -qF 'admin_session_sign_in_fkey' "$scratch/rejection.log"
"${query[@]}" "DELETE FROM public.admin_principal WHERE handle='other-owner'"
expect_identity_rejection 'Expected history to reject an end after the session deadline.' \
    "${query[@]}" "UPDATE public.admin_sign_in SET ended_at=expires_at+interval '1 second'"
rg -qF 'check constraint' "$scratch/rejection.log"

"${migrate[@]}" admin-identity revoke-all identity-fixture
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_passkey_credential') == 1 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_invitation') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 0 ]]
[[ $("${query[@]}" 'SELECT ended_at>=started_at AND ended_at<expires_at FROM public.admin_sign_in') == t ]]

"${query[@]}" "WITH sign_in AS (
        INSERT INTO public.admin_sign_in(principal_id,started_at,expires_at)
        SELECT id,statement_timestamp()-interval '2 hours',statement_timestamp()-interval '1 hour' FROM public.admin_principal
        RETURNING principal_id,id,expires_at
    )
    INSERT INTO public.admin_session(digest,principal_id,generation,expires_at,sign_in_id)
    SELECT decode(repeat('ab',32),'hex'),i.principal_id,p.generation,i.expires_at,i.id
    FROM sign_in i JOIN public.admin_principal p ON p.id=i.principal_id"
"${migrate[@]}" admin-identity disable identity-fixture
[[ $("${query[@]}" 'SELECT ended_at=expires_at FROM public.admin_sign_in ORDER BY id DESC LIMIT 1') == t ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_passkey_credential') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_principal WHERE NOT enabled AND generation=4') == 1 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.blog_user WHERE enabled AND generation=1') == 1 ]]
audit=$("${query[@]}" "SELECT string_agg(action, ',' ORDER BY id) FROM public.admin_identity_audit WHERE actor=session_user::text")
[[ "$audit" == 'bootstrap,rotate-passkey,revoke-all,disable' ]]
printf '%s\n' 'Verified unified administrator schema, bootstrap, step-up cascade, sign-in history, credential rotation, revocation, and database actor audit.'
