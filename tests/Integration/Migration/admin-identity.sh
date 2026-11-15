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
remove_sign_in_history() {
    "${query[@]}" 'ALTER TABLE public.admin_session DROP COLUMN sign_in_id;
        DROP TABLE public.admin_sign_in'
}

remove_moderation_component() {
    remove_sign_in_history
    "${query[@]}" 'DROP TABLE public.admin_comment_claim, public.admin_comment_moderation;
        ALTER TABLE public.comment DROP COLUMN moderation_version'
}

remove_moderation_component
"${query[@]}" 'ALTER TABLE public.article_publication_history DROP COLUMN admin_actor_id, DROP COLUMN admin_command_id;
    DROP TABLE public.comment_author_delete_outbox, public.comment_author_deleted,
        public.comment_author_delete_challenge, public.comment_account_owner,
        public.admin_article_rollback_step_up, public.admin_article_rollback,
        public.article_publication_responsibility, public.article_revision_responsibility,
        public.admin_appearance_step_up, public.appearance_activation_audit, public.appearance_activation,
        public.inbox_admin_read, public.inbox_admin_reply, public.inbox_admin_status, public.inbox_admin_notice,
        public.admin_site_page_step_up, public.site_page_publish_audit, public.site_page_content,
        public.admin_tag_metadata_command, public.taxonomy_epoch'
"${query[@]}" 'DROP TABLE public.admin_step_up, public.admin_identity_audit, public.admin_session, public.admin_challenge,
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
remove_moderation_component
"${query[@]}" "DROP TABLE public.admin_step_up;
    ALTER TABLE public.admin_permission DROP CONSTRAINT admin_permission_permission_check;
    ALTER TABLE public.admin_permission ADD CONSTRAINT admin_permission_permission_check CHECK (permission='admin.manage');
    ALTER TABLE public.admin_identity_schema DROP CONSTRAINT admin_identity_schema_version_check;
    UPDATE public.admin_identity_schema SET version=1;
    ALTER TABLE public.admin_identity_schema ADD CONSTRAINT admin_identity_schema_version_check CHECK (version=1)"
if "${migrate[@]}" admin-identity grant identity-fixture audit.read > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected an offline grant to require the current administrator identity schema.' >&2
    exit 1
fi
rg -qF 'relation/column shape mismatch' "$scratch/rejection.log"
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
[[ $("${query[@]}" 'SELECT version FROM public.admin_identity_schema') == 8 ]]
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
remove_moderation_component
"${query[@]}" "DROP TABLE public.admin_step_up;
    ALTER TABLE public.admin_permission DROP CONSTRAINT admin_permission_permission_check;
    ALTER TABLE public.admin_permission ADD CONSTRAINT admin_permission_permission_check CHECK (permission='admin.manage' OR permission='audit.read');
    ALTER TABLE public.admin_identity_schema DROP CONSTRAINT admin_identity_schema_version_check;
    UPDATE public.admin_identity_schema SET version=2;
    ALTER TABLE public.admin_identity_schema ADD CONSTRAINT admin_identity_schema_version_check CHECK (version=2)"
if "${migrate[@]}" admin-identity grant identity-fixture comment.moderate > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected an offline moderation grant to require the current administrator identity schema.' >&2
    exit 1
fi
rg -qF 'relation/column shape mismatch' "$scratch/rejection.log"
"${migrate[@]}" admin-identity schema
"${migrate[@]}" admin-identity schema
"${migrate[@]}" verify
[[ $("${query[@]}" 'SELECT version FROM public.admin_identity_schema') == 8 ]]
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
remove_moderation_component
"${query[@]}" "DROP TABLE public.admin_step_up;
    ALTER TABLE public.admin_permission DROP CONSTRAINT admin_permission_permission_check;
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
rg -qF 'relation/column shape mismatch' "$scratch/rejection.log"
"${migrate[@]}" admin-identity schema
"${migrate[@]}" admin-identity schema
"${migrate[@]}" verify
[[ $("${query[@]}" 'SELECT version FROM public.admin_identity_schema') == 8 ]]
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
remove_moderation_component
"${query[@]}" "DROP TABLE public.admin_step_up;
    ALTER TABLE public.admin_permission DROP CONSTRAINT admin_permission_permission_check;
    ALTER TABLE public.admin_permission ADD CONSTRAINT admin_permission_permission_check
        CHECK (permission='admin.manage' OR permission='audit.read' OR permission='comment.moderate' OR permission='article.write');
    ALTER TABLE public.admin_identity_schema DROP CONSTRAINT admin_identity_schema_version_check;
    UPDATE public.admin_identity_schema SET version=4;
    ALTER TABLE public.admin_identity_schema ADD CONSTRAINT admin_identity_schema_version_check CHECK (version=4)"
"${migrate[@]}" admin-identity schema
"${migrate[@]}" verify
[[ $("${query[@]}" 'SELECT version FROM public.admin_identity_schema') == 8 ]]
[[ $("${query[@]}" "SELECT generation=6 AND generation_changed_at='$fence'::timestamptz FROM public.admin_principal") == t ]]
[[ $("${query[@]}" "SELECT string_agg(permission, ',' ORDER BY permission) FROM public.admin_permission") == 'admin.manage,article.write,audit.read' ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 1 ]]

# Test real constraints and lifecycle storage without simulating an authenticator.
"${query[@]}" "INSERT INTO public.admin_step_up
    SELECT decode(repeat('01',32),'hex'),principal_id,digest,generation,1,decode(repeat('ff',32),'hex'),'{}',now()+interval '2 minutes',1
    FROM public.admin_session;
    INSERT INTO public.admin_step_up
    SELECT decode(repeat('02',32),'hex'),principal_id,digest,generation,1,decode(repeat('ff',32),'hex'),NULL,now()+interval '45 seconds',2
    FROM public.admin_session"
if "${query[@]}" "INSERT INTO public.admin_step_up
    SELECT decode(repeat('03',32),'hex'),principal_id,digest,generation,1,decode(repeat('ff',32),'hex'),NULL,now()+interval '45 seconds',2
    FROM public.admin_session" > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected independent step-up proofs to be bounded per session.' >&2
    exit 1
fi
rg -qF 'admin_step_up_session_digest_kind_key' "$scratch/rejection.log"
if "${query[@]}" "UPDATE public.admin_step_up SET options='{}' WHERE kind=2" > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected the database to reject options on a proof.' >&2
    exit 1
fi
rg -qF 'check constraint' "$scratch/rejection.log"

# Build the exact v5 shape while step-up rows and already persisted comments exist.
remove_moderation_component
"${query[@]}" "ALTER TABLE public.admin_permission DROP CONSTRAINT admin_permission_permission_check;
    ALTER TABLE public.admin_permission ADD CONSTRAINT admin_permission_permission_check
        CHECK (permission='admin.manage' OR permission='audit.read' OR permission='comment.moderate' OR permission='article.write');
    ALTER TABLE public.admin_identity_schema DROP CONSTRAINT admin_identity_schema_version_check;
    UPDATE public.admin_identity_schema SET version=5;
    ALTER TABLE public.admin_identity_schema ADD CONSTRAINT admin_identity_schema_version_check CHECK (version=5);
    INSERT INTO public.article(owner_id,revision,title,body,deleted)
    SELECT id,1,'Moderation fixture','Fixture text',false FROM public.blog_user;
    INSERT INTO public.article_revision(article_id,revision,title,body,happened_at)
    VALUES(1,1,'Moderation fixture','Fixture text',clock_timestamp());
    INSERT INTO public.comment(article_id,id,root_id,depth,moderation_status,deleted,body,author_mode,display_name,display_language,created_at)
    VALUES(1,1,1,0,0,false,'queue fixture',1,'reader','en',clock_timestamp()),
          (1,2,2,0,1,false,'standalone fixture',1,'reader','en',clock_timestamp());
    INSERT INTO public.comment_submit_command(user_id,command_id,fingerprint,article_id,comment_id)
    SELECT id,'88888888-8888-8888-8888-888888888888',decode(repeat('06',32),'hex'),1,1 FROM public.blog_user"
"${migrate[@]}" admin-identity schema
"${migrate[@]}" admin-identity schema
"${migrate[@]}" verify
[[ $("${query[@]}" 'SELECT version FROM public.admin_identity_schema') == 8 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_step_up') == 2 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.comment WHERE moderation_version=1') == 2 ]]
if "${query[@]}" "INSERT INTO public.admin_comment_claim
    SELECT 1,2,principal_id,digest,generation,decode(repeat('ee',32),'hex'),1,1,1,clock_timestamp()+interval '1 minute',1
    FROM public.admin_session" > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected claims to require a real public comment submission.' >&2
    exit 1
fi
rg -qF 'foreign key constraint' "$scratch/rejection.log"
"${query[@]}" "INSERT INTO public.admin_comment_claim
    SELECT 1,1,principal_id,digest,generation,decode(repeat('ee',32),'hex'),1,1,1,clock_timestamp()+interval '1 minute',1
    FROM public.admin_session"
"${migrate[@]}" comment moderate 1 1 0 reject 'Trusted operator moderation fixture'
[[ $("${query[@]}" 'SELECT moderation_status=2 AND moderation_version=2 FROM public.comment WHERE article_id=1 AND id=1') == t ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.comment_moderation_log WHERE article_id=1 AND comment_id=1') == 1 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_comment_moderation') == 0 ]]

"${migrate[@]}" admin-identity grant identity-fixture article.write
[[ $("${query[@]}" "SELECT generation=6 AND generation_changed_at='$fence'::timestamptz FROM public.admin_principal") == t ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 1 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_step_up') == 2 ]]
"${migrate[@]}" admin-identity revoke identity-fixture article.write
"${migrate[@]}" admin-identity revoke identity-fixture article.write
[[ $("${query[@]}" "SELECT generation=7 AND generation_changed_at>'$fence'::timestamptz FROM public.admin_principal") == t ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_challenge') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_step_up') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_comment_claim WHERE claim_generation=1 AND claim_version=1') == 1 ]]
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
remove_sign_in_history
"${query[@]}" "ALTER TABLE public.admin_permission DROP CONSTRAINT admin_permission_permission_check;
    ALTER TABLE public.admin_permission ADD CONSTRAINT admin_permission_permission_check
        CHECK (permission='admin.manage' OR permission='audit.read' OR permission='comment.moderate' OR permission='article.write');
    ALTER TABLE public.admin_identity_schema DROP CONSTRAINT admin_identity_schema_version_check;
    UPDATE public.admin_identity_schema SET version=6;
    ALTER TABLE public.admin_identity_schema ADD CONSTRAINT admin_identity_schema_version_check CHECK (version=6)"
"${migrate[@]}" admin-identity schema
[[ $("${query[@]}" 'SELECT version FROM public.admin_identity_schema') == 8 ]]
[[ $("${query[@]}" 'SELECT generation FROM public.admin_principal') == 8 ]]
"${migrate[@]}" admin-identity grant identity-fixture system.config
"${migrate[@]}" admin-identity grant identity-fixture system.config
[[ $("${query[@]}" "SELECT string_agg(permission, ',' ORDER BY permission) FROM public.admin_permission") == 'admin.manage,system.config' ]]
[[ $("${query[@]}" 'SELECT generation FROM public.admin_principal') == 9 ]]

# Retain v7 authority without minting a historical sign-in during the upgrade.
remove_sign_in_history
"${query[@]}" 'ALTER TABLE public.admin_identity_schema DROP CONSTRAINT admin_identity_schema_version_check;
    UPDATE public.admin_identity_schema SET version=7;
    ALTER TABLE public.admin_identity_schema ADD CONSTRAINT admin_identity_schema_version_check CHECK (version=7)'
add_pending_session_and_challenge
previous_session=$("${query[@]}" "SELECT encode(digest,'hex'),principal_id,generation,expires_at FROM public.admin_session")
"${migrate[@]}" admin-identity schema
"${migrate[@]}" admin-identity schema
"${migrate[@]}" verify
[[ $("${query[@]}" 'SELECT version FROM public.admin_identity_schema') == 8 ]]
[[ $("${query[@]}" "SELECT encode(digest,'hex'),principal_id,generation,expires_at FROM public.admin_session WHERE sign_in_id IS NULL") == "$previous_session" ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_sign_in') == 0 ]]
[[ $("${query[@]}" "SELECT string_agg(permission, ',' ORDER BY permission) FROM public.admin_permission") == 'admin.manage,system.config' ]]
"${migrate[@]}" admin-identity revoke identity-fixture system.config
[[ $("${query[@]}" 'SELECT generation FROM public.admin_principal') == 10 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_session') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_challenge') == 0 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_sign_in') == 0 ]]

# Exercise offline retirement with a real history link. Browser tests exercise Passkey issuance.
"${query[@]}" "WITH sign_in AS (
        INSERT INTO public.admin_sign_in(principal_id,started_at,expires_at)
        SELECT id,statement_timestamp()-interval '1 minute',statement_timestamp()+interval '1 hour' FROM public.admin_principal
        RETURNING principal_id,id,expires_at
    )
    INSERT INTO public.admin_session(digest,principal_id,generation,expires_at,sign_in_id)
    SELECT decode(repeat('ab',32),'hex'),i.principal_id,p.generation,i.expires_at,i.id
    FROM sign_in i JOIN public.admin_principal p ON p.id=i.principal_id;
    INSERT INTO public.admin_principal(id,handle,user_handle,enabled,generation)
    VALUES('99999999-9999-9999-9999-999999999999','other-owner',decode(repeat('09',32),'hex'),false,1)"
if "${query[@]}" "INSERT INTO public.admin_session(digest,principal_id,generation,expires_at,sign_in_id)
    SELECT decode(repeat('bc',32),'hex'),'99999999-9999-9999-9999-999999999999',1,expires_at,id
    FROM public.admin_sign_in" > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected sign-in history links to require the same administrator principal.' >&2
    exit 1
fi
rg -qF 'admin_session_sign_in_fkey' "$scratch/rejection.log"
"${query[@]}" "DELETE FROM public.admin_principal WHERE handle='other-owner'"
if "${query[@]}" "UPDATE public.admin_sign_in SET ended_at=expires_at+interval '1 second'" > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected history to reject an end after the session deadline.' >&2
    exit 1
fi
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
[[ $("${query[@]}" 'SELECT count(*) FROM public.admin_principal WHERE NOT enabled AND generation=12') == 1 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.blog_user WHERE enabled AND can_author AND generation=1') == 1 ]]
audit=$("${query[@]}" "SELECT string_agg(action, ',' ORDER BY id) FROM public.admin_identity_audit WHERE actor=session_user::text")
[[ "$audit" == 'bootstrap,rotate-passkey,grant:audit.read,grant:comment.moderate,revoke:comment.moderate,grant:article.write,revoke:article.write,revoke:audit.read,grant:system.config,revoke:system.config,revoke-all,disable' ]]
printf '%s\n' 'Verified v1 through v7 administrator schema upgrades, preserved pre-upgrade sessions without invented sign-ins, scoped step-up cascade, revisioned comments and claim custody, independent permissions, credential rotation, and database actor audit.'
