#!/usr/bin/env bash
set -euo pipefail

CHECKER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="${FSUSBLOG_GATE_INTEGRITY_ROOT:-$CHECKER_ROOT}"

RunSelfTest() {
    local tempDir
    tempDir="$(mktemp -d)"
    trap 'rm -rf "$tempDir"' RETURN

    mkdir -p \
        "$tempDir/.github/workflows" \
        "$tempDir/docs" \
        "$tempDir/src/frontend" \
        "$tempDir/tests/backend" \
        "$tempDir/tests" \
        "$tempDir/tools/ci" \
        "$tempDir/tools/test/lanes" \
        "$tempDir/tools/coverage"

    touch "$tempDir/tests/backend/FsusBlog.Server.Tests.csproj"
    touch "$tempDir/src/frontend/package-lock.json"

    cat >"$tempDir/tools/test.sh" <<'EOF'
#!/usr/bin/env bash
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-}" in
  ci-fast|ci-production|ci-job|ci-tier|ci-plan)
    exec node "$ROOT_DIR/tools/run-test-matrix.mjs" "$@"
    ;;
esac
exec node "$ROOT_DIR/tools/run-test-matrix.mjs" run "$@"
EOF

    cat >"$tempDir/tools/run-test-matrix.mjs" <<'EOF'
#!/usr/bin/env node
console.log('[matrix] ok')
EOF

    cat >"$tempDir/tools/ci/summarize-quality-gate.mjs" <<'EOF'
#!/usr/bin/env node
console.log('production summary ok')
EOF

    cat >"$tempDir/tools/ci/check-job-summaries.mjs" <<'EOF'
#!/usr/bin/env node
console.log('[job-summary-check] ok')
EOF

    cat >"$tempDir/tools/ci/run-stage.mjs" <<'EOF'
#!/usr/bin/env node
console.log('[ci-stage] ok')
EOF

    cat >"$tempDir/tools/ci/check-flaky-registry.mjs" <<'EOF'
#!/usr/bin/env node
console.log('[flaky-registry] ok')
EOF

    cat >"$tempDir/tools/ci/check-flaky-evidence.mjs" <<'EOF'
#!/usr/bin/env node
console.log('[flaky-evidence] ok')
EOF

    cat >"$tempDir/tools/ci/run-flaky-governed.mjs" <<'EOF'
#!/usr/bin/env node
console.log('[flaky] ok')
EOF

    cat >"$tempDir/tools/test/lanes/_suite-support.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

    cat >"$tempDir/tests/matrix.yml" <<'EOF'
version: fsusblog-test-matrix-v2
tiers:
  - id: fast
    command: tools/ok.sh
  - id: validate-matrix
    command: tools/test/run-matrix-governance-once.sh validate-matrix
  - id: coverage-backend
    command: tools/coverage/collect-backend-coverage.sh
  - id: coverage-frontend
    command: tools/coverage/collect-frontend-coverage.sh
  - id: coverage-merge
    command: tools/coverage/merge-coverage.sh
  - id: coverage-threshold
    command: tools/test/lanes/coverage-threshold.sh
  - id: coverage-gate
    command: tools/coverage/check-scope-snapshot.sh
  - id: production
    command: tools/test/lanes/noop.sh
EOF

    cat >"$tempDir/tests/matrix.schema.json" <<'EOF'
{}
EOF

    cat >"$tempDir/tests/flaky.yml" <<'EOF'
version: fsusblog-flaky-v1
entries: []
EOF

    cat >"$tempDir/tools/ok.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

    cat >"$tempDir/tools/check-gate-integrity.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

    for file in \
        "$tempDir/tools/test.sh" \
        "$tempDir/tools/run-test-matrix.mjs" \
        "$tempDir/tools/ci/summarize-quality-gate.mjs" \
        "$tempDir/tools/ci/check-job-summaries.mjs" \
        "$tempDir/tools/ci/run-stage.mjs" \
        "$tempDir/tools/ci/check-flaky-registry.mjs" \
        "$tempDir/tools/ci/check-flaky-evidence.mjs" \
        "$tempDir/tools/ci/run-flaky-governed.mjs" \
        "$tempDir/tools/test/lanes/_suite-support.sh" \
        "$tempDir/tools/ok.sh" \
        "$tempDir/tools/check-gate-integrity.sh" \
        "$tempDir/tools/test/run-matrix-governance-once.sh" \
        "$tempDir/tools/test/lanes/noop.sh" \
        "$tempDir/tools/test/lanes/coverage-threshold.sh" \
        "$tempDir/tools/coverage/collect-backend-coverage.sh" \
        "$tempDir/tools/coverage/collect-frontend-coverage.sh" \
        "$tempDir/tools/coverage/merge-coverage.sh" \
        "$tempDir/tools/coverage/check-scope-snapshot.sh" \
        "$tempDir/tools/coverage/check-threshold.sh"; do
        [[ -f "$file" ]] || printf '#!/usr/bin/env bash\nexit 0\n' >"$file"
        chmod +x "$file"
    done

    cat >"$tempDir/src/frontend/package.json" <<'EOF'
{
  "scripts": {
    "test:production": "bash ../../tools/test.sh production",
    "check:fixture": "node ../../tests/frontend/checks/fixture.mjs"
  }
}
EOF

    mkdir -p "$tempDir/tests/frontend/checks"
    touch "$tempDir/tests/frontend/checks/fixture.mjs"

    cat >"$tempDir/.github/workflows/quality-gate.yml" <<'EOF'
name: Quality Gate
on:
  pull_request:
  push:
    branches:
      - main
      - master
  workflow_dispatch:
jobs:
  validate-matrix:
    steps:
      - run: ./tools/test.sh ci-tier validate-matrix --no-deps
      - run: node tools/run-test-matrix.mjs ci-plan --format github-actions --out .tmp/ci-plan.json
  coverage:
    steps:
      - run: ./tools/test.sh ci-job fast-backend --fresh
      - run: ./tools/test.sh ci-job fast-frontend-unit --fresh
      - run: ./tools/test.sh coverage-merge
      - run: ./tools/test.sh coverage-threshold
  production:
    steps:
      - run: ./tools/test.sh production
  production-summary:
    steps:
      - run: node tools/ci/summarize-quality-gate.mjs
EOF

    cat >"$tempDir/README.md" <<'EOF'
Quality Gate runs on pull requests, pushes to main and master, and manual dispatch.
See tests/backend/TESTING.md.
EOF
    cat >"$tempDir/docs/testing.md" <<'EOF'
Quality Gate runs on pull_request, main and master push, and workflow_dispatch.
EOF
    cat >"$tempDir/docs/operations.md" <<'EOF'
Quality Gate runs on pull requests, pushes to main and master, and manual dispatch.
EOF
    cat >"$tempDir/tests/backend/TESTING.md" <<'EOF'
Quality Gate runs on pull_request, main and master push, and workflow_dispatch.
EOF

    if [[ "${1:-}" == "ordinary-parser" ]]; then
        local ordinaryStatus=0
        RunOrdinaryParserFixtures "$tempDir" || ordinaryStatus=$?
        return "$ordinaryStatus"
    fi

    FSUSBLOG_GATE_INTEGRITY_ROOT="$tempDir" "$0" >/dev/null

    rm "$tempDir/tools/ok.sh"
    if FSUSBLOG_GATE_INTEGRITY_ROOT="$tempDir" "$0" >"$tempDir/missing.log" 2>&1; then
        echo "[gate-integrity:self-test] expected missing-file fixture to fail" >&2
        return 1
    fi
    grep -q "missing path" "$tempDir/missing.log"

    printf '#!/usr/bin/env bash\nexit 0\n' >"$tempDir/tools/ok.sh"
    chmod 0644 "$tempDir/tools/ok.sh"
    if FSUSBLOG_GATE_INTEGRITY_ROOT="$tempDir" "$0" >"$tempDir/perm.log" 2>&1; then
        echo "[gate-integrity:self-test] expected permission fixture to fail" >&2
        return 1
    fi
    grep -q "not executable" "$tempDir/perm.log"
    chmod +x "$tempDir/tools/ok.sh"

    printf 'See tests/server/FsusBlog.Server.Tests/TESTING.md.\n' >"$tempDir/README.md"
    if FSUSBLOG_GATE_INTEGRITY_ROOT="$tempDir" "$0" >"$tempDir/drift.log" 2>&1; then
        echo "[gate-integrity:self-test] expected path-drift fixture to fail" >&2
        return 1
    fi
    grep -q "stale path" "$tempDir/drift.log"
    sed -i 's#tests/server/FsusBlog.Server.Tests/TESTING.md#tests/backend/TESTING.md#' "$tempDir/README.md"

    local workflow="$tempDir/.github/workflows/quality-gate.yml"
    local matrix="$tempDir/tests/matrix.yml"
    cp "$workflow" "$tempDir/quality-gate.baseline.yml"
    cp "$matrix" "$tempDir/matrix.baseline.yml"

    # Source-only declaration validation is not the canonical governance command.
    sed -i '/^      - run: .\/tools\/test.sh ci-tier validate-matrix --no-deps$/a\      - run: node tools/run-test-matrix.mjs validate-declarations' "$workflow"
    FSUSBLOG_GATE_INTEGRITY_ROOT="$tempDir" "$0" >/dev/null
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    printf '\n# node tools/run-test-matrix.mjs validate\n# node tools/run-test-matrix.mjs preflight\n# node tools/run-test-matrix.mjs evidence-plan\n' >>"$workflow"
    FSUSBLOG_GATE_INTEGRITY_ROOT="$tempDir" "$0" >/dev/null
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    sed -i 's#^      - run: ./tools/test.sh ci-tier validate-matrix --no-deps$#      - name: Canonical governance\n        run: ./tools/test.sh ci-tier validate-matrix --no-deps#' "$workflow"
    FSUSBLOG_GATE_INTEGRITY_ROOT="$tempDir" "$0" >/dev/null
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    local blockMarker
    for blockMarker in '|' '>' '|-' '>-'; do
        sed -i "s#^      - run: ./tools/test.sh ci-tier validate-matrix --no-deps\$#      - run: $blockMarker\\n          ./tools/test.sh ci-tier validate-matrix --no-deps#" "$workflow"
        FSUSBLOG_GATE_INTEGRITY_ROOT="$tempDir" "$0" >/dev/null
        cp "$tempDir/quality-gate.baseline.yml" "$workflow"
    done

    ExpectFixtureFailure() {
        local expected="$1"
        if FSUSBLOG_GATE_INTEGRITY_ROOT="$tempDir" "$0" >"$tempDir/refusal.log" 2>&1; then
            echo "[gate-integrity:self-test] expected refusal: $expected" >&2
            return 1
        fi
        grep -Fq "$expected" "$tempDir/refusal.log"
    }

    rm "$tempDir/tools/test/run-matrix-governance-once.sh"
    ExpectFixtureFailure 'missing path: tools/test/run-matrix-governance-once.sh'
    printf '#!/usr/bin/env bash\nexit 0\n' >"$tempDir/tools/test/run-matrix-governance-once.sh"
    ExpectFixtureFailure 'not executable: tools/test/run-matrix-governance-once.sh'
    chmod +x "$tempDir/tools/test/run-matrix-governance-once.sh"

    sed -i 's|^      - run: ./tools/test.sh ci-tier validate-matrix --no-deps$|      # - run: ./tools/test.sh ci-tier validate-matrix --no-deps|' "$workflow"
    ExpectFixtureFailure 'validate-matrix job must invoke the scheduler-owned canonical tier exactly once'
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    sed -i 's#^      - run: ./tools/test.sh ci-tier validate-matrix --no-deps$#      - run: >\n          \# disabled command\n          ./tools/test.sh ci-tier validate-matrix --no-deps#' "$workflow"
    ExpectFixtureFailure 'workflow must invoke the scheduler-owned canonical tier exactly once'
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    sed -i 's#^  validate-matrix:$#  wrong-job:#' "$workflow"
    printf '\n  validate-matrix:\n    steps:\n      - run: ./tools/test.sh ci-tier test-inventory --no-deps\n' >>"$workflow"
    ExpectFixtureFailure 'validate-matrix job must invoke the scheduler-owned canonical tier exactly once'
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    sed -i 's#^      - run: ./tools/test.sh ci-tier validate-matrix --no-deps$#      - run: tools/test/run-matrix-governance-once.sh validate-matrix#' "$workflow"
    ExpectFixtureFailure 'validate-matrix job must invoke the scheduler-owned canonical tier exactly once'
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    sed -i '/^      - run: .\/tools\/test.sh ci-tier validate-matrix --no-deps$/a\      - run: ./tools/test.sh ci-tier validate-matrix --no-deps' "$workflow"
    ExpectFixtureFailure 'validate-matrix job must invoke the scheduler-owned canonical tier exactly once'
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    sed -i '/^      - run: .\/tools\/test.sh ci-tier validate-matrix --no-deps$/a\      - run: node tools/run-test-matrix.mjs ci-tier validate-matrix --no-deps' "$workflow"
    ExpectFixtureFailure 'validate-matrix job must invoke the scheduler-owned canonical tier exactly once'
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    sed -i '/^      - run: .\/tools\/test.sh coverage-threshold$/a\      - run: ./tools/test.sh ci-tier validate-matrix --no-deps' "$workflow"
    ExpectFixtureFailure 'workflow must invoke the scheduler-owned canonical tier exactly once'
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    sed -i '/^      - run: .\/tools\/test.sh coverage-threshold$/a\      - run: tools/test/run-matrix-governance-once.sh validate-matrix' "$workflow"
    ExpectFixtureFailure 'workflow must invoke the scheduler-owned canonical tier exactly once'
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    sed -i '/^      - run: .\/tools\/test.sh coverage-threshold$/a\      - run: |\n          ./tools/test.sh ci-tier validate-matrix --no-deps' "$workflow"
    ExpectFixtureFailure 'workflow must invoke the scheduler-owned canonical tier exactly once'
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    sed -i '/^      - run: .\/tools\/test.sh coverage-threshold$/a\      - run: >\n          ./tools/test.sh ci-tier validate-matrix --no-deps' "$workflow"
    ExpectFixtureFailure 'workflow must invoke the scheduler-owned canonical tier exactly once'
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    sed -i '/^      - run: .\/tools\/test.sh coverage-threshold$/a\      - run: >\n          ./tools/test.sh ci-tier\n          validate-matrix --no-deps' "$workflow"
    ExpectFixtureFailure 'workflow must invoke the scheduler-owned canonical tier exactly once'
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    sed -i '/^      - run: .\/tools\/test.sh coverage-threshold$/a\      - run: |-\n          ./tools/test.sh ci-tier validate-matrix --no-deps' "$workflow"
    ExpectFixtureFailure 'workflow must invoke the scheduler-owned canonical tier exactly once'
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    sed -i 's#^    command: tools/test/run-matrix-governance-once.sh validate-matrix$#    command: tools/ok.sh#' "$matrix"
    ExpectFixtureFailure 'validate-matrix tier must run the canonical matrix governance owner exactly once'
    cp "$tempDir/matrix.baseline.yml" "$matrix"

    sed -i 's#^  - id: validate-matrix$#  - id: renamed-matrix#' "$matrix"
    ExpectFixtureFailure 'must declare exactly one validate-matrix tier'
    cp "$tempDir/matrix.baseline.yml" "$matrix"

    printf '\n  - id: "validate-matrix"\n    command: tools/test/run-matrix-governance-once.sh validate-matrix\n' >>"$matrix"
    ExpectFixtureFailure 'must declare exactly one validate-matrix tier'
    cp "$tempDir/matrix.baseline.yml" "$matrix"

    printf '\n  - id: validate-matrix\n    command: tools/test/run-matrix-governance-once.sh validate-matrix\n' >>"$matrix"
    ExpectFixtureFailure 'must declare exactly one validate-matrix tier'
    cp "$tempDir/matrix.baseline.yml" "$matrix"

    sed -i '/^    command: tools\/test\/run-matrix-governance-once.sh validate-matrix$/a\    command: tools/test/run-matrix-governance-once.sh validate-matrix' "$matrix"
    ExpectFixtureFailure 'duplicate YAML key command'
    cp "$tempDir/matrix.baseline.yml" "$matrix"

    sed -i 's#^    command: tools/test/run-matrix-governance-once.sh validate-matrix$#    command: echo tools/test/run-matrix-governance-once.sh validate-matrix#' "$matrix"
    ExpectFixtureFailure 'validate-matrix tier must run the canonical matrix governance owner exactly once'
    cp "$tempDir/matrix.baseline.yml" "$matrix"

    sed -i 's#^      - run: ./tools/test.sh ci-tier validate-matrix --no-deps$#      - run: echo ./tools/test.sh ci-tier validate-matrix --no-deps#' "$workflow"
    ExpectFixtureFailure 'workflow must invoke the scheduler-owned canonical tier exactly once'
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    sed -i 's#^      - run: ./tools/test.sh ci-tier validate-matrix --no-deps$#      - run: ./tools/test.sh ci-tier validate-matrix-renamed --no-deps#' "$workflow"
    ExpectFixtureFailure 'workflow must invoke the scheduler-owned canonical tier exactly once'
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    printf '\n  validate-matrix:\n    steps:\n      - run: ./tools/test.sh ci-tier validate-matrix --no-deps\n' >>"$workflow"
    ExpectFixtureFailure 'duplicate YAML key validate-matrix'
    cp "$tempDir/quality-gate.baseline.yml" "$workflow"

    local matrixCommand
    for matrixCommand in validate preflight evidence-plan "'validate'" '"preflight"'; do
        sed -i "/^      - run: .\/tools\/test.sh coverage-threshold\$/a\\      - run: node tools/run-test-matrix.mjs $matrixCommand" "$workflow"
        ExpectFixtureFailure 'bypasses the canonical matrix governance owner'
        cp "$tempDir/quality-gate.baseline.yml" "$workflow"
    done

    FSUSBLOG_GATE_INTEGRITY_ROOT="$tempDir" "$0" >/dev/null

    echo "[gate-integrity:self-test] ok"
}

RunOrdinaryParserFixtures() {
    node --input-type=module - "$1" "$CHECKER_ROOT/tools/check-gate-integrity.sh" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.argv[2];
const checker = process.argv[3];
const workflowPath = path.join(root, '.github/workflows/quality-gate.yml');
const matrixPath = path.join(root, 'tests/matrix.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const matrix = fs.readFileSync(matrixPath, 'utf8');
const owner = './tools/test.sh ci-tier validate-matrix --no-deps';
const tierOwner = 'tools/test/run-matrix-governance-once.sh validate-matrix';
const cases = [];
function workflowCase(name, expected, replacement) {
  cases.push({ name, expected, workflow: workflow.replace(`run: ${owner}`, replacement), matrix });
}
function extraCommand(name, expected, command) {
  cases.push({ name, expected, workflow: `${workflow}\n  extra:\n    steps:\n      - run: ${command}\n`, matrix });
}
workflowCase('plain', 0, `run: ${owner}`);
workflowCase('single-quoted YAML', 0, `run: '${owner}'`);
workflowCase('double-quoted YAML', 0, `run: "${owner}"`);
workflowCase('trailing YAML comment', 0, `run: ${owner} # canonical owner`);
workflowCase('folded adjacent lines', 0, 'run: >\n          ./tools/test.sh ci-tier\n          validate-matrix --no-deps');
workflowCase('folded interior blank', 1, 'run: >\n          ./tools/test.sh ci-tier\n\n          validate-matrix --no-deps');
workflowCase('folded shell comment', 1, `run: >\n          # disabled owner\n          ${owner}`);
workflowCase('literal separate lines', 1, 'run: |\n          ./tools/test.sh ci-tier\n          validate-matrix --no-deps');
workflowCase('disabled step', 1, `if: false\n        run: ${owner}`);
workflowCase('enabled step', 0, `if: true\n        run: ${owner}`);
workflowCase('dynamic step condition', 0, `if: github.event_name == 'push'\n        run: ${owner}`);
workflowCase('unbound owner substring', 1, `run: echo ${owner}`);
workflowCase('direct canonical route', 1, `run: ${tierOwner}`);
cases.push({ name: 'disabled job', expected: 1, workflow: workflow.replace('  validate-matrix:\n', '  validate-matrix:\n    if: false\n'), matrix });
cases.push({ name: 'dynamic job condition', expected: 0, workflow: workflow.replace('  validate-matrix:\n', '  validate-matrix:\n    if: github.event_name == \'push\'\n'), matrix });
cases.push({ name: 'folded matrix comment', expected: 1, workflow, matrix: matrix.replace(`command: ${tierOwner}`, `command: >\n      # disabled canonical owner\n      ${tierOwner}`) });
cases.push({ name: 'wrong matrix command', expected: 1, workflow, matrix: matrix.replace(`command: ${tierOwner}`, 'command: tools/ok.sh') });
cases.push({ name: 'renamed tier', expected: 1, workflow, matrix: matrix.replace('id: validate-matrix', 'id: renamed-matrix') });
cases.push({ name: 'quoted duplicate tier', expected: 1, workflow, matrix: `${matrix}\n  - id: "validate-matrix"\n    command: ${tierOwner}\n` });
cases.push({ name: 'duplicate command field', expected: 1, workflow, matrix: matrix.replace(`command: ${tierOwner}`, `command: ${tierOwner}\n    command: ${tierOwner}`) });
cases.push({ name: 'renamed workflow job', expected: 1, workflow: workflow.replace('  validate-matrix:', '  renamed-job:'), matrix });
for (const script of ["'tools/run-test-matrix.mjs'", '"tools/run-test-matrix.mjs"', "tools/'run-test-matrix'.mjs", 'tools/run-test-matri\\x.mjs']) {
  for (const verb of ['validate', 'preflight', 'evidence-plan']) extraCommand(`${script} ${verb}`, 1, `node ${script} ${verb}`);
}
extraCommand('quoted argv', 1, 'node "tools/run-test-matrix.mjs" "validate"');
extraCommand('longer subcommand', 0, 'node "tools/run-test-matrix.mjs" validate-declarations');
extraCommand('shell comment', 0, 'echo ok # node "tools/run-test-matrix.mjs" validate');
extraCommand('empty argv word', 0, 'node "tools/run-test-matrix.mjs" \'\' validate');
extraCommand('shell separator', 0, 'node "tools/run-test-matrix.mjs"; echo validate');
cases.push({ name: 'disabled duplicate owner', expected: 1, workflow: `${workflow}\n  disabled:\n    if: false\n    steps:\n      - run: ${owner}\n`, matrix });
workflowCase('nonbreaking workflow prefix', 1, `run: '\u00a0${owner}'`);
workflowCase('nonbreaking workflow suffix', 1, `run: '${owner}\u00a0'`);
cases.push({ name: 'nonbreaking matrix prefix', expected: 1, workflow, matrix: matrix.replace(`command: ${tierOwner}`, `command: \u00a0${tierOwner}`) });
cases.push({ name: 'nonbreaking matrix suffix', expected: 1, workflow, matrix: matrix.replace(`command: ${tierOwner}`, `command: '${tierOwner}\u00a0'`) });
extraCommand('nonbreaking argv separator', 0, 'node "tools/run-test-matrix.mjs"\u00a0validate');
let failed = 0;
for (const fixture of cases) {
  fs.writeFileSync(workflowPath, fixture.workflow);
  fs.writeFileSync(matrixPath, fixture.matrix);
  const result = spawnSync('bash', [checker], { env: { ...process.env, FSUSBLOG_GATE_INTEGRITY_ROOT: root }, encoding: 'utf8' });
  const passed = result.status === fixture.expected;
  if (!passed) failed += 1;
  console.log(JSON.stringify({ name: fixture.name, expectedExit: fixture.expected, actualExit: result.status, passed }));
  if (!passed) process.stderr.write(result.stderr || result.stdout);
}
console.log(`[gate-integrity:ordinary-parser] ${cases.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
NODE
}

if [[ "${1:-}" == "--ordinary-parser-self-test" ]]; then
    RunSelfTest ordinary-parser
    exit 0
fi

if [[ "${1:-}" == "--self-test" ]]; then
    RunSelfTest
    exit 0
fi

export FSUSBLOG_GATE_INTEGRITY_ROOT="$ROOT_DIR"
node --input-type=module - "$CHECKER_ROOT" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep fixture data separate from the checker's canonical parser implementation.
const { parseMatrix } = await import(pathToFileURL(path.join(process.argv[2], 'tools/test-matrix/parse-matrix.mjs')));
const { parseYamlDocument } = await import(pathToFileURL(path.join(process.argv[2], 'tools/yaml/parse-document.mjs')));

const root = process.env.FSUSBLOG_GATE_INTEGRITY_ROOT;
const errors = [];
const references = new Map();

function relPath(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/');
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

function isExecutable(rel) {
  try {
    return (fs.statSync(path.join(root, rel)).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function addError(message) {
  errors.push(message);
}

function addRef(rel, source, executable = false) {
  if (!rel || rel.includes('*')) {
    return;
  }

  const normalized = path.posix.normalize(rel.replaceAll('\\', '/'));
  if (normalized.startsWith('../') || path.isAbsolute(normalized)) {
    addError(`unsafe referenced path in ${source}: ${rel}`);
    return;
  }

  const existing = references.get(normalized) ?? { sources: new Set(), executable: false };
  existing.sources.add(source);
  existing.executable = existing.executable || executable || /^tools\/.+\.sh$/.test(normalized);
  references.set(normalized, existing);
}

function readRequired(rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    addError(`missing required file: ${rel}`);
    return '';
  }
  return fs.readFileSync(file, 'utf8');
}

function addRefsFromText(text, source, baseRel = '') {
  const tokenPattern = /(?:^|[\s"'(=])((?:\.\.\/\.\.\/)?(?:\.\/)?(?:tools|tests|src)\/[A-Za-z0-9._/-]+)/g;
  let match;
  while ((match = tokenPattern.exec(text)) !== null) {
    let token = match[1].replace(/^.\//, '').replace(/[.,;:]+$/, '');
    if (token.startsWith('../../') && baseRel === '') {
      continue;
    }
    if (token.startsWith('../../')) {
      token = path.posix.normalize(path.posix.join(baseRel, token));
    }
    addRef(token, source);
  }
}

function addRootVarRefs(text, source) {
  const rootVarPattern = /\$ROOT_DIR\/((?:tools|tests|src)\/[A-Za-z0-9._/-]+)/g;
  let match;
  while ((match = rootVarPattern.exec(text)) !== null) {
    addRef(match[1], source);
  }
}

function scanToolsTest() {
  const source = 'tools/test.sh';
  const text = readRequired(source);
  addRootVarRefs(text, source);
  addRefsFromText(text, source);
  for (const line of text.split(/\r?\n/).filter((value) => value.includes('RunInClient'))) {
    addRefsFromText(line, `${source}:RunInClient`, 'src/frontend');
  }

  for (const needle of [
    'tools/run-test-matrix.mjs',
    'ci-fast',
    'ci-production',
    'ci-job',
    'ci-tier',
    'ci-plan'
  ]) {
    if (!text.includes(needle)) {
      addError(`tools/test.sh does not reference ${needle}`);
    }
  }
}

function scanMatrix() {
  const source = 'tests/matrix.yml';
  const text = readRequired(source);
  for (const line of text.split(/\r?\n/).filter((value) => /^\s+command:\s+/.test(value))) {
    addRefsFromText(line, source);
  }
  for (const required of [
    'tools/coverage/collect-backend-coverage.sh',
    'tools/coverage/collect-frontend-coverage.sh',
    'tools/coverage/merge-coverage.sh',
    'tools/test/lanes/coverage-threshold.sh'
  ]) {
    if (!text.includes(required)) {
      addError(`${source} does not reference ${required}`);
    }
  }

  // The workflow schedules this tier; the tier, not the workflow, owns the producer.
  let tiers;
  try {
    tiers = parseMatrix(text, { validateDependencyFields: false }).tiers;
  } catch (error) {
    addError(`${source} invalid matrix: ${error.message}`);
    return;
  }
  const owners = tiers.filter((tier) => tier.id === 'validate-matrix');
  if (owners.length !== 1) {
    addError(`${source} must declare exactly one validate-matrix tier`);
    return;
  }
  // YAML clip/keep terminators are shell whitespace; internal breaks and comments
  // remain part of the command and cannot qualify the canonical owner.
  if (typeof owners[0].command !== 'string'
    || trimShellWhitespace(owners[0].command) !== 'tools/test/run-matrix-governance-once.sh validate-matrix') {
    addError(`${source} validate-matrix tier must run the canonical matrix governance owner exactly once`);
  }
}

function scanPackageJson() {
  const source = 'src/frontend/package.json';
  const text = readRequired(source);
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch (error) {
    addError(`invalid package json: ${source}: ${error.message}`);
    return;
  }

  for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
    addRefsFromText(String(script), `${source}#${name}`, 'src/frontend');
  }

  if (pkg.scripts?.['test:production'] !== 'bash ../../tools/test.sh production') {
    addError('src/frontend/package.json test:production must delegate to bash ../../tools/test.sh production');
  }
}

function trimShellWhitespace(value) {
  return value.replace(/^[ \t\n]+|[ \t\n]+$/gu, '');
}

function isYamlRunBlock(value) {
  const marker = trimShellWhitespace(value).replace(/[ \t]+#.*$/u, '');
  return /^[|>](?:[+-][1-9]?|[1-9][+-]?)?$/u.test(marker);
}

function rawWorkflowCommands(text) {
  const commands = [];
  let blockIndent = -1;
  let blockLines = [];
  function flushRunBlock() {
    if (blockLines.length > 0) commands.push(trimShellWhitespace(blockLines.join(' ').replace(/[ \t\n]+/gu, ' ')));
    blockIndent = -1;
    blockLines = [];
  }
  for (const line of text.split(/\r?\n/)) {
    // A block's contents are shell text, even if a line looks like a YAML key.
    if (blockIndent >= 0 && (!trimShellWhitespace(line) || line.match(/^[ \t]*/)[0].length > blockIndent)) {
      blockLines.push(trimShellWhitespace(line));
      continue;
    }
    flushRunBlock();
    const run = line.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (run) {
      blockIndent = isYamlRunBlock(run[2]) ? run[1].length : -1;
      // Inline YAML scalars are decoded by the canonical parser, including quotes
      // and trailing YAML comments. Only block contents need this interim guard.
    }
  }
  flushRunBlock();
  return commands;
}

// Match literal shell word identity without executing or expanding shell text.
// Separators interrupt argv adjacency; quoting and escapes preserve literal words.
function shellLiteralWords(command) {
  const words = [];
  let word = '';
  let started = false;
  let quote = '';
  function flushWord() {
    if (started) words.push(word);
    word = '';
    started = false;
  }
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === "'") {
      if (character === quote) quote = '';
      else word += character;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      const next = command[index + 1];
      if (next === '\n') index += 1;
      else if (next !== undefined && (!quote || /[$`"\\]/u.test(next))) {
        word += next;
        started = true;
        index += 1;
      } else word += character;
      continue;
    }
    if (quote === '"') {
      if (character === quote) quote = '';
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === '#' && !started) {
      while (index < command.length && command[index] !== '\n') index += 1;
      words.push(null);
    } else if (/[\n;&|()<>]/u.test(character)) {
      flushWord();
      words.push(null);
    } else if (/[ \t]/u.test(character)) flushWord();
    else {
      word += character;
      started = true;
    }
  }
  flushWord();
  return words;
}

function bypassesMatrixOwner(command) {
  const words = shellLiteralWords(command);
  return words.some((word, index) =>
    typeof word === 'string' && /^(?:\.?\/)?tools\/run-test-matrix\.mjs$/u.test(word)
    && ['preflight', 'validate', 'evidence-plan'].includes(words[index + 1]));
}

function scanWorkflow(file) {
  const text = readRequired(file);
  if (file.endsWith('quality-gate.yml')) {
    const branchBlock = text.match(/push:\s*[\s\S]*?branches:\s*([\s\S]*?)(?:\n\S|\n\s{2}\w|$)/);
    const branchText = branchBlock?.[1] ?? '';
    for (const branch of ['main', 'master']) {
      if (!new RegExp(`(^|\\s|- )${branch}(\\s|$)`).test(branchText)) {
        addError(`${file} push.branches is missing ${branch}`);
      }
    }

    for (const required of ['./tools/test.sh ci-job fast-backend --fresh', './tools/test.sh ci-job fast-frontend-unit --fresh', './tools/test.sh coverage-merge', './tools/test.sh coverage-threshold']) {
      if (!text.includes(required)) {
        addError(`${file} does not run ${required}`);
      }
    }
    if (!text.includes('production-summary:')) {
      addError(`${file} is missing production-summary job`);
    }
    let jobs;
    try {
      jobs = parseYamlDocument(text, { source: file }).jobs ?? {};
    } catch (error) {
      addError(`${file} invalid workflow: ${error.message}`);
      return;
    }
    const declaredCommands = Object.values(jobs).flatMap((job) =>
      (job.steps ?? []).filter((step) => typeof step.run === 'string').map((step) => trimShellWhitespace(step.run)));
    // Until the shared parser preserves block contents, retain the existing raw
    // guard: a comment in a folded scalar can disable its command.
    const rawCommands = rawWorkflowCommands(text);
    const schedulerStep = './tools/test.sh ci-tier validate-matrix --no-deps';
    const matrixInvocations = declaredCommands.filter((command) =>
        /(?:tools\/test\.sh|tools\/run-test-matrix\.mjs|run-matrix-governance-once\.sh)/u.test(command)
        && (command.includes('validate-matrix') || command.includes('run-matrix-governance-once.sh')));
    const invalidRawOwner = rawCommands.some((command) =>
      /(?:tools\/test\.sh|tools\/run-test-matrix\.mjs|run-matrix-governance-once\.sh)/u.test(command)
      && (command.includes('validate-matrix') || command.includes('run-matrix-governance-once.sh'))
      && command !== schedulerStep);
    if (matrixInvocations.length !== 1 || matrixInvocations[0] !== schedulerStep || invalidRawOwner) {
      addError(`${file} workflow must invoke the scheduler-owned canonical tier exactly once`);
    }
    if (!Object.hasOwn(jobs, 'validate-matrix')) {
      addError(`${file} must declare exactly one validate-matrix job`);
    } else {
      const owner = jobs['validate-matrix'];
      const runSteps = owner.if === false ? [] : (owner.steps ?? [])
        .filter((step) => step.if !== false && typeof step.run === 'string').map((step) => trimShellWhitespace(step.run));
      const matrixOwnerSteps = runSteps.filter((command) =>
        command.includes('validate-matrix')
        && /(?:tools\/test\.sh|tools\/run-test-matrix\.mjs|run-matrix-governance-once\.sh)/u.test(command));
      if (matrixOwnerSteps.length !== 1 || matrixOwnerSteps[0] !== schedulerStep) {
        addError(`${file} validate-matrix job must invoke the scheduler-owned canonical tier exactly once`);
      }
    }
    if (declaredCommands.some(bypassesMatrixOwner)) {
      addError(`${file} bypasses the canonical matrix governance owner`);
    }
    if (!text.includes('node tools/run-test-matrix.mjs ci-plan --format github-actions --out .tmp/ci-plan.json')) {
      addError(`${file} must write the CI plan with run-test-matrix --out`);
    }
    if (text.includes('> .tmp/ci-plan.json')) {
      addError(`${file} must not write .tmp/ci-plan.json with shell redirection`);
    }
    if (!text.includes('node tools/ci/summarize-quality-gate.mjs')) {
      addError(`${file} does not use the quality gate summary classifier`);
    }
  }

  const lines = text.split(/\r?\n/);
  let inRunBlock = false;
  let runIndent = 0;
  for (const line of lines) {
    const runMatch = line.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (runMatch) {
      inRunBlock = isYamlRunBlock(runMatch[2]);
      runIndent = runMatch[1].length;
      addRefsFromText(runMatch[2], file);
      continue;
    }

    if (inRunBlock) {
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (line.trim() === '' || indent > runIndent) {
        addRefsFromText(line, file);
      } else {
        inRunBlock = false;
      }
    }

    const cacheMatch = line.match(/cache-dependency-path:\s*(.+)$/);
    if (cacheMatch) {
      addRef(cacheMatch[1].trim(), file);
    }
  }
}

function scanDocs() {
  const docs = [
    'README.md',
    'docs/testing.md',
    'docs/operations.md',
    'tests/backend/TESTING.md'
  ];

  for (const doc of docs) {
    const text = readRequired(doc);
    if (text.includes('tests/server/')) {
      addError(`stale path in ${doc}: tests/server/`);
    }
    if (text.includes('src/frontend/FsusBlog.Client/')) {
      addError(`stale path in ${doc}: src/frontend/FsusBlog.Client/`);
    }
    if (/Quality Gate/.test(text) && !/(main[\s\S]{0,80}master|master[\s\S]{0,80}main)/.test(text)) {
      addError(`${doc} mentions Quality Gate branch coverage without both main and master`);
    }
  }
}

function requirePath(rel, executable = false) {
  addRef(rel, 'required', executable);
}

const requiredPaths = [
  'tools/test.sh',
  'tools/test/lanes/_suite-support.sh',
  'tools/run-test-matrix.mjs',
  'tools/ci/summarize-quality-gate.mjs',
  'tools/ci/check-job-summaries.mjs',
  'tools/ci/run-stage.mjs',
  'tools/ci/check-flaky-registry.mjs',
  'tools/ci/check-flaky-evidence.mjs',
  'tools/ci/run-flaky-governed.mjs',
  'tools/check-gate-integrity.sh',
  'tools/test/run-matrix-governance-once.sh',
  'tests/matrix.yml',
  'tests/matrix.schema.json',
  'tests/flaky.yml',
  'tools/coverage/collect-backend-coverage.sh',
  'tools/coverage/collect-frontend-coverage.sh',
  'tools/coverage/merge-coverage.sh',
  'tools/coverage/check-scope-snapshot.sh',
  'tools/coverage/check-threshold.sh'
];
const requiredExecutablePaths = new Set(requiredPaths.filter((rel) => rel.startsWith('tools/') && !rel.startsWith('tools/ci/')));
for (const rel of requiredPaths) {
  requirePath(rel, requiredExecutablePaths.has(rel));
}

scanToolsTest();
scanMatrix();
scanPackageJson();
for (const workflow of fs.readdirSync(path.join(root, '.github/workflows')).filter((value) => /\.ya?ml$/.test(value)).sort()) {
  scanWorkflow(`.github/workflows/${workflow}`);
}
scanDocs();

for (const [rel, info] of references.entries()) {
  if (!exists(rel)) {
    addError(`missing path: ${rel} (referenced by ${Array.from(info.sources).sort().join(', ')})`);
    continue;
  }
  if (info.executable && !isExecutable(rel)) {
    addError(`not executable: ${rel} (referenced by ${Array.from(info.sources).sort().join(', ')})`);
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[gate-integrity] ${error}`);
  }
  process.exit(1);
}

console.log(`[gate-integrity] ok (${references.size} referenced paths checked)`);
NODE
