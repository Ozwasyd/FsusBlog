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

log() {
  printf '[supply-chain] %s\n' "$1"
}

fail() {
  printf '[supply-chain] error: %s\n' "$1" >&2
  exit 1
}

log "run NuGet vulnerable package audit"
NUGET_OUT_DIR="$OUT_DIR/nuget"
rm -rf "$NUGET_OUT_DIR"
mkdir -p "$NUGET_OUT_DIR"

mapfile -d '' NUGET_PROJECTS < <(find "$ROOT_DIR" \
  -name '*.csproj' \
  ! -path '*/bin/*' \
  ! -path '*/obj/*' \
  -print0 | sort -z)

if [[ "${#NUGET_PROJECTS[@]}" -eq 0 ]]; then
  fail "no PackageReference .csproj files found for NuGet audit"
fi

log "check dependency lock files"
if [[ ! -f "$CLIENT_DIR/package-lock.json" ]]; then
  fail "src/frontend/package-lock.json is required for npm dependency integrity"
fi

for project in "${NUGET_PROJECTS[@]}"; do
  lock_file="$(dirname "$project")/packages.lock.json"
  if [[ ! -f "$lock_file" ]]; then
    fail "${lock_file#$ROOT_DIR/} is required for NuGet dependency integrity"
  fi
done

for project in "${NUGET_PROJECTS[@]}"; do
  relative_project="${project#$ROOT_DIR/}"
  safe_name="${relative_project//\//__}"
  if ! dotnet list "$project" package --vulnerable --include-transitive --format json --output-version 1 > "$NUGET_OUT_DIR/$safe_name.json"; then
    fail "dotnet vulnerable package audit failed for $relative_project"
  fi
done

node - "$NUGET_OUT_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
const blockers = [];
const problems = [];

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

for (const entry of fs.readdirSync(dir).filter((value) => value.endsWith('.json'))) {
  const file = path.join(dir, entry);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const problem of data.problems ?? []) {
    problems.push(problem);
  }
  for (const project of data.projects ?? []) {
    for (const framework of project.frameworks ?? []) {
      collectPackages(framework.topLevelPackages, project.name, framework.framework);
      collectPackages(framework.transitivePackages, project.name, framework.framework);
    }
  }
}

if (problems.length > 0) {
  console.error(JSON.stringify({ status: 'invalid', problems }, null, 2));
  process.exit(1);
}

if (blockers.length > 0) {
  console.error(JSON.stringify({ status: 'blocked', blockers }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: 'ok', blockers: [] }));
NODE

log "run npm production dependency audit"
set +e
(
  cd "$CLIENT_DIR"
  npm audit --omit=dev --audit-level=high --json
) > "$OUT_DIR/npm-audit.json" 2> "$OUT_DIR/npm-audit.stderr"
npm_status=$?
set -e

node - "$OUT_DIR/npm-audit.json" "$OUT_DIR/npm-audit.stderr" "$npm_status" <<'NODE'
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

cat > "$OUT_DIR/summary.json" <<JSON
{
  "status": "ok",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "nugetAudit": "nuget-vulnerable.json",
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

log "ok: $OUT_DIR/summary.json"
