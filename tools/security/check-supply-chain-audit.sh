#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLIENT_DIR="$ROOT_DIR/src/frontend"
OUT_DIR="${FSUSBLOG_SUPPLY_CHAIN_AUDIT_DIR:-$ROOT_DIR/.tmp/security/supply-chain}"
mkdir -p "$OUT_DIR"

if [[ -z "${GITHUB_PACKAGES_TOKEN:-}" ]] && command -v gh >/dev/null 2>&1; then
    GITHUB_PACKAGES_TOKEN="$(gh auth token 2>/dev/null || true)"
    export GITHUB_PACKAGES_TOKEN
fi

Log() {
    printf '[supply-chain] %s\n' "$1"
}

Fail() {
    printf '[supply-chain] error: %s\n' "$1" >&2
    exit 1
}

NUGET_OUT_DIR="$OUT_DIR/nuget"
rm -rf "$NUGET_OUT_DIR"
mkdir -p "$NUGET_OUT_DIR"

mapfile -d '' NUGET_PROJECTS < <(find "$ROOT_DIR" \
    -name '*.csproj' \
    ! -path '*/bin/*' \
    ! -path '*/obj/*' \
    ! -path '*/.tmp/*' \
    ! -path '*/tmp/*' \
    ! -path '*/release-evidence/*' \
    -print0 | sort -z)

if [[ "${#NUGET_PROJECTS[@]}" -eq 0 ]]; then
    Fail "no PackageReference .csproj files found for NuGet audit"
fi

CheckDependencyLocks() {
    Log "check dependency lock files"
    local -a missing=()
    if [[ ! -f "$CLIENT_DIR/package-lock.json" ]]; then
        missing+=("src/frontend/package-lock.json is required for npm dependency integrity")
    fi

    local project lockFile
    for project in "${NUGET_PROJECTS[@]}"; do
        lockFile="$(dirname "$project")/packages.lock.json"
        if [[ ! -f "$lockFile" ]]; then
            missing+=("${lockFile#$ROOT_DIR/} is required for NuGet dependency integrity")
        fi
    done

    if ((${#missing[@]} > 0)); then
        printf '[supply-chain] lock-file violation: %s\n' "${missing[@]}" >&2
        return 1
    fi
}

CheckDependencyDocs() {
    Log "check documented security-sensitive backend dependencies"
    node - "$ROOT_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const csproj = fs.readFileSync(path.join(root, 'src/backend/FsusBlog.Server.csproj'), 'utf8');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'src/backend/packages.lock.json'), 'utf8'));

function fail(message) {
  console.error(`[supply-chain] dependency-docs violation: ${message}`);
  process.exit(1);
}

function packageVersionFromCsproj(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = csproj.match(new RegExp(`<PackageReference\\s+Include="${escaped}"\\s+Version="([^"]+)"\\s*/>`));
  return match?.[1] ?? null;
}

function packageVersionFromReadme(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = readme.match(new RegExp(`\\|\\s*${escaped}\\s*\\|\\s*([^|]+?)\\s*\\|`));
  return match?.[1]?.trim() ?? null;
}

for (const name of ['Fido2']) {
  const csprojVersion = packageVersionFromCsproj(name);
  const lockVersion = lock.dependencies?.['net10.0']?.[name]?.resolved;
  const readmeVersion = packageVersionFromReadme(name);
  if (!csprojVersion) fail(`${name} is missing from FsusBlog.Server.csproj`);
  if (!lockVersion) fail(`${name} is missing from src/backend/packages.lock.json`);
  if (!readmeVersion) fail(`${name} is missing from README dependency table`);
  if (readmeVersion !== csprojVersion || lockVersion !== csprojVersion) {
    fail(`${name} version drift README=${readmeVersion} csproj=${csprojVersion} lock=${lockVersion}`);
  }
}
NODE
}

RunNugetAudit() {
    Log "run NuGet vulnerable package audit (${#NUGET_PROJECTS[@]} projects in one solution evaluation)"
    local auditSolution="$OUT_DIR/.nuget-audit.slnx"
    local auditJson="$OUT_DIR/.nuget-audit.json"
    local auditStderr="$OUT_DIR/.nuget-audit.stderr"

    node - "$auditSolution" "${NUGET_PROJECTS[@]}" <<'NODE'
const fs = require('node:fs');
const solutionFile = process.argv[2];
const projects = process.argv.slice(3);
const escapeXml = value => value
  .replaceAll('&', '&amp;')
  .replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');
const body = projects.map(project => `  <Project Path="${escapeXml(project)}" />`).join('\n');
fs.writeFileSync(solutionFile, `<Solution>\n${body}\n</Solution>\n`);
NODE

    local dotnetStatus=0
    dotnet list "$auditSolution" package --vulnerable --include-transitive --format json --output-version 1 \
        >"$auditJson" 2>"$auditStderr" || dotnetStatus=$?

    local validationStatus=0
    node - "$ROOT_DIR" "$NUGET_OUT_DIR" "$auditJson" "$auditStderr" "$dotnetStatus" "${NUGET_PROJECTS[@]}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const dir = process.argv[3];
const auditFile = process.argv[4];
const stderrFile = process.argv[5];
const exitCode = Number(process.argv[6]);
const expectedProjects = process.argv.slice(7).map(value => path.resolve(value));
const blockers = [];
const problems = [];

let data;
try {
  data = JSON.parse(fs.readFileSync(auditFile, 'utf8'));
} catch (error) {
  const stderr = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, 'utf8').trim() : '';
  console.error(JSON.stringify({
    status: 'invalid',
    reason: 'dotnet audit did not produce valid JSON',
    exitCode,
    stderr
  }, null, 2));
  process.exit(1);
}

function collectPackages(packages, projectName, framework) {
  for (const item of packages ?? []) {
    for (const vulnerability of item.vulnerabilities ?? []) {
      const severity = String(vulnerability.severity ?? '').toLowerCase();
      if (severity === 'high' || severity === 'critical') {
        blockers.push({
          ecosystem: 'nuget',
          project: projectName,
          framework,
          package: item.id,
          resolvedVersion: item.resolvedVersion,
          severity,
          advisoryUrl: vulnerability.advisoryUrl ?? null
        });
      }
    }
  }
}

for (const problem of data.problems ?? []) problems.push(problem);

const actualProjects = (data.projects ?? []).map(project => path.resolve(project.path));
const actualSet = new Set(actualProjects);
const expectedSet = new Set(expectedProjects);
for (const project of expectedProjects) {
  if (!actualSet.has(project)) problems.push({ project, text: 'project missing from batched NuGet audit output' });
}
for (const project of actualProjects) {
  if (!expectedSet.has(project)) problems.push({ project, text: 'unexpected project in batched NuGet audit output' });
}

for (const project of data.projects ?? []) {
  const absoluteProject = path.resolve(project.path);
  const relativeProject = path.relative(root, absoluteProject).replaceAll(path.sep, '/');
  const safeName = relativeProject.replaceAll('/', '__');
  fs.writeFileSync(path.join(dir, `${safeName}.json`), `${JSON.stringify({
    version: data.version,
    parameters: data.parameters,
    sources: data.sources,
    projects: [project]
  }, null, 2)}\n`);
  for (const framework of project.frameworks ?? []) {
    collectPackages(framework.topLevelPackages, project.name ?? relativeProject, framework.framework);
    collectPackages(framework.transitivePackages, project.name ?? relativeProject, framework.framework);
  }
}

if (problems.length > 0) {
  console.error(JSON.stringify({ status: 'invalid', problems }, null, 2));
  process.exit(1);
}

if (exitCode !== 0) {
  const stderr = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, 'utf8').trim() : '';
  console.error(JSON.stringify({
    status: 'invalid',
    reason: 'dotnet audit exited non-zero without reported project problems',
    exitCode,
    stderr
  }, null, 2));
  process.exit(1);
}

if (blockers.length > 0) {
  console.error(JSON.stringify({ status: 'blocked', blockers }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: 'ok', blockers: [] }));
NODE
    validationStatus=$?
    rm -f "$auditSolution" "$auditJson"
    if ((validationStatus == 0)); then rm -f "$auditStderr"; fi
    return "$validationStatus"
}

RunNpmAudit() {
    Log "run npm production dependency audit"
    local npmStatus=0
    (
        cd "$CLIENT_DIR"
        npm audit --omit=dev --audit-level=high --json
    ) >"$OUT_DIR/npm-audit.json" 2>"$OUT_DIR/npm-audit.stderr" || npmStatus=$?

    local validationStatus=0
    node - "$OUT_DIR/npm-audit.json" "$OUT_DIR/npm-audit.stderr" "$npmStatus" <<'NODE'
const fs = require('node:fs');
const jsonFile = process.argv[2];
const stderrFile = process.argv[3];
const exitCode = Number(process.argv[4]);
let data;
try {
  data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
} catch (error) {
  const stderr = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, 'utf8').trim() : '';
  console.error(JSON.stringify({
    status: 'invalid',
    reason: 'npm audit did not produce valid JSON',
    exitCode,
    stderr
  }, null, 2));
  process.exit(1);
}

const counts = data.metadata?.vulnerabilities ?? {};
const high = Number(counts.high ?? 0);
const critical = Number(counts.critical ?? 0);
if (high > 0 || critical > 0) {
  const blockers = Object.entries(data.vulnerabilities ?? {})
    .filter(([, value]) => value.severity === 'high' || value.severity === 'critical')
    .map(([name, value]) => ({
      ecosystem: 'npm',
      package: name,
      severity: value.severity,
      via: value.via,
      range: value.range ?? null,
      fixAvailable: value.fixAvailable ?? null
    }));
  console.error(JSON.stringify({ status: 'blocked', high, critical, blockers }, null, 2));
  process.exit(1);
}

if (exitCode !== 0) {
  const stderr = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, 'utf8').trim() : '';
  console.error(JSON.stringify({
    status: 'invalid',
    reason: 'npm audit exited non-zero without high/critical vulnerability metadata',
    exitCode,
    stderr
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: 'ok', high, critical, blockers: [] }));
NODE
    validationStatus=$?
    return "$validationStatus"
}

ResolveAuditWorkers() {
    local jobCount="$1"
    FSUSBLOG_SUPPLY_CHAIN_JOB_COUNT="$jobCount" node <<'NODE'
const os = require('node:os');
const positive = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const firstPositive = values => values.find(value => value !== null) ?? 1;
const jobs = Math.max(1, Math.floor(positive(process.env.FSUSBLOG_SUPPLY_CHAIN_JOB_COUNT) ?? 1));
const cpu = firstPositive([
  positive(process.env.FSUSBLOG_STEP_CPU_BUDGET),
  positive(process.env.FSUSBLOG_BUNDLE_CPU_UNITS),
  positive(process.env.FSUSBLOG_BUNDLE_CPU_BUDGET),
  positive(os.availableParallelism?.()),
  positive(os.cpus().length)
]);
const memoryGiB = firstPositive([
  positive(process.env.FSUSBLOG_STEP_MEMORY_GIB),
  positive(process.env.FSUSBLOG_BUNDLE_MEMORY_GIB),
  positive(os.totalmem() / (1024 ** 3))
]);
// Vulnerability queries are network/IO heavy. Two jobs per granted CPU keeps
// both ecosystems busy while the memory-derived bound prevents oversubscription.
const cpuBound = Math.max(1, Math.floor(cpu * 2));
const memoryBound = Math.max(1, Math.floor(memoryGiB / 0.4));
process.stdout.write(String(Math.min(jobs, cpuBound, memoryBound)));
NODE
}

SUPPLY_CHAIN_FAILURES=()
RunCheckGroup() {
    local group="$1"
    shift
    local -a specs=("$@")
    local total="${#specs[@]}"
    local workers
    workers="$(ResolveAuditWorkers "$total")"
    local statusDir="$OUT_DIR/.parallel-$group-$$-$RANDOM"
    mkdir -p "$statusDir"
    Log "parallel group start: $group ($total jobs, workers=$workers)"

    local -a pids=()
    local -a statusFiles=()
    local -a logFiles=()
    local launched=0
    local settled=0
    local active=0
    local spec label command statusFile logFile
    for spec in "${specs[@]}"; do
        label="${spec%%::*}"
        command="${spec#*::}"
        statusFile="$statusDir/$launched.status"
        logFile="$statusDir/$launched.log"
        statusFiles+=("$statusFile")
        logFiles+=("$logFile")
        (
            set +e
            "$command" >"$logFile" 2>&1
            status=$?
            printf '%s\t%s\n' "$status" "$label" >"$statusFile"
            exit "$status"
        ) &
        pids+=("$!")
        launched=$((launched + 1))
        active=$((active + 1))
        if ((active >= workers)); then
            wait "${pids[$settled]}" >/dev/null 2>&1 || true
            settled=$((settled + 1))
            active=$((active - 1))
        fi
    done
    while ((settled < launched)); do
        wait "${pids[$settled]}" >/dev/null 2>&1 || true
        settled=$((settled + 1))
    done

    local index status
    for ((index = 0; index < total; index += 1)); do
        cat "${logFiles[$index]}"
        IFS=$'\t' read -r status label <"${statusFiles[$index]}"
        if [[ "$status" != "0" ]]; then
            SUPPLY_CHAIN_FAILURES+=("$label:$status")
        fi
    done
    rm -rf "$statusDir"
    Log "parallel group done: $group"
}

RunCheckGroup preflight \
    "dependency-locks::CheckDependencyLocks" \
    "dependency-docs::CheckDependencyDocs"
RunCheckGroup ecosystem-audits \
    "nuget::RunNugetAudit" \
    "npm::RunNpmAudit"

if ((${#SUPPLY_CHAIN_FAILURES[@]} > 0)); then
    Fail "supply-chain checks failed (${SUPPLY_CHAIN_FAILURES[*]})"
fi

cat >"$OUT_DIR/summary.json" <<JSON
{
  "status": "ok",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "nugetAudit": "nuget/",
  "npmAudit": "npm-audit.json",
  "lockFiles": {
    "npm": "src/frontend/package-lock.json",
    "nuget": "packages.lock.json next to each audited .csproj",
    "ciLockedMode": true
  },
  "policy": {
    "nuget": "fail on high or critical vulnerabilities",
    "npm": "npm audit --omit=dev --audit-level=high"
  }
}
JSON

Log "ok: $OUT_DIR/summary.json"
