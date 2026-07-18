#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERIFY_SCRIPT="$ROOT_DIR/tools/security/verify-production-exposure-evidence.sh"
FIREWALL_POLICY_SCRIPT="$ROOT_DIR/tools/security/verify-production-firewall-policy-evidence.sh"
COLLECT_HOST_FIREWALL_SCRIPT="$ROOT_DIR/tools/security/collect-host-firewall-policy-evidence.sh"
CLOUD_FIREWALL_NORMALIZER_SCRIPT="$ROOT_DIR/tools/security/normalize-cloud-firewall-policy-evidence.sh"
DNS_DELEGATION_SCRIPT="$ROOT_DIR/tools/security/check-production-dns-delegation.sh"
DNS_READINESS_SCRIPT="$ROOT_DIR/tools/security/check-production-dns-readiness.sh"
STATUS_SCRIPT="$ROOT_DIR/tools/security/report-production-exposure-status.sh"
CLOSEOUT_SCRIPT="$ROOT_DIR/tools/security/verify-production-exposure-closeout.sh"
COMPLETE_SCRIPT="$ROOT_DIR/tools/security/complete-production-exposure-closeout.sh"
RETURNED_COMPLETE_SCRIPT="$ROOT_DIR/tools/security/complete-production-exposure-from-returned-evidence.sh"
RETURNED_HANDOFF_COMPLETE_SCRIPT="$ROOT_DIR/tools/security/complete-production-exposure-from-returned-handoff-bundle.sh"
PREREQ_SCRIPT="$ROOT_DIR/tools/security/check-production-exposure-prereqs.sh"
EVIDENCE_REQUEST_SCRIPT="$ROOT_DIR/tools/security/write-production-exposure-evidence-request.sh"
HANDOFF_SCRIPT="$ROOT_DIR/tools/security/check-production-exposure-handoff.sh"
HANDOFF_BUNDLE_SCRIPT="$ROOT_DIR/tools/security/export-production-exposure-handoff-bundle.sh"
HANDOFF_BUNDLE_CHECK_SCRIPT="$ROOT_DIR/tools/security/check-production-exposure-handoff-bundle.sh"
RETURNED_EVIDENCE_SCRIPT="$ROOT_DIR/tools/security/verify-production-exposure-returned-evidence.sh"

tmp_dir="$(mktemp -d)"
parallel_log_root="$(mktemp -d)"
trap 'rm -rf "$tmp_dir" "$parallel_log_root"' EXIT

# Keep self-test artifacts isolated from release evidence files. Complete closeout
# invokes the status reporter, so an inherited/default status path would otherwise
# make fixture evidence look like the current production state. Complete closeout
# also writes an operator request package, so keep that isolated too.
export FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$tmp_dir/production-exposure-status.default.json"
export FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$tmp_dir/production-exposure-evidence-request.default.json"

fail() {
    printf '[production-exposure-tools-test] failed\n' >&2
    printf -- '- %s\n' "$1" >&2
    exit 1
}

resolve_parallel_capacity() {
    local total="$1"
    local host_cpus host_memory_gib granted_cpus granted_memory_gib
    local cpu_workers memory_workers workers scheduler_controlled=0
    local grant_file grant_tier expected_run grant_schema grant_run grant_cpus grant_memory budget_cpus budget_memory

    host_cpus="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc)"
    host_memory_gib="$(awk '/^MemTotal:/ { printf "%.6f", $2 / 1024 / 1024; exit }' /proc/meminfo)"
    granted_cpus="${FSUSBLOG_STEP_CPU_BUDGET:-${FSUSBLOG_BUNDLE_CPU_UNITS:-${FSUSBLOG_BUNDLE_CPU_BUDGET:-$host_cpus}}}"
    granted_memory_gib="${FSUSBLOG_STEP_MEMORY_GIB:-${FSUSBLOG_BUNDLE_MEMORY_GIB:-$host_memory_gib}}"
    if [[ -n "${FSUSBLOG_STEP_CPU_BUDGET:-}${FSUSBLOG_BUNDLE_CPU_UNITS:-}${FSUSBLOG_BUNDLE_CPU_BUDGET:-}${FSUSBLOG_STEP_MEMORY_GIB:-}${FSUSBLOG_BUNDLE_MEMORY_GIB:-}" ]]; then
        scheduler_controlled=1
    fi

    # A long-lived security lane can receive a larger atomic scheduler grant after
    # sibling bundles finish. Resolve that current grant immediately before each
    # independent validation wave instead of freezing the lane's initial budget.
    grant_file="${FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE:-}"
    grant_tier="${FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID:-}"
    if [[ -n "$grant_file" || -n "$grant_tier" ]]; then
        [[ -n "$grant_file" && -n "$grant_tier" ]] ||
            fail 'scheduler resource grant requires both file and tier id'
        expected_run="${FSUSBLOG_TEST_RUN_ID:-}"
        [[ -n "$expected_run" ]] || fail 'scheduler resource grant requires FSUSBLOG_TEST_RUN_ID'
        [[ -r "$grant_file" ]] || fail "scheduler resource grant is unreadable: $grant_file"
        IFS=$'\t' read -r grant_schema grant_run grant_cpus grant_memory budget_cpus budget_memory < <(
            jq -er --arg tier "$grant_tier" '
        [
          .schema,
          (.runId // ""),
          (.grants[$tier].cpuUnits // ""),
          (.grants[$tier].memoryGiB // ""),
          (.resourceBudget.cpuUnits // ""),
          (.resourceBudget.memoryGiB // "")
        ] | @tsv
      ' "$grant_file"
        ) || fail "scheduler resource grant is invalid: $grant_file"
        [[ "$grant_schema" == 'fsusblog.test-matrix.resource-grants.v1' ]] ||
            fail 'scheduler resource grant has an invalid schema'
        [[ "$grant_run" == "$expected_run" ]] ||
            fail "scheduler resource grant runId mismatch: expected $expected_run, got ${grant_run:-missing}"
        [[ "$grant_cpus" =~ ^[1-9][0-9]*$ && "$budget_cpus" =~ ^[1-9][0-9]*$ ]] ||
            fail "scheduler CPU grant is invalid for $grant_tier"
        if ! awk -v cpu="$grant_cpus" -v memory="$grant_memory" -v budgetCpu="$budget_cpus" -v budgetMemory="$budget_memory" 'BEGIN {
      exit !(memory + 0 > 0 && budgetMemory + 0 >= memory + 0 && budgetCpu + 0 >= cpu + 0)
    }'; then
            fail "scheduler resource grant is invalid for $grant_tier"
        fi
        granted_cpus="$grant_cpus"
        granted_memory_gib="$grant_memory"
        scheduler_controlled=1
    fi

    cpu_workers="$(awk -v value="$granted_cpus" 'BEGIN { value += 0; print (value > 1 ? int(value + 0.999999) : 1) }')"
    if ((scheduler_controlled == 1)); then
        # The scheduler has already admitted this CPU/memory pair against current
        # host capacity; applying host-average memory per CPU again double-counts it.
        memory_workers="$cpu_workers"
    else
        memory_workers="$(awk -v granted="$granted_memory_gib" -v hostMemory="$host_memory_gib" -v hostCpus="$host_cpus" '
      BEGIN {
        granted += 0; hostMemory += 0; hostCpus += 0
        if (granted <= 0 || hostMemory <= 0 || hostCpus <= 0) { print 1; exit }
        equivalent = granted / (hostMemory / hostCpus)
        print (equivalent > 1 ? int(equivalent + 0.999999) : 1)
      }
    ')"
    fi
    workers="$cpu_workers"
    ((memory_workers < workers)) && workers="$memory_workers"
    ((total < workers)) && workers="$total"
    ((workers < 1)) && workers=1
    printf '%s\t%s\t%s\n' "$workers" "$granted_cpus" "$granted_memory_gib"
}

resolve_parallel_workers() {
    local workers _cpu _memory
    IFS=$'\t' read -r workers _cpu _memory < <(resolve_parallel_capacity "$1")
    printf '%s\n' "$workers"
}

run_parallel_functions() {
    local phase="$1"
    shift
    local -a functions=("$@") active_pids=() failures=()
    local worker_cap granted_cpu granted_memory child_cpu child_memory log_dir completion_fifo completion_fd function_name pid finished_pid rc
    local wait_timeout_seconds phase_started_ms inherited_deadline_ms
    local -A pid_names=() pid_logs=()

    IFS=$'\t' read -r worker_cap granted_cpu granted_memory < <(resolve_parallel_capacity "${#functions[@]}")
    phase_started_ms="$(date +%s%3N)"
    inherited_deadline_ms="${FSUSBLOG_STEP_DEADLINE_MS:-${FSUSBLOG_BUNDLE_DEADLINE_MS:-}}"
    child_cpu="$(awk -v value="$granted_cpu" -v workers="$worker_cap" 'BEGIN { printf "%.6f", (value + 0) / workers }')"
    child_memory="$(awk -v value="$granted_memory" -v workers="$worker_cap" 'BEGIN { printf "%.6f", (value + 0) / workers }')"
    log_dir="$parallel_log_root/$phase"
    mkdir -p "$log_dir"
    completion_fifo="$log_dir/completions.fifo"
    mkfifo "$completion_fifo"
    exec {completion_fd}<>"$completion_fifo"

    resolve_wait_timeout_seconds() {
        local configured="${FSUSBLOG_PRODUCTION_EXPOSURE_SELFTEST_WAIT_TIMEOUT_SECONDS:-120}"
        if [[ "$inherited_deadline_ms" =~ ^[0-9]+$ ]]; then
            awk -v started="$phase_started_ms" -v budget="$inherited_deadline_ms" -v now="$(date +%s%3N)" 'BEGIN {
        remaining = (started + budget - now) / 1000
        print (remaining > 1 ? int(remaining + 0.999999) : 1)
      }'
        else
            awk -v configured="$configured" 'BEGIN { configured += 0; print (configured > 1 ? configured : 1) }'
        fi
    }

    reap_one() {
        wait_timeout_seconds="$(resolve_wait_timeout_seconds)"
        if ! IFS=$'\t' read -r -t "$wait_timeout_seconds" -u "$completion_fd" finished_pid rc; then
            for pid in "${active_pids[@]}"; do
                printf '[production-exposure-tools-test] timed out waiting for %s\n' "${pid_names[$pid]}" >>"${pid_logs[$pid]}"
                failures+=("${pid_names[$pid]}:${pid_logs[$pid]}")
                pkill -TERM -P "$pid" 2>/dev/null || true
                pkill -KILL -P "$pid" 2>/dev/null || true
                kill "$pid" 2>/dev/null || true
                kill -KILL "$pid" 2>/dev/null || true
                wait "$pid" 2>/dev/null || true
            done
            active_pids=()
            return
        fi
        wait "$finished_pid" 2>/dev/null || true
        if ((rc != 0)); then
            failures+=("${pid_names[$finished_pid]}:${pid_logs[$finished_pid]}")
        fi
        local -a remaining=()
        for pid in "${active_pids[@]}"; do
            [[ "$pid" == "$finished_pid" ]] || remaining+=("$pid")
        done
        active_pids=("${remaining[@]}")
    }

    for function_name in "${functions[@]}"; do
        while ((${#active_pids[@]} >= worker_cap)); do
            reap_one
        done
        (
            trap 'rc=$?; printf '\''%s\t%s\n'\'' "$BASHPID" "$rc" > "$completion_fifo"' EXIT
            export FSUSBLOG_STEP_CPU_BUDGET="$child_cpu"
            export FSUSBLOG_STEP_MEMORY_GIB="$child_memory"
            "$function_name"
        ) >"$log_dir/$function_name.log" 2>&1 &
        pid=$!
        active_pids+=("$pid")
        pid_names["$pid"]="$function_name"
        pid_logs["$pid"]="$log_dir/$function_name.log"
    done
    while ((${#active_pids[@]} > 0)); do
        reap_one
    done
    exec {completion_fd}>&-
    rm -f "$completion_fifo"

    if ((${#failures[@]} > 0)); then
        for function_name in "${failures[@]}"; do
            printf '[production-exposure-tools-test] parallel failure: %s\n' "${function_name%%:*}" >&2
            sed 's/^/  /' "${function_name#*:}" >&2
        done
        fail "$phase completed with ${#failures[@]} failed validation group(s)"
    fi
}

if [[ "${FSUSBLOG_PRODUCTION_EXPOSURE_SELFTEST_SOURCE_ONLY:-0}" == "1" ]]; then
    return 0 2>/dev/null || exit 0
fi

"$PREREQ_SCRIPT" >/dev/null
for prereq_token in \
    'tools/security/check-production-exposure-handoff-bundle.sh' \
    'tools/security/export-production-exposure-handoff-bundle.sh' \
    'tools/security/verify-production-exposure-returned-evidence.sh' \
    'tools/security/complete-production-exposure-from-returned-evidence.sh' \
    'tools/security/complete-production-exposure-from-returned-handoff-bundle.sh' \
    ' tar ' \
    ' xargs'; do
    grep -Fq "$prereq_token" "$PREREQ_SCRIPT" ||
        fail "production exposure prereq script does not cover $prereq_token"
done
fresh_generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
stale_generated_at="$(date -u -d '2 days ago' +%Y-%m-%dT%H:%M:%SZ)"

cat >"$tmp_dir/production.env" <<'EOF'
SITE_BASEURL=https://fsus.blog
CORS_ALLOWED_HOSTS=https://www.fsus.blog
APP_ALLOWED_HOSTS=fsus.blog;www.fsus.blog
FIDO2_SERVER_DOMAIN=passkey.fsus.blog
Fido2__Origins__0=https://login.fsus.blog
Seo__BaseUrl=https://seo.fsus.blog
EOF

expected_hosts=$'fsus.blog\nlogin.fsus.blog\npasskey.fsus.blog\nseo.fsus.blog\nwww.fsus.blog'
actual_hosts="$(env -u FSUSBLOG_LIVE_HOSTS FSUSBLOG_PRODUCTION_ENV_FILE="$tmp_dir/production.env" "$ROOT_DIR/tools/security/collect-production-hosts.sh")"
[[ "$actual_hosts" == "$expected_hosts" ]] || fail "production host collection did not match expected host set"

FSUSBLOG_PRODUCTION_ENV_FILE="$tmp_dir/production.env" \
    FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$tmp_dir/production-exposure-evidence-request.json" \
    "$EVIDENCE_REQUEST_SCRIPT" >/dev/null
jq -e '
  .status == "awaiting-external-evidence"
  and (.requiredHosts | length == 5)
  and (.requiredHosts | index("fsus.blog") != null)
  and (.requiredHosts | index("www.fsus.blog") != null)
  and (.delegationDomains | index("fsus.blog") != null)
  and (.requiredPublicTcpPorts == [80, 443])
  and (.forbiddenPublicTcpPorts | index(22) != null)
  and .firewallPolicyRequirements.fixedManagementIpMustBeSingleHostCidr == true
  and .firewallPolicyRequirements.rawSourceSha256Required == true
  and .firewallPolicyRequirements.rejectPublicNonWebTcpPorts == true
  and any(.requiredEvidence[]?; .key == "firewallPolicy" and .sourceSha256Required == true)
  and (.requiredEvidence | map(.key) | sort) == ["dnsDelegation","dnsReadiness","firewallPolicy","liveExposure","statusReport"]
  and all(.requiredEvidence[]; .requiredForCloseout == true and (.artifactName | test("^production-.*\\.json$")))
  and any(.verificationCommands[]?; .name == "complete-closeout" and .requiredForCloseout == true)
  and any(.verificationCommands[]?; .name == "verify-returned-evidence" and .requiredBeforeReturnedCloseout == true)
  and any(.verificationCommands[]?; .name == "complete-returned-evidence" and .requiredForCloseout == true)
  and any(.verificationCommands[]?; .name == "complete-returned-handoff" and .requiredForCloseout == true)
  and any(.verificationCommands[]?; .name == "handoff-check" and .requiredBeforeExternalHandoff == true)
  and any(.handoffChecks[]?; .id == "request-status-manifest-alignment" and .requiredBeforeExternalHandoff == true)
  and .currentStatus.status == "missing"
  and any(.nextActions[]?; .source == "status-report")
  and .finalCloseoutCommand == "tools/security/complete-production-exposure-closeout.sh"
  and .returnedEvidenceVerifierCommand == "tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>"
  and .returnedEvidenceCloseoutCommand == "tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>"
  and .returnedHandoffCloseoutCommand == "tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>"
' "$tmp_dir/production-exposure-evidence-request.json" >/dev/null ||
    fail "production exposure evidence request did not describe required closeout evidence"

cat >"$tmp_dir/production-invalid-hosts.env" <<'EOF'
SITE_BASEURL=https://fsus.blog
APP_ALLOWED_HOSTS=fsus.blog;*.fsus.blog
EOF

if env -u FSUSBLOG_LIVE_HOSTS FSUSBLOG_PRODUCTION_ENV_FILE="$tmp_dir/production-invalid-hosts.env" "$ROOT_DIR/tools/security/collect-production-hosts.sh" >/dev/null 2>&1; then
    fail "production host collection accepted wildcard production host"
fi

if FSUSBLOG_LIVE_HOSTS=fsus.blog,localhost "$ROOT_DIR/tools/security/collect-production-hosts.sh" >/dev/null 2>&1; then
    fail "production host collection accepted localhost live host"
fi

if FSUSBLOG_LIVE_HOSTS=fsus.blog,203.0.113.10 "$ROOT_DIR/tools/security/collect-production-hosts.sh" >/dev/null 2>&1; then
    fail "production host collection accepted IP literal live host"
fi

cat >"$tmp_dir/dns-public-ok.tsv" <<'EOF'
fsus.blog	1.1.1.1	A	ok	fsus.blog. 300 IN A 203.0.113.10
fsus.blog	1.1.1.1	AAAA	failed	status=NOERROR; no answer
fsus.blog	8.8.8.8	A	ok	fsus.blog. 300 IN A 203.0.113.10
fsus.blog	8.8.8.8	AAAA	failed	status=NOERROR; no answer
www.fsus.blog	1.1.1.1	A	ok	www.fsus.blog. 300 IN A 203.0.113.10
www.fsus.blog	1.1.1.1	AAAA	failed	status=NOERROR; no answer
www.fsus.blog	8.8.8.8	A	ok	www.fsus.blog. 300 IN A 203.0.113.10
www.fsus.blog	8.8.8.8	AAAA	failed	status=NOERROR; no answer
EOF

cat >"$tmp_dir/dns-local-ok.tsv" <<'EOF'
fsus.blog	ok	203.0.113.10
www.fsus.blog	ok	203.0.113.10
EOF

cat >"$tmp_dir/dns-public-failed.tsv" <<'EOF'
fsus.blog	1.1.1.1	A	failed	status=NXDOMAIN; no answer
fsus.blog	1.1.1.1	AAAA	failed	status=NXDOMAIN; no answer
fsus.blog	8.8.8.8	A	failed	status=NXDOMAIN; no answer
fsus.blog	8.8.8.8	AAAA	failed	status=NXDOMAIN; no answer
www.fsus.blog	1.1.1.1	A	failed	status=NXDOMAIN; no answer
www.fsus.blog	1.1.1.1	AAAA	failed	status=NXDOMAIN; no answer
www.fsus.blog	8.8.8.8	A	failed	status=NXDOMAIN; no answer
www.fsus.blog	8.8.8.8	AAAA	failed	status=NXDOMAIN; no answer
EOF

cat >"$tmp_dir/dns-local-failed.tsv" <<'EOF'
fsus.blog	failed	DNS does not resolve from this network
www.fsus.blog	failed	DNS does not resolve from this network
EOF

cat >"$tmp_dir/dns-delegation-ok.tsv" <<'EOF'
fsus.blog	resolver/1.1.1.1/NS	ok	fsus.blog. 300 IN NS ns1.example.net.
fsus.blog	resolver/1.1.1.1/SOA	failed	status=NOERROR; no answer
fsus.blog	resolver/8.8.8.8/NS	ok	fsus.blog. 300 IN NS ns1.example.net.
fsus.blog	resolver/8.8.8.8/SOA	failed	status=NOERROR; no answer
fsus.blog	tld-ns	ok	a.ns.nic.blog delegates fsus.blog
EOF

cat >"$tmp_dir/dns-delegation-failed.tsv" <<'EOF'
fsus.blog	resolver/1.1.1.1/NS	failed	status=NXDOMAIN; no answer
fsus.blog	resolver/1.1.1.1/SOA	failed	status=NXDOMAIN; no answer
fsus.blog	resolver/8.8.8.8/NS	failed	status=NXDOMAIN; no answer
fsus.blog	resolver/8.8.8.8/SOA	failed	status=NXDOMAIN; no answer
fsus.blog	tld-ns	failed	status=NXDOMAIN; no delegation answer
EOF

FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
    FSUSBLOG_DNS_DELEGATION_FIXTURE="$tmp_dir/dns-delegation-ok.tsv" \
    FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
    "$DNS_DELEGATION_SCRIPT" >/dev/null

jq -e '.delegationDomains == "fsus.blog" and ([.results[] | select(.status == "ok")] | length) >= 2' "$tmp_dir/dns-delegation-ok.json" >/dev/null ||
    fail "DNS delegation evidence did not include expected ok results"

if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
    FSUSBLOG_DNS_DELEGATION_FIXTURE="$tmp_dir/dns-delegation-failed.tsv" \
    FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-failed.json" \
    "$DNS_DELEGATION_SCRIPT" >/dev/null 2>&1; then
    fail "DNS delegation unexpectedly passed failed fixture"
fi

FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
    FSUSBLOG_DNS_READINESS_FIXTURE="$tmp_dir/dns-public-ok.tsv" \
    FSUSBLOG_DNS_READINESS_LOCAL_FIXTURE="$tmp_dir/dns-local-ok.tsv" \
    FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
    "$DNS_READINESS_SCRIPT" >/dev/null

jq -e '.requiredHosts == "fsus.blog www.fsus.blog" and ([.results[] | select(.status == "ok")] | length) >= 2' "$tmp_dir/dns-readiness-ok.json" >/dev/null ||
    fail "DNS readiness evidence did not include expected ok results"

if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
    FSUSBLOG_DNS_READINESS_FIXTURE="$tmp_dir/dns-public-failed.tsv" \
    FSUSBLOG_DNS_READINESS_LOCAL_FIXTURE="$tmp_dir/dns-local-failed.tsv" \
    FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-failed.json" \
    "$DNS_READINESS_SCRIPT" >/dev/null 2>&1; then
    fail "DNS readiness unexpectedly passed failed DNS fixture"
fi

cat >"$tmp_dir/ufw-status-ok.txt" <<'EOF'
Status: active

To                         Action      From
--                         ------      ----
80/tcp                     ALLOW       Anywhere
443/tcp                    ALLOW       Anywhere
22/tcp                     ALLOW       203.0.113.4/32
22/tcp                     ALLOW       10.0.0.0/24
EOF

cat >"$tmp_dir/ufw-status-bare-fixed-ip.txt" <<'EOF'
Status: active

To                         Action      From
--                         ------      ----
80/tcp                     ALLOW       Anywhere
443/tcp                    ALLOW       Anywhere
22/tcp                     ALLOW       203.0.113.4
EOF

cat >"$tmp_dir/ufw-status-public-ssh.txt" <<'EOF'
Status: active

To                         Action      From
--                         ------      ----
80/tcp                     ALLOW       Anywhere
443/tcp                    ALLOW       Anywhere
22/tcp                     ALLOW       Anywhere
EOF

cat >"$tmp_dir/ufw-status-public-v6-ssh.txt" <<'EOF'
Status: active

To                         Action      From
--                         ------      ----
80/tcp                     ALLOW       Anywhere
443/tcp                    ALLOW       Anywhere
80/tcp (v6)                ALLOW       Anywhere (v6)
443/tcp (v6)               ALLOW       Anywhere (v6)
22/tcp                     ALLOW       203.0.113.4/32
22/tcp (v6)                ALLOW       Anywhere (v6)
EOF

cat >"$tmp_dir/ufw-status-ok-v6.txt" <<'EOF'
Status: active

To                         Action      From
--                         ------      ----
80/tcp                     ALLOW       Anywhere
443/tcp                    ALLOW       Anywhere
80/tcp (v6)                ALLOW       Anywhere (v6)
443/tcp (v6)               ALLOW       Anywhere (v6)
22/tcp                     ALLOW       203.0.113.4/32
22/tcp (v6)                ALLOW       fd00::/64
EOF

cat >"$tmp_dir/ufw-status-inactive.txt" <<'EOF'
Status: inactive
EOF

cat >"$tmp_dir/aws-security-groups-ok.json" <<'JSON'
{
  "SecurityGroups": [
    {
      "GroupId": "sg-0123456789abcdef0",
      "GroupName": "fsusblog-production",
      "IpPermissions": [
        {
          "IpProtocol": "tcp",
          "FromPort": 80,
          "ToPort": 80,
          "IpRanges": [{ "CidrIp": "0.0.0.0/0" }],
          "Ipv6Ranges": []
        },
        {
          "IpProtocol": "tcp",
          "FromPort": 443,
          "ToPort": 443,
          "IpRanges": [{ "CidrIp": "0.0.0.0/0" }],
          "Ipv6Ranges": []
        },
        {
          "IpProtocol": "tcp",
          "FromPort": 22,
          "ToPort": 22,
          "IpRanges": [
            { "CidrIp": "203.0.113.4/32" },
            { "CidrIp": "10.0.0.0/24" }
          ],
          "Ipv6Ranges": []
        }
      ]
    }
  ]
}
JSON

cat >"$tmp_dir/aws-security-groups-public-db.json" <<'JSON'
{
  "SecurityGroups": [
    {
      "GroupId": "sg-bad",
      "GroupName": "fsusblog-production-bad",
      "IpPermissions": [
        {
          "IpProtocol": "tcp",
          "FromPort": 80,
          "ToPort": 80,
          "IpRanges": [{ "CidrIp": "0.0.0.0/0" }],
          "Ipv6Ranges": []
        },
        {
          "IpProtocol": "tcp",
          "FromPort": 443,
          "ToPort": 443,
          "IpRanges": [{ "CidrIp": "0.0.0.0/0" }],
          "Ipv6Ranges": []
        },
        {
          "IpProtocol": "tcp",
          "FromPort": 6379,
          "ToPort": 6379,
          "IpRanges": [{ "CidrIp": "0.0.0.0/0" }],
          "Ipv6Ranges": []
        }
      ]
    }
  ]
}
JSON

cat >"$tmp_dir/failed-dns.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "requiredHosts": "fsus.blog www.fsus.blog",
  "requiredOpenPorts": "80 443",
  "forbiddenPublicPorts": "22 6379 5432 8080",
  "dnsResolvers": "1.1.1.1 8.8.8.8",
  "results": [
    { "host": "fsus.blog", "target": "fsus.blog", "check": "dns/1.1.1.1/A", "status": "failed", "detail": "status=NXDOMAIN; no answer" },
    { "host": "fsus.blog", "target": "fsus.blog", "check": "dns/8.8.8.8/A", "status": "failed", "detail": "status=NXDOMAIN; no answer" },
    { "host": "fsus.blog", "target": "fsus.blog", "check": "dns", "status": "failed", "detail": "DNS does not resolve from this network" }
  ]
}
JSON

cat >"$tmp_dir/target-override.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "requiredHosts": "fsus.blog",
  "requiredOpenPorts": "80 443",
  "forbiddenPublicPorts": "22 6379 5432 8080",
  "dnsResolvers": "1.1.1.1 8.8.8.8",
  "results": [
    { "host": "fsus.blog", "target": "203.0.113.10", "check": "dns", "status": "ok", "detail": "203.0.113.10" },
    { "host": "fsus.blog", "target": "203.0.113.10", "check": "dns/1.1.1.1/A", "status": "ok", "detail": "fsus.blog. 300 IN A 203.0.113.10" },
    { "host": "fsus.blog", "target": "203.0.113.10", "check": "dns/8.8.8.8/A", "status": "ok", "detail": "fsus.blog. 300 IN A 203.0.113.10" },
    { "host": "fsus.blog", "target": "203.0.113.10", "check": "tcp/80", "status": "ok", "detail": "required public port 80 is reachable" },
    { "host": "fsus.blog", "target": "203.0.113.10", "check": "tcp/443", "status": "ok", "detail": "required public port 443 is reachable" },
    { "host": "fsus.blog", "target": "203.0.113.10", "check": "tcp/22", "status": "ok", "detail": "forbidden public port 22 is not reachable" },
    { "host": "fsus.blog", "target": "203.0.113.10", "check": "tcp/6379", "status": "ok", "detail": "forbidden public port 6379 is not reachable" },
    { "host": "fsus.blog", "target": "203.0.113.10", "check": "tcp/5432", "status": "ok", "detail": "forbidden public port 5432 is not reachable" },
    { "host": "fsus.blog", "target": "203.0.113.10", "check": "tcp/8080", "status": "ok", "detail": "forbidden public port 8080 is not reachable" },
    { "host": "fsus.blog", "target": "203.0.113.10", "check": "https", "status": "ok", "detail": "HTTP/2 200" },
    { "host": "fsus.blog", "target": "203.0.113.10", "check": "hsts", "status": "ok", "detail": "strict-transport-security: max-age=31536000" }
  ]
}
JSON

cat >"$tmp_dir/firewall-ok.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "evidenceSource": { "kind": "aws-security-groups", "sourceFile": "fixture/aws-security-groups-ok.json" },
  "appliesToHosts": ["fsus.blog", "www.fsus.blog"],
  "ingressRules": [
    { "protocol": "tcp", "fromPort": 80, "toPort": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "port": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" },
    { "protocol": "tcp", "port": 22, "source": "203.0.113.4/32", "sourceType": "fixed-management-ip", "action": "allow", "purpose": "ssh-management" },
    { "protocol": "tcp", "port": 22, "source": "10.0.0.0/24", "sourceType": "vpn", "action": "allow", "purpose": "ssh-vpn" }
  ]
}
JSON

cat >"$tmp_dir/firewall-public-ssh.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "evidenceSource": { "kind": "aws-security-groups", "sourceFile": "fixture/aws-security-groups-public-ssh.json" },
  "appliesToHosts": ["fsus.blog", "www.fsus.blog"],
  "ingressRules": [
    { "protocol": "tcp", "port": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "port": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" },
    { "protocol": "tcp", "port": 22, "source": "0.0.0.0/0", "sourceType": "fixed-management-ip", "action": "allow", "purpose": "ssh-management" }
  ]
}
JSON

cat >"$tmp_dir/firewall-public-db.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "evidenceSource": { "kind": "aws-security-groups", "sourceFile": "fixture/aws-security-groups-public-db.json" },
  "appliesToHosts": ["fsus.blog", "www.fsus.blog"],
  "ingressRules": [
    { "protocol": "tcp", "port": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "port": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" },
    { "protocol": "tcp", "port": 6379, "source": "0.0.0.0/0", "action": "allow", "purpose": "redis" }
  ]
}
JSON

cat >"$tmp_dir/firewall-public-fixed-db.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "evidenceSource": { "kind": "aws-security-groups", "sourceFile": "fixture/aws-security-groups-public-fixed-db.json" },
  "appliesToHosts": ["fsus.blog", "www.fsus.blog"],
  "ingressRules": [
    { "protocol": "tcp", "port": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "port": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" },
    { "protocol": "tcp", "port": 5432, "source": "203.0.113.4/32", "action": "allow", "purpose": "postgresql-public-fixed" }
  ]
}
JSON

cat >"$tmp_dir/firewall-public-fixed-extra-port.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "evidenceSource": { "kind": "aws-security-groups", "sourceFile": "fixture/aws-security-groups-public-fixed-extra-port.json" },
  "appliesToHosts": ["fsus.blog", "www.fsus.blog"],
  "ingressRules": [
    { "protocol": "tcp", "port": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "port": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" },
    { "protocol": "tcp", "port": 8080, "source": "203.0.113.4/32", "action": "allow", "purpose": "kestrel-public-fixed" }
  ]
}
JSON

cat >"$tmp_dir/firewall-public-range.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "evidenceSource": { "kind": "aws-security-groups", "sourceFile": "fixture/aws-security-groups-public-range.json" },
  "appliesToHosts": ["fsus.blog", "www.fsus.blog"],
  "ingressRules": [
    { "protocol": "tcp", "fromPort": 80, "toPort": 80, "cidrBlocks": ["0.0.0.0/0"], "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "fromPort": 443, "toPort": 443, "cidrBlocks": ["0.0.0.0/0"], "action": "allow", "purpose": "https" },
    { "protocol": "tcp", "fromPort": 1, "toPort": 65535, "cidrBlocks": ["0.0.0.0/0"], "action": "allow", "purpose": "bad-wide-open" }
  ]
}
JSON

cat >"$tmp_dir/firewall-public-all-protocols.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "evidenceSource": { "kind": "aws-security-groups", "sourceFile": "fixture/aws-security-groups-all-protocols.json" },
  "appliesToHosts": ["fsus.blog", "www.fsus.blog"],
  "ingressRules": [
    { "protocol": "tcp", "port": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "port": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" },
    { "protocol": "-1", "source": "0.0.0.0/0", "action": "allow", "purpose": "bad-all" }
  ]
}
JSON

cat >"$tmp_dir/firewall-ssh-missing-source-type.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "evidenceSource": { "kind": "aws-security-groups", "sourceFile": "fixture/aws-security-groups-ssh-missing-source-type.json" },
  "appliesToHosts": ["fsus.blog", "www.fsus.blog"],
  "ingressRules": [
    { "protocol": "tcp", "port": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "port": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" },
    { "protocol": "tcp", "fromPort": 22, "toPort": 22, "source": "203.0.113.4/32", "action": "allow", "purpose": "ssh-management" }
  ]
}
JSON

cat >"$tmp_dir/firewall-ssh-wide-fixed-source.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "evidenceSource": { "kind": "aws-security-groups", "sourceFile": "fixture/aws-security-groups-ssh-wide-fixed-source.json" },
  "appliesToHosts": ["fsus.blog", "www.fsus.blog"],
  "ingressRules": [
    { "protocol": "tcp", "port": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "port": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" },
    { "protocol": "tcp", "fromPort": 22, "toPort": 22, "source": "203.0.113.0/24", "sourceType": "fixed-management-ip", "action": "allow", "purpose": "ssh-management" }
  ]
}
JSON

cat >"$tmp_dir/firewall-ssh-public-private-network.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "evidenceSource": { "kind": "aws-security-groups", "sourceFile": "fixture/aws-security-groups-ssh-public-private-network.json" },
  "appliesToHosts": ["fsus.blog", "www.fsus.blog"],
  "ingressRules": [
    { "protocol": "tcp", "port": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "port": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" },
    { "protocol": "tcp", "fromPort": 22, "toPort": 22, "source": "198.51.100.0/24", "sourceType": "private-management-network", "action": "allow", "purpose": "ssh-management" }
  ]
}
JSON

cat >"$tmp_dir/firewall-ssh-invalid-fixed-ip.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "evidenceSource": { "kind": "aws-security-groups", "sourceFile": "fixture/aws-security-groups-ssh-invalid-fixed-ip.json" },
  "appliesToHosts": ["fsus.blog", "www.fsus.blog"],
  "ingressRules": [
    { "protocol": "tcp", "port": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "port": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" },
    { "protocol": "tcp", "fromPort": 22, "toPort": 22, "source": "999.999.999.999/32", "sourceType": "fixed-management-ip", "action": "allow", "purpose": "ssh-management" }
  ]
}
JSON

cat >"$tmp_dir/firewall-ssh-bare-fixed-ip.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "evidenceSource": { "kind": "aws-security-groups", "sourceFile": "fixture/aws-security-groups-ssh-bare-fixed-ip.json" },
  "appliesToHosts": ["fsus.blog", "www.fsus.blog"],
  "ingressRules": [
    { "protocol": "tcp", "port": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "port": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" },
    { "protocol": "tcp", "fromPort": 22, "toPort": 22, "source": "203.0.113.4", "sourceType": "fixed-management-ip", "action": "allow", "purpose": "ssh-management" }
  ]
}
JSON

cat >"$tmp_dir/firewall-ssh-spoofed-private-network.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "evidenceSource": { "kind": "aws-security-groups", "sourceFile": "fixture/aws-security-groups-ssh-spoofed-private-network.json" },
  "appliesToHosts": ["fsus.blog", "www.fsus.blog"],
  "ingressRules": [
    { "protocol": "tcp", "port": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "port": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" },
    { "protocol": "tcp", "fromPort": 22, "toPort": 22, "source": "10.evil", "sourceType": "private-management-network", "action": "allow", "purpose": "ssh-management" }
  ]
}
JSON

cat >"$tmp_dir/firewall-ssh-too-wide-private-network.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "evidenceSource": { "kind": "aws-security-groups", "sourceFile": "fixture/aws-security-groups-ssh-too-wide-private-network.json" },
  "appliesToHosts": ["fsus.blog", "www.fsus.blog"],
  "ingressRules": [
    { "protocol": "tcp", "port": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "port": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" },
    { "protocol": "tcp", "fromPort": 22, "toPort": 22, "source": "10.0.0.0/7", "sourceType": "private-management-network", "action": "allow", "purpose": "ssh-management" }
  ]
}
JSON

cat >"$tmp_dir/firewall-missing-applies.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "evidenceSource": { "kind": "aws-security-groups", "sourceFile": "fixture/aws-security-groups-missing-applies.json" },
  "ingressRules": [
    { "protocol": "tcp", "port": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "port": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" }
  ]
}
JSON

cat >"$tmp_dir/firewall-missing-required-host.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "evidenceSource": { "kind": "aws-security-groups", "sourceFile": "fixture/aws-security-groups-missing-required-host.json" },
  "appliesToHosts": ["fsus.blog"],
  "ingressRules": [
    { "protocol": "tcp", "port": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "port": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" }
  ]
}
JSON

cat >"$tmp_dir/firewall-other-host.json" <<'JSON'
{
  "generatedAt": "2026-05-17T00:00:00Z",
  "evidenceSource": { "kind": "aws-security-groups", "sourceFile": "fixture/aws-security-groups-other-host.json" },
  "appliesToHosts": ["other.example"],
  "ingressRules": [
    { "protocol": "tcp", "port": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "port": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" }
  ]
}
JSON

jq --arg generatedAt "$stale_generated_at" '.generatedAt = $generatedAt' "$tmp_dir/firewall-ok.json" >"$tmp_dir/firewall-stale.json"
jq 'del(.evidenceSource)' "$tmp_dir/firewall-ok.json" >"$tmp_dir/firewall-missing-evidence-source.json"

jq -n '
  {
    generatedAt: "2026-05-17T00:00:00Z",
    requiredHosts: "fsus.blog www.fsus.blog",
    requiredOpenPorts: "80 443",
    forbiddenPublicPorts: "22 6379 5432 8080",
    dnsResolvers: "1.1.1.1 8.8.8.8",
    results: (
      ["fsus.blog", "www.fsus.blog"] as $hosts
      | [
          $hosts[] as $host
          | [
              {host: $host, target: $host, check: "dns", status: "ok", detail: "203.0.113.10"},
              {host: $host, target: $host, check: "dns/1.1.1.1/A", status: "ok", detail: "\($host). 300 IN A 203.0.113.10"},
              {host: $host, target: $host, check: "dns/8.8.8.8/A", status: "ok", detail: "\($host). 300 IN A 203.0.113.10"},
              {host: $host, target: $host, check: "tcp/80", status: "ok", detail: "required public port 80 is reachable"},
              {host: $host, target: $host, check: "tcp/443", status: "ok", detail: "required public port 443 is reachable"},
              {host: $host, target: $host, check: "tcp/22", status: "ok", detail: "forbidden public port 22 is not reachable"},
              {host: $host, target: $host, check: "tcp/6379", status: "ok", detail: "forbidden public port 6379 is not reachable"},
              {host: $host, target: $host, check: "tcp/5432", status: "ok", detail: "forbidden public port 5432 is not reachable"},
              {host: $host, target: $host, check: "tcp/8080", status: "ok", detail: "forbidden public port 8080 is not reachable"},
              {host: $host, target: $host, check: "https", status: "ok", detail: "HTTP/2 200"},
              {host: $host, target: $host, check: "hsts", status: "ok", detail: "strict-transport-security: max-age=31536000"}
            ]
        ]
      | flatten
    )
  }
' >"$tmp_dir/ok.json"

jq 'del(.results[] | select(.host == "www.fsus.blog"))' "$tmp_dir/ok.json" >"$tmp_dir/missing-required-host.json"
jq '.requiredHosts = "fsus.blog" | del(.results[] | select(.host == "www.fsus.blog"))' "$tmp_dir/ok.json" >"$tmp_dir/live-subset-required-hosts.json"
jq '.requiredHosts = ["fsus.blog", "www.fsus.blog"]' "$tmp_dir/ok.json" >"$tmp_dir/ok-array-required-hosts.json"
jq 'del(.requiredHosts)' "$tmp_dir/ok.json" >"$tmp_dir/missing-required-hosts-field.json"
jq --arg generatedAt "$stale_generated_at" '.generatedAt = $generatedAt' "$tmp_dir/ok.json" >"$tmp_dir/stale-live.json"

for json_fixture in "$tmp_dir"/*.json; do
    sed -i "s|2026-05-17T00:00:00Z|$fresh_generated_at|g" "$json_fixture"
done
for firewall_fixture in "$tmp_dir"/firewall*.json; do
    tmp_firewall_fixture="$firewall_fixture.tmp"
    jq 'if has("evidenceSource") then .evidenceSource.sourceSha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" else . end' "$firewall_fixture" >"$tmp_firewall_fixture"
    mv "$tmp_firewall_fixture" "$firewall_fixture"
done
jq '.requiredHosts = ["fsus.blog", "www.fsus.blog"]' "$tmp_dir/dns-readiness-ok.json" >"$tmp_dir/dns-readiness-array-hosts-ok.json"
jq '.delegationDomains = ["fsus.blog"]' "$tmp_dir/dns-delegation-ok.json" >"$tmp_dir/dns-delegation-array-domains-ok.json"

cat >"$tmp_dir/closeout.fixture.md" <<'EOF'
# Production Exposure Closeout Fixture

status: pending
EOF
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.complete.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.complete-refresh-after-delegation-failure.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.complete-missing-delegation.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.complete-missing-readiness.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.direct-missing-delegation.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.direct-missing-readiness.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.array-required-hosts.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.array-dns-fields.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.complete-cloud.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.complete-ufw.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.returned-complete.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.returned-handoff-dir.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.returned-handoff-tar.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.returned-handoff-empty.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.returned-handoff-blocked-tar.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.returned-handoff-symlink-tar.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.returned-handoff-path-traversal-tar.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.returned-handoff-tampered-checklist.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.returned-direct-parent-tampered-checklist.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.returned-blocked.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.returned-missing-manifest.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.returned-narrow-request.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.returned-narrow-manifest.fixture.md"
cp "$tmp_dir/closeout.fixture.md" "$tmp_dir/closeout.returned-unblock-plan.fixture.md"

test_status_and_live_evidence() {
    if "$VERIFY_SCRIPT" "$tmp_dir/failed-dns.json" >/dev/null 2>&1; then
        fail "failed DNS evidence unexpectedly passed verifier"
    fi

    if "$VERIFY_SCRIPT" "$tmp_dir/target-override.json" >/dev/null 2>&1; then
        fail "target override evidence unexpectedly passed final verifier"
    fi

    "$VERIFY_SCRIPT" "$tmp_dir/ok.json" >/dev/null
    "$VERIFY_SCRIPT" "$tmp_dir/ok-array-required-hosts.json" >/dev/null

    FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$tmp_dir/status-ok.json" \
        "$STATUS_SCRIPT" >/dev/null

    jq -e '.status == "ok" and (.blockers | length) == 0 and (.requiredHosts == ["fsus.blog", "www.fsus.blog"]) and (.delegationDomains == ["fsus.blog"])' "$tmp_dir/status-ok.json" >/dev/null ||
        fail "production exposure status report did not accept valid evidence"

    FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/ok-array-required-hosts.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$tmp_dir/status-array-required-hosts-ok.json" \
        "$STATUS_SCRIPT" >/dev/null

    jq -e '.status == "ok" and (.blockers | length) == 0 and (.requiredHosts == ["fsus.blog", "www.fsus.blog"])' "$tmp_dir/status-array-required-hosts-ok.json" >/dev/null ||
        fail "production exposure status report did not accept array requiredHosts live evidence"

    FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-array-hosts-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-array-domains-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$tmp_dir/status-array-dns-ok.json" \
        "$STATUS_SCRIPT" >/dev/null

    jq -e '.status == "ok" and (.blockers | length) == 0 and (.requiredHosts == ["fsus.blog", "www.fsus.blog"]) and (.delegationDomains == ["fsus.blog"])' "$tmp_dir/status-array-dns-ok.json" >/dev/null ||
        fail "production exposure status report did not accept array DNS readiness/delegation evidence"

    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/live-subset-required-hosts.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$tmp_dir/status-subset-live-hosts.json" \
        "$STATUS_SCRIPT" >/dev/null 2>&1; then
        fail "production exposure status report unexpectedly passed live evidence missing a required production host"
    fi

    jq -e '.status == "blocked" and any(.blockers[]; .source == "live-evidence" and (.message | contains("required production host is missing from live evidence requiredHosts")))' "$tmp_dir/status-subset-live-hosts.json" >/dev/null ||
        fail "production exposure status report did not capture live evidence requiredHosts subset"

    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/missing-dns-readiness.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$tmp_dir/status-missing-readiness.json" \
        "$STATUS_SCRIPT" >/dev/null 2>&1; then
        fail "production exposure status report unexpectedly passed missing DNS readiness evidence"
    fi

    jq -e '.status == "blocked" and any(.blockers[]; .source == "dns-readiness" and (.message | contains("missing DNS readiness evidence file")))' "$tmp_dir/status-missing-readiness.json" >/dev/null ||
        fail "production exposure status report did not capture missing DNS readiness evidence"

    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/missing-dns-delegation.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$tmp_dir/status-missing-delegation.json" \
        "$STATUS_SCRIPT" >/dev/null 2>&1; then
        fail "production exposure status report unexpectedly passed missing DNS delegation evidence"
    fi

    jq -e '.status == "blocked" and any(.blockers[]; .source == "dns-delegation" and (.message | contains("missing DNS delegation evidence file")))' "$tmp_dir/status-missing-delegation.json" >/dev/null ||
        fail "production exposure status report did not capture missing DNS delegation evidence"

    jq --arg generatedAt "$stale_generated_at" '.generatedAt = $generatedAt' "$tmp_dir/dns-delegation-ok.json" >"$tmp_dir/dns-delegation-stale.json"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-stale.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$tmp_dir/status-stale-delegation.json" \
        "$STATUS_SCRIPT" >/dev/null 2>&1; then
        fail "production exposure status report unexpectedly passed stale DNS delegation evidence"
    fi

    jq -e '.status == "blocked" and any(.blockers[]; .source == "dns-delegation" and (.message | contains("DNS delegation evidence is stale")))' "$tmp_dir/status-stale-delegation.json" >/dev/null ||
        fail "production exposure status report did not capture stale DNS delegation evidence"

    jq --arg generatedAt "$stale_generated_at" '.generatedAt = $generatedAt' "$tmp_dir/dns-readiness-ok.json" >"$tmp_dir/dns-readiness-stale.json"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-stale.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$tmp_dir/status-stale-readiness.json" \
        "$STATUS_SCRIPT" >/dev/null 2>&1; then
        fail "production exposure status report unexpectedly passed stale DNS readiness evidence"
    fi

    jq -e '.status == "blocked" and any(.blockers[]; .source == "dns-readiness" and (.message | contains("DNS readiness evidence is stale")))' "$tmp_dir/status-stale-readiness.json" >/dev/null ||
        fail "production exposure status report did not capture stale DNS readiness evidence"

    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-failed.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$tmp_dir/status-failed-readiness.json" \
        "$STATUS_SCRIPT" >/dev/null 2>&1; then
        fail "production exposure status report unexpectedly passed failed DNS readiness evidence"
    fi

    jq -e '.status == "blocked" and any(.blockers[]; .source == "dns-readiness" and (.message | contains("DNS readiness public resolver")))' "$tmp_dir/status-failed-readiness.json" >/dev/null ||
        fail "production exposure status report did not capture failed DNS readiness evidence"

    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/missing-firewall.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-failed.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-failed.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$tmp_dir/status-blocked.json" \
        "$STATUS_SCRIPT" >/dev/null 2>&1; then
        fail "production exposure status report unexpectedly passed blocked evidence"
    fi

    jq -e '.status == "blocked" and (.blockers | length) > 0 and ([.blockers[].source] | index("firewall-policy") != null) and ([.blockers[].source] | index("live-evidence") != null) and ([.blockers[].source] | index("dns-readiness") != null) and ([.blockers[].source] | index("dns-delegation") != null)' "$tmp_dir/status-blocked.json" >/dev/null ||
        fail "production exposure status report did not capture firewall, DNS readiness, DNS delegation, and live blockers"

    if "$VERIFY_SCRIPT" "$tmp_dir/stale-live.json" >/dev/null 2>&1; then
        fail "stale live evidence unexpectedly passed verifier"
    fi

    if "$VERIFY_SCRIPT" "$tmp_dir/missing-required-host.json" >/dev/null 2>&1; then
        fail "evidence missing a required host unexpectedly passed verifier"
    fi

    if "$VERIFY_SCRIPT" "$tmp_dir/missing-required-hosts-field.json" >/dev/null 2>&1; then
        fail "evidence without requiredHosts unexpectedly passed verifier"
    fi
}

test_firewall_evidence() {
    if "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-public-ssh.json" >/dev/null 2>&1; then
        fail "public SSH firewall policy unexpectedly passed verifier"
    fi

    if "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-public-db.json" >/dev/null 2>&1; then
        fail "public database/cache firewall policy unexpectedly passed verifier"
    fi

    if "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-public-fixed-db.json" >/dev/null 2>&1; then
        fail "public fixed-IP database/cache firewall policy unexpectedly passed verifier"
    fi

    if "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-public-fixed-extra-port.json" >/dev/null 2>&1; then
        fail "public fixed-IP extra-port firewall policy unexpectedly passed verifier"
    fi

    if "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-public-range.json" >/dev/null 2>&1; then
        fail "public wide TCP range firewall policy unexpectedly passed verifier"
    fi

    if "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-public-all-protocols.json" >/dev/null 2>&1; then
        fail "public all-protocols firewall policy unexpectedly passed verifier"
    fi

    if "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-ssh-missing-source-type.json" >/dev/null 2>&1; then
        fail "SSH firewall policy without management sourceType unexpectedly passed verifier"
    fi

    if "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-ssh-wide-fixed-source.json" >/dev/null 2>&1; then
        fail "SSH firewall policy with wide fixed-management-ip source unexpectedly passed verifier"
    fi

    if "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-ssh-public-private-network.json" >/dev/null 2>&1; then
        fail "SSH firewall policy with public private-management-network source unexpectedly passed verifier"
    fi

    if "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-ssh-invalid-fixed-ip.json" >/dev/null 2>&1; then
        fail "SSH firewall policy with invalid fixed-management-ip source unexpectedly passed verifier"
    fi

    if "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-ssh-bare-fixed-ip.json" >/dev/null 2>&1; then
        fail "SSH firewall policy with bare fixed-management-ip source unexpectedly passed verifier"
    fi

    if "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-ssh-spoofed-private-network.json" >/dev/null 2>&1; then
        fail "SSH firewall policy with spoofed private-management-network source unexpectedly passed verifier"
    fi

    if "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-ssh-too-wide-private-network.json" >/dev/null 2>&1; then
        fail "SSH firewall policy with too-wide private-management-network source unexpectedly passed verifier"
    fi

    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-stale.json" >/dev/null 2>&1; then
        fail "stale firewall policy evidence unexpectedly passed verifier"
    fi

    jq 'del(.evidenceSource.sourceSha256)' "$tmp_dir/firewall-ok.json" >"$tmp_dir/firewall-missing-source-sha256.json"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-missing-source-sha256.json" >/dev/null 2>&1; then
        fail "firewall policy without source sha256 unexpectedly passed verifier"
    fi

    jq '.evidenceSource.sourceSha256 = "not-a-sha256"' "$tmp_dir/firewall-ok.json" >"$tmp_dir/firewall-invalid-source-sha256.json"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-invalid-source-sha256.json" >/dev/null 2>&1; then
        fail "firewall policy with invalid source sha256 unexpectedly passed verifier"
    fi

    jq --arg sourceFile "$tmp_dir/aws-security-groups-ok.json" \
        '.evidenceSource.sourceFile = $sourceFile | .evidenceSource.sourceSha256 = "0000000000000000000000000000000000000000000000000000000000000000"' \
        "$tmp_dir/firewall-ok.json" >"$tmp_dir/firewall-source-sha256-mismatch.json"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-source-sha256-mismatch.json" >/dev/null 2>&1; then
        fail "firewall policy with mismatched source sha256 unexpectedly passed verifier"
    fi

    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-missing-evidence-source.json" >/dev/null 2>&1; then
        fail "firewall policy without evidenceSource unexpectedly passed verifier"
    fi

    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-missing-applies.json" >/dev/null 2>&1; then
        fail "firewall policy without appliesToHosts unexpectedly passed verifier"
    fi

    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-missing-required-host.json" >/dev/null 2>&1; then
        fail "firewall policy missing a required host unexpectedly passed verifier"
    fi

    FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-ok.json" >/dev/null

    FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_UFW_STATUS_FILE="$tmp_dir/ufw-status-ok.txt" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-collected-from-ufw.json" \
        FSUSBLOG_FIREWALL_SSH_SOURCE_TYPE=fixed-management-ip \
        "$COLLECT_HOST_FIREWALL_SCRIPT" >/dev/null

    ufw_status_ok_digest="$(sha256sum "$tmp_dir/ufw-status-ok.txt" | awk '{print $1}')"
    jq -e --arg digest "$ufw_status_ok_digest" '.evidenceSource.sourceSha256 == $digest' "$tmp_dir/firewall-collected-from-ufw.json" >/dev/null ||
        fail "host firewall collector did not record raw UFW status sha256"
    "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-collected-from-ufw.json" >/dev/null

    FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_UFW_STATUS_FILE="$tmp_dir/ufw-status-bare-fixed-ip.txt" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-collected-from-ufw-bare-fixed-ip.json" \
        FSUSBLOG_FIREWALL_SSH_SOURCE_TYPE=fixed-management-ip \
        "$COLLECT_HOST_FIREWALL_SCRIPT" >/dev/null

    jq -e 'any(.ingressRules[]; .source == "203.0.113.4/32" and .sourceType == "fixed-management-ip")' "$tmp_dir/firewall-collected-from-ufw-bare-fixed-ip.json" >/dev/null ||
        fail "host firewall collector did not normalize bare fixed SSH IP to /32"
    "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-collected-from-ufw-bare-fixed-ip.json" >/dev/null

    FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_UFW_STATUS_FILE="$tmp_dir/ufw-status-ok-v6.txt" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-collected-from-ufw-v6.json" \
        FSUSBLOG_FIREWALL_SSH_SOURCE_TYPE=fixed-management-ip \
        "$COLLECT_HOST_FIREWALL_SCRIPT" >/dev/null

    "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-collected-from-ufw-v6.json" >/dev/null

    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_UFW_STATUS_FILE="$tmp_dir/ufw-status-public-ssh.txt" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-collected-public-ssh.json" \
        FSUSBLOG_FIREWALL_SSH_SOURCE_TYPE=fixed-management-ip \
        "$COLLECT_HOST_FIREWALL_SCRIPT" >/dev/null 2>&1; then
        fail "host firewall collector accepted public SSH"
    fi

    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_UFW_STATUS_FILE="$tmp_dir/ufw-status-public-v6-ssh.txt" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-collected-public-v6-ssh.json" \
        FSUSBLOG_FIREWALL_SSH_SOURCE_TYPE=fixed-management-ip \
        "$COLLECT_HOST_FIREWALL_SCRIPT" >/dev/null 2>&1; then
        fail "host firewall collector accepted public IPv6 SSH"
    fi

    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_UFW_STATUS_FILE="$tmp_dir/ufw-status-inactive.txt" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-collected-inactive.json" \
        "$COLLECT_HOST_FIREWALL_SCRIPT" >/dev/null 2>&1; then
        fail "host firewall collector accepted inactive UFW"
    fi

    FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-normalized-from-aws.json" \
        FSUSBLOG_FIREWALL_SSH_SOURCE_TYPE=fixed-management-ip \
        "$CLOUD_FIREWALL_NORMALIZER_SCRIPT" "$tmp_dir/aws-security-groups-ok.json" >/dev/null

    aws_security_groups_ok_digest="$(sha256sum "$tmp_dir/aws-security-groups-ok.json" | awk '{print $1}')"
    jq -e --arg digest "$aws_security_groups_ok_digest" '.evidenceSource.sourceSha256 == $digest' "$tmp_dir/firewall-normalized-from-aws.json" >/dev/null ||
        fail "cloud firewall normalizer did not record raw security group export sha256"
    "$FIREWALL_POLICY_SCRIPT" "$tmp_dir/firewall-normalized-from-aws.json" >/dev/null

    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-normalized-public-db.json" \
        "$CLOUD_FIREWALL_NORMALIZER_SCRIPT" "$tmp_dir/aws-security-groups-public-db.json" >/dev/null 2>&1; then
        fail "cloud firewall normalizer accepted public database/cache ingress"
    fi
}

test_direct_closeout() {
    if FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-other-host.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.fixture.md" \
        "$CLOSEOUT_SCRIPT" "$tmp_dir/ok.json" >/dev/null 2>&1; then
        fail "closeout accepted firewall policy that does not apply to evidence requiredHosts"
    fi

    before="$(sha256sum "$tmp_dir/closeout.fixture.md" | awk '{print $1}')"
    if FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.fixture.md" \
        "$CLOSEOUT_SCRIPT" "$tmp_dir/failed-dns.json" >/dev/null 2>&1; then
        fail "closeout unexpectedly accepted failed DNS evidence"
    fi
    after="$(sha256sum "$tmp_dir/closeout.fixture.md" | awk '{print $1}')"
    [[ "$before" == "$after" ]] || fail "closeout modified closeout fixture after failed evidence"

    direct_missing_delegation_before="$(sha256sum "$tmp_dir/closeout.direct-missing-delegation.fixture.md" | awk '{print $1}')"
    if FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/missing-dns-delegation.json" \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.direct-missing-delegation.fixture.md" \
        "$CLOSEOUT_SCRIPT" "$tmp_dir/ok.json" >/dev/null 2>&1; then
        fail "direct closeout unexpectedly accepted missing DNS delegation evidence"
    fi
    direct_missing_delegation_after="$(sha256sum "$tmp_dir/closeout.direct-missing-delegation.fixture.md" | awk '{print $1}')"
    [[ "$direct_missing_delegation_before" == "$direct_missing_delegation_after" ]] || fail "direct closeout modified closeout fixture after missing DNS delegation evidence"

    direct_missing_readiness_before="$(sha256sum "$tmp_dir/closeout.direct-missing-readiness.fixture.md" | awk '{print $1}')"
    if FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/missing-dns-readiness.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.direct-missing-readiness.fixture.md" \
        "$CLOSEOUT_SCRIPT" "$tmp_dir/ok.json" >/dev/null 2>&1; then
        fail "direct closeout unexpectedly accepted missing DNS readiness evidence"
    fi
    direct_missing_readiness_after="$(sha256sum "$tmp_dir/closeout.direct-missing-readiness.fixture.md" | awk '{print $1}')"
    [[ "$direct_missing_readiness_before" == "$direct_missing_readiness_after" ]] || fail "direct closeout modified closeout fixture after missing DNS readiness evidence"

    FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$tmp_dir/direct-array-required-hosts-status.json" \
        "$CLOSEOUT_SCRIPT" "$tmp_dir/ok-array-required-hosts.json" >/dev/null

    jq -e '.status == "ok" and (.blockers | length) == 0' "$tmp_dir/direct-array-required-hosts-status.json" >/dev/null ||
        fail "direct closeout did not accept array requiredHosts live evidence"

    FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-array-hosts-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-array-domains-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$tmp_dir/direct-array-dns-status.json" \
        "$CLOSEOUT_SCRIPT" "$tmp_dir/ok.json" >/dev/null

    jq -e '.status == "ok" and (.blockers | length) == 0' "$tmp_dir/direct-array-dns-status.json" >/dev/null ||
        fail "direct closeout did not accept array DNS readiness/delegation evidence"

    direct_ok_before="$(sha256sum "$tmp_dir/closeout.fixture.md" | awk '{print $1}')"
    FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$tmp_dir/direct-ok-status.json" \
        "$CLOSEOUT_SCRIPT" "$tmp_dir/ok.json" >/dev/null

    direct_ok_after="$(sha256sum "$tmp_dir/closeout.fixture.md" | awk '{print $1}')"
    [[ "$direct_ok_before" == "$direct_ok_after" ]] || fail "direct closeout modified closeout fixture after valid evidence"
    jq -e '.status == "ok" and (.blockers | length) == 0' "$tmp_dir/direct-ok-status.json" >/dev/null ||
        fail "direct closeout did not write ok status after valid evidence"
}

run_parallel_functions evidence-verifiers \
    test_status_and_live_evidence \
    test_firewall_evidence \
    test_direct_closeout

complete_before="$(sha256sum "$tmp_dir/closeout.complete.fixture.md" | awk '{print $1}')"
complete_failed_status="$tmp_dir/complete-failed-status.json"
complete_failed_request="$tmp_dir/complete-failed-request.json"
if FSUSBLOG_SKIP_PRODUCTION_NETWORK_BASELINE=1 \
    FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
    FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
    FSUSBLOG_USE_EXISTING_PRODUCTION_EXPOSURE_EVIDENCE=1 \
    FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
    FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
    FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
    FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
    FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
    FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.complete.fixture.md" \
    "$COMPLETE_SCRIPT" >/dev/null 2>&1; then
    fail "complete closeout unexpectedly accepted failed DNS evidence"
fi
complete_after="$(sha256sum "$tmp_dir/closeout.complete.fixture.md" | awk '{print $1}')"
[[ "$complete_before" == "$complete_after" ]] || fail "complete closeout modified closeout fixture after failed evidence"
[[ -f "$complete_failed_status" ]] || fail "complete closeout did not write status report after failed evidence"
[[ -f "$complete_failed_request" ]] || fail "complete closeout did not write evidence request after failed evidence"
jq -e '
  .status == "awaiting-external-evidence"
  and (.requiredHosts | index("fsus.blog") != null)
  and .currentStatus.status == "blocked"
  and .currentStatus.blockerCount > 0
	  and (.currentStatus.blockerSources | index("live-evidence") != null)
	  and (.requiredEvidence | map(.key) | sort) == ["dnsDelegation","dnsReadiness","firewallPolicy","liveExposure","statusReport"]
	  and (.unblockPlan | map(.source) | sort) == ["live-evidence"]
	  and any(.unblockPlan[]?; .source == "live-evidence" and .blockerCount > 0 and (.artifactNames | index("production-exposure-live.json") != null) and (.commands | index("tools/security/check-production-exposure-live.sh") != null))
	  and any(.requiredEvidence[]?; .key == "firewallPolicy" and .sourceSha256Required == true)
  and .firewallPolicyRequirements.rawSourceSha256Required == true
  and any(.handoffChecks[]?; .id == "request-status-manifest-alignment")
  and any(.verificationCommands[]?; .name == "verify-returned-evidence")
  and any(.verificationCommands[]?; .name == "complete-returned-evidence")
  and any(.verificationCommands[]?; .name == "complete-returned-handoff")
  and any(.nextActions[]?; .source == "live-evidence")
  and .finalCloseoutCommand == "tools/security/complete-production-exposure-closeout.sh"
  and .returnedEvidenceVerifierCommand == "tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>"
  and .returnedEvidenceCloseoutCommand == "tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>"
  and .returnedHandoffCloseoutCommand == "tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>"
' "$complete_failed_request" >/dev/null ||
    fail "complete closeout evidence request did not describe required external evidence"
if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
    FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
    "$HANDOFF_SCRIPT" >/dev/null 2>&1; then
    fail "handoff check accepted fixture /tmp evidence paths without explicit allowance"
fi
FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
    FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
    FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
    FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
    FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
    FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
    FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
    "$HANDOFF_SCRIPT" >/dev/null
complete_failed_request_scope_mismatch="$tmp_dir/complete-failed-request-scope-mismatch.json"
jq '.delegationDomains = ["other.example"]' "$complete_failed_request" >"$complete_failed_request_scope_mismatch"
if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request_scope_mismatch" \
    FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
    FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
    FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
    FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
    FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
    FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
    "$HANDOFF_SCRIPT" >/dev/null 2>&1; then
    fail "handoff check accepted request/status delegation domain drift"
fi
complete_failed_request_blocker_mismatch="$tmp_dir/complete-failed-request-blocker-mismatch.json"
jq '.currentStatus.blockers[0].message = "stale synthetic blocker"' "$complete_failed_request" >"$complete_failed_request_blocker_mismatch"
if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request_blocker_mismatch" \
    FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
    FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
    FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
    FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
    FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
    FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
    "$HANDOFF_SCRIPT" >/dev/null 2>&1; then
    fail "handoff check accepted request/status blocker detail drift"
fi
complete_failed_request_path_mismatch="$tmp_dir/complete-failed-request-path-mismatch.json"
jq '.evidenceFiles.liveExposure = "/var/tmp/production-exposure-live.json"' "$complete_failed_request" >"$complete_failed_request_path_mismatch"
if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request_path_mismatch" \
    FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
    FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
    FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
    FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
    FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
    FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
    "$HANDOFF_SCRIPT" >/dev/null 2>&1; then
    fail "handoff check accepted request evidenceFiles path drift"
fi
complete_failed_request_required_evidence_mismatch="$tmp_dir/complete-failed-request-required-evidence-mismatch.json"
jq '.requiredEvidence[] |= if .key == "liveExposure" then .path = "/var/tmp/production-exposure-live.json" else . end' "$complete_failed_request" >"$complete_failed_request_required_evidence_mismatch"
if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request_required_evidence_mismatch" \
    FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
    FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
    FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
    FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
    FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
    FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
    "$HANDOFF_SCRIPT" >/dev/null 2>&1; then
    fail "handoff check accepted request requiredEvidence path drift"
fi
complete_failed_request_firewall_sha_contract_missing="$tmp_dir/complete-failed-request-firewall-sha-contract-missing.json"
jq '(.requiredEvidence[] | select(.key == "firewallPolicy") | .sourceSha256Required) = false | .firewallPolicyRequirements.rawSourceSha256Required = false' "$complete_failed_request" >"$complete_failed_request_firewall_sha_contract_missing"
if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request_firewall_sha_contract_missing" \
    FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
    FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
    FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
    FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
    FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
    FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
    "$HANDOFF_SCRIPT" >/dev/null 2>&1; then
    fail "handoff check accepted request without firewall source sha256 contract"
fi
complete_failed_request_handoff_check_missing="$tmp_dir/complete-failed-request-handoff-check-missing.json"
jq 'del(.handoffChecks[] | select(.id == "request-status-manifest-alignment"))' "$complete_failed_request" >"$complete_failed_request_handoff_check_missing"
if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request_handoff_check_missing" \
    FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
    FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
    FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
    FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
    FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
    FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
    "$HANDOFF_SCRIPT" >/dev/null 2>&1; then
    fail "handoff check accepted request without required handoff check"
fi
complete_failed_request_unblock_plan_missing="$tmp_dir/complete-failed-request-unblock-plan-missing.json"
jq 'del(.unblockPlan[] | select(.source == "live-evidence"))' "$complete_failed_request" >"$complete_failed_request_unblock_plan_missing"
if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request_unblock_plan_missing" \
    FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
    FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
    FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
    FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
    FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
    FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
    "$HANDOFF_SCRIPT" >/dev/null 2>&1; then
    fail "handoff check accepted request without unblock plan for blocker source"
fi
complete_failed_request_returned_command_missing="$tmp_dir/complete-failed-request-returned-command-missing.json"
jq 'del(.verificationCommands[] | select(.name == "complete-returned-handoff"))' "$complete_failed_request" >"$complete_failed_request_returned_command_missing"
if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request_returned_command_missing" \
    FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
    FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
    FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
    FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
    FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
    FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
    "$HANDOFF_SCRIPT" >/dev/null 2>&1; then
    fail "handoff check accepted request without returned handoff closeout command"
fi
complete_failed_request_returned_field_mismatch="$tmp_dir/complete-failed-request-returned-field-mismatch.json"
jq '.returnedEvidenceVerifierCommand = "tools/security/verify-production-exposure-returned-evidence.sh <other-dir>"' "$complete_failed_request" >"$complete_failed_request_returned_field_mismatch"
if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request_returned_field_mismatch" \
    FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
    FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
    FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
    FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
    FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
    FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
    "$HANDOFF_SCRIPT" >/dev/null 2>&1; then
    fail "handoff check accepted request with drifted returned verifier command field"
fi
complete_failed_manifest="$tmp_dir/complete-failed-manifest.json"
cp "$complete_failed_request" "$tmp_dir/production-exposure-evidence-request.json"
cp "$complete_failed_status" "$tmp_dir/production-exposure-status.json"
cp "$tmp_dir/failed-dns.json" "$tmp_dir/production-exposure-live.json"
cp "$tmp_dir/firewall-ok.json" "$tmp_dir/production-firewall-policy.json"
cp "$tmp_dir/dns-readiness-ok.json" "$tmp_dir/production-dns-readiness.json"
cp "$tmp_dir/dns-delegation-ok.json" "$tmp_dir/production-dns-delegation.json"
complete_failed_request_digest="$(sha256sum "$tmp_dir/production-exposure-evidence-request.json" | awk '{print $1}')"
complete_failed_status_digest="$(sha256sum "$tmp_dir/production-exposure-status.json" | awk '{print $1}')"
complete_failed_live_digest="$(sha256sum "$tmp_dir/production-exposure-live.json" | awk '{print $1}')"
complete_failed_firewall_digest="$(sha256sum "$tmp_dir/production-firewall-policy.json" | awk '{print $1}')"
complete_failed_readiness_digest="$(sha256sum "$tmp_dir/production-dns-readiness.json" | awk '{print $1}')"
complete_failed_delegation_digest="$(sha256sum "$tmp_dir/production-dns-delegation.json" | awk '{print $1}')"
jq -n \
    --arg requestDigest "$complete_failed_request_digest" \
    --arg statusDigest "$complete_failed_status_digest" \
    --arg liveDigest "$complete_failed_live_digest" \
    --arg firewallDigest "$complete_failed_firewall_digest" \
    --arg readinessDigest "$complete_failed_readiness_digest" \
    --arg delegationDigest "$complete_failed_delegation_digest" \
    --slurpfile request "$complete_failed_request" \
    --slurpfile status "$complete_failed_status" '{
  status: "collected-blocked",
  releaseStamp: "fixture",
  generatedAt: "2026-05-19T00:00:00Z",
  gitRevision: "fixture",
  imageDigest: "fixture",
  artifacts: {
    productionExposureRequest: "production-exposure-evidence-request.json",
    productionExposureStatus: "production-exposure-status.json",
    productionExposureLive: "production-exposure-live.json",
    firewallPolicy: "production-firewall-policy.json",
    dnsReadiness: "production-dns-readiness.json",
    dnsDelegation: "production-dns-delegation.json"
  },
  artifactDigests: {
    productionExposureRequest: {algorithm: "sha256", value: $requestDigest},
    productionExposureStatus: {algorithm: "sha256", value: $statusDigest},
    productionExposureLive: {algorithm: "sha256", value: $liveDigest},
    firewallPolicy: {algorithm: "sha256", value: $firewallDigest},
    dnsReadiness: {algorithm: "sha256", value: $readinessDigest},
    dnsDelegation: {algorithm: "sha256", value: $delegationDigest}
  },
  evidenceSummary: {
    externalExposure: {
      status: $status[0].status,
      valid: ($status[0].status == "ok"),
      firewallPolicy: "present",
      dnsReadiness: "blocked",
      dnsDelegation: "blocked",
      liveExposure: "blocked",
      blockers: ($status[0].blockers // []),
      request: {
        status: $request[0].status,
        currentStatus: $request[0].currentStatus.status,
	        blockerCount: $request[0].currentStatus.blockerCount,
	        blockerSources: ($request[0].currentStatus.blockerSources // []),
	        nextActionSources: ($request[0].nextActions // [] | map(.source)),
	        unblockPlanSources: ($request[0].unblockPlan // [] | map(.source)),
	        unblockPlanCount: ($request[0].unblockPlan // [] | length),
	        requiredHosts: ($request[0].requiredHosts // []),
        delegationDomains: ($request[0].delegationDomains // []),
        requiredEvidenceKeys: ($request[0].requiredEvidence // [] | map(.key)),
	        requiredEvidenceCount: ($request[0].requiredEvidence // [] | length),
	        firewallSourceSha256Required: any($request[0].requiredEvidence[]?; .key == "firewallPolicy" and .sourceSha256Required == true),
	        rawSourceSha256Required: ($request[0].firewallPolicyRequirements.rawSourceSha256Required == true),
	        handoffCheckCount: ($request[0].handoffChecks // [] | length),
	        verificationCommandNames: ($request[0].verificationCommands // [] | map(.name)),
	        verificationCommandCount: ($request[0].verificationCommands // [] | length),
	        returnedCloseoutCommandCount: ([
	          $request[0].verificationCommands[]?
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
	        ] | length),
	        closeoutCommands: {
	          finalCloseout: ($request[0].finalCloseoutCommand // null),
	          returnedEvidenceVerifier: ($request[0].returnedEvidenceVerifierCommand // null),
	          returnedEvidenceCloseout: ($request[0].returnedEvidenceCloseoutCommand // null),
	          returnedHandoffCloseout: ($request[0].returnedHandoffCloseoutCommand // null),
	          releaseEvidence: ($request[0].releaseEvidenceCommand // null)
	        }
	      }
	    }
	  }
}' >"$complete_failed_manifest"
FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
    FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
    FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
    FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
    FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
    FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
    FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
    "$HANDOFF_SCRIPT" "$complete_failed_manifest" >/dev/null
complete_failed_handoff_bundle="$tmp_dir.handoff-bundle"
FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
    FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
    FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
    FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
    FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
    FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
    FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
    FSUSBLOG_PRODUCTION_EXPOSURE_HANDOFF_DIR="$complete_failed_handoff_bundle" \
    "$HANDOFF_BUNDLE_SCRIPT" "$complete_failed_manifest" >/dev/null
[[ -f "$complete_failed_handoff_bundle/release-evidence/manifest.json" ]] || fail "handoff bundle did not copy release manifest"
[[ -f "$complete_failed_handoff_bundle/handoff-summary.json" ]] || fail "handoff bundle did not write summary"
[[ -f "$complete_failed_handoff_bundle/operator-checklist.json" ]] || fail "handoff bundle did not write operator checklist"
[[ -f "$complete_failed_handoff_bundle/README.md" ]] || fail "handoff bundle did not write README"
[[ -f "$complete_failed_handoff_bundle/returned-evidence/README.md" ]] || fail "handoff bundle did not write returned evidence README"
[[ -f "$complete_failed_handoff_bundle/returned-evidence/expected-evidence-manifest.json" ]] || fail "handoff bundle did not write returned evidence manifest"
[[ -f "$complete_failed_handoff_bundle/SHA256SUMS" ]] || fail "handoff bundle did not write checksums"
[[ -f "$complete_failed_handoff_bundle.tar.gz" ]] || fail "handoff bundle did not write archive"
[[ -f "$complete_failed_handoff_bundle.tar.gz.sha256" ]] || fail "handoff bundle did not write archive checksum"

test_handoff_bundle_security() {
    export_symlink_release_dir="$tmp_dir/export-symlink-release"
    mkdir -p "$export_symlink_release_dir"
    cp "$complete_failed_manifest" "$export_symlink_release_dir/manifest.json"
    cp "$complete_failed_request" "$export_symlink_release_dir/production-exposure-evidence-request.json"
    cp "$complete_failed_status" "$export_symlink_release_dir/production-exposure-status.json"
    cp "$tmp_dir/failed-dns.json" "$export_symlink_release_dir/production-exposure-live.json"
    cp "$tmp_dir/firewall-ok.json" "$export_symlink_release_dir/production-firewall-policy.json"
    cp "$tmp_dir/dns-readiness-ok.json" "$export_symlink_release_dir/production-dns-readiness.json"
    cp "$tmp_dir/dns-delegation-ok.json" "$export_symlink_release_dir/production-dns-delegation.json"
    ln -s manifest.json "$export_symlink_release_dir/copied-release-symlink.json"
    export_symlink_handoff_bundle="$tmp_dir.handoff-bundle-export-symlink"
    if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_PRODUCTION_EXPOSURE_HANDOFF_DIR="$export_symlink_handoff_bundle" \
        "$HANDOFF_BUNDLE_SCRIPT" "$export_symlink_release_dir/manifest.json" >/dev/null 2>&1; then
        fail "handoff bundle exporter accepted a release evidence source containing a symlink"
    fi
    [[ ! -f "$export_symlink_handoff_bundle.tar.gz" ]] ||
        fail "handoff bundle exporter wrote archive after symlink self-check failure"
    (
        cd "$complete_failed_handoff_bundle"
        sha256sum -c SHA256SUMS >/dev/null
    ) || fail "handoff bundle checksum verification failed"
    jq -e '
  .handoffStatus == "verified"
  and .releaseManifest.status == "collected-blocked"
	  and .externalExposure.request.firewallSourceSha256Required == true
	  and .externalExposure.request.rawSourceSha256Required == true
	  and (.requiredEvidence | length) == 5
	  and (.unblockPlan | length) > 0
	  and any(.unblockPlan[]?; .source == "live-evidence" and .returnedEvidenceRequired == true)
	  and any(.nextActions[]?; .source == "live-evidence")
	  and any(.verificationCommands[]?; .name == "complete-closeout")
	  and any(.verificationCommands[]?; .name == "verify-returned-evidence")
	  and any(.verificationCommands[]?; .name == "complete-returned-evidence")
	  and any(.verificationCommands[]?; .name == "complete-returned-handoff")
	  and .externalExposure.request.returnedCloseoutCommandCount == 3
	' "$complete_failed_handoff_bundle/handoff-summary.json" >/dev/null ||
        fail "handoff bundle summary did not preserve request and manifest status"
    jq -e '
  .contractVersion == 1
  and .generatedBy == "tools/security/export-production-exposure-handoff-bundle.sh"
  and .status == "action-required"
  and .releaseManifestStatus == "collected-blocked"
  and .externalExposureStatus == "blocked"
  and .requiredHosts == ["fsus.blog", "www.fsus.blog"]
  and .delegationDomains == ["fsus.blog"]
  and .blockerCount > 0
  and (.blockerSources | sort) == ["live-evidence"]
  and (.checklist | length) == 1
  and any(.checklist[]?; .source == "live-evidence" and .blockerCount > 0 and .returnedEvidenceRequired == true and (.artifactNames | index("production-exposure-live.json")) and (.commands | index("tools/security/check-production-exposure-live.sh")))
  and (.verifyReturnedEvidenceCommand | contains("verify-production-exposure-returned-evidence.sh"))
  and (.closeoutCommand | contains("complete-production-exposure-from-returned-evidence.sh"))
  and (.handoffCloseoutCommand | contains("complete-production-exposure-from-returned-handoff-bundle.sh"))
' "$complete_failed_handoff_bundle/operator-checklist.json" >/dev/null ||
        fail "handoff bundle operator checklist did not preserve unblock plan and closeout commands"
    jq -e '
  .contractVersion == 1
  and .generatedBy == "tools/security/export-production-exposure-handoff-bundle.sh"
  and (.sourceReleaseManifest | type) == "string"
  and (.sourceReleaseManifestSha256 | test("^[0-9a-f]{64}$"))
  and (.sourceRequestSha256 | test("^[0-9a-f]{64}$"))
  and
  .status == "awaiting-returned-evidence"
  and .requiredHosts == ["fsus.blog", "www.fsus.blog"]
  and .delegationDomains == ["fsus.blog"]
  and (.requiredReturnedFiles | length) == 4
  and ([.requiredReturnedFiles[].artifactName] | sort) == ["production-dns-delegation.json","production-dns-readiness.json","production-exposure-live.json","production-firewall-policy.json"]
	  and all(.requiredReturnedFiles[]; .requiredForCloseout == true)
		  and any(.requiredReturnedFiles[]; .key == "firewallPolicy" and .sourceSha256Required == true)
		  and (.unblockPlanSources | sort) == ["live-evidence"]
		  and .unblockPlanCount == 1
		  and (.unblockPlan | length) > 0
		  and any(.unblockPlan[]?; .source == "live-evidence" and .returnedEvidenceRequired == true)
		  and (.generatedByVerifier | sort) == ["production-exposure-evidence-request.json","production-exposure-status.json"]
  and (.scopeRule | contains("must not narrow"))
  and (.verifierCommand | contains("verify-production-exposure-returned-evidence.sh"))
  and (.closeoutCommand | contains("complete-production-exposure-from-returned-evidence.sh"))
  and (.handoffCloseoutCommand | contains("complete-production-exposure-from-returned-handoff-bundle.sh"))
' "$complete_failed_handoff_bundle/returned-evidence/expected-evidence-manifest.json" >/dev/null ||
        fail "handoff bundle returned evidence manifest did not preserve returned closeout requirements"
    grep -Fq 'complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>' "$complete_failed_handoff_bundle/returned-evidence/README.md" ||
        fail "handoff bundle returned evidence README did not describe handoff bundle closeout command"
    grep -Fq 'operator-checklist.json' "$complete_failed_handoff_bundle/README.md" ||
        fail "handoff bundle README did not describe operator checklist"
    grep -Fq 'not a passing production closeout signal' "$complete_failed_handoff_bundle/README.md" ||
        fail "handoff bundle README did not describe blocked closeout rule"
    FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 "$HANDOFF_BUNDLE_CHECK_SCRIPT" "$complete_failed_handoff_bundle" >/dev/null
    FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 "$HANDOFF_BUNDLE_CHECK_SCRIPT" "$complete_failed_handoff_bundle.tar.gz" >/dev/null
    returned_empty_handoff_closeout_before="$(sha256sum "$tmp_dir/closeout.returned-handoff-empty.fixture.md" | awk '{print $1}')"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.returned-handoff-empty.fixture.md" \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-handoff-empty-closeout-release" \
        "$RETURNED_HANDOFF_COMPLETE_SCRIPT" "$complete_failed_handoff_bundle" >/dev/null 2>&1; then
        fail "returned handoff bundle closeout accepted an empty returned-evidence slot"
    fi
    returned_empty_handoff_closeout_after="$(sha256sum "$tmp_dir/closeout.returned-handoff-empty.fixture.md" | awk '{print $1}')"
    [[ "$returned_empty_handoff_closeout_before" == "$returned_empty_handoff_closeout_after" ]] ||
        fail "returned handoff bundle closeout modified closeout after empty returned-evidence slot"
    relocated_handoff_archive_dir="$tmp_dir/relocated-handoff-archive"
    mkdir -p "$relocated_handoff_archive_dir"
    cp "$complete_failed_handoff_bundle.tar.gz" "$relocated_handoff_archive_dir/handoff.tar.gz"
    cp "$complete_failed_handoff_bundle.tar.gz.sha256" "$relocated_handoff_archive_dir/handoff.tar.gz.sha256"
    FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 "$HANDOFF_BUNDLE_CHECK_SCRIPT" "$relocated_handoff_archive_dir/handoff.tar.gz" >/dev/null
    path_traversal_archive_dir="$tmp_dir/path-traversal-archive"
    mkdir -p "$path_traversal_archive_dir/src"
    printf '{}\n' >"$path_traversal_archive_dir/src/manifest.json"
    tar -czf "$path_traversal_archive_dir/handoff.tar.gz" \
        -C "$path_traversal_archive_dir/src" \
        --transform='s,^,../,' \
        manifest.json
    (
        cd "$path_traversal_archive_dir"
        sha256sum handoff.tar.gz >handoff.tar.gz.sha256
    )
    if FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 "$HANDOFF_BUNDLE_CHECK_SCRIPT" "$path_traversal_archive_dir/handoff.tar.gz" >/dev/null 2>&1; then
        fail "handoff bundle checker accepted archive path traversal member"
    fi
    symlink_member_archive_dir="$tmp_dir/symlink-member-archive"
    mkdir -p "$symlink_member_archive_dir/src/handoff"
    printf '{}\n' >"$symlink_member_archive_dir/src/handoff/manifest.json"
    ln -s manifest.json "$symlink_member_archive_dir/src/handoff/manifest-link.json"
    tar -czf "$symlink_member_archive_dir/handoff.tar.gz" -C "$symlink_member_archive_dir/src" handoff
    (
        cd "$symlink_member_archive_dir"
        sha256sum handoff.tar.gz >handoff.tar.gz.sha256
    )
    if FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 "$HANDOFF_BUNDLE_CHECK_SCRIPT" "$symlink_member_archive_dir/handoff.tar.gz" >/dev/null 2>&1; then
        fail "handoff bundle checker accepted unsupported symlink archive member"
    fi
    tampered_handoff_bundle="$tmp_dir.handoff-bundle-tampered"
    cp -a "$complete_failed_handoff_bundle" "$tampered_handoff_bundle"
    jq '.requiredHosts = ["fsus.blog"]' \
        "$complete_failed_handoff_bundle/returned-evidence/expected-evidence-manifest.json" \
        >"$tampered_handoff_bundle/returned-evidence/expected-evidence-manifest.json"
    (
        cd "$tampered_handoff_bundle"
        find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
    )
    if FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 "$HANDOFF_BUNDLE_CHECK_SCRIPT" "$tampered_handoff_bundle" >/dev/null 2>&1; then
        fail "handoff bundle checker accepted narrowed returned evidence manifest"
    fi
    tampered_summary_unblock_plan_bundle="$tmp_dir.handoff-bundle-tampered-summary-unblock"
    cp -a "$complete_failed_handoff_bundle" "$tampered_summary_unblock_plan_bundle"
    jq 'del(.unblockPlan[] | select(.source == "live-evidence"))' \
        "$complete_failed_handoff_bundle/handoff-summary.json" \
        >"$tampered_summary_unblock_plan_bundle/handoff-summary.json"
    (
        cd "$tampered_summary_unblock_plan_bundle"
        find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
    )
    if FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 "$HANDOFF_BUNDLE_CHECK_SCRIPT" "$tampered_summary_unblock_plan_bundle" >/dev/null 2>&1; then
        fail "handoff bundle checker accepted handoff summary unblock plan drift"
    fi
    tampered_operator_checklist_bundle="$tmp_dir.handoff-bundle-tampered-operator-checklist"
    cp -a "$complete_failed_handoff_bundle" "$tampered_operator_checklist_bundle"
    jq 'del(.checklist[] | select(.source == "live-evidence"))' \
        "$complete_failed_handoff_bundle/operator-checklist.json" \
        >"$tampered_operator_checklist_bundle/operator-checklist.json"
    (
        cd "$tampered_operator_checklist_bundle"
        find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
    )
    if FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 "$HANDOFF_BUNDLE_CHECK_SCRIPT" "$tampered_operator_checklist_bundle" >/dev/null 2>&1; then
        fail "handoff bundle checker accepted operator checklist unblock plan drift"
    fi
    tampered_returned_readme_bundle="$tmp_dir.handoff-bundle-tampered-returned-readme"
    cp -a "$complete_failed_handoff_bundle" "$tampered_returned_readme_bundle"
    sed '/complete-production-exposure-from-returned-evidence.sh/d' \
        "$complete_failed_handoff_bundle/returned-evidence/README.md" \
        >"$tampered_returned_readme_bundle/returned-evidence/README.md"
    (
        cd "$tampered_returned_readme_bundle"
        find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
    )
    if FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 "$HANDOFF_BUNDLE_CHECK_SCRIPT" "$tampered_returned_readme_bundle" >/dev/null 2>&1; then
        fail "handoff bundle checker accepted tampered returned evidence README"
    fi
    tampered_symlink_handoff_bundle="$tmp_dir.handoff-bundle-tampered-symlink"
    cp -a "$complete_failed_handoff_bundle" "$tampered_symlink_handoff_bundle"
    rm "$tampered_symlink_handoff_bundle/returned-evidence/README.md"
    ln -s ../README.md "$tampered_symlink_handoff_bundle/returned-evidence/README.md"
    (
        cd "$tampered_symlink_handoff_bundle"
        find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
    )
    if FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 "$HANDOFF_BUNDLE_CHECK_SCRIPT" "$tampered_symlink_handoff_bundle" >/dev/null 2>&1; then
        fail "handoff bundle checker accepted symlinked bundle contents"
    fi
    tampered_returned_unblock_plan_bundle="$tmp_dir.handoff-bundle-tampered-returned-unblock"
    cp -a "$complete_failed_handoff_bundle" "$tampered_returned_unblock_plan_bundle"
    jq 'del(.unblockPlan[] | select(.source == "live-evidence"))' \
        "$complete_failed_handoff_bundle/returned-evidence/expected-evidence-manifest.json" \
        >"$tampered_returned_unblock_plan_bundle/returned-evidence/expected-evidence-manifest.json"
    (
        cd "$tampered_returned_unblock_plan_bundle"
        find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
    )
    if FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 "$HANDOFF_BUNDLE_CHECK_SCRIPT" "$tampered_returned_unblock_plan_bundle" >/dev/null 2>&1; then
        fail "handoff bundle checker accepted returned manifest unblock plan drift"
    fi
    tampered_digest_handoff_bundle="$tmp_dir.handoff-bundle-tampered-digest"
    cp -a "$complete_failed_handoff_bundle" "$tampered_digest_handoff_bundle"
    jq '.artifactDigests.productionExposureStatus.value = "0000000000000000000000000000000000000000000000000000000000000000"' \
        "$complete_failed_handoff_bundle/release-evidence/manifest.json" \
        >"$tampered_digest_handoff_bundle/release-evidence/manifest.json"
    (
        cd "$tampered_digest_handoff_bundle"
        find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
    )
    if FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 "$HANDOFF_BUNDLE_CHECK_SCRIPT" "$tampered_digest_handoff_bundle" >/dev/null 2>&1; then
        fail "handoff bundle checker accepted tampered manifest artifact digest"
    fi
}

returned_ok_dir="$tmp_dir/returned-ok"
mkdir -p "$returned_ok_dir"
cp "$tmp_dir/firewall-ok.json" "$returned_ok_dir/production-firewall-policy.json"
cp "$tmp_dir/dns-readiness-ok.json" "$returned_ok_dir/production-dns-readiness.json"
cp "$tmp_dir/dns-delegation-ok.json" "$returned_ok_dir/production-dns-delegation.json"
cp "$tmp_dir/ok.json" "$returned_ok_dir/production-exposure-live.json"
cat >"$returned_ok_dir/expected-evidence-manifest.json" <<'JSON'
{
  "contractVersion": 1,
  "status": "awaiting-returned-evidence",
  "generatedBy": "tools/security/export-production-exposure-handoff-bundle.sh",
  "sourceReleaseManifest": ".tmp/release-evidence/fixture/manifest.json",
  "sourceReleaseManifestSha256": "1111111111111111111111111111111111111111111111111111111111111111",
  "sourceRequestSha256": "2222222222222222222222222222222222222222222222222222222222222222",
  "requiredHosts": ["fsus.blog", "www.fsus.blog"],
  "delegationDomains": ["fsus.blog"],
  "requiredReturnedFiles": [
    {
      "key": "firewallPolicy",
      "source": "firewall-policy",
      "artifactName": "production-firewall-policy.json",
      "requiredForCloseout": true,
      "sourceSha256Required": true
    },
    {
      "key": "dnsReadiness",
      "source": "dns-readiness",
      "artifactName": "production-dns-readiness.json",
      "requiredForCloseout": true,
      "sourceSha256Required": false
    },
    {
      "key": "dnsDelegation",
      "source": "dns-delegation",
      "artifactName": "production-dns-delegation.json",
      "requiredForCloseout": true,
      "sourceSha256Required": false
    },
    {
      "key": "liveExposure",
      "source": "live-evidence",
      "artifactName": "production-exposure-live.json",
      "requiredForCloseout": true,
      "sourceSha256Required": false
    }
  ],
  "unblockPlanSources": ["dns-delegation", "dns-readiness", "firewall-policy", "live-evidence"],
  "unblockPlanCount": 4,
  "unblockPlan": [
	    {
	      "source": "firewall-policy",
	      "blockerCount": 1,
	      "evidenceKeys": ["firewallPolicy"],
	      "artifactNames": ["production-firewall-policy.json"],
	      "evidenceFiles": ["production-firewall-policy.json"],
	      "commands": ["tools/security/verify-production-firewall-policy-evidence.sh"],
	      "returnedEvidenceRequired": true
	    },
	    {
	      "source": "dns-readiness",
	      "blockerCount": 1,
	      "evidenceKeys": ["dnsReadiness"],
	      "artifactNames": ["production-dns-readiness.json"],
	      "evidenceFiles": ["production-dns-readiness.json"],
	      "commands": ["tools/security/check-production-dns-readiness.sh"],
	      "returnedEvidenceRequired": true
	    },
	    {
	      "source": "dns-delegation",
	      "blockerCount": 1,
	      "evidenceKeys": ["dnsDelegation"],
	      "artifactNames": ["production-dns-delegation.json"],
	      "evidenceFiles": ["production-dns-delegation.json"],
	      "commands": ["tools/security/check-production-dns-delegation.sh"],
	      "returnedEvidenceRequired": true
	    },
	    {
	      "source": "live-evidence",
	      "blockerCount": 1,
	      "evidenceKeys": ["liveExposure"],
	      "artifactNames": ["production-exposure-live.json"],
	      "evidenceFiles": ["production-exposure-live.json"],
	      "commands": ["tools/security/check-production-exposure-live.sh", "tools/security/verify-production-exposure-evidence.sh"],
	      "returnedEvidenceRequired": true
	    }
	  ],
  "scopeRule": "Returned request requiredHosts/delegationDomains may be present, but they must cover the current production scope and must not narrow it."
}
JSON
FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
    FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
    FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-ok-release" \
    "$RETURNED_EVIDENCE_SCRIPT" "$returned_ok_dir" >/dev/null
jq -e '.status == "ok" and (.blockers | length) == 0' "$returned_ok_dir/production-exposure-status.json" >/dev/null ||
    fail "returned evidence verifier did not write ok status"
jq -e '.currentStatus.status == "ok" and .currentStatus.blockerCount == 0' "$returned_ok_dir/production-exposure-evidence-request.json" >/dev/null ||
    fail "returned evidence verifier did not refresh ok request"
jq -e '.evidenceSummary.externalExposure.valid == true and .evidenceSummary.externalExposure.request.currentStatus == "ok" and .evidenceSummary.externalExposure.request.requiredEvidenceCount == 5' "$tmp_dir/returned-ok-release/manifest.json" >/dev/null ||
    fail "returned evidence verifier did not write ok release manifest"

# The rolling groups below treat complete_failed_status, complete_failed_manifest,
# complete_failed_handoff_bundle, and returned_ok_dir as immutable baselines. Every
# negative mutation and every successful closeout writes to a group-owned copy.
test_returned_evidence_rejections() {
    returned_symlink_dir="$tmp_dir/returned-symlink"
    cp -a "$returned_ok_dir" "$returned_symlink_dir"
    rm "$returned_symlink_dir/production-exposure-live.json"
    ln -s "$tmp_dir/ok.json" "$returned_symlink_dir/production-exposure-live.json"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-symlink-release" \
        "$RETURNED_EVIDENCE_SCRIPT" "$returned_symlink_dir" >/dev/null 2>&1; then
        fail "returned evidence verifier accepted symlinked evidence file"
    fi
    returned_missing_manifest_dir="$tmp_dir/returned-missing-manifest"
    mkdir -p "$returned_missing_manifest_dir"
    cp "$returned_ok_dir/production-firewall-policy.json" "$returned_missing_manifest_dir/production-firewall-policy.json"
    cp "$returned_ok_dir/production-dns-readiness.json" "$returned_missing_manifest_dir/production-dns-readiness.json"
    cp "$returned_ok_dir/production-dns-delegation.json" "$returned_missing_manifest_dir/production-dns-delegation.json"
    cp "$returned_ok_dir/production-exposure-live.json" "$returned_missing_manifest_dir/production-exposure-live.json"
    returned_missing_manifest_closeout_before="$(sha256sum "$tmp_dir/closeout.returned-missing-manifest.fixture.md" | awk '{print $1}')"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.returned-missing-manifest.fixture.md" \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-missing-manifest-closeout-release" \
        "$RETURNED_COMPLETE_SCRIPT" "$returned_missing_manifest_dir" >/dev/null 2>&1; then
        fail "returned evidence complete closeout accepted missing expected evidence manifest"
    fi
    returned_missing_manifest_closeout_after="$(sha256sum "$tmp_dir/closeout.returned-missing-manifest.fixture.md" | awk '{print $1}')"
    [[ "$returned_missing_manifest_closeout_before" == "$returned_missing_manifest_closeout_after" ]] ||
        fail "returned evidence complete closeout modified closeout after missing expected evidence manifest"
    tampered_returned_handoff_checklist_dir="$tmp_dir/returned-handoff-tampered-checklist"
    cp -a "$complete_failed_handoff_bundle" "$tampered_returned_handoff_checklist_dir"
    cp "$returned_ok_dir/production-firewall-policy.json" "$tampered_returned_handoff_checklist_dir/returned-evidence/production-firewall-policy.json"
    cp "$returned_ok_dir/production-dns-readiness.json" "$tampered_returned_handoff_checklist_dir/returned-evidence/production-dns-readiness.json"
    cp "$returned_ok_dir/production-dns-delegation.json" "$tampered_returned_handoff_checklist_dir/returned-evidence/production-dns-delegation.json"
    cp "$returned_ok_dir/production-exposure-live.json" "$tampered_returned_handoff_checklist_dir/returned-evidence/production-exposure-live.json"
    jq 'del(.checklist[] | select(.source == "live-evidence"))' \
        "$complete_failed_handoff_bundle/operator-checklist.json" \
        >"$tampered_returned_handoff_checklist_dir/operator-checklist.json"
    (
        cd "$tampered_returned_handoff_checklist_dir"
        find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
    )
    returned_handoff_tampered_checklist_closeout_before="$(sha256sum "$tmp_dir/closeout.returned-handoff-tampered-checklist.fixture.md" | awk '{print $1}')"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.returned-handoff-tampered-checklist.fixture.md" \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-handoff-tampered-checklist-release" \
        "$RETURNED_HANDOFF_COMPLETE_SCRIPT" "$tampered_returned_handoff_checklist_dir" >/dev/null 2>&1; then
        fail "returned handoff bundle closeout accepted tampered operator checklist"
    fi
    returned_handoff_tampered_checklist_closeout_after="$(sha256sum "$tmp_dir/closeout.returned-handoff-tampered-checklist.fixture.md" | awk '{print $1}')"
    [[ "$returned_handoff_tampered_checklist_closeout_before" == "$returned_handoff_tampered_checklist_closeout_after" ]] ||
        fail "returned handoff bundle closeout modified closeout after tampered operator checklist"
    returned_direct_parent_tampered_checklist_closeout_before="$(sha256sum "$tmp_dir/closeout.returned-direct-parent-tampered-checklist.fixture.md" | awk '{print $1}')"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.returned-direct-parent-tampered-checklist.fixture.md" \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-direct-parent-tampered-checklist-release" \
        "$RETURNED_COMPLETE_SCRIPT" "$tampered_returned_handoff_checklist_dir/returned-evidence" >/dev/null 2>&1; then
        fail "returned evidence direct closeout accepted tampered parent handoff bundle"
    fi
    returned_direct_parent_tampered_checklist_closeout_after="$(sha256sum "$tmp_dir/closeout.returned-direct-parent-tampered-checklist.fixture.md" | awk '{print $1}')"
    [[ "$returned_direct_parent_tampered_checklist_closeout_before" == "$returned_direct_parent_tampered_checklist_closeout_after" ]] ||
        fail "returned evidence direct closeout modified closeout after tampered parent handoff bundle"
}

test_returned_handoff_success() {
    returned_handoff_dir="$tmp_dir/returned-handoff-dir"
    mkdir -p "$returned_handoff_dir/returned-evidence"
    cp "$returned_ok_dir/production-firewall-policy.json" "$returned_handoff_dir/returned-evidence/production-firewall-policy.json"
    cp "$returned_ok_dir/production-dns-readiness.json" "$returned_handoff_dir/returned-evidence/production-dns-readiness.json"
    cp "$returned_ok_dir/production-dns-delegation.json" "$returned_handoff_dir/returned-evidence/production-dns-delegation.json"
    cp "$returned_ok_dir/production-exposure-live.json" "$returned_handoff_dir/returned-evidence/production-exposure-live.json"
    cp "$returned_ok_dir/expected-evidence-manifest.json" "$returned_handoff_dir/returned-evidence/expected-evidence-manifest.json"
    FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-handoff-dir-release" \
        "$RETURNED_HANDOFF_COMPLETE_SCRIPT" "$returned_handoff_dir" >/dev/null
    jq -e '.status == "ok" and (.blockers | length) == 0' "$returned_handoff_dir/returned-evidence/production-exposure-status.json" >/dev/null ||
        fail "returned handoff directory closeout did not preserve ok status"
    returned_handoff_tar_source="$tmp_dir/returned-handoff-tar-source"
    mkdir -p "$returned_handoff_tar_source/returned-evidence"
    cp "$returned_ok_dir/production-firewall-policy.json" "$returned_handoff_tar_source/returned-evidence/production-firewall-policy.json"
    cp "$returned_ok_dir/production-dns-readiness.json" "$returned_handoff_tar_source/returned-evidence/production-dns-readiness.json"
    cp "$returned_ok_dir/production-dns-delegation.json" "$returned_handoff_tar_source/returned-evidence/production-dns-delegation.json"
    cp "$returned_ok_dir/production-exposure-live.json" "$returned_handoff_tar_source/returned-evidence/production-exposure-live.json"
    cp "$returned_ok_dir/expected-evidence-manifest.json" "$returned_handoff_tar_source/returned-evidence/expected-evidence-manifest.json"
    returned_handoff_tar="$tmp_dir/returned-handoff.tar.gz"
    tar -czf "$returned_handoff_tar" -C "$(dirname "$returned_handoff_tar_source")" "$(basename "$returned_handoff_tar_source")"
    (
        cd "$(dirname "$returned_handoff_tar")"
        sha256sum "$(basename "$returned_handoff_tar")" >"$(basename "$returned_handoff_tar").sha256"
    )
    FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-handoff-tar-release" \
        "$RETURNED_HANDOFF_COMPLETE_SCRIPT" "$returned_handoff_tar" >/dev/null
    jq -e '.evidenceSummary.externalExposure.valid == true and .evidenceSummary.externalExposure.request.currentStatus == "ok"' "$tmp_dir/returned-handoff-tar-release/manifest.json" >/dev/null ||
        fail "returned handoff tarball closeout did not write ok release manifest"
}

test_returned_handoff_archive_safety() {
    returned_handoff_blocked_tar_source="$tmp_dir/returned-handoff-blocked-tar-source"
    mkdir -p "$returned_handoff_blocked_tar_source/returned-evidence"
    cp "$returned_ok_dir/production-firewall-policy.json" "$returned_handoff_blocked_tar_source/returned-evidence/production-firewall-policy.json"
    cp "$returned_ok_dir/production-dns-readiness.json" "$returned_handoff_blocked_tar_source/returned-evidence/production-dns-readiness.json"
    cp "$returned_ok_dir/production-dns-delegation.json" "$returned_handoff_blocked_tar_source/returned-evidence/production-dns-delegation.json"
    cp "$tmp_dir/failed-dns.json" "$returned_handoff_blocked_tar_source/returned-evidence/production-exposure-live.json"
    cp "$returned_ok_dir/expected-evidence-manifest.json" "$returned_handoff_blocked_tar_source/returned-evidence/expected-evidence-manifest.json"
    returned_handoff_blocked_tar="$tmp_dir/returned-handoff-blocked.tar.gz"
    tar -czf "$returned_handoff_blocked_tar" -C "$(dirname "$returned_handoff_blocked_tar_source")" "$(basename "$returned_handoff_blocked_tar_source")"
    (
        cd "$(dirname "$returned_handoff_blocked_tar")"
        sha256sum "$(basename "$returned_handoff_blocked_tar")" >"$(basename "$returned_handoff_blocked_tar").sha256"
    )
    returned_handoff_blocked_closeout_before="$(sha256sum "$tmp_dir/closeout.returned-handoff-blocked-tar.fixture.md" | awk '{print $1}')"
    returned_handoff_preserve_root="$tmp_dir/returned-handoff-preserved"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.returned-handoff-blocked-tar.fixture.md" \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-handoff-blocked-tar-release" \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_HANDOFF_PRESERVE_ROOT="$returned_handoff_preserve_root" \
        "$RETURNED_HANDOFF_COMPLETE_SCRIPT" "$returned_handoff_blocked_tar" >/dev/null 2>&1; then
        fail "returned handoff tarball closeout accepted blocked returned evidence"
    fi
    returned_handoff_blocked_closeout_after="$(sha256sum "$tmp_dir/closeout.returned-handoff-blocked-tar.fixture.md" | awk '{print $1}')"
    [[ "$returned_handoff_blocked_closeout_before" == "$returned_handoff_blocked_closeout_after" ]] ||
        fail "returned handoff tarball closeout modified closeout after blocked returned evidence"
    mapfile -t preserved_handoff_dirs < <(find "$returned_handoff_preserve_root" -mindepth 1 -maxdepth 1 -type d | sort)
    ((${#preserved_handoff_dirs[@]} == 1)) ||
        fail "returned handoff tarball closeout did not preserve exactly one extracted evidence directory"
    jq -e '.status == "blocked" and any(.blockers[]?; .source == "live-evidence")' "${preserved_handoff_dirs[0]}/returned-evidence/production-exposure-status.json" >/dev/null ||
        fail "returned handoff tarball closeout did not preserve blocked status evidence"
    returned_handoff_symlink_tar_source="$tmp_dir/returned-handoff-symlink-tar-source"
    mkdir -p "$returned_handoff_symlink_tar_source"
    ln -s "$returned_ok_dir" "$returned_handoff_symlink_tar_source/returned-evidence"
    returned_handoff_symlink_tar="$tmp_dir/returned-handoff-symlink.tar.gz"
    tar -czf "$returned_handoff_symlink_tar" -C "$(dirname "$returned_handoff_symlink_tar_source")" "$(basename "$returned_handoff_symlink_tar_source")"
    (
        cd "$(dirname "$returned_handoff_symlink_tar")"
        sha256sum "$(basename "$returned_handoff_symlink_tar")" >"$(basename "$returned_handoff_symlink_tar").sha256"
    )
    returned_handoff_symlink_closeout_before="$(sha256sum "$tmp_dir/closeout.returned-handoff-symlink-tar.fixture.md" | awk '{print $1}')"
    returned_handoff_symlink_preserve_root="$tmp_dir/returned-handoff-symlink-preserved"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.returned-handoff-symlink-tar.fixture.md" \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-handoff-symlink-tar-release" \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_HANDOFF_PRESERVE_ROOT="$returned_handoff_symlink_preserve_root" \
        "$RETURNED_HANDOFF_COMPLETE_SCRIPT" "$returned_handoff_symlink_tar" >/dev/null 2>&1; then
        fail "returned handoff tarball closeout accepted symlinked returned-evidence"
    fi
    returned_handoff_symlink_closeout_after="$(sha256sum "$tmp_dir/closeout.returned-handoff-symlink-tar.fixture.md" | awk '{print $1}')"
    [[ "$returned_handoff_symlink_closeout_before" == "$returned_handoff_symlink_closeout_after" ]] ||
        fail "returned handoff tarball closeout modified closeout after symlinked returned-evidence"
    if [[ -d "$returned_handoff_symlink_preserve_root" ]] &&
        find "$returned_handoff_symlink_preserve_root" -mindepth 1 -print -quit | grep -q .; then
        fail "returned handoff tarball closeout extracted unsupported symlink archive member before failing"
    fi
    returned_handoff_path_traversal_tar_source="$tmp_dir/returned-handoff-path-traversal-tar-source"
    mkdir -p "$returned_handoff_path_traversal_tar_source/returned-evidence"
    cp "$returned_ok_dir/expected-evidence-manifest.json" "$returned_handoff_path_traversal_tar_source/returned-evidence/expected-evidence-manifest.json"
    returned_handoff_path_traversal_tar="$tmp_dir/returned-handoff-path-traversal.tar.gz"
    tar -czf "$returned_handoff_path_traversal_tar" \
        -C "$returned_handoff_path_traversal_tar_source" \
        --transform='s,^,../,' \
        returned-evidence
    (
        cd "$(dirname "$returned_handoff_path_traversal_tar")"
        sha256sum "$(basename "$returned_handoff_path_traversal_tar")" >"$(basename "$returned_handoff_path_traversal_tar").sha256"
    )
    returned_handoff_path_traversal_closeout_before="$(sha256sum "$tmp_dir/closeout.returned-handoff-path-traversal-tar.fixture.md" | awk '{print $1}')"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.returned-handoff-path-traversal-tar.fixture.md" \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-handoff-path-traversal-release" \
        "$RETURNED_HANDOFF_COMPLETE_SCRIPT" "$returned_handoff_path_traversal_tar" >/dev/null 2>&1; then
        fail "returned handoff tarball closeout accepted archive path traversal member"
    fi
    returned_handoff_path_traversal_closeout_after="$(sha256sum "$tmp_dir/closeout.returned-handoff-path-traversal-tar.fixture.md" | awk '{print $1}')"
    [[ "$returned_handoff_path_traversal_closeout_before" == "$returned_handoff_path_traversal_closeout_after" ]] ||
        fail "returned handoff tarball closeout modified closeout after archive path traversal member"
}

test_returned_contract_drift() {
    returned_narrow_request_dir="$tmp_dir/returned-narrow-request"
    mkdir -p "$returned_narrow_request_dir"
    cp "$tmp_dir/firewall-ok.json" "$returned_narrow_request_dir/production-firewall-policy.json"
    cp "$tmp_dir/dns-readiness-ok.json" "$returned_narrow_request_dir/production-dns-readiness.json"
    cp "$tmp_dir/dns-delegation-ok.json" "$returned_narrow_request_dir/production-dns-delegation.json"
    cp "$tmp_dir/ok.json" "$returned_narrow_request_dir/production-exposure-live.json"
    cat >"$returned_narrow_request_dir/production-exposure-evidence-request.json" <<'JSON'
{
  "status": "awaiting-external-evidence",
  "requiredHosts": ["fsus.blog"],
  "delegationDomains": ["fsus.blog"]
}
JSON
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-narrow-request-release" \
        "$RETURNED_EVIDENCE_SCRIPT" "$returned_narrow_request_dir" >/dev/null 2>&1; then
        fail "returned evidence verifier accepted a narrowed returned request scope"
    fi
    returned_narrow_closeout_before="$(sha256sum "$tmp_dir/closeout.returned-narrow-request.fixture.md" | awk '{print $1}')"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.returned-narrow-request.fixture.md" \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-narrow-request-closeout-release" \
        "$RETURNED_COMPLETE_SCRIPT" "$returned_narrow_request_dir" >/dev/null 2>&1; then
        fail "returned evidence complete closeout accepted a narrowed returned request scope"
    fi
    returned_narrow_closeout_after="$(sha256sum "$tmp_dir/closeout.returned-narrow-request.fixture.md" | awk '{print $1}')"
    [[ "$returned_narrow_closeout_before" == "$returned_narrow_closeout_after" ]] ||
        fail "returned evidence complete closeout modified closeout after narrowed returned request"
    returned_narrow_manifest_dir="$tmp_dir/returned-narrow-manifest"
    mkdir -p "$returned_narrow_manifest_dir"
    cp "$tmp_dir/firewall-ok.json" "$returned_narrow_manifest_dir/production-firewall-policy.json"
    cp "$tmp_dir/dns-readiness-ok.json" "$returned_narrow_manifest_dir/production-dns-readiness.json"
    cp "$tmp_dir/dns-delegation-ok.json" "$returned_narrow_manifest_dir/production-dns-delegation.json"
    cp "$tmp_dir/ok.json" "$returned_narrow_manifest_dir/production-exposure-live.json"
    jq '.requiredHosts = ["fsus.blog"]' "$returned_ok_dir/expected-evidence-manifest.json" >"$returned_narrow_manifest_dir/expected-evidence-manifest.json"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-narrow-manifest-release" \
        "$RETURNED_EVIDENCE_SCRIPT" "$returned_narrow_manifest_dir" >/dev/null 2>&1; then
        fail "returned evidence verifier accepted a narrowed expected evidence manifest"
    fi
    returned_narrow_manifest_closeout_before="$(sha256sum "$tmp_dir/closeout.returned-narrow-manifest.fixture.md" | awk '{print $1}')"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.returned-narrow-manifest.fixture.md" \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-narrow-manifest-closeout-release" \
        "$RETURNED_COMPLETE_SCRIPT" "$returned_narrow_manifest_dir" >/dev/null 2>&1; then
        fail "returned evidence complete closeout accepted a narrowed expected evidence manifest"
    fi
    returned_narrow_manifest_closeout_after="$(sha256sum "$tmp_dir/closeout.returned-narrow-manifest.fixture.md" | awk '{print $1}')"
    [[ "$returned_narrow_manifest_closeout_before" == "$returned_narrow_manifest_closeout_after" ]] ||
        fail "returned evidence complete closeout modified closeout after narrowed expected evidence manifest"
    returned_unblock_plan_drift_dir="$tmp_dir/returned-unblock-plan-drift"
    cp -a "$returned_ok_dir" "$returned_unblock_plan_drift_dir"
    jq 'del(.unblockPlan[] | select(.source == "live-evidence"))' \
        "$returned_ok_dir/expected-evidence-manifest.json" \
        >"$returned_unblock_plan_drift_dir/expected-evidence-manifest.json"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-unblock-plan-drift-release" \
        "$RETURNED_EVIDENCE_SCRIPT" "$returned_unblock_plan_drift_dir" >/dev/null 2>&1; then
        fail "returned evidence verifier accepted expected manifest unblockPlan drift"
    fi
    returned_unblock_plan_closeout_before="$(sha256sum "$tmp_dir/closeout.returned-unblock-plan.fixture.md" | awk '{print $1}')"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.returned-unblock-plan.fixture.md" \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-unblock-plan-closeout-release" \
        "$RETURNED_COMPLETE_SCRIPT" "$returned_unblock_plan_drift_dir" >/dev/null 2>&1; then
        fail "returned evidence complete closeout accepted expected manifest unblockPlan drift"
    fi
    returned_unblock_plan_closeout_after="$(sha256sum "$tmp_dir/closeout.returned-unblock-plan.fixture.md" | awk '{print $1}')"
    [[ "$returned_unblock_plan_closeout_before" == "$returned_unblock_plan_closeout_after" ]] ||
        fail "returned evidence complete closeout modified closeout after expected manifest unblockPlan drift"
    returned_unblock_plan_file_drift_dir="$tmp_dir/returned-unblock-plan-file-drift"
    cp -a "$returned_ok_dir" "$returned_unblock_plan_file_drift_dir"
    jq '(.unblockPlan[] | select(.source == "live-evidence") | .evidenceFiles) = ["wrong-production-exposure-live.json"]' \
        "$returned_ok_dir/expected-evidence-manifest.json" \
        >"$returned_unblock_plan_file_drift_dir/expected-evidence-manifest.json"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-unblock-plan-file-drift-release" \
        "$RETURNED_EVIDENCE_SCRIPT" "$returned_unblock_plan_file_drift_dir" >/dev/null 2>&1; then
        fail "returned evidence verifier accepted expected manifest unblockPlan evidenceFiles drift"
    fi
    returned_unblock_plan_file_closeout_before="$(sha256sum "$tmp_dir/closeout.returned-unblock-plan.fixture.md" | awk '{print $1}')"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.returned-unblock-plan.fixture.md" \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-unblock-plan-file-closeout-release" \
        "$RETURNED_COMPLETE_SCRIPT" "$returned_unblock_plan_file_drift_dir" >/dev/null 2>&1; then
        fail "returned evidence complete closeout accepted expected manifest unblockPlan evidenceFiles drift"
    fi
    returned_unblock_plan_file_closeout_after="$(sha256sum "$tmp_dir/closeout.returned-unblock-plan.fixture.md" | awk '{print $1}')"
    [[ "$returned_unblock_plan_file_closeout_before" == "$returned_unblock_plan_file_closeout_after" ]] ||
        fail "returned evidence complete closeout modified closeout after expected manifest unblockPlan evidenceFiles drift"
    returned_unblock_plan_command_drift_dir="$tmp_dir/returned-unblock-plan-command-drift"
    cp -a "$returned_ok_dir" "$returned_unblock_plan_command_drift_dir"
    jq '(.unblockPlan[] | select(.source == "firewall-policy") | .commands) = ["tools/security/check-production-exposure-live.sh"]' \
        "$returned_ok_dir/expected-evidence-manifest.json" \
        >"$returned_unblock_plan_command_drift_dir/expected-evidence-manifest.json"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-unblock-plan-command-drift-release" \
        "$RETURNED_EVIDENCE_SCRIPT" "$returned_unblock_plan_command_drift_dir" >/dev/null 2>&1; then
        fail "returned evidence verifier accepted expected manifest unblockPlan command drift"
    fi
    returned_unblock_plan_command_closeout_before="$(sha256sum "$tmp_dir/closeout.returned-unblock-plan.fixture.md" | awk '{print $1}')"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.returned-unblock-plan.fixture.md" \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-unblock-plan-command-closeout-release" \
        "$RETURNED_COMPLETE_SCRIPT" "$returned_unblock_plan_command_drift_dir" >/dev/null 2>&1; then
        fail "returned evidence complete closeout accepted expected manifest unblockPlan command drift"
    fi
    returned_unblock_plan_command_closeout_after="$(sha256sum "$tmp_dir/closeout.returned-unblock-plan.fixture.md" | awk '{print $1}')"
    [[ "$returned_unblock_plan_command_closeout_before" == "$returned_unblock_plan_command_closeout_after" ]] ||
        fail "returned evidence complete closeout modified closeout after expected manifest unblockPlan command drift"
    returned_manifest_source_drift_dir="$tmp_dir/returned-manifest-source-drift"
    cp -a "$returned_ok_dir" "$returned_manifest_source_drift_dir"
    jq 'del(.sourceRequestSha256)' \
        "$returned_ok_dir/expected-evidence-manifest.json" \
        >"$returned_manifest_source_drift_dir/expected-evidence-manifest.json"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-manifest-source-drift-release" \
        "$RETURNED_EVIDENCE_SCRIPT" "$returned_manifest_source_drift_dir" >/dev/null 2>&1; then
        fail "returned evidence verifier accepted expected manifest source metadata drift"
    fi
    returned_manifest_source_closeout_before="$(sha256sum "$tmp_dir/closeout.returned-unblock-plan.fixture.md" | awk '{print $1}')"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.returned-unblock-plan.fixture.md" \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-manifest-source-closeout-release" \
        "$RETURNED_COMPLETE_SCRIPT" "$returned_manifest_source_drift_dir" >/dev/null 2>&1; then
        fail "returned evidence complete closeout accepted expected manifest source metadata drift"
    fi
    returned_manifest_source_closeout_after="$(sha256sum "$tmp_dir/closeout.returned-unblock-plan.fixture.md" | awk '{print $1}')"
    [[ "$returned_manifest_source_closeout_before" == "$returned_manifest_source_closeout_after" ]] ||
        fail "returned evidence complete closeout modified closeout after expected manifest source metadata drift"
}

test_returned_status_and_complete() {
    returned_blocked_dir="$tmp_dir/returned-blocked"
    mkdir -p "$returned_blocked_dir"
    cp "$tmp_dir/firewall-ok.json" "$returned_blocked_dir/production-firewall-policy.json"
    cp "$tmp_dir/dns-readiness-ok.json" "$returned_blocked_dir/production-dns-readiness.json"
    cp "$tmp_dir/dns-delegation-ok.json" "$returned_blocked_dir/production-dns-delegation.json"
    cp "$tmp_dir/failed-dns.json" "$returned_blocked_dir/production-exposure-live.json"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-blocked-release" \
        "$RETURNED_EVIDENCE_SCRIPT" "$returned_blocked_dir" >/dev/null 2>&1; then
        fail "returned evidence verifier accepted blocked live evidence"
    fi
    jq -e '.status == "blocked" and any(.blockers[]?; .source == "live-evidence")' "$returned_blocked_dir/production-exposure-status.json" >/dev/null ||
        fail "returned evidence verifier did not preserve blocked status"
    jq -e '.evidenceSummary.externalExposure.valid == false and .evidenceSummary.externalExposure.request.currentStatus == "blocked" and any(.evidenceSummary.externalExposure.blockers[]?; .source == "live-evidence")' "$tmp_dir/returned-blocked-release/manifest.json" >/dev/null ||
        fail "returned evidence verifier did not preserve blocked manifest"
    returned_complete_ok_dir="$tmp_dir/returned-complete-ok"
    cp -a "$returned_ok_dir" "$returned_complete_ok_dir"
    FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-complete-release" \
        "$RETURNED_COMPLETE_SCRIPT" "$returned_complete_ok_dir" >/dev/null
    jq -e '.status == "ok" and (.blockers | length) == 0' "$returned_complete_ok_dir/production-exposure-status.json" >/dev/null ||
        fail "returned evidence complete closeout did not preserve ok status"
    returned_blocked_closeout_before="$(sha256sum "$tmp_dir/closeout.returned-blocked.fixture.md" | awk '{print $1}')"
    if FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.returned-blocked.fixture.md" \
        FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR="$tmp_dir/returned-blocked-closeout-release" \
        "$RETURNED_COMPLETE_SCRIPT" "$returned_blocked_dir" >/dev/null 2>&1; then
        fail "returned evidence complete closeout accepted blocked returned evidence"
    fi
    returned_blocked_closeout_after="$(sha256sum "$tmp_dir/closeout.returned-blocked.fixture.md" | awk '{print $1}')"
    [[ "$returned_blocked_closeout_before" == "$returned_blocked_closeout_after" ]] ||
        fail "returned evidence complete closeout modified closeout after blocked returned evidence"
}

test_handoff_manifest_drift() {
    complete_failed_request_digest_mismatch="$tmp_dir/complete-failed-request-digest-mismatch.json"
    jq '.artifactDigests.productionExposureRequest.value = "0000000000000000000000000000000000000000000000000000000000000000"' "$complete_failed_manifest" >"$complete_failed_request_digest_mismatch"
    if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        "$HANDOFF_SCRIPT" "$complete_failed_request_digest_mismatch" >/dev/null 2>&1; then
        fail "handoff check accepted request artifact digest drift"
    fi
    complete_failed_status_digest_mismatch="$tmp_dir/complete-failed-status-digest-mismatch.json"
    jq '.artifactDigests.productionExposureStatus.value = "0000000000000000000000000000000000000000000000000000000000000000"' "$complete_failed_manifest" >"$complete_failed_status_digest_mismatch"
    if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        "$HANDOFF_SCRIPT" "$complete_failed_status_digest_mismatch" >/dev/null 2>&1; then
        fail "handoff check accepted status artifact digest drift"
    fi
    complete_failed_bundle_drift_dir="$tmp_dir/complete-failed-bundle-drift"
    mkdir -p "$complete_failed_bundle_drift_dir"
    cp "$complete_failed_manifest" "$complete_failed_bundle_drift_dir/manifest.json"
    cp "$complete_failed_request" "$complete_failed_bundle_drift_dir/production-exposure-evidence-request.json"
    cp "$tmp_dir/failed-dns.json" "$complete_failed_bundle_drift_dir/production-exposure-live.json"
    cp "$tmp_dir/firewall-ok.json" "$complete_failed_bundle_drift_dir/production-firewall-policy.json"
    cp "$tmp_dir/dns-readiness-ok.json" "$complete_failed_bundle_drift_dir/production-dns-readiness.json"
    cp "$tmp_dir/dns-delegation-ok.json" "$complete_failed_bundle_drift_dir/production-dns-delegation.json"
    jq '.status = "ok"' "$complete_failed_status" >"$complete_failed_bundle_drift_dir/production-exposure-status.json"
    if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        "$HANDOFF_SCRIPT" "$complete_failed_bundle_drift_dir/manifest.json" >/dev/null 2>&1; then
        fail "handoff check accepted release bundle status drift"
    fi
    complete_failed_artifact_path_mismatch="$tmp_dir/complete-failed-artifact-path-mismatch.json"
    jq '.artifacts.productionExposureLive = "../production-exposure-live.json"' "$complete_failed_manifest" >"$complete_failed_artifact_path_mismatch"
    if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        "$HANDOFF_SCRIPT" "$complete_failed_artifact_path_mismatch" >/dev/null 2>&1; then
        fail "handoff check accepted nonstandard release bundle artifact path"
    fi
    complete_failed_missing_firewall_manifest="$tmp_dir/complete-failed-missing-firewall-manifest.json"
    jq '.artifacts.firewallPolicy = null | .artifactDigests.firewallPolicy = {algorithm: "sha256", value: "0000000000000000000000000000000000000000000000000000000000000000"}' "$complete_failed_manifest" >"$complete_failed_missing_firewall_manifest"
    if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/missing-firewall-policy-for-handoff.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        "$HANDOFF_SCRIPT" "$complete_failed_missing_firewall_manifest" >/dev/null 2>&1; then
        fail "handoff check accepted digest for missing firewall policy artifact"
    fi
    complete_failed_manifest_mismatch="$tmp_dir/complete-failed-manifest-mismatch.json"
    jq '.evidenceSummary.externalExposure.request.requiredHosts = ["other.example"]' "$complete_failed_manifest" >"$complete_failed_manifest_mismatch"
    if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        "$HANDOFF_SCRIPT" "$complete_failed_manifest_mismatch" >/dev/null 2>&1; then
        fail "handoff check accepted manifest request host drift"
    fi
    complete_failed_manifest_request_contract_mismatch="$tmp_dir/complete-failed-manifest-request-contract-mismatch.json"
    jq '.evidenceSummary.externalExposure.request.firewallSourceSha256Required = false | .evidenceSummary.externalExposure.request.rawSourceSha256Required = false' "$complete_failed_manifest" >"$complete_failed_manifest_request_contract_mismatch"
    if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        "$HANDOFF_SCRIPT" "$complete_failed_manifest_request_contract_mismatch" >/dev/null 2>&1; then
        fail "handoff check accepted manifest request firewall source sha256 contract drift"
    fi
    complete_failed_manifest_command_mismatch="$tmp_dir/complete-failed-manifest-command-mismatch.json"
    jq '.evidenceSummary.externalExposure.request.returnedCloseoutCommandCount = 0 | .evidenceSummary.externalExposure.request.closeoutCommands.returnedHandoffCloseout = "stale"' "$complete_failed_manifest" >"$complete_failed_manifest_command_mismatch"
    if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        "$HANDOFF_SCRIPT" "$complete_failed_manifest_command_mismatch" >/dev/null 2>&1; then
        fail "handoff check accepted manifest request returned closeout command drift"
    fi
    complete_failed_manifest_unblock_plan_mismatch="$tmp_dir/complete-failed-manifest-unblock-plan-mismatch.json"
    jq '.evidenceSummary.externalExposure.request.unblockPlanSources = [] | .evidenceSummary.externalExposure.request.unblockPlanCount = 0' "$complete_failed_manifest" >"$complete_failed_manifest_unblock_plan_mismatch"
    if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        "$HANDOFF_SCRIPT" "$complete_failed_manifest_unblock_plan_mismatch" >/dev/null 2>&1; then
        fail "handoff check accepted manifest request unblock plan drift"
    fi
    complete_failed_manifest_blocker_mismatch="$tmp_dir/complete-failed-manifest-blocker-mismatch.json"
    jq '.evidenceSummary.externalExposure.blockers[0].message = "stale manifest blocker"' "$complete_failed_manifest" >"$complete_failed_manifest_blocker_mismatch"
    if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        "$HANDOFF_SCRIPT" "$complete_failed_manifest_blocker_mismatch" >/dev/null 2>&1; then
        fail "handoff check accepted manifest blocker detail drift"
    fi
    complete_failed_manifest_valid_mismatch="$tmp_dir/complete-failed-manifest-valid-mismatch.json"
    jq '.evidenceSummary.externalExposure.valid = true' "$complete_failed_manifest" >"$complete_failed_manifest_valid_mismatch"
    if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        "$HANDOFF_SCRIPT" "$complete_failed_manifest_valid_mismatch" >/dev/null 2>&1; then
        fail "handoff check accepted manifest external exposure validity drift"
    fi
    complete_failed_manifest_component_mismatch="$tmp_dir/complete-failed-manifest-component-mismatch.json"
    jq '.evidenceSummary.externalExposure.liveExposure = "ok"' "$complete_failed_manifest" >"$complete_failed_manifest_component_mismatch"
    if FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$complete_failed_request" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_failed_status" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/failed-dns.json" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
        "$HANDOFF_SCRIPT" "$complete_failed_manifest_component_mismatch" >/dev/null 2>&1; then
        fail "handoff check accepted manifest external exposure component status drift"
    fi
    jq -e '.status == "blocked" and any(.blockers[]?; .source == "live-evidence")' "$complete_failed_status" >/dev/null ||
        fail "complete closeout failure status did not record live-evidence blocker"
}

test_complete_closeout_flows() {
    complete_refresh_before="$(sha256sum "$tmp_dir/closeout.complete-refresh-after-delegation-failure.fixture.md" | awk '{print $1}')"
    complete_refresh_status="$tmp_dir/complete-refresh-after-delegation-failure-status.json"
    complete_refresh_readiness="$tmp_dir/complete-refresh-after-delegation-failure-readiness.json"
    complete_refresh_delegation="$tmp_dir/complete-refresh-after-delegation-failure-delegation.json"
    complete_refresh_live="$tmp_dir/complete-refresh-after-delegation-failure-live.json"
    if FSUSBLOG_SKIP_PRODUCTION_NETWORK_BASELINE=1 \
        FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_DNS_DELEGATION_FIXTURE="$tmp_dir/dns-delegation-failed.tsv" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$complete_refresh_delegation" \
        FSUSBLOG_DNS_READINESS_FIXTURE="$tmp_dir/dns-public-ok.tsv" \
        FSUSBLOG_DNS_READINESS_LOCAL_FIXTURE="$tmp_dir/dns-local-ok.tsv" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$complete_refresh_readiness" \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$complete_refresh_live" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$complete_refresh_status" \
        FSUSBLOG_LIVE_TARGETS=fsus.blog=127.0.0.1,www.fsus.blog=127.0.0.1 \
        FSUSBLOG_LIVE_CONNECT_TIMEOUT=1 \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.complete-refresh-after-delegation-failure.fixture.md" \
        "$COMPLETE_SCRIPT" >/dev/null 2>&1; then
        fail "complete closeout unexpectedly accepted failed DNS delegation while refreshing later evidence"
    fi
    complete_refresh_after="$(sha256sum "$tmp_dir/closeout.complete-refresh-after-delegation-failure.fixture.md" | awk '{print $1}')"
    [[ "$complete_refresh_before" == "$complete_refresh_after" ]] || fail "complete closeout modified closeout fixture while refreshing failed evidence"
    jq -e '.requiredHosts == "fsus.blog www.fsus.blog" and any(.results[]?; .check == "dns" and .status == "ok")' "$complete_refresh_readiness" >/dev/null ||
        fail "complete closeout did not refresh DNS readiness after DNS delegation failure"
    jq -e '.requiredHosts == "fsus.blog www.fsus.blog" and any(.results[]?; .check == "tcp/80")' "$complete_refresh_live" >/dev/null ||
        fail "complete closeout did not refresh live evidence after DNS delegation failure"
    jq -e '.status == "blocked" and any(.blockers[]?; .source == "dns-delegation") and any(.blockers[]?; .source == "live-evidence")' "$complete_refresh_status" >/dev/null ||
        fail "complete closeout refreshed status did not include DNS delegation and live blockers"

    complete_missing_delegation_before="$(sha256sum "$tmp_dir/closeout.complete-missing-delegation.fixture.md" | awk '{print $1}')"
    if FSUSBLOG_SKIP_PRODUCTION_NETWORK_BASELINE=1 \
        FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_USE_EXISTING_PRODUCTION_EXPOSURE_EVIDENCE=1 \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/missing-dns-delegation.json" \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.complete-missing-delegation.fixture.md" \
        "$COMPLETE_SCRIPT" >/dev/null 2>&1; then
        fail "complete closeout unexpectedly accepted missing DNS delegation evidence"
    fi
    complete_missing_delegation_after="$(sha256sum "$tmp_dir/closeout.complete-missing-delegation.fixture.md" | awk '{print $1}')"
    [[ "$complete_missing_delegation_before" == "$complete_missing_delegation_after" ]] || fail "complete closeout modified closeout fixture after missing DNS delegation evidence"

    complete_missing_readiness_before="$(sha256sum "$tmp_dir/closeout.complete-missing-readiness.fixture.md" | awk '{print $1}')"
    if FSUSBLOG_SKIP_PRODUCTION_NETWORK_BASELINE=1 \
        FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_USE_EXISTING_PRODUCTION_EXPOSURE_EVIDENCE=1 \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/missing-dns-readiness.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_CLOSEOUT_FIXTURE_FILE="$tmp_dir/closeout.complete-missing-readiness.fixture.md" \
        "$COMPLETE_SCRIPT" >/dev/null 2>&1; then
        fail "complete closeout unexpectedly accepted missing DNS readiness evidence"
    fi
    complete_missing_readiness_after="$(sha256sum "$tmp_dir/closeout.complete-missing-readiness.fixture.md" | awk '{print $1}')"
    [[ "$complete_missing_readiness_before" == "$complete_missing_readiness_after" ]] || fail "complete closeout modified closeout fixture after missing DNS readiness evidence"

    FSUSBLOG_SKIP_PRODUCTION_NETWORK_BASELINE=1 \
        FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-ok.json" \
        FSUSBLOG_USE_EXISTING_PRODUCTION_EXPOSURE_EVIDENCE=1 \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$tmp_dir/complete-ok-status.json" \
        "$COMPLETE_SCRIPT" >/dev/null

    jq -e '.status == "ok" and (.blockers | length) == 0' "$tmp_dir/complete-ok-status.json" >/dev/null ||
        fail "complete closeout did not write ok status after valid evidence"

    FSUSBLOG_SKIP_PRODUCTION_NETWORK_BASELINE=1 \
        FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_CLOUD_FIREWALL_SOURCE="$tmp_dir/aws-security-groups-ok.json" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-complete-cloud.json" \
        FSUSBLOG_FIREWALL_SSH_SOURCE_TYPE=fixed-management-ip \
        FSUSBLOG_USE_EXISTING_PRODUCTION_EXPOSURE_EVIDENCE=1 \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$tmp_dir/complete-cloud-status.json" \
        "$COMPLETE_SCRIPT" >/dev/null

    jq -e '.status == "ok" and (.blockers | length) == 0' "$tmp_dir/complete-cloud-status.json" >/dev/null ||
        fail "complete closeout with cloud firewall source did not write ok status"

    FSUSBLOG_SKIP_PRODUCTION_NETWORK_BASELINE=1 \
        FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
        FSUSBLOG_COLLECT_HOST_FIREWALL_POLICY=1 \
        FSUSBLOG_UFW_STATUS_FILE="$tmp_dir/ufw-status-ok.txt" \
        FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$tmp_dir/firewall-complete-ufw.json" \
        FSUSBLOG_FIREWALL_SSH_SOURCE_TYPE=fixed-management-ip \
        FSUSBLOG_USE_EXISTING_PRODUCTION_EXPOSURE_EVIDENCE=1 \
        FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$tmp_dir/ok.json" \
        FSUSBLOG_DNS_READINESS_EVIDENCE="$tmp_dir/dns-readiness-ok.json" \
        FSUSBLOG_DNS_DELEGATION_EVIDENCE="$tmp_dir/dns-delegation-ok.json" \
        FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$tmp_dir/complete-ufw-status.json" \
        "$COMPLETE_SCRIPT" >/dev/null

    jq -e '.status == "ok" and (.blockers | length) == 0' "$tmp_dir/complete-ufw-status.json" >/dev/null ||
        fail "complete closeout with host firewall collector did not write ok status"
}

run_parallel_functions closeout-and-handoff \
    test_handoff_bundle_security \
    test_returned_evidence_rejections \
    test_returned_handoff_success \
    test_returned_handoff_archive_safety \
    test_returned_contract_drift \
    test_returned_status_and_complete \
    test_handoff_manifest_drift \
    test_complete_closeout_flows

printf '[production-exposure-tools-test] ok\n'
