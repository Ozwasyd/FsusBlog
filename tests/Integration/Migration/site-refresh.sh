#!/usr/bin/env bash
set -euo pipefail
umask 077

source "$(dirname -- "$0")/identity-schema-fixture.sh"
start_identity_fixture site-refresh site_refresh 'site refresh' ' WITH (FORCE)'
"${migrate[@]}" operator refresh-fixture > /dev/null

"${query[@]}" "INSERT INTO public.user_session(digest,user_id,generation,expires_at)
    SELECT decode(repeat('01',32),'hex'),id,generation,clock_timestamp()+interval '1 hour'
    FROM public.blog_user WHERE name='refresh-fixture';
    DROP TABLE public.site_session_refresh_tombstone"
if "${migrate[@]}" site-refresh schema > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected the partial site refresh component to be rejected.' >&2
    exit 1
fi
rg -qF 'The site refresh schema is partially installed.' "$scratch/rejection.log"
"${query[@]}" 'DROP TABLE public.site_session_refresh'
"${migrate[@]}" verify

require_stopped_identity_schema 'Expected installation to require the serving instance to stop.' site-refresh schema

"${migrate[@]}" site-refresh schema
"${query[@]}" "INSERT INTO public.site_session_refresh(family_id,access_digest,refresh_digest,generation,
    idle_expires_at,absolute_expires_at,rotated_at)
    SELECT gen_random_uuid(),digest,decode(repeat('02',32),'hex'),1,statement_timestamp()+interval '1 day',
        statement_timestamp()+interval '2 days',statement_timestamp() FROM public.user_session;
    INSERT INTO public.site_session_refresh_tombstone(refresh_digest,family_id,generation,used_at,expires_at)
    SELECT decode(repeat('03',32),'hex'),family_id,0,statement_timestamp(),statement_timestamp()+interval '1 day'
    FROM public.site_session_refresh"
"${migrate[@]}" site-refresh schema
"${migrate[@]}" verify
[[ $("${query[@]}" 'SELECT generation FROM public.site_session_refresh') == 1 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.site_session_refresh_tombstone') == 1 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.user_session') == 1 ]]

"${query[@]}" 'ALTER TABLE public.site_session_refresh ADD COLUMN unexpected_fixture integer'
if "${migrate[@]}" site-refresh schema > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected drifted site refresh storage to remain untouched.' >&2
    exit 1
fi
rg -qF 'relation/column shape mismatch' "$scratch/rejection.log"
"${query[@]}" 'ALTER TABLE public.site_session_refresh DROP COLUMN unexpected_fixture'
"${migrate[@]}" verify
printf '%s\n' 'Verified fresh site refresh storage, stopped-service upgrade, partial and drifted schema rejection, and idempotent state preservation.'
