#!/usr/bin/env bash
set -euo pipefail
umask 077

# A previous image is not proof that its database matches the current schema.
# Recovery requires a verified database restore and fresh admission, or a forward release.
printf 'gateway-rollback.sh: schema_image_only_rollback_retired\n' >&2
exit 2
