#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRY_RUN="${FSUSBLOG_RETENTION_DRY_RUN:-1}"
OUT_DIR="${FSUSBLOG_RETENTION_OUTPUT_DIR:-$ROOT_DIR/.tmp/operations}"
mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/retention-cleanup.json"
WEBROOT_DIR="${FSUSBLOG_RETENTION_WEBROOT_DIR:-$ROOT_DIR/src/backend/wwwroot}"
UPLOAD_ASSET_DIR="${FSUSBLOG_RETENTION_UPLOAD_ASSET_DIR:-$WEBROOT_DIR/uploads/illustration}"
SCAN_UPLOAD_ASSETS="${FSUSBLOG_RETENTION_SCAN_UPLOAD_ASSETS:-0}"
REFERENCED_ASSETS_FILE="${FSUSBLOG_RETENTION_REFERENCED_ASSETS:-}"
UPLOAD_ASSET_DAYS="${FSUSBLOG_RETENTION_UPLOAD_ASSET_DAYS:-365}"
REFERENCES_TMP="$(mktemp)"
trap 'rm -f "$REFERENCES_TMP"' EXIT

declare -A days=(
  ["${FSUSBLOG_RETENTION_SECURITY_DIR:-$ROOT_DIR/.tmp/security}"]=30
  ["${FSUSBLOG_RETENTION_RELEASE_EVIDENCE_DIR:-$ROOT_DIR/.tmp/release-evidence}"]=180
  ["${FSUSBLOG_RETENTION_COVERAGE_DIR:-$ROOT_DIR/artifacts/coverage}"]=30
  ["${FSUSBLOG_RETENTION_UPLOAD_SESSION_DIR:-$ROOT_DIR/src/backend/.upload-sessions}"]=2
  ["${FSUSBLOG_RETENTION_AOT_CACHE_DIR:-$WEBROOT_DIR/aot-cache}"]=14
  ["${FSUSBLOG_RETENTION_SEARCH_DIR:-$WEBROOT_DIR/search}"]=14
)

deleted=0
scanned=0
asset_candidates=0
asset_deleted=0
asset_protected=0
asset_reference_mode="not_configured"

normalize_asset_reference() {
  local value="$1"
  [[ -n "$value" ]] || return 0
  value="${value%%[?#]*}"
  if [[ "$value" == http://* || "$value" == https://* ]]; then
    value="/${value#*://*/}"
  fi
  if [[ "$value" == uploads/illustration/* ]]; then
    value="/$value"
  fi
  if [[ "$value" == */uploads/illustration/* && "$value" != /uploads/illustration/* ]]; then
    value="/uploads/illustration/${value##*/uploads/illustration/}"
  fi
  printf '%s\n' "$value"
}

load_referenced_assets() {
  if [[ -z "$REFERENCED_ASSETS_FILE" ]]; then
    return
  fi

  if [[ ! -f "$REFERENCED_ASSETS_FILE" ]]; then
    echo "[retention-cleanup] referenced asset file not found: $REFERENCED_ASSETS_FILE" >&2
    exit 1
  fi

  asset_reference_mode="configured"
  if jq -e . "$REFERENCED_ASSETS_FILE" >/dev/null 2>&1; then
    jq -r '
      if type == "array" then
        .[]?
      elif type == "object" then
        .referencedAssets[]?,
        .assets[]?.url?,
        .articles[]?.coverImageUrl?
      else
        empty
      end
    ' "$REFERENCED_ASSETS_FILE" | while IFS= read -r value; do
      normalize_asset_reference "$value"
    done | sort -u > "$REFERENCES_TMP"
  else
    while IFS= read -r value; do
      normalize_asset_reference "$value"
    done < "$REFERENCED_ASSETS_FILE" | sort -u > "$REFERENCES_TMP"
  fi
}

is_referenced_asset() {
  local file_path="$1"
  local relative_url
  if [[ "$file_path" == "$WEBROOT_DIR/"* ]]; then
    relative_url="/${file_path#"$WEBROOT_DIR"/}"
  else
    relative_url="/uploads/illustration/${file_path##*/}"
  fi
  relative_url="${relative_url//\/\//\/}"
  grep -Fxq "$relative_url" "$REFERENCES_TMP" || grep -Fxq "$file_path" "$REFERENCES_TMP"
}

load_referenced_assets

for dir in "${!days[@]}"; do
  [[ -d "$dir" ]] || continue
  ((scanned+=1))
  if [[ "$DRY_RUN" == "1" ]]; then
    find "$dir" -mindepth 1 -mtime +"${days[$dir]}" -print >/dev/null
  else
    while IFS= read -r path; do
      rm -rf "$path"
      ((deleted+=1))
    done < <(find "$dir" -mindepth 1 -mtime +"${days[$dir]}" -print)
  fi
done

if [[ "$SCAN_UPLOAD_ASSETS" == "1" ]]; then
  [[ -d "$UPLOAD_ASSET_DIR" ]] || {
    echo "[retention-cleanup] upload asset directory not found: $UPLOAD_ASSET_DIR" >&2
    exit 1
  }
  [[ -s "$REFERENCES_TMP" ]] || {
    echo "[retention-cleanup] upload asset scan requires non-empty FSUSBLOG_RETENTION_REFERENCED_ASSETS" >&2
    exit 1
  }

  ((scanned+=1))
  while IFS= read -r asset_path; do
    ((asset_candidates+=1))
    if is_referenced_asset "$asset_path"; then
      ((asset_protected+=1))
      continue
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
      continue
    fi

    rm -f "$asset_path"
    ((deleted+=1))
    ((asset_deleted+=1))
  done < <(find "$UPLOAD_ASSET_DIR" -type f -mtime +"$UPLOAD_ASSET_DAYS" -print)
fi

cat > "$OUT_FILE" <<JSON
{
  "status": "ok",
  "dryRun": $([[ "$DRY_RUN" == "1" ]] && echo true || echo false),
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "scannedRoots": $scanned,
  "deletedEntries": $deleted,
  "policy": {
    "securityEvidenceDays": 30,
    "releaseEvidenceDays": 180,
    "coverageDays": 30,
    "uploadTempDays": 2,
    "aotSearchHistoryDays": 14,
    "uploadAssetDays": $UPLOAD_ASSET_DAYS
  },
  "assetGuard": {
    "scanEnabled": $([[ "$SCAN_UPLOAD_ASSETS" == "1" ]] && echo true || echo false),
    "referenceMode": "$asset_reference_mode",
    "uploadAssetDir": "$UPLOAD_ASSET_DIR",
    "candidateAssets": $asset_candidates,
    "protectedReferencedAssets": $asset_protected,
    "deletedUnreferencedAssets": $asset_deleted
  }
}
JSON

echo "[retention-cleanup] wrote $OUT_FILE"
