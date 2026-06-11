#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${FSUSBLOG_GATE_INTEGRITY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

run_self_test() {
  local temp_dir
  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"' RETURN

  mkdir -p \
    "$temp_dir/.github/workflows" \
    "$temp_dir/docs" \
    "$temp_dir/src/frontend" \
    "$temp_dir/tests/backend" \
    "$temp_dir/tests" \
    "$temp_dir/tools/ci" \
    "$temp_dir/tools/test/lanes" \
    "$temp_dir/tools/coverage"

  touch "$temp_dir/tests/backend/FsusBlog.Server.Tests.csproj"
  touch "$temp_dir/src/frontend/package-lock.json"

  cat > "$temp_dir/tools/test.sh" <<'EOF'
#!/usr/bin/env bash
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-}" in
  ci-fast|ci-production|ci-job|ci-tier|ci-plan)
    exec node "$ROOT_DIR/tools/run-test-matrix.mjs" "$@"
    ;;
esac
exec node "$ROOT_DIR/tools/run-test-matrix.mjs" run "$@"
EOF

  cat > "$temp_dir/tools/run-test-matrix.mjs" <<'EOF'
#!/usr/bin/env node
console.log('[matrix] ok')
EOF

  cat > "$temp_dir/tools/ci/summarize-quality-gate.mjs" <<'EOF'
#!/usr/bin/env node
console.log('production summary ok')
EOF

  cat > "$temp_dir/tools/ci/check-job-summaries.mjs" <<'EOF'
#!/usr/bin/env node
console.log('[job-summary-check] ok')
EOF

  cat > "$temp_dir/tools/ci/run-stage.mjs" <<'EOF'
#!/usr/bin/env node
console.log('[ci-stage] ok')
EOF

  cat > "$temp_dir/tools/test/legacy-test.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  cat > "$temp_dir/tests/matrix.yml" <<'EOF'
version: fsusblog-test-matrix-v2
tiers:
  - id: fast
    command: tools/ok.sh
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

  cat > "$temp_dir/tests/matrix.schema.json" <<'EOF'
{}
EOF

  cat > "$temp_dir/tools/ok.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  cat > "$temp_dir/tools/check-gate-integrity.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  for file in \
    "$temp_dir/tools/test.sh" \
    "$temp_dir/tools/run-test-matrix.mjs" \
    "$temp_dir/tools/ci/summarize-quality-gate.mjs" \
    "$temp_dir/tools/ci/check-job-summaries.mjs" \
    "$temp_dir/tools/ci/run-stage.mjs" \
    "$temp_dir/tools/test/legacy-test.sh" \
    "$temp_dir/tools/ok.sh" \
    "$temp_dir/tools/check-gate-integrity.sh" \
    "$temp_dir/tools/test/lanes/noop.sh" \
    "$temp_dir/tools/test/lanes/coverage-threshold.sh" \
    "$temp_dir/tools/coverage/collect-backend-coverage.sh" \
    "$temp_dir/tools/coverage/collect-frontend-coverage.sh" \
    "$temp_dir/tools/coverage/merge-coverage.sh" \
    "$temp_dir/tools/coverage/check-scope-snapshot.sh" \
    "$temp_dir/tools/coverage/check-threshold.sh"; do
    [[ -f "$file" ]] || printf '#!/usr/bin/env bash\nexit 0\n' > "$file"
    chmod +x "$file"
  done

  cat > "$temp_dir/src/frontend/package.json" <<'EOF'
{
  "scripts": {
    "test:production": "bash ../../tools/test.sh production",
    "check:fixture": "node ../../tests/frontend/checks/fixture.mjs"
  }
}
EOF

  mkdir -p "$temp_dir/tests/frontend/checks"
  touch "$temp_dir/tests/frontend/checks/fixture.mjs"

  cat > "$temp_dir/.github/workflows/quality-gate.yml" <<'EOF'
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
      - run: node tools/run-test-matrix.mjs preflight
      - run: node tools/run-test-matrix.mjs validate
      - run: node tools/run-test-matrix.mjs ci-plan --format github-actions --out .tmp/ci-plan.json
  coverage:
    steps:
      - run: ./tools/test.sh coverage-backend
      - run: ./tools/test.sh coverage-frontend
      - run: ./tools/test.sh coverage-merge
      - run: ./tools/test.sh coverage-threshold
  production:
    steps:
      - run: ./tools/test.sh production
  production-summary:
    steps:
      - run: node tools/ci/summarize-quality-gate.mjs
EOF

  cat > "$temp_dir/README.md" <<'EOF'
Quality Gate runs on pull requests, pushes to main and master, and manual dispatch.
See tests/backend/TESTING.md.
EOF
  cat > "$temp_dir/docs/testing.md" <<'EOF'
Quality Gate runs on pull_request, main and master push, and workflow_dispatch.
EOF
  cat > "$temp_dir/docs/operations.md" <<'EOF'
Quality Gate runs on pull requests, pushes to main and master, and manual dispatch.
EOF
  cat > "$temp_dir/tests/backend/TESTING.md" <<'EOF'
Quality Gate runs on pull_request, main and master push, and workflow_dispatch.
EOF

  FSUSBLOG_GATE_INTEGRITY_ROOT="$temp_dir" "$0" >/dev/null

  rm "$temp_dir/tools/ok.sh"
  if FSUSBLOG_GATE_INTEGRITY_ROOT="$temp_dir" "$0" >/tmp/fsusblog-gate-integrity-missing.log 2>&1; then
    echo "[gate-integrity:self-test] expected missing-file fixture to fail" >&2
    return 1
  fi
  grep -q "missing path" /tmp/fsusblog-gate-integrity-missing.log

  printf '#!/usr/bin/env bash\nexit 0\n' > "$temp_dir/tools/ok.sh"
  chmod 0644 "$temp_dir/tools/ok.sh"
  if FSUSBLOG_GATE_INTEGRITY_ROOT="$temp_dir" "$0" >/tmp/fsusblog-gate-integrity-perm.log 2>&1; then
    echo "[gate-integrity:self-test] expected permission fixture to fail" >&2
    return 1
  fi
  grep -q "not executable" /tmp/fsusblog-gate-integrity-perm.log
  chmod +x "$temp_dir/tools/ok.sh"

  printf 'See tests/server/FsusBlog.Server.Tests/TESTING.md.\n' > "$temp_dir/README.md"
  if FSUSBLOG_GATE_INTEGRITY_ROOT="$temp_dir" "$0" >/tmp/fsusblog-gate-integrity-drift.log 2>&1; then
    echo "[gate-integrity:self-test] expected path-drift fixture to fail" >&2
    return 1
  fi
  grep -q "stale path" /tmp/fsusblog-gate-integrity-drift.log

  echo "[gate-integrity:self-test] ok"
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
  exit 0
fi

export FSUSBLOG_GATE_INTEGRITY_ROOT="$ROOT_DIR"
node <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

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
  for (const line of text.split(/\r?\n/).filter((value) => value.includes('run_in_client'))) {
    addRefsFromText(line, `${source}:run_in_client`, 'src/frontend');
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

    for (const required of ['./tools/test.sh coverage-backend', './tools/test.sh coverage-frontend', './tools/test.sh coverage-merge', './tools/test.sh coverage-threshold']) {
      if (!text.includes(required)) {
        addError(`${file} does not run ${required}`);
      }
    }
    if (!text.includes('production-summary:')) {
      addError(`${file} is missing production-summary job`);
    }
    if (!text.includes('node tools/run-test-matrix.mjs preflight')) {
      addError(`${file} does not run matrix preflight`);
    }
    if (!text.includes('node tools/run-test-matrix.mjs validate')) {
      addError(`${file} does not validate tests/matrix.yml`);
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
    const runMatch = line.match(/^(\s*)run:\s*(.*)$/);
    if (runMatch) {
      inRunBlock = runMatch[2].trim() === '|';
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
  'tools/test/legacy-test.sh',
  'tools/run-test-matrix.mjs',
  'tools/ci/summarize-quality-gate.mjs',
  'tools/ci/check-job-summaries.mjs',
  'tools/ci/run-stage.mjs',
  'tools/check-gate-integrity.sh',
  'tests/matrix.yml',
  'tests/matrix.schema.json',
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
