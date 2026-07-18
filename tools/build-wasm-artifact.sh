#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="${ROOT_DIR}/build/artifacts/wasm-release"
TMP_DIR="${ROOT_DIR}/build/artifacts/.wasm-release-tmp"
CLIENT_DIR="${ROOT_DIR}/src/frontend"
MANIFEST_PATH="${ARTIFACT_DIR}/wasm-manifest.aeds"

Log() {
    printf '[build-wasm-artifact] %s\n' "$1"
}

RequireCommand() {
    if ! command -v "$1" >/dev/null 2>&1; then
        printf '[build-wasm-artifact] fatal: missing required command: %s\n' "$1" >&2
        exit 1
    fi
}

RequireCommand docker
RequireCommand node

node "${ROOT_DIR}/tools/check-wasm-artifact-ownership.mjs"

Log "building wasm artifact target"
rm -rf "${TMP_DIR}"
mkdir -p "${TMP_DIR}"
DOCKER_BUILDKIT=1 docker build \
    --pull \
    -f "${ROOT_DIR}/ops/docker/FsusBlog.Server.Dockerfile" \
    --target wasm-artifact \
    --output "type=local,dest=${TMP_DIR}" \
    "${ROOT_DIR}"

Log "refreshing artifact directory ${ARTIFACT_DIR}"
rm -rf "${ARTIFACT_DIR}"
mkdir -p "${ARTIFACT_DIR}"
find "${TMP_DIR}" -maxdepth 1 -type f -exec mv {} "${ARTIFACT_DIR}/" \;
rm -rf "${TMP_DIR}"

Log "verifying artifact contract"
ARTIFACT_DIR="${ARTIFACT_DIR}" MANIFEST_PATH="${MANIFEST_PATH}" CLIENT_DIR="${CLIENT_DIR}" node <<'EOF'
const fs = require('node:fs');
const path = require('node:path');

const artifactDir = process.env.ARTIFACT_DIR;
const manifestPath = process.env.MANIFEST_PATH;
const clientDir = process.env.CLIENT_DIR;

const entries = fs.readdirSync(artifactDir, { withFileTypes: true });
const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
const manifestName = path.basename(manifestPath);
const runtimeManifestName = 'aeds-runtime-manifest.json';
const checksumName = 'SHA256SUMS';
const structuredArtifactNames = new Set([
  runtimeManifestName,
  'comment-privacy-prover.manifest.json',
  'comment-privacy-prover.zkey',
  manifestName,
  checksumName
]);
const invalidFiles = files.filter((name) => !name.endsWith('.js') && !name.endsWith('.wasm') && !structuredArtifactNames.has(name));
if (invalidFiles.length > 0) {
  console.error(`[build-wasm-artifact] fatal: artifact directory contains unsupported files: ${invalidFiles.join(', ')}`);
  process.exit(1);
}

if (!fs.existsSync(manifestPath)) {
  console.error('[build-wasm-artifact] fatal: wasm-manifest.aeds is missing from artifact directory');
  process.exit(1);
}

const manifest = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.schemaVersion !== 3 || manifest.aedsAbi !== 'fsusblog.aeds.v4' || !manifest.toolchain) {
  console.error('[build-wasm-artifact] fatal: manifest must bind schema v3, AEDS ABI v4, and immutable toolchain identity');
  process.exit(1);
}
const runtimeManifest = JSON.parse(fs.readFileSync(path.join(artifactDir, runtimeManifestName), 'utf8'));
if (runtimeManifest.schema !== 'fsusblog.aeds-runtime.v1' || runtimeManifest.abi !== manifest.aedsAbi ||
    runtimeManifest.tiers?.speed?.wasmOptValidated !== true) {
  console.error('[build-wasm-artifact] fatal: AEDS runtime manifest tier identity is invalid');
  process.exit(1);
}
const requiredFiles = Array.isArray(manifest.outputFiles) ? [...manifest.outputFiles].sort() : [];
const actualOutputFiles = files.filter((name) => name !== manifestName && name !== checksumName).sort();

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

function decodeManifestField(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function parseManifest(raw) {
  const manifest = {
    schemaVersion: 0,
    builtAtUtc: '',
    buildModes: [],
    buildScript: '',
    dependencyInstaller: '',
    aedsAbi: '',
    toolchain: null,
    sourceHash: '',
    sourceFiles: [],
    outputFiles: [],
    outputFileHashes: {}
  };

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const [key, value = '', extra = ''] = trimmed.split('\t');
    switch (key) {
      case 'schemaVersion':
        manifest.schemaVersion = Number(value);
        break;
      case 'builtAtUtc':
        manifest.builtAtUtc = decodeManifestField(value);
        break;
      case 'buildModes':
        manifest.buildModes = value ? value.split(',').map(decodeManifestField) : [];
        break;
      case 'buildScript':
        manifest.buildScript = decodeManifestField(value);
        break;
      case 'dependencyInstaller':
        manifest.dependencyInstaller = decodeManifestField(value);
        break;
      case 'aedsAbi':
        manifest.aedsAbi = decodeManifestField(value);
        break;
      case 'toolchain':
        manifest.toolchain = JSON.parse(decodeManifestField(value));
        break;
      case 'sourceHash':
        manifest.sourceHash = decodeManifestField(value);
        break;
      case 'sourceFile':
        manifest.sourceFiles.push(decodeManifestField(value));
        break;
      case 'outputFile': {
        const outputFile = decodeManifestField(value);
        manifest.outputFiles.push(outputFile);
        manifest.outputFileHashes[outputFile] = decodeManifestField(extra);
        break;
      }
    }
  }

  return manifest;
}
EOF

(
    cd "${ARTIFACT_DIR}"
    find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%P\0' | sort -z | xargs -0 sha256sum >SHA256SUMS
    sha256sum -c SHA256SUMS >/dev/null
)

node "${ROOT_DIR}/tools/check-wasm-artifact-ownership.mjs" --require-generated --artifact-dir "${ARTIFACT_DIR}"

Log "artifact ready at ${ARTIFACT_DIR}"
