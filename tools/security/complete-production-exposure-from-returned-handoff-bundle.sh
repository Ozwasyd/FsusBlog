#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INPUT_PATH="${1:-${FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_HANDOFF:-}}"
TODO_FILE="${FSUSBLOG_TODO_FILE:-$ROOT_DIR/TODO.md}"
PRESERVE_ROOT="${FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_HANDOFF_PRESERVE_ROOT:-$ROOT_DIR/.tmp/security/production-exposure-returned-handoff}"
WORK_DIR=""
INPUT_DIR=""
RETURNED_DIR=""
EXTRACTED_FROM_ARCHIVE=0

cleanup() {
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

fail() {
  printf '[production-exposure-returned-handoff-closeout] failed\n' >&2
  printf -- '- %s\n' "$1" >&2
  exit 1
}

preserve_extracted_and_fail() {
  local message="$1"

  if (( EXTRACTED_FROM_ARCHIVE == 1 )); then
    mkdir -p "$PRESERVE_ROOT"
    preserved_dir="$(mktemp -d "$PRESERVE_ROOT/returned-handoff.XXXXXX")"
    cp -a "$INPUT_DIR/." "$preserved_dir/"
    printf '[production-exposure-returned-handoff-closeout] failed\n' >&2
    printf -- '- %s\n' "$message" >&2
    printf -- '- preserved extracted returned handoff evidence: %s\n' "$preserved_dir" >&2
    exit 1
  fi

  fail "$message"
}

reject_symlinks_or_fail() {
  local dir="$1"
  local symlink_path

  symlink_path="$(find "$dir" -type l -print -quit 2>/dev/null || true)"
  if [[ -n "$symlink_path" ]]; then
    preserve_extracted_and_fail "returned handoff bundle contains a symlink: ${symlink_path#$dir/}"
  fi
}

check_archive_checksum() {
  local archive="$1"
  local checksum_file="$archive.sha256"
  local expected_digest actual_digest

  [[ -f "$checksum_file" ]] || fail "returned handoff archive checksum file is missing: $checksum_file"
  expected_digest="$(awk 'NF >= 1 { print $1; exit }' "$checksum_file" 2>/dev/null || true)"
  expected_digest="${expected_digest,,}"
  [[ "$expected_digest" =~ ^[0-9a-f]{64}$ ]] || fail "returned handoff archive checksum file does not contain a valid sha256 digest: $checksum_file"

  actual_digest="$(sha256sum "$archive" | awk '{print $1}')"
  [[ "$expected_digest" == "$actual_digest" ]] || fail "returned handoff archive checksum verification failed: $checksum_file"
}

validate_archive_members() {
  local archive="$1"
  local archive_listing archive_members archive_member entry_type
  local top_level=""

  if ! archive_members="$(tar -tzf "$archive" 2>/dev/null)"; then
    fail "returned handoff archive member list could not be read: $archive"
  fi

  [[ -n "$archive_members" ]] || fail "returned handoff archive is empty: $archive"

  if ! archive_listing="$(tar -tvzf "$archive" 2>/dev/null)"; then
    fail "returned handoff archive member metadata could not be read: $archive"
  fi

  while IFS= read -r archive_member; do
    [[ -n "$archive_member" ]] || continue
    entry_type="${archive_member:0:1}"
    case "$entry_type" in
      -|d) ;;
      *) fail "returned handoff archive contains unsupported member type: $entry_type" ;;
    esac
  done <<<"$archive_listing"

  while IFS= read -r archive_member; do
    [[ -n "$archive_member" ]] || continue
    if [[ "$archive_member" == /* \
      || "$archive_member" == "." \
      || "$archive_member" == ".." \
      || "$archive_member" == ../* \
      || "$archive_member" == */../* \
      || "$archive_member" == */.. ]]; then
      fail "returned handoff archive contains unsafe member path: $archive_member"
    fi
    if [[ "$archive_member" != */* ]]; then
      fail "returned handoff archive member is not under a top-level directory: $archive_member"
    fi
    if [[ -z "$top_level" ]]; then
      top_level="${archive_member%%/*}"
    elif [[ "${archive_member%%/*}" != "$top_level" ]]; then
      fail "returned handoff archive must contain exactly one top-level directory"
    fi
  done <<<"$archive_members"
}

if [[ -z "$INPUT_PATH" ]]; then
  fail 'missing returned handoff bundle path'
fi

if [[ -d "$INPUT_PATH" ]]; then
  [[ ! -L "$INPUT_PATH" ]] || fail "returned handoff bundle directory must not be a symlink: $INPUT_PATH"
  INPUT_DIR="$(cd "$INPUT_PATH" && pwd)"
elif [[ -f "$INPUT_PATH" ]]; then
  [[ "$INPUT_PATH" == *.tar.gz ]] || fail "returned handoff bundle file must be a .tar.gz archive: $INPUT_PATH"
  check_archive_checksum "$INPUT_PATH"
  validate_archive_members "$INPUT_PATH"
  WORK_DIR="$(mktemp -d)"
  EXTRACTED_FROM_ARCHIVE=1
  tar -xzf "$INPUT_PATH" -C "$WORK_DIR"
  mapfile -t extracted_dirs < <(find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d | sort)
  (( ${#extracted_dirs[@]} == 1 )) || fail 'returned handoff archive must contain exactly one top-level directory'
  INPUT_DIR="${extracted_dirs[0]}"
else
  fail "returned handoff bundle path does not exist: $INPUT_PATH"
fi

reject_symlinks_or_fail "$INPUT_DIR"

if [[ -d "$INPUT_DIR/release-evidence" || -f "$INPUT_DIR/SHA256SUMS" || -f "$INPUT_DIR/handoff-summary.json" ]]; then
  "$ROOT_DIR/tools/security/check-production-exposure-handoff-bundle.sh" "$INPUT_DIR" >/dev/null \
    || preserve_extracted_and_fail 'returned handoff bundle verification failed'
fi

if [[ -d "$INPUT_DIR/returned-evidence" ]]; then
  RETURNED_DIR="$INPUT_DIR/returned-evidence"
elif [[ -f "$INPUT_DIR/expected-evidence-manifest.json" ]]; then
  RETURNED_DIR="$INPUT_DIR"
else
  fail 'returned handoff bundle must contain returned-evidence/ or be a returned-evidence directory'
fi

[[ -f "$RETURNED_DIR/expected-evidence-manifest.json" ]] || fail "returned evidence is missing expected-evidence-manifest.json: $RETURNED_DIR"

closeout_rc=0
FSUSBLOG_TODO_FILE="$TODO_FILE" \
  "$ROOT_DIR/tools/security/complete-production-exposure-from-returned-evidence.sh" "$RETURNED_DIR" >/dev/null \
  || closeout_rc=$?

if (( closeout_rc != 0 )); then
  if (( EXTRACTED_FROM_ARCHIVE == 1 )); then
    preserve_extracted_and_fail 'returned evidence closeout failed'
  fi
  exit "$closeout_rc"
fi

printf '[production-exposure-returned-handoff-closeout] ok\n'
printf -- '- returned evidence: %s\n' "$RETURNED_DIR"
