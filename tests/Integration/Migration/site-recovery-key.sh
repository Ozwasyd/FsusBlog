#!/usr/bin/env bash
set -euo pipefail
umask 077

source "$(dirname -- "$0")/identity-schema-fixture.sh"
start_identity_fixture site-recovery-key site_recovery 'Recovery Key' ' WITH (FORCE)'
[[ $("${query[@]}" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN
    ('site_recovery_key','site_recovery_flow','site_recovery_rebind')") == 3 ]]

"${migrate[@]}" operator recovery-fixture > /dev/null
"${query[@]}" "INSERT INTO public.passkey_subject(user_id,user_handle)
    SELECT id,decode(repeat('09',32),'hex') FROM public.blog_user WHERE name='recovery-fixture';
    DROP TABLE public.site_recovery_flow, public.site_recovery_rebind, public.site_recovery_key"
"${migrate[@]}" verify

require_stopped_identity_schema 'Expected schema initialization to require the serving instance to stop.' recovery-key schema

"${query[@]}" 'CREATE TABLE public.site_recovery_key (unexpected_fixture integer)'
for command in verify 'recovery-key schema'; do
    # Both operations must fail closed on a partial set of component relations.
    read -r -a arguments <<< "$command"
    if "${migrate[@]}" "${arguments[@]}" > "$scratch/rejection.log" 2>&1; then
        printf '%s\n' 'Expected partial Recovery Key component rejection.' >&2
        exit 1
    fi
    rg -qF 'Recovery Key schema is partially installed' "$scratch/rejection.log"
done
"${query[@]}" 'DROP TABLE public.site_recovery_key'
"${migrate[@]}" recovery-key schema
"${migrate[@]}" verify

"${query[@]}" "INSERT INTO public.site_recovery_key
    SELECT user_id,decode(repeat('01',32),'hex'),decode(repeat('02',16),'hex'),decode(repeat('03',32),'hex'),2,clock_timestamp(),NULL,0,clock_timestamp()
    FROM public.passkey_subject;
    INSERT INTO public.site_recovery_rebind(user_id,generation,ticket_digest,expires_at)
    SELECT user_id,1,decode(repeat('04',32),'hex'),clock_timestamp()+interval '1 minute' FROM public.passkey_subject"
"${migrate[@]}" recovery-key schema
[[ $("${query[@]}" 'SELECT version FROM public.site_recovery_key') == 2 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.site_recovery_rebind') == 1 ]]
if "${query[@]}" 'UPDATE public.site_recovery_rebind SET completed_at=clock_timestamp()' > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected completion metadata to require a matching request digest.' >&2
    exit 1
fi
rg -qF 'check constraint' "$scratch/rejection.log"
if "${query[@]}" "UPDATE public.site_recovery_rebind SET challenge_digest=decode(repeat('05',32),'hex'),options='{}'" > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected a stored Passkey challenge to require an explicit expiry.' >&2
    exit 1
fi
rg -qF 'check constraint' "$scratch/rejection.log"
"${query[@]}" 'ALTER TABLE public.site_recovery_key ADD COLUMN unexpected_fixture integer'
if "${migrate[@]}" recovery-key schema > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected drifted Recovery Key storage to remain untouched.' >&2
    exit 1
fi
rg -qF 'relation/column shape mismatch' "$scratch/rejection.log"
"${query[@]}" 'ALTER TABLE public.site_recovery_key DROP COLUMN unexpected_fixture'
"${migrate[@]}" verify
printf '%s\n' 'Verified fresh Recovery Key storage, stopped-service upgrade, partial/drifted component rejection, and idempotent state preservation.'
