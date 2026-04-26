#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="${ROOT_DIR}/build/artifacts/wasm-release"
TMP_DIR="${ROOT_DIR}/build/artifacts/.wasm-release-tmp"
CLIENT_DIR="${ROOT_DIR}/FsusBlog.Client"
MANIFEST_PATH="${ARTIFACT_DIR}/wasm-manifest.json"

log() {
  printf '[build-wasm-artifact] %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[build-wasm-artifact] fatal: missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

require_command docker
require_command node

log "building wasm artifact target"
rm -rf "${TMP_DIR}"
mkdir -p "${TMP_DIR}"
DOCKER_BUILDKIT=1 docker build \
  --pull \
  -f "${ROOT_DIR}/FsusBlog.Server/Dockerfile" \
  --target wasm-artifact \
  --output "type=local,dest=${TMP_DIR}" \
  "${ROOT_DIR}"

log "refreshing artifact directory ${ARTIFACT_DIR}"
rm -rf "${ARTIFACT_DIR}"
mkdir -p "${ARTIFACT_DIR}"
find "${TMP_DIR}" -maxdepth 1 -type f -exec mv {} "${ARTIFACT_DIR}/" \;
rm -rf "${TMP_DIR}"

log "verifying artifact contract"
ARTIFACT_DIR="${ARTIFACT_DIR}" MANIFEST_PATH="${MANIFEST_PATH}" CLIENT_DIR="${CLIENT_DIR}" node <<'EOF'
const fs = require('node:fs');
const path = require('node:path');

const artifactDir = process.env.ARTIFACT_DIR;
const manifestPath = process.env.MANIFEST_PATH;
const clientDir = process.env.CLIENT_DIR;

const entries = fs.readdirSync(artifactDir, { withFileTypes: true });
const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
const invalidFiles = files.filter((name) => !name.endsWith('.js') && !name.endsWith('.wasm') && name !== 'wasm-manifest.json');
if (invalidFiles.length > 0) {
  console.error(`[build-wasm-artifact] fatal: artifact directory contains unsupported files: ${invalidFiles.join(', ')}`);
  process.exit(1);
}

if (!fs.existsSync(manifestPath)) {
  console.error('[build-wasm-artifact] fatal: wasm-manifest.json is missing from artifact directory');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const requiredFiles = Array.isArray(manifest.outputFiles) ? [...manifest.outputFiles].sort() : [];
const actualOutputFiles = files.filter((name) => name !== 'wasm-manifest.json').sort();

if (requiredFiles.length !== actualOutputFiles.length ||
    requiredFiles.some((name, index) => name !== actualOutputFiles[index])) {
  console.error('[build-wasm-artifact] fatal: artifact files do not match manifest outputFiles');
  process.exit(1);
}

console.log(`[build-wasm-artifact] manifest schemaVersion=${manifest.schemaVersion}`);
console.log(`[build-wasm-artifact] manifest sourceHash=${manifest.sourceHash}`);
console.log(`[build-wasm-artifact] manifest outputFiles=${requiredFiles.length}`);
console.log(`[build-wasm-artifact] manifest outputFileHashes=${Object.keys(manifest.outputFileHashes ?? {}).length}`);
console.log(`[build-wasm-artifact] trusted input boundary=${path.relative(clientDir, path.join(clientDir, 'public', 'wasm')).replaceAll(path.sep, '/')}`);
console.log('[build-wasm-artifact] artifact contents');
for (const file of files) {
  console.log(file);
}
EOF

log "artifact ready at ${ARTIFACT_DIR}"
