#!/usr/bin/env bash
set -euo pipefail
umask 077

# Retained only to reject obsolete callers until release consumers are retired.
# The sole offline migration executable owns plan/apply/verify; never forward to Server.
printf '{"status":"failed","code":"schema_wrapper_retired"}\n'
exit 2
