#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INPUT_PATH="${1:-${FSUSBLOG_PRODUCTION_EXPOSURE_HANDOFF_DIR:-}}"
WORK_DIR=""
BUNDLE_DIR=""

failures=()

Cleanup() {
    if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
        rm -rf "$WORK_DIR"
    fi
}
trap Cleanup EXIT

AddFailure() {
    failures+=("$1")
}

RequireFile() {
    local file="$1"
    local label="$2"
    [[ -f "$file" ]] || AddFailure "missing $label: $file"
}

RequireContains() {
    local file="$1"
    local label="$2"
    local needle="$3"

    if [[ -f "$file" ]] && ! grep -Fq "$needle" "$file"; then
        AddFailure "$label does not contain required text: $needle"
    fi
}

RejectSymlinks() {
    local dir="$1"
    local label="$2"
    local symlinkPath

    symlinkPath="$(find "$dir" -type l -print -quit 2>/dev/null || true)"
    if [[ -n "$symlinkPath" ]]; then
        AddFailure "$label contains a symlink: ${symlinkPath#$dir/}"
    fi
}

CheckArchiveChecksum() {
    local archive="$1"
    local checksumFile="$archive.sha256"
    local expectedDigest actualDigest

    expectedDigest="$(awk 'NF >= 1 { print $1; exit }' "$checksumFile" 2>/dev/null || true)"
    expectedDigest="${expectedDigest,,}"
    if [[ ! "$expectedDigest" =~ ^[0-9a-f]{64}$ ]]; then
        AddFailure "handoff bundle archive checksum file does not contain a valid sha256 digest: $checksumFile"
        return
    fi

    actualDigest="$(sha256sum "$archive" | awk '{print $1}')"
    if [[ "$expectedDigest" != "$actualDigest" ]]; then
        AddFailure "handoff bundle archive checksum verification failed: $checksumFile"
    fi
}

ValidateArchiveMembers() {
    local archive="$1"
    local archiveListing archiveMembers archiveMember entryType
    local topLevel=""

    if ! archiveMembers="$(tar -tzf "$archive" 2>/dev/null)"; then
        AddFailure "handoff bundle archive member list could not be read: $archive"
        return
    fi

    if [[ -z "$archiveMembers" ]]; then
        AddFailure "handoff bundle archive is empty: $archive"
        return
    fi

    if ! archiveListing="$(tar -tvzf "$archive" 2>/dev/null)"; then
        AddFailure "handoff bundle archive member metadata could not be read: $archive"
        return
    fi

    while IFS= read -r archiveMember; do
        [[ -n "$archiveMember" ]] || continue
        entryType="${archiveMember:0:1}"
        case "$entryType" in
            - | d) ;;
            *)
                AddFailure "handoff bundle archive contains unsupported member type: $entryType"
                return
                ;;
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
            AddFailure "handoff bundle archive contains unsafe member path: $archiveMember"
            return
        fi
        if [[ "$archiveMember" != */* ]]; then
            AddFailure "handoff bundle archive member is not under a top-level directory: $archiveMember"
            return
        fi
        if [[ -z "$topLevel" ]]; then
            topLevel="${archiveMember%%/*}"
        elif [[ "${archiveMember%%/*}" != "$topLevel" ]]; then
            AddFailure "handoff bundle archive must contain exactly one top-level directory"
            return
        fi
    done <<<"$archiveMembers"
}

JsonValue() {
    local file="$1"
    local expr="$2"
    jq -r "$expr" "$file" 2>/dev/null || true
}

ManifestArtifact() {
    local key="$1"
    jq -r --arg key "$key" '
    .artifacts[$key] | if type == "string" then . else "" end
  ' "$MANIFEST_FILE" 2>/dev/null || true
}

ManifestDigestAlgorithm() {
    local key="$1"
    JsonValue "$MANIFEST_FILE" ".artifactDigests.$key.algorithm // \"\""
}

ManifestDigestValue() {
    local key="$1"
    JsonValue "$MANIFEST_FILE" ".artifactDigests.$key.value // \"\""
}

CheckManifestArtifactDigest() {
    local key="$1"
    local label="$2"
    local expectedArtifact="$3"
    local artifact artifactFile digestAlgorithm digestValue actualDigest

    artifact="$(ManifestArtifact "$key")"
    digestAlgorithm="$(ManifestDigestAlgorithm "$key")"
    digestValue="$(ManifestDigestValue "$key")"

    if [[ -z "$artifact" ]]; then
        if [[ -n "$digestAlgorithm" || -n "$digestValue" ]]; then
            AddFailure "manifest has digest for missing $label"
        fi
        return
    fi

    if [[ "$artifact" != "$expectedArtifact" ]]; then
        AddFailure "manifest indexes unexpected artifact for $label: $artifact"
        return
    fi

    artifactFile="$RELEASE_DIR/$artifact"
    if [[ ! -f "$artifactFile" ]]; then
        AddFailure "manifest indexes missing bundled $label: $artifact"
        return
    fi

    if [[ "$digestAlgorithm" != "sha256" || ! "$digestValue" =~ ^[0-9a-f]{64}$ ]]; then
        AddFailure "manifest is missing a valid sha256 digest for $label"
        return
    fi

    actualDigest="$(sha256sum "$artifactFile" | awk '{print $1}')"
    if [[ "$digestValue" != "$actualDigest" ]]; then
        AddFailure "manifest sha256 digest for $label does not match bundled artifact"
    fi
}

if [[ -z "$INPUT_PATH" ]]; then
    AddFailure 'missing handoff bundle directory'
elif [[ -d "$INPUT_PATH" ]]; then
    if [[ -L "$INPUT_PATH" ]]; then
        AddFailure "handoff bundle directory must not be a symlink: $INPUT_PATH"
    else
        BUNDLE_DIR="$INPUT_PATH"
    fi
elif [[ -f "$INPUT_PATH" ]]; then
    if [[ "$INPUT_PATH" != *.tar.gz ]]; then
        AddFailure "handoff bundle file must be a .tar.gz archive: $INPUT_PATH"
    elif [[ ! -f "$INPUT_PATH.sha256" ]]; then
        AddFailure "handoff bundle archive checksum file is missing: $INPUT_PATH.sha256"
    else
        CheckArchiveChecksum "$INPUT_PATH"
        if ((${#failures[@]} == 0)); then
            ValidateArchiveMembers "$INPUT_PATH"
        fi
        if ((${#failures[@]} == 0)); then
            WORK_DIR="$(mktemp -d)"
            tar -xzf "$INPUT_PATH" -C "$WORK_DIR"
            mapfile -t extracted_dirs < <(find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d | sort)
            if ((${#extracted_dirs[@]} != 1)); then
                AddFailure "handoff bundle archive must contain exactly one top-level directory"
            else
                BUNDLE_DIR="${extracted_dirs[0]}"
            fi
        fi
    fi
else
    AddFailure "handoff bundle path does not exist: $INPUT_PATH"
fi

if ((${#failures[@]} == 0)); then
    BUNDLE_DIR="$(cd "$BUNDLE_DIR" && pwd)"
    RejectSymlinks "$BUNDLE_DIR" 'handoff bundle'
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

    RequireFile "$MANIFEST_FILE" 'release manifest'
    RequireFile "$REQUEST_FILE" 'production exposure request'
    RequireFile "$STATUS_FILE" 'production exposure status'
    RequireFile "$LIVE_FILE" 'live exposure evidence'
    RequireFile "$DNS_READINESS_FILE" 'DNS readiness evidence'
    RequireFile "$DNS_DELEGATION_FILE" 'DNS delegation evidence'
    RequireFile "$SUMMARY_FILE" 'handoff summary'
    RequireFile "$CHECKLIST_FILE" 'operator checklist'
    RequireFile "$ROOT_README_FILE" 'handoff README'
    RequireFile "$RETURNED_MANIFEST_FILE" 'returned evidence manifest'
    RequireFile "$RETURNED_README_FILE" 'returned evidence README'
    RequireFile "$SHA_FILE" 'SHA256SUMS'
fi

if ((${#failures[@]} == 0)); then
    if ! (
        cd "$BUNDLE_DIR"
        sha256sum -c SHA256SUMS >/dev/null
    ); then
        AddFailure 'handoff bundle SHA256SUMS verification failed'
    fi
fi

if ((${#failures[@]} == 0)); then
    CheckManifestArtifactDigest productionExposureRequest 'production exposure request' production-exposure-evidence-request.json
    CheckManifestArtifactDigest productionExposureStatus 'production exposure status' production-exposure-status.json
    CheckManifestArtifactDigest productionExposureLive 'live exposure evidence' production-exposure-live.json
    CheckManifestArtifactDigest dnsReadiness 'DNS readiness evidence' production-dns-readiness.json
    CheckManifestArtifactDigest dnsDelegation 'DNS delegation evidence' production-dns-delegation.json
    CheckManifestArtifactDigest firewallPolicy 'firewall policy evidence' production-firewall-policy.json

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
        AddFailure 'release manifest external exposure summary does not match bundled request/status'
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
        AddFailure 'handoff summary does not preserve verified request and closeout metadata'
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
        AddFailure 'operator checklist does not match bundled request unblock plan and closeout commands'
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
        AddFailure 'returned evidence manifest does not match handoff summary scope or closeout requirements'
    fi

    for readme_token in \
        'release-evidence/manifest.json' \
        'operator-checklist.json' \
        'returned-evidence/' \
        'This is not a passing production closeout signal'; do
        RequireContains "$ROOT_README_FILE" 'handoff README' "$readme_token"
    done

    for readme_token in \
        'production-firewall-policy.json' \
        'production-dns-readiness.json' \
        'production-dns-delegation.json' \
        'production-exposure-live.json' \
        'tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>' \
        'tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>' \
        'tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>'; do
        RequireContains "$RETURNED_README_FILE" 'returned evidence README' "$readme_token"
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
