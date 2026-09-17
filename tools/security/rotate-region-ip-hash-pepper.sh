#!/usr/bin/env bash
set -euo pipefail

CONFIRM_VALUE="INVALIDATE_OLD_REGION_IP_HASHES"
CONFIRM="${FSUSBLOG_CONFIRM_REGION_IP_HASH_ROTATION:-}"
DATABASE_URL="${FSUSBLOG_DATABASE_URL:-${DATABASE_URL:-}}"
DRY_RUN="${FSUSBLOG_REGION_IP_HASH_ROTATION_DRY_RUN:-1}"

if [[ "$CONFIRM" != "$CONFIRM_VALUE" ]]; then
    cat >&2 <<EOF
Refusing to invalidate stored region IP hashes.
Set FSUSBLOG_CONFIRM_REGION_IP_HASH_ROTATION=$CONFIRM_VALUE after rotating Moderation:RegionPolicy:IpHashKey.
EOF
    exit 2
fi

if [[ -z "$DATABASE_URL" ]]; then
    cat >&2 <<'EOF'
DATABASE_URL or FSUSBLOG_DATABASE_URL must point at the FsusBlog PostgreSQL database.
EOF
    exit 2
fi

if ! command -v psql >/dev/null 2>&1; then
    echo "psql is required." >&2
    exit 2
fi

if [[ "$DRY_RUN" == "1" || "$DRY_RUN" == "true" ]]; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*) AS rows_that_would_be_invalidated
FROM comment_region_compliance
WHERE submit_ip_hash IS NOT NULL;
SQL
    cat >&2 <<'EOF'
Dry run only. Set FSUSBLOG_REGION_IP_HASH_ROTATION_DRY_RUN=0 to clear old submit_ip_hash values.
EOF
    exit 0
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
UPDATE comment_region_compliance
SET submit_ip_hash = NULL,
    updated_at_utc = now()
WHERE submit_ip_hash IS NOT NULL;
COMMIT;
SQL
