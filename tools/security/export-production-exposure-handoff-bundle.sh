#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HANDOFF_CHECK_SCRIPT="$ROOT_DIR/tools/security/check-production-exposure-handoff.sh"
BUNDLE_CHECK_SCRIPT="$ROOT_DIR/tools/security/check-production-exposure-handoff-bundle.sh"
MANIFEST_FILE="${1:-${FSUSBLOG_RELEASE_EVIDENCE_MANIFEST:-}}"
OUT_ROOT="${FSUSBLOG_PRODUCTION_EXPOSURE_HANDOFF_ROOT:-$ROOT_DIR/.tmp/security/production-exposure-handoff}"

Fail() {
    printf '[production-exposure-handoff-bundle] failed\n' >&2
    printf -- '- %s\n' "$1" >&2
    exit 1
}

JsonValue() {
    local file="$1"
    local expr="$2"
    jq -r "$expr" "$file" 2>/dev/null || true
}

WriteCurrentDirectoryChecksums() {
    local -a checksumFiles=()
    mapfile -d '' -t checksumFiles < <(find . -type f ! -name SHA256SUMS -print0 | sort -z)
    ((${#checksumFiles[@]} > 0)) || Fail 'handoff bundle contains no files to checksum'
    sha256sum "${checksumFiles[@]}" >SHA256SUMS
}

if [[ -z "$MANIFEST_FILE" ]]; then
    Fail 'missing release evidence manifest path'
fi

if [[ ! -f "$MANIFEST_FILE" ]]; then
    Fail "release evidence manifest does not exist: $MANIFEST_FILE"
fi

manifest_dir="$(cd "$(dirname "$MANIFEST_FILE")" && pwd)"
manifest_file_abs="$manifest_dir/$(basename "$MANIFEST_FILE")"
release_stamp="$(JsonValue "$manifest_file_abs" '.releaseStamp // empty')"
if [[ -z "$release_stamp" ]]; then
    release_stamp="$(basename "$manifest_dir")"
fi

OUT_DIR="${FSUSBLOG_PRODUCTION_EXPOSURE_HANDOFF_DIR:-$OUT_ROOT/$release_stamp}"
if [[ -e "$OUT_DIR" ]]; then
    Fail "handoff output already exists: $OUT_DIR"
fi

"$HANDOFF_CHECK_SCRIPT" "$manifest_file_abs" >/dev/null

mkdir -p "$OUT_DIR/release-evidence"
cp -a "$manifest_dir/." "$OUT_DIR/release-evidence/"
cp "$manifest_file_abs" "$OUT_DIR/release-evidence/manifest.json"

request_artifact="$(JsonValue "$manifest_file_abs" '.artifacts.productionExposureRequest // empty')"
request_file="/dev/null"
if [[ -n "$request_artifact" && -f "$manifest_dir/$request_artifact" ]]; then
    request_file="$manifest_dir/$request_artifact"
fi
manifest_sha256="$(sha256sum "$manifest_file_abs" | awk '{print $1}')"
request_sha256="$(sha256sum "$request_file" | awk '{print $1}')"

blocker_count="$(JsonValue "$manifest_file_abs" '.evidenceSummary.externalExposure.request.blockerCount // (.evidenceSummary.externalExposure.blockers // [] | length)')"
blocker_sources="$(JsonValue "$manifest_file_abs" '(.evidenceSummary.externalExposure.request.blockerSources // [] | join(", "))')"
required_hosts="$(JsonValue "$manifest_file_abs" '(.evidenceSummary.externalExposure.request.requiredHosts // [] | join(", "))')"
delegation_domains="$(JsonValue "$manifest_file_abs" '(.evidenceSummary.externalExposure.request.delegationDomains // [] | join(", "))')"
manifest_status="$(JsonValue "$manifest_file_abs" '.status // "unknown"')"
external_status="$(JsonValue "$manifest_file_abs" '.evidenceSummary.externalExposure.status // "unknown"')"

jq -n \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg sourceManifest "$manifest_file_abs" \
    --arg releaseEvidenceDir "release-evidence" \
    --slurpfile manifest "$manifest_file_abs" \
    --slurpfile request "$request_file" '
  ($manifest[0] // {}) as $manifestData
  | ($request[0] // {}) as $requestData
  | {
      handoffStatus: "verified",
      generatedAt: $generatedAt,
      sourceManifest: $sourceManifest,
      releaseEvidenceDir: $releaseEvidenceDir,
      releaseManifest: {
        status: ($manifestData.status // null),
        releaseStamp: ($manifestData.releaseStamp // null),
        generatedAt: ($manifestData.generatedAt // null),
        gitRevision: ($manifestData.gitRevision // null),
        imageDigest: ($manifestData.imageDigest // null)
      },
	      externalExposure: ($manifestData.evidenceSummary.externalExposure // {}),
	      requiredEvidence: ($requestData.requiredEvidence // []),
	      unblockPlan: ($requestData.unblockPlan // []),
	      operatorInputs: ($requestData.operatorInputs // {}),
      verificationCommands: ($requestData.verificationCommands // []),
      handoffChecks: ($requestData.handoffChecks // []),
      nextActions: ($requestData.nextActions // []),
      closeoutRule: ($requestData.closeoutRule // "Production exposure closeout is complete only after complete closeout succeeds and statusReport.status is ok")
    }
' >"$OUT_DIR/handoff-summary.json"

mkdir -p "$OUT_DIR/returned-evidence"
jq -n \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg generatedBy "tools/security/export-production-exposure-handoff-bundle.sh" \
    --arg sourceReleaseManifest "$manifest_file_abs" \
    --arg sourceReleaseManifestSha256 "$manifest_sha256" \
    --arg sourceRequestSha256 "$request_sha256" \
    --slurpfile request "$request_file" '
  ($request[0] // {}) as $requestData
  | ($requestData.unblockPlan // [] | map(select(.returnedEvidenceRequired == true))) as $returnedUnblockPlan
	  | {
	      contractVersion: 1,
	      status: "awaiting-returned-evidence",
	      generatedAt: $generatedAt,
	      generatedBy: $generatedBy,
	      sourceReleaseManifest: $sourceReleaseManifest,
	      sourceReleaseManifestSha256: $sourceReleaseManifestSha256,
	      sourceRequestSha256: $sourceRequestSha256,
	      requiredHosts: ($requestData.requiredHosts // []),
	      delegationDomains: ($requestData.delegationDomains // []),
	      requiredReturnedFiles: (
	        ($requestData.requiredEvidence // [])
	        | map(select(.key != "statusReport"))
	        | map({
            key,
            source,
            artifactName,
            requiredForCloseout: (.requiredForCloseout == true),
            sourceSha256Required: (.sourceSha256Required == true),
            acceptedSources: (.acceptedSources // []),
	            command: (.command // null)
	          })
	      ),
		      unblockPlanSources: ($returnedUnblockPlan | map(.source) | unique | sort),
		      unblockPlanCount: ($returnedUnblockPlan | length),
		      unblockPlan: $returnedUnblockPlan,
	      generatedByVerifier: [
	        "production-exposure-status.json",
	        "production-exposure-evidence-request.json"
	      ],
      verifierCommand: "tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>",
      closeoutCommand: "tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>",
      handoffCloseoutCommand: "tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>",
      scopeRule: "Returned request requiredHosts/delegationDomains may be present, but they must cover the current production scope and must not narrow it."
    }
' >"$OUT_DIR/returned-evidence/expected-evidence-manifest.json"

jq -n \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg generatedBy "tools/security/export-production-exposure-handoff-bundle.sh" \
    --slurpfile manifest "$manifest_file_abs" \
    --slurpfile request "$request_file" '
  ($manifest[0] // {}) as $manifestData
  | ($request[0] // {}) as $requestData
  | {
      contractVersion: 1,
      status: "action-required",
      generatedAt: $generatedAt,
      generatedBy: $generatedBy,
      releaseStamp: ($manifestData.releaseStamp // null),
      releaseManifestStatus: ($manifestData.status // null),
      externalExposureStatus: ($manifestData.evidenceSummary.externalExposure.status // null),
      requiredHosts: ($requestData.requiredHosts // []),
      delegationDomains: ($requestData.delegationDomains // []),
      blockerCount: ($requestData.currentStatus.blockerCount // ($requestData.currentStatus.blockers // [] | length)),
      blockerSources: ($requestData.unblockPlan // [] | map(.source) | sort),
      checklist: (
        ($requestData.unblockPlan // [])
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
      ),
      operatorInputs: ($requestData.operatorInputs // {}),
      verifyReturnedEvidenceCommand: ($requestData.returnedEvidenceVerifierCommand // "tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>"),
      closeoutCommand: ($requestData.returnedEvidenceCloseoutCommand // "tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>"),
      handoffCloseoutCommand: ($requestData.returnedHandoffCloseoutCommand // "tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>"),
      closeoutRule: ($requestData.closeoutRule // "Production exposure closeout is complete only after complete closeout succeeds and statusReport.status is ok")
    }
' >"$OUT_DIR/operator-checklist.json"

cat >"$OUT_DIR/returned-evidence/README.md" <<EOF
# Returned Production Exposure Evidence

Place the operator-returned production evidence files in this directory before closeout:

- \`production-firewall-policy.json\`
- \`production-dns-readiness.json\`
- \`production-dns-delegation.json\`
- \`production-exposure-live.json\`

\`expected-evidence-manifest.json\` records the required hosts, delegation domains and exact artifact names expected by the repo. If a returned \`production-exposure-evidence-request.json\` is included, its scope must cover the same required hosts and delegation domains; narrowed scope is rejected.

Validate the directory first:

\`\`\`bash
tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>
\`\`\`

Only after that command reports \`ok\`, complete the returned production exposure closeout:

\`\`\`bash
tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>
\`\`\`

If you return the whole handoff directory or a tarball with its adjacent \`.sha256\`, close through:

\`\`\`bash
tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>
\`\`\`
EOF

cat >"$OUT_DIR/README.md" <<EOF
# Production Exposure Handoff

This bundle was generated after \`tools/security/check-production-exposure-handoff.sh\` verified the release evidence manifest.

- Manifest status: \`$manifest_status\`
- External exposure status: \`$external_status\`
- Blocker count: \`$blocker_count\`
- Blocker sources: \`$blocker_sources\`
- Required hosts: \`$required_hosts\`
- Delegation domains: \`$delegation_domains\`

Files:

- \`release-evidence/manifest.json\`: release evidence index and artifact digests
- \`release-evidence/production-exposure-evidence-request.json\`: operator request package
- \`release-evidence/production-exposure-status.json\`: current blocker status
- \`handoff-summary.json\`: normalized request, blocker, unblock plan, next action and verification summary
- \`operator-checklist.json\`: machine-readable blocker-source checklist for the external operator
- \`returned-evidence/\`: empty return slot with the exact evidence filenames and scope rule for operator-provided files
- \`SHA256SUMS\`: checksum list for the bundle contents

This is not a passing production closeout signal unless \`release-evidence/manifest.json\` reports \`evidenceSummary.externalExposure.valid=true\` and \`tools/security/complete-production-exposure-closeout.sh\` succeeds against the real production DNS/firewall/live evidence.
EOF

(
    cd "$OUT_DIR"
    WriteCurrentDirectoryChecksums
)

"$BUNDLE_CHECK_SCRIPT" "$OUT_DIR" >/dev/null

tar_file="$OUT_DIR.tar.gz"
if [[ -e "$tar_file" || -e "$tar_file.sha256" ]]; then
    Fail "handoff archive already exists: $tar_file"
fi

tar -czf "$tar_file" -C "$(dirname "$OUT_DIR")" "$(basename "$OUT_DIR")"
(
    cd "$(dirname "$tar_file")"
    sha256sum "$(basename "$tar_file")" >"$(basename "$tar_file").sha256"
)

"$BUNDLE_CHECK_SCRIPT" "$tar_file" >/dev/null

printf '[production-exposure-handoff-bundle] wrote %s\n' "$OUT_DIR"
printf '[production-exposure-handoff-bundle] wrote %s\n' "$tar_file"
