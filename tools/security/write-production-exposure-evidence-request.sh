#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_FILE="${1:-${FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST:-$ROOT_DIR/.tmp/security/production-exposure-evidence-request.json}}"
DNS_RESOLVERS="${FSUSBLOG_DNS_RESOLVERS:-1.1.1.1 8.8.8.8}"
REQUIRED_OPEN_PORTS="${FSUSBLOG_REQUIRED_PUBLIC_PORTS:-80 443}"
FORBIDDEN_PUBLIC_PORTS="${FSUSBLOG_FORBIDDEN_PUBLIC_PORTS:-22 6379 5432 8080}"
FIREWALL_POLICY_FILE="${FSUSBLOG_FIREWALL_POLICY_EVIDENCE:-$ROOT_DIR/.tmp/security/production-firewall-policy.json}"
DNS_READINESS_FILE="${FSUSBLOG_DNS_READINESS_EVIDENCE:-$ROOT_DIR/.tmp/security/production-dns-readiness.json}"
DNS_DELEGATION_FILE="${FSUSBLOG_DNS_DELEGATION_EVIDENCE:-$ROOT_DIR/.tmp/security/production-dns-delegation.json}"
LIVE_EVIDENCE_FILE="${FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE:-$ROOT_DIR/.tmp/security/production-exposure-live.json}"
STATUS_FILE="${FSUSBLOG_PRODUCTION_EXPOSURE_STATUS:-$ROOT_DIR/.tmp/security/production-exposure-status.json}"

fail() {
    printf '[production-exposure-evidence-request] failed\n' >&2
    printf -- '- %s\n' "$1" >&2
    exit 1
}

domain_from_host() {
    awk -F '.' '
    NF >= 2 { print $(NF - 1) "." $NF }
  ' <<<"$1"
}

status_summary_json() {
    if [[ ! -f "$STATUS_FILE" ]]; then
        jq -n -c --arg sourceFile "$STATUS_FILE" '{
      sourceFile: $sourceFile,
      status: "missing",
      blockerCount: 0,
      blockerSources: [],
      blockers: []
    }'
        return
    fi

    jq -c --arg sourceFile "$STATUS_FILE" '{
    sourceFile: $sourceFile,
    status: (.status // "unknown"),
    blockerCount: (.blockers // [] | length),
    blockerSources: (.blockers // [] | map(.source) | unique),
    blockers: (.blockers // [])
  }' "$STATUS_FILE" 2>/dev/null || jq -n -c --arg sourceFile "$STATUS_FILE" '{
    sourceFile: $sourceFile,
    status: "invalid",
    blockerCount: 0,
    blockerSources: [],
    blockers: []
  }'
}

mapfile -t hosts < <("$ROOT_DIR/tools/security/collect-production-hosts.sh")
if ((${#hosts[@]} == 0)); then
    fail 'no production hosts found; set FSUSBLOG_LIVE_HOSTS or production env values'
fi

host_words="$(printf '%s\n' "${hosts[@]}" | paste -sd ' ' -)"
domain_words="$(printf '%s\n' "${hosts[@]}" | while read -r host; do
    [[ -n "$host" ]] || continue
    domain_from_host "$host"
done | sort -u | paste -sd ' ' -)"
status_summary="$(status_summary_json)"

mkdir -p "$(dirname "$OUT_FILE")"

jq -n \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg hosts "$host_words" \
    --arg domains "$domain_words" \
    --arg dnsResolvers "$DNS_RESOLVERS" \
    --arg requiredOpenPorts "$REQUIRED_OPEN_PORTS" \
    --arg forbiddenPublicPorts "$FORBIDDEN_PUBLIC_PORTS" \
    --arg firewallPolicy "$FIREWALL_POLICY_FILE" \
    --arg dnsReadiness "$DNS_READINESS_FILE" \
    --arg dnsDelegation "$DNS_DELEGATION_FILE" \
    --arg liveEvidence "$LIVE_EVIDENCE_FILE" \
    --arg statusReport "$STATUS_FILE" \
    --arg requestFile "$OUT_FILE" \
    --argjson currentStatus "$status_summary" '
  def words($value): ($value // "" | split(" ") | map(select(length > 0)));
  def numbers($value): words($value) | map(tonumber);
  def has_blocker($source): any($currentStatus.blockers[]?; .source == $source);
  def action($source; $description; $command): {source: $source, action: $description, command: $command};
  {
    status: "awaiting-external-evidence",
    generatedAt: $generatedAt,
    requestFile: $requestFile,
    requiredHosts: words($hosts),
    delegationDomains: words($domains),
    dnsResolvers: words($dnsResolvers),
    requiredPublicTcpPorts: numbers($requiredOpenPorts),
    forbiddenPublicTcpPorts: numbers($forbiddenPublicPorts),
    evidenceFiles: {
      firewallPolicy: $firewallPolicy,
      dnsReadiness: $dnsReadiness,
      dnsDelegation: $dnsDelegation,
      liveExposure: $liveEvidence,
      statusReport: $statusReport
    },
    requiredEvidence: [
      {
        key: "firewallPolicy",
        source: "firewall-policy",
        path: $firewallPolicy,
        artifactName: "production-firewall-policy.json",
        requiredForCloseout: true,
        sourceSha256Required: true,
        acceptedSources: ["FSUSBLOG_CLOUD_FIREWALL_SOURCE", "FSUSBLOG_UFW_STATUS_FILE", "FSUSBLOG_COLLECT_HOST_FIREWALL_POLICY"]
      },
      {
        key: "dnsReadiness",
        source: "dns-readiness",
        path: $dnsReadiness,
        artifactName: "production-dns-readiness.json",
        requiredForCloseout: true,
        command: "tools/security/check-production-dns-readiness.sh"
      },
      {
        key: "dnsDelegation",
        source: "dns-delegation",
        path: $dnsDelegation,
        artifactName: "production-dns-delegation.json",
        requiredForCloseout: true,
        command: "tools/security/check-production-dns-delegation.sh"
      },
      {
        key: "liveExposure",
        source: "live-evidence",
        path: $liveEvidence,
        artifactName: "production-exposure-live.json",
        requiredForCloseout: true,
        command: "tools/security/check-production-exposure-live.sh"
      },
      {
        key: "statusReport",
        source: "status-report",
        path: $statusReport,
        artifactName: "production-exposure-status.json",
        requiredForCloseout: true,
        command: "tools/security/report-production-exposure-status.sh"
      }
    ],
    firewallPolicyRequirements: {
      supportedSourceKinds: ["aws-security-groups", "ufw-status"],
      appliesToHosts: words($hosts),
      allowedPublicTcpPorts: numbers($requiredOpenPorts),
      forbiddenPublicTcpPorts: numbers($forbiddenPublicPorts),
      sshSourceTypes: ["fixed-management-ip", "vpn", "private-management-network"],
      fixedManagementIpMustBeSingleHostCidr: true,
      rawSourceSha256Required: true,
      databaseAndCachePortsRequirePrivateSource: [5432, 6379],
      rejectPublicNonWebTcpPorts: true,
      rejectAllProtocolPublicIngress: true
    },
    operatorInputs: {
      cloudFirewallExport: {
        expectedSource: "real cloud security group export",
        normalizeCommand: "FSUSBLOG_CLOUD_FIREWALL_SOURCE=<cloud-export.json> tools/security/complete-production-exposure-closeout.sh"
      },
      hostFirewallExport: {
        expectedSource: "real UFW status output from production host",
        collectCommand: "FSUSBLOG_UFW_STATUS_FILE=<ufw-status.txt> tools/security/complete-production-exposure-closeout.sh"
      },
      liveDnsAndHttps: {
        expectedSource: "public DNS and live production endpoints",
        probeCommand: "tools/security/complete-production-exposure-closeout.sh"
      }
    },
    verificationCommands: [
      {
        name: "complete-closeout",
        command: "tools/security/complete-production-exposure-closeout.sh",
        requiredForCloseout: true
      },
      {
        name: "verify-returned-evidence",
        command: "tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>",
        requiredBeforeReturnedCloseout: true
      },
      {
        name: "complete-returned-evidence",
        command: "tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>",
        requiredForCloseout: true
      },
      {
        name: "complete-returned-handoff",
        command: "tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>",
        requiredForCloseout: true
      },
      {
        name: "release-evidence",
        command: "tools/operations/collect-release-evidence.sh",
        outputPattern: ".tmp/release-evidence/<release-identity>/manifest.json"
      },
      {
        name: "handoff-check",
        command: "tools/security/check-production-exposure-handoff.sh <manifest.json>",
        requiredBeforeExternalHandoff: true
      }
    ],
    handoffChecks: [
      {
        id: "request-status-manifest-alignment",
        command: "tools/security/check-production-exposure-handoff.sh <manifest.json>",
        requiredBeforeExternalHandoff: true
      },
      {
        id: "no-synthetic-evidence",
        rule: "evidenceFiles must not point at /tmp/tmp fixture paths"
      },
      {
        id: "standard-artifact-names",
        rule: "release bundle artifact names must match requiredEvidence.artifactName"
      },
      {
        id: "sha256-digests",
        rule: "copied production exposure artifacts must match manifest artifactDigests"
      }
    ],
    currentStatus: $currentStatus,
	    nextActions: (
	      [
	        if ($currentStatus.status == "missing") then
	          action("status-report"; "Run the status reporter or complete closeout once to capture current blockers."; "tools/security/report-production-exposure-status.sh")
        else empty end,
        if has_blocker("firewall-policy") then
          action("firewall-policy"; "Provide a real cloud security-group export or production host UFW status that applies to every required host and only allows the documented ports."; "FSUSBLOG_CLOUD_FIREWALL_SOURCE=<cloud-export.json> tools/security/complete-production-exposure-closeout.sh")
        else empty end,
        if has_blocker("dns-delegation") then
          action("dns-delegation"; "Configure public NS/SOA delegation for every delegation domain and rerun the delegation check."; "tools/security/check-production-dns-delegation.sh")
        else empty end,
        if has_blocker("dns-readiness") then
          action("dns-readiness"; "Publish A/AAAA records for every required host through the configured public resolvers and local resolver path."; "tools/security/check-production-dns-readiness.sh")
        else empty end,
        if has_blocker("live-evidence") then
          action("live-evidence"; "Expose production 80/443 with HTTPS and HSTS, and prove forbidden public TCP ports are not reachable."; "tools/security/check-production-exposure-live.sh")
	        else empty end
	      ]
	    ),
	    unblockPlan: (
	      [
	        if ($currentStatus.status == "missing") then
	          {
	            source: "status-report",
	            blockerCount: 1,
	            blockers: [],
	            evidenceKeys: ["statusReport"],
	            artifactNames: ["production-exposure-status.json"],
	            evidenceFiles: [$statusReport],
	            commands: ["tools/security/report-production-exposure-status.sh"],
	            returnedEvidenceRequired: false
	          }
	        else empty end,
	        if has_blocker("firewall-policy") then
	          {
	            source: "firewall-policy",
	            blockerCount: ([$currentStatus.blockers[]? | select(.source == "firewall-policy")] | length),
	            blockers: [$currentStatus.blockers[]? | select(.source == "firewall-policy")],
	            evidenceKeys: ["firewallPolicy"],
	            artifactNames: ["production-firewall-policy.json"],
	            evidenceFiles: [$firewallPolicy],
	            commands: [
	              "FSUSBLOG_CLOUD_FIREWALL_SOURCE=<cloud-export.json> tools/security/complete-production-exposure-closeout.sh",
	              "FSUSBLOG_UFW_STATUS_FILE=<ufw-status.txt> tools/security/complete-production-exposure-closeout.sh",
	              "tools/security/verify-production-firewall-policy-evidence.sh"
	            ],
	            returnedEvidenceRequired: true
	          }
	        else empty end,
	        if has_blocker("dns-delegation") then
	          {
	            source: "dns-delegation",
	            blockerCount: ([$currentStatus.blockers[]? | select(.source == "dns-delegation")] | length),
	            blockers: [$currentStatus.blockers[]? | select(.source == "dns-delegation")],
	            evidenceKeys: ["dnsDelegation"],
	            artifactNames: ["production-dns-delegation.json"],
	            evidenceFiles: [$dnsDelegation],
	            commands: ["tools/security/check-production-dns-delegation.sh"],
	            returnedEvidenceRequired: true
	          }
	        else empty end,
	        if has_blocker("dns-readiness") then
	          {
	            source: "dns-readiness",
	            blockerCount: ([$currentStatus.blockers[]? | select(.source == "dns-readiness")] | length),
	            blockers: [$currentStatus.blockers[]? | select(.source == "dns-readiness")],
	            evidenceKeys: ["dnsReadiness"],
	            artifactNames: ["production-dns-readiness.json"],
	            evidenceFiles: [$dnsReadiness],
	            commands: ["tools/security/check-production-dns-readiness.sh"],
	            returnedEvidenceRequired: true
	          }
	        else empty end,
	        if has_blocker("live-evidence") then
	          {
	            source: "live-evidence",
	            blockerCount: ([$currentStatus.blockers[]? | select(.source == "live-evidence")] | length),
	            blockers: [$currentStatus.blockers[]? | select(.source == "live-evidence")],
	            evidenceKeys: ["liveExposure"],
	            artifactNames: ["production-exposure-live.json"],
	            evidenceFiles: [$liveEvidence],
	            commands: [
	              "tools/security/check-production-exposure-live.sh",
	              "tools/security/verify-production-exposure-evidence.sh"
	            ],
	            returnedEvidenceRequired: true
	          }
	        else empty end
	      ]
	    ),
	    finalCloseoutCommand: "tools/security/complete-production-exposure-closeout.sh",
    returnedEvidenceVerifierCommand: "tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>",
    returnedEvidenceCloseoutCommand: "tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>",
    returnedHandoffCloseoutCommand: "tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>",
    releaseEvidenceCommand: "tools/operations/collect-release-evidence.sh",
    closeoutRule: "Production exposure closeout is complete only after complete closeout succeeds and statusReport.status is ok"
  }
' >"$OUT_FILE"

printf '[production-exposure-evidence-request] wrote %s\n' "$OUT_FILE"
