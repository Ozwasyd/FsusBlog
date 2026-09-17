#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INPUT_PATH="${1:-${FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_HANDOFF:-}}"
PRESERVE_ROOT="${FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_HANDOFF_PRESERVE_ROOT:-$ROOT_DIR/.tmp/security/production-exposure-returned-handoff}"
WORK_DIR=""
INPUT_DIR=""
RETURNED_DIR=""
EXTRACTED_FROM_ARCHIVE=0

Cleanup() {
    if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
        rm -rf "$WORK_DIR"
    fi
}
trap Cleanup EXIT

Fail() {
    printf '[production-exposure-returned-handoff-closeout] failed\n' >&2
    printf -- '- %s\n' "$1" >&2
    exit 1
}

PreserveExtractedAndFail() {
    local message="$1"

    if ((EXTRACTED_FROM_ARCHIVE == 1)); then
        mkdir -p "$PRESERVE_ROOT"
        preserved_dir="$(mktemp -d "$PRESERVE_ROOT/returned-handoff.XXXXXX")"
        cp -a "$INPUT_DIR/." "$preserved_dir/"
        printf '[production-exposure-returned-handoff-closeout] failed\n' >&2
        printf -- '- %s\n' "$message" >&2
        printf -- '- preserved extracted returned handoff evidence: %s\n' "$preserved_dir" >&2
        exit 1
    fi

    Fail "$message"
}

RejectSymlinksOrFail() {
    local dir="$1"
    local symlinkPath

    symlinkPath="$(find "$dir" -type l -print -quit 2>/dev/null || true)"
    if [[ -n "$symlinkPath" ]]; then
        PreserveExtractedAndFail "returned handoff bundle contains a symlink: ${symlinkPath#"$dir"/}"
    fi
}

CheckArchiveChecksum() {
    local archive="$1"
    local checksumFile="$archive.sha256"
    local expectedDigest actualDigest

    [[ -f "$checksumFile" ]] || Fail "returned handoff archive checksum file is missing: $checksumFile"
    expectedDigest="$(awk 'NF >= 1 { print $1; exit }' "$checksumFile" 2>/dev/null || true)"
    expectedDigest="${expectedDigest,,}"
    [[ "$expectedDigest" =~ ^[0-9a-f]{64}$ ]] || Fail "returned handoff archive checksum file does not contain a valid sha256 digest: $checksumFile"

    actualDigest="$(sha256sum "$archive" | awk '{print $1}')"
    [[ "$expectedDigest" == "$actualDigest" ]] || Fail "returned handoff archive checksum verification failed: $checksumFile"
}

ValidateArchiveMembers() {
    local archive="$1"
    local archiveListing archiveMembers archiveMember entryType
    local topLevel=""

    if ! archiveMembers="$(tar -tzf "$archive" 2>/dev/null)"; then
        Fail "returned handoff archive member list could not be read: $archive"
    fi

    [[ -n "$archiveMembers" ]] || Fail "returned handoff archive is empty: $archive"

    if ! archiveListing="$(tar -tvzf "$archive" 2>/dev/null)"; then
        Fail "returned handoff archive member metadata could not be read: $archive"
    fi

    while IFS= read -r archiveMember; do
        [[ -n "$archiveMember" ]] || continue
        entryType="${archiveMember:0:1}"
        case "$entryType" in
            - | d) ;;
            *) Fail "returned handoff archive contains unsupported member type: $entryType" ;;
        esac
    done <<<"$archiveListing"

    while IFS= read -r archiveMember; do
        [[ -n "$archiveMember" ]] || continue
        if [[ "$archiveMember" == /* ||
            "$archiveMember" == "." ||
            "$archiveMember" == ".." ||
            "$archiveMember" == ../* ||
            "$archiveMember" == */../* ||
            "$archiveMember" == */.. ]]; then
            Fail "returned handoff archive contains unsafe member path: $archiveMember"
        fi
        if [[ "$archiveMember" != */* ]]; then
            Fail "returned handoff archive member is not under a top-level directory: $archiveMember"
        fi
        if [[ -z "$topLevel" ]]; then
            topLevel="${archiveMember%%/*}"
        elif [[ "${archiveMember%%/*}" != "$topLevel" ]]; then
            Fail "returned handoff archive must contain exactly one top-level directory"
        fi
    done <<<"$archiveMembers"
}

if [[ -z "$INPUT_PATH" ]]; then
    Fail 'missing returned handoff bundle path'
fi

if [[ -d "$INPUT_PATH" ]]; then
    [[ ! -L "$INPUT_PATH" ]] || Fail "returned handoff bundle directory must not be a symlink: $INPUT_PATH"
    INPUT_DIR="$(cd "$INPUT_PATH" && pwd)"
elif [[ -f "$INPUT_PATH" ]]; then
    [[ "$INPUT_PATH" == *.tar.gz ]] || Fail "returned handoff bundle file must be a .tar.gz archive: $INPUT_PATH"
    CheckArchiveChecksum "$INPUT_PATH"
    ValidateArchiveMembers "$INPUT_PATH"
    WORK_DIR="$(mktemp -d)"
    EXTRACTED_FROM_ARCHIVE=1
    tar -xzf "$INPUT_PATH" -C "$WORK_DIR"
    mapfile -t extracted_dirs < <(find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d | sort)
    ((${#extracted_dirs[@]} == 1)) || Fail 'returned handoff archive must contain exactly one top-level directory'
    INPUT_DIR="${extracted_dirs[0]}"
else
    Fail "returned handoff bundle path does not exist: $INPUT_PATH"
fi

RejectSymlinksOrFail "$INPUT_DIR"

if [[ -d "$INPUT_DIR/release-evidence" || -f "$INPUT_DIR/SHA256SUMS" || -f "$INPUT_DIR/handoff-summary.json" ]]; then
    "$ROOT_DIR/tools/security/check-production-exposure-handoff-bundle.sh" "$INPUT_DIR" >/dev/null ||
        PreserveExtractedAndFail 'returned handoff bundle verification failed'
fi

if [[ -d "$INPUT_DIR/returned-evidence" ]]; then
    RETURNED_DIR="$INPUT_DIR/returned-evidence"
elif [[ -f "$INPUT_DIR/expected-evidence-manifest.json" ]]; then
    RETURNED_DIR="$INPUT_DIR"
else
    Fail 'returned handoff bundle must contain returned-evidence/ or be a returned-evidence directory'
fi

[[ -f "$RETURNED_DIR/expected-evidence-manifest.json" ]] || Fail "returned evidence is missing expected-evidence-manifest.json: $RETURNED_DIR"

closeout_rc=0
"$ROOT_DIR/tools/security/complete-production-exposure-from-returned-evidence.sh" "$RETURNED_DIR" >/dev/null ||
    closeout_rc=$?

if ((closeout_rc != 0)); then
    if ((EXTRACTED_FROM_ARCHIVE == 1)); then
        PreserveExtractedAndFail 'returned evidence closeout failed'
    fi
    exit "$closeout_rc"
fi

printf '[production-exposure-returned-handoff-closeout] ok\n'
printf -- '- returned evidence: %s\n' "$RETURNED_DIR"
