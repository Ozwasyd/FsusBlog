#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INPUT_PATH="${1:-${FSUSBLOG_PRODUCTION_EXPOSURE_HANDOFF_DIR:-}}"
WORK_DIR=""
BUNDLE_DIR=""

failures=()

cleanup() {
    if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
        rm -rf "$WORK_DIR"
    fi
}
trap cleanup EXIT

add_failure() {
    failures+=("$1")
}

require_file() {
    local file="$1"
    local label="$2"
    [[ -f "$file" ]] || add_failure "missing $label: $file"
}

require_contains() {
    local file="$1"
    local label="$2"
    local needle="$3"

    if [[ -f "$file" ]] && ! grep -Fq "$needle" "$file"; then
        add_failure "$label does not contain required text: $needle"
    fi
}

reject_symlinks() {
    local dir="$1"
    local label="$2"
    local symlink_path

    symlink_path="$(find "$dir" -type l -print -quit 2>/dev/null || true)"
    if [[ -n "$symlink_path" ]]; then
        add_failure "$label contains a symlink: ${symlink_path#$dir/}"
    fi
}

check_archive_checksum() {
    local archive="$1"
    local checksum_file="$archive.sha256"
    local expected_digest actual_digest

    expected_digest="$(awk 'NF >= 1 { print $1; exit }' "$checksum_file" 2>/dev/null || true)"
    expected_digest="${expected_digest,,}"
    if [[ ! "$expected_digest" =~ ^[0-9a-f]{64}$ ]]; then
        add_failure "handoff bundle archive checksum file does not contain a valid sha256 digest: $checksum_file"
        return
    fi

    actual_digest="$(sha256sum "$archive" | awk '{print $1}')"
    if [[ "$expected_digest" != "$actual_digest" ]]; then
        add_failure "handoff bundle archive checksum verification failed: $checksum_file"
    fi
}

validate_archive_members() {
    local archive="$1"
    local archive_listing archive_members archive_member entry_type
    local top_level=""

    if ! archive_members="$(tar -tzf "$archive" 2>/dev/null)"; then
        add_failure "handoff bundle archive member list could not be read: $archive"
        return
    fi

    if [[ -z "$archive_members" ]]; then
        add_failure "handoff bundle archive is empty: $archive"
        return
    fi

    if ! archive_listing="$(tar -tvzf "$archive" 2>/dev/null)"; then
        add_failure "handoff bundle archive member metadata could not be read: $archive"
        return
    fi

    while IFS= read -r archive_member; do
        [[ -n "$archive_member" ]] || continue
        entry_type="${archive_member:0:1}"
        case "$entry_type" in
            - | d) ;;
            *)
                add_failure "handoff bundle archive contains unsupported member type: $entry_type"
                return
                ;;
        esac
    done <<<"$archive_listing"

    while IFS= read -r archive_member; do
        [[ -n "$archive_member" ]] || continue
        if [[ "$archive_member" == /* ||
            "$archive_member" == "." ||
            "$archive_member" == ".." ||
            "$archive_member" == ../* ||
            "$archive_member" == */../* ||
            "$archive_member" == */.. ]]; then
            add_failure "handoff bundle archive contains unsafe member path: $archive_member"
            return
        fi
        if [[ "$archive_member" != */* ]]; then
            add_failure "handoff bundle archive member is not under a top-level directory: $archive_member"
            return
        fi
        if [[ -z "$top_level" ]]; then
            top_level="${archive_member%%/*}"
        elif [[ "${archive_member%%/*}" != "$top_level" ]]; then
            add_failure "handoff bundle archive must contain exactly one top-level directory"
            return
        fi
    done <<<"$archive_members"
}

json_value() {
    local file="$1"
    local expr="$2"
    jq -r "$expr" "$file" 2>/dev/null || true
}

manifest_artifact() {
    local key="$1"
    jq -r --arg key "$key" '
    .artifacts[$key] | if type == "string" then . else "" end
  ' "$MANIFEST_FILE" 2>/dev/null || true
}

manifest_digest_algorithm() {
    local key="$1"
    json_value "$MANIFEST_FILE" ".artifactDigests.$key.algorithm // \"\""
}

manifest_digest_value() {
    local key="$1"
    json_value "$MANIFEST_FILE" ".artifactDigests.$key.value // \"\""
}

check_manifest_artifact_digest() {
    local key="$1"
    local label="$2"
    local expected_artifact="$3"
    local artifact artifact_file digest_algorithm digest_value actual_digest

    artifact="$(manifest_artifact "$key")"
    digest_algorithm="$(manifest_digest_algorithm "$key")"
    digest_value="$(manifest_digest_value "$key")"

    if [[ -z "$artifact" ]]; then
        if [[ -n "$digest_algorithm" || -n "$digest_value" ]]; then
            add_failure "manifest has digest for missing $label"
        fi
        return
    fi

    if [[ "$artifact" != "$expected_artifact" ]]; then
        add_failure "manifest indexes unexpected artifact for $label: $artifact"
        return
    fi

    artifact_file="$RELEASE_DIR/$artifact"
    if [[ ! -f "$artifact_file" ]]; then
        add_failure "manifest indexes missing bundled $label: $artifact"
        return
    fi

    if [[ "$digest_algorithm" != "sha256" || ! "$digest_value" =~ ^[0-9a-f]{64}$ ]]; then
        add_failure "manifest is missing a valid sha256 digest for $label"
        return
    fi

    actual_digest="$(sha256sum "$artifact_file" | awk '{print $1}')"
    if [[ "$digest_value" != "$actual_digest" ]]; then
        add_failure "manifest sha256 digest for $label does not match bundled artifact"
    fi
}

if [[ -z "$INPUT_PATH" ]]; then
    add_failure 'missing handoff bundle directory'
elif [[ -d "$INPUT_PATH" ]]; then
    if [[ -L "$INPUT_PATH" ]]; then
        add_failure "handoff bundle directory must not be a symlink: $INPUT_PATH"
    else
        BUNDLE_DIR="$INPUT_PATH"
    fi
elif [[ -f "$INPUT_PATH" ]]; then
    if [[ "$INPUT_PATH" != *.tar.gz ]]; then
        add_failure "handoff bundle file must be a .tar.gz archive: $INPUT_PATH"
    elif [[ ! -f "$INPUT_PATH.sha256" ]]; then
        add_failure "handoff bundle archive checksum file is missing: $INPUT_PATH.sha256"
    else
        check_archive_checksum "$INPUT_PATH"
        if ((${#failures[@]} == 0)); then
            validate_archive_members "$INPUT_PATH"
        fi
        if ((${#failures[@]} == 0)); then
            WORK_DIR="$(mktemp -d)"
            tar -xzf "$INPUT_PATH" -C "$WORK_DIR"
            mapfile -t extracted_dirs < <(find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d | sort)
            if ((${#extracted_dirs[@]} != 1)); then
                add_failure "handoff bundle archive must contain exactly one top-level directory"
            else
                BUNDLE_DIR="${extracted_dirs[0]}"
            fi
        fi
    fi
else
    add_failure "handoff bundle path does not exist: $INPUT_PATH"
fi

if ((${#failures[@]} == 0)); then
    BUNDLE_DIR="$(cd "$BUNDLE_DIR" && pwd)"
    reject_symlinks "$BUNDLE_DIR" 'handoff bundle'
fi

if ((${#failures[@]} == 0)); then
    RELEASE_DIR="$BUNDLE_DIR/release-evidence"
    MANIFEST_FILE="$RELEASE_DIR/manifest.json"
    REQUEST_FILE="$RELEASE_DIR/production-exposure-evidence-request.json"
    STATUS_FILE="$RELEASE_DIR/production-exposure-status.json"
    LIVE_FILE="$RELEASE_DIR/production-exposure-live.json"
    DNS_READINESS_FILE="$RELEASE_DIR/production-dns-readiness.json"
    DNS_DELEGATION_FILE="$RELEASE_DIR/production-dns-delegation.json"
    FIREWALL_FILE="$RELEASE_DIR/production-firewall-policy.json"
    SUMMARY_FILE="$BUNDLE_DIR/handoff-summary.json"
    CHECKLIST_FILE="$BUNDLE_DIR/operator-checklist.json"
    ROOT_README_FILE="$BUNDLE_DIR/README.md"
    RETURNED_MANIFEST_FILE="$BUNDLE_DIR/returned-evidence/expected-evidence-manifest.json"
    RETURNED_README_FILE="$BUNDLE_DIR/returned-evidence/README.md"
    SHA_FILE="$BUNDLE_DIR/SHA256SUMS"

    require_file "$MANIFEST_FILE" 'release manifest'
    require_file "$REQUEST_FILE" 'production exposure request'
    require_file "$STATUS_FILE" 'production exposure status'
    require_file "$LIVE_FILE" 'live exposure evidence'
    require_file "$DNS_READINESS_FILE" 'DNS readiness evidence'
    require_file "$DNS_DELEGATION_FILE" 'DNS delegation evidence'
    require_file "$SUMMARY_FILE" 'handoff summary'
    require_file "$CHECKLIST_FILE" 'operator checklist'
    require_file "$ROOT_README_FILE" 'handoff README'
    require_file "$RETURNED_MANIFEST_FILE" 'returned evidence manifest'
    require_file "$RETURNED_README_FILE" 'returned evidence README'
    require_file "$SHA_FILE" 'SHA256SUMS'
fi

if ((${#failures[@]} == 0)); then
    if ! (
        cd "$BUNDLE_DIR"
        sha256sum -c SHA256SUMS >/dev/null
    ); then
        add_failure 'handoff bundle SHA256SUMS verification failed'
    fi
fi

if ((${#failures[@]} == 0)); then
    check_manifest_artifact_digest productionExposureRequest 'production exposure request' production-exposure-evidence-request.json
    check_manifest_artifact_digest productionExposureStatus 'production exposure status' production-exposure-status.json
    check_manifest_artifact_digest productionExposureLive 'live exposure evidence' production-exposure-live.json
    check_manifest_artifact_digest dnsReadiness 'DNS readiness evidence' production-dns-readiness.json
    check_manifest_artifact_digest dnsDelegation 'DNS delegation evidence' production-dns-delegation.json
    check_manifest_artifact_digest firewallPolicy 'firewall policy evidence' production-firewall-policy.json

    if ! jq -e --slurpfile request "$REQUEST_FILE" --slurpfile status "$STATUS_FILE" '
    def returned_closeout_command_count($request):
      [
        $request.verificationCommands[]?
        | select(
            (.name == "verify-returned-evidence"
              and .command == "tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>"
              and .requiredBeforeReturnedCloseout == true)
            or (.name == "complete-returned-evidence"
              and .command == "tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>"
              and .requiredForCloseout == true)
            or (.name == "complete-returned-handoff"
              and .command == "tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>"
              and .requiredForCloseout == true)
          )
      ] | length;
    .artifacts.productionExposureRequest == "production-exposure-evidence-request.json"
    and .artifacts.productionExposureStatus == "production-exposure-status.json"
	    and (.evidenceSummary.externalExposure.request.requiredHosts // [] | sort) == ($request[0].requiredHosts // [] | sort)
	    and (.evidenceSummary.externalExposure.request.delegationDomains // [] | sort) == ($request[0].delegationDomains // [] | sort)
	    and (.evidenceSummary.externalExposure.request.blockerCount // 0) == ($status[0].blockers // [] | length)
	    and (.evidenceSummary.externalExposure.request.blockerSources // [] | sort) == ($status[0].blockers // [] | map(.source) | unique | sort)
	    and (.evidenceSummary.externalExposure.request.unblockPlanSources // [] | sort) == ($request[0].unblockPlan // [] | map(.source) | sort)
	    and (.evidenceSummary.externalExposure.request.unblockPlanCount // null) == ($request[0].unblockPlan // [] | length)
	    and (.evidenceSummary.externalExposure.request.requiredEvidenceKeys // [] | sort) == ($request[0].requiredEvidence // [] | map(.key) | sort)
    and (.evidenceSummary.externalExposure.request.firewallSourceSha256Required == true)
    and (.evidenceSummary.externalExposure.request.rawSourceSha256Required == true)
    and (.evidenceSummary.externalExposure.request.verificationCommandNames // [] | sort) == ($request[0].verificationCommands // [] | map(.name) | sort)
    and (.evidenceSummary.externalExposure.request.verificationCommandCount // null) == ($request[0].verificationCommands // [] | length)
    and (.evidenceSummary.externalExposure.request.returnedCloseoutCommandCount // null) == returned_closeout_command_count($request[0])
    and (.evidenceSummary.externalExposure.request.closeoutCommands.finalCloseout // null) == ($request[0].finalCloseoutCommand // null)
    and (.evidenceSummary.externalExposure.request.closeoutCommands.returnedEvidenceVerifier // null) == ($request[0].returnedEvidenceVerifierCommand // null)
    and (.evidenceSummary.externalExposure.request.closeoutCommands.returnedEvidenceCloseout // null) == ($request[0].returnedEvidenceCloseoutCommand // null)
    and (.evidenceSummary.externalExposure.request.closeoutCommands.returnedHandoffCloseout // null) == ($request[0].returnedHandoffCloseoutCommand // null)
    and (.evidenceSummary.externalExposure.request.closeoutCommands.releaseEvidence // null) == ($request[0].releaseEvidenceCommand // null)
  ' "$MANIFEST_FILE" >/dev/null 2>&1; then
        add_failure 'release manifest external exposure summary does not match bundled request/status'
    fi

    if ! jq -e --slurpfile request "$REQUEST_FILE" '
	    .handoffStatus == "verified"
	    and .releaseEvidenceDir == "release-evidence"
	    and (.externalExposure.request.requiredHosts // [] | length) > 0
	    and (.externalExposure.request.delegationDomains // [] | length) > 0
	    and (.requiredEvidence // []) == ($request[0].requiredEvidence // [])
	    and (.unblockPlan // []) == ($request[0].unblockPlan // [])
	    and (.unblockPlan // [] | length) > 0
	    and all(.unblockPlan[]?; (.blockerCount // 0) > 0 and (.artifactNames // [] | length) > 0 and (.commands // [] | length) > 0)
	    and any(.verificationCommands[]?; .name == "complete-closeout")
    and any(.verificationCommands[]?; .name == "verify-returned-evidence")
    and any(.verificationCommands[]?; .name == "complete-returned-evidence")
    and any(.verificationCommands[]?; .name == "complete-returned-handoff")
    and any(.verificationCommands[]?; .name == "handoff-check")
    and any(.handoffChecks[]?; .id == "request-status-manifest-alignment")
  ' "$SUMMARY_FILE" >/dev/null 2>&1; then
        add_failure 'handoff summary does not preserve verified request and closeout metadata'
    fi

    if ! jq -e --slurpfile request "$REQUEST_FILE" '
    .contractVersion == 1
    and .generatedBy == "tools/security/export-production-exposure-handoff-bundle.sh"
    and .status == "action-required"
    and (.requiredHosts // [] | sort) == ($request[0].requiredHosts // [] | sort)
    and (.delegationDomains // [] | sort) == ($request[0].delegationDomains // [] | sort)
    and (.blockerCount // null) == ($request[0].currentStatus.blockerCount // ($request[0].currentStatus.blockers // [] | length))
    and (.blockerSources // [] | sort) == ($request[0].unblockPlan // [] | map(.source) | sort)
    and (.checklist // []) == (
      ($request[0].unblockPlan // [])
      | map({
          source,
          blockerCount,
          blockers: (.blockers // []),
          evidenceKeys: (.evidenceKeys // []),
          artifactNames: (.artifactNames // []),
          evidenceFiles: (.evidenceFiles // []),
          commands: (.commands // []),
          returnedEvidenceRequired: (.returnedEvidenceRequired == true)
        })
    )
    and all(.checklist[]?; (.source | type) == "string" and (.artifactNames // [] | length) > 0 and (.commands // [] | length) > 0)
    and (.verifyReturnedEvidenceCommand // null) == ($request[0].returnedEvidenceVerifierCommand // null)
    and (.closeoutCommand // null) == ($request[0].returnedEvidenceCloseoutCommand // null)
    and (.handoffCloseoutCommand // null) == ($request[0].returnedHandoffCloseoutCommand // null)
    and (.closeoutRule // null) == ($request[0].closeoutRule // null)
  ' "$CHECKLIST_FILE" >/dev/null 2>&1; then
        add_failure 'operator checklist does not match bundled request unblock plan and closeout commands'
    fi

    bundled_manifest_sha256="$(sha256sum "$MANIFEST_FILE" | awk '{print $1}')"
    bundled_request_sha256="$(sha256sum "$REQUEST_FILE" | awk '{print $1}')"
    if ! jq -e \
        --arg manifestSha256 "$bundled_manifest_sha256" \
        --arg requestSha256 "$bundled_request_sha256" \
        --slurpfile summary "$SUMMARY_FILE" '
    ($summary[0].unblockPlan // [] | map(select(.returnedEvidenceRequired == true))) as $returnedUnblockPlan
    |
    .contractVersion == 1
    and .generatedBy == "tools/security/export-production-exposure-handoff-bundle.sh"
    and .sourceReleaseManifestSha256 == $manifestSha256
    and .sourceRequestSha256 == $requestSha256
    and (.sourceReleaseManifest | type) == "string"
    and .status == "awaiting-returned-evidence"
    and (.requiredHosts // [] | sort) == ($summary[0].externalExposure.request.requiredHosts // [] | sort)
    and (.delegationDomains // [] | sort) == ($summary[0].externalExposure.request.delegationDomains // [] | sort)
    and (.unblockPlanSources // [] | sort) == ($returnedUnblockPlan | map(.source) | unique | sort)
    and (.unblockPlanCount // null) == ($returnedUnblockPlan | length)
    and (.unblockPlan // []) == $returnedUnblockPlan
    and ([.requiredReturnedFiles[].artifactName] | sort) == [
      "production-dns-delegation.json",
      "production-dns-readiness.json",
      "production-exposure-live.json",
      "production-firewall-policy.json"
    ]
    and all(.requiredReturnedFiles[]; .requiredForCloseout == true)
    and any(.requiredReturnedFiles[]; .artifactName == "production-firewall-policy.json" and .sourceSha256Required == true)
    and (.scopeRule | tostring | contains("must not narrow"))
    and (.verifierCommand | contains("verify-production-exposure-returned-evidence.sh"))
    and (.closeoutCommand | contains("complete-production-exposure-from-returned-evidence.sh"))
    and (.handoffCloseoutCommand | contains("complete-production-exposure-from-returned-handoff-bundle.sh"))
  ' "$RETURNED_MANIFEST_FILE" >/dev/null 2>&1; then
        add_failure 'returned evidence manifest does not match handoff summary scope or closeout requirements'
    fi

    for readme_token in \
        'release-evidence/manifest.json' \
        'operator-checklist.json' \
        'returned-evidence/' \
        'This is not a passing production closeout signal'; do
        require_contains "$ROOT_README_FILE" 'handoff README' "$readme_token"
    done

    for readme_token in \
        'production-firewall-policy.json' \
        'production-dns-readiness.json' \
        'production-dns-delegation.json' \
        'production-exposure-live.json' \
        'tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>' \
        'tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>' \
        'tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>'; do
        require_contains "$RETURNED_README_FILE" 'returned evidence README' "$readme_token"
    done
fi

if ((${#failures[@]} > 0)); then
    printf '[production-exposure-handoff-bundle-check] failed\n' >&2
    for failure in "${failures[@]}"; do
        printf -- '- %s\n' "$failure" >&2
    done
    exit 1
fi

printf '[production-exposure-handoff-bundle-check] ok\n'
