#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${FSUSBLOG_SBOM_DIR:-$ROOT_DIR/.tmp/security/sbom}"
mkdir -p "$OUT_DIR"

node - "$ROOT_DIR" "$OUT_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = process.argv[2];
const outDir = process.argv[3];
const now = new Date().toISOString();

function walk(dir, predicate, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'bin' || entry.name === 'obj' || entry.name === 'node_modules') continue;
      walk(fullPath, predicate, results);
    } else if (predicate(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

function bomSerial(label) {
  const digest = crypto.createHash('sha256').update(`${label}:${now}`).digest('hex');
  return `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function writeBom(fileName, name, components, metadata = {}) {
  const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: bomSerial(name),
    version: 1,
    metadata: {
      timestamp: now,
      component: {
        type: 'application',
        name: 'FsusBlog',
        version: process.env.GITHUB_SHA || process.env.FSUSBLOG_RELEASE_STAMP || 'local'
      },
      ...metadata
    },
    components
  };
  fs.writeFileSync(path.join(outDir, fileName), `${JSON.stringify(bom, null, 2)}\n`);
  return { file: fileName, count: components.length };
}

function nugetComponents() {
  const components = new Map();
  for (const lockFile of walk(root, (value) => value.endsWith('packages.lock.json'))) {
    const data = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    for (const [framework, packages] of Object.entries(data.dependencies ?? {})) {
      for (const [name, info] of Object.entries(packages ?? {})) {
        const version = info.resolved ?? String(info.requested ?? '').replace(/[\[\](), ]/g, '');
        const key = `${name}@${version}`;
        if (!components.has(key)) {
          components.set(key, {
            type: 'library',
            name,
            version,
            scope: info.type === 'Direct' ? 'required' : 'optional',
            purl: `pkg:nuget/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
            hashes: info.contentHash ? [{ alg: 'SHA-512', content: info.contentHash }] : undefined,
            properties: [
              { name: 'fsusblog.framework', value: framework },
              { name: 'fsusblog.lockFile', value: path.relative(root, lockFile).replaceAll(path.sep, '/') }
            ]
          });
        }
      }
    }
  }
  return Array.from(components.values());
}

function npmComponents() {
  const lockFile = path.join(root, 'src/frontend/package-lock.json');
  const data = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const components = [];
  for (const [packagePath, info] of Object.entries(data.packages ?? {})) {
    if (!packagePath.startsWith('node_modules/') || !info.version) continue;
    const name = packagePath.slice('node_modules/'.length);
    components.push({
      type: 'library',
      name,
      version: info.version,
      scope: info.dev ? 'optional' : 'required',
      purl: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(info.version)}`,
      hashes: info.integrity ? [{ alg: 'SHA-512', content: info.integrity.replace(/^sha512-/, '') }] : undefined,
      licenses: info.license ? [{ license: { id: info.license } }] : undefined,
      externalReferences: info.resolved ? [{ type: 'distribution', url: info.resolved }] : undefined,
      properties: [
        { name: 'fsusblog.privateGithubPackage', value: String(info.resolved?.includes('npm.pkg.github.com') ?? false) },
        { name: 'fsusblog.lockFile', value: 'src/frontend/package-lock.json' }
      ]
    });
  }
  return components;
}

function imageComponents() {
  const digest = process.env.FSUSBLOG_IMAGE_DIGEST || '';
  const image = process.env.FSUSBLOG_IMAGE_NAME || 'fsusblog-server';
  return [{
    type: 'container',
    name: image,
    version: digest || 'missing-image-digest',
    purl: digest ? `pkg:docker/${encodeURIComponent(image)}@${encodeURIComponent(digest)}` : undefined,
    properties: [
      { name: 'fsusblog.imageDigestPresent', value: String(Boolean(digest)) }
    ]
  }];
}

const summaries = [
  writeBom('nuget.cdx.json', 'FsusBlog NuGet', nugetComponents()),
  writeBom('npm.cdx.json', 'FsusBlog npm', npmComponents()),
  writeBom('image.cdx.json', 'FsusBlog image', imageComponents(), {
    properties: [
      { name: 'fsusblog.imageDigest', value: process.env.FSUSBLOG_IMAGE_DIGEST || 'missing' }
    ]
  })
];

fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify({
  status: 'ok',
  generatedAt: now,
  format: 'CycloneDX 1.5',
  artifacts: summaries
}, null, 2)}\n`);
NODE

echo "[sbom] wrote $OUT_DIR"
