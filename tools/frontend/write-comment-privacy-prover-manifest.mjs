#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    commentPrivacyBuildContract,
    validateCommentPrivacyBuild
} from '../security/comment-privacy-build-contract.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const publicWasmRoot = resolve(process.env.FSUSBLOG_FRONTEND_WASM_ROOT
  || join(repoRoot, 'src', 'frontend', 'public', 'wasm'));
const manifestPath = join(publicWasmRoot, 'comment-privacy-prover.manifest.json');
const buildContract = validateCommentPrivacyBuild({ root: process.env.FSUSBLOG_REPOSITORY_ROOT || repoRoot });
if (buildContract.mode !== 'enabled')
{
    throw new Error('comment privacy prover manifest cannot be written while production ZK is disabled');
}

const files = {
    module: 'comment-privacy-prover.js',
  wasm: 'comment_privacy_runtime.wasm',
  provingKey: 'comment-privacy-prover.zkey'
}

async function sha256Bytes(path) {
  return createHash('sha256').update(await readFile(path)).digest()
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex')
}

function base64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

const moduleDigest = await sha256Bytes(join(publicWasmRoot, files.module))
const wasmDigest = await sha256Bytes(join(publicWasmRoot, files.wasm))
const provingKeyDigest = await sha256Bytes(join(publicWasmRoot, files.provingKey))

const manifest = {
  moduleUrl: `/wasm/${files.module}`,
    wasmUrl: `/wasm/${files.wasm}`,
    provingKeyUrl: `/wasm/${files.provingKey}`,
    integrity: `sha256-${base64(moduleDigest)}`,
    circuitId: commentPrivacyBuildContract.circuitId,
    publicInputLayoutVersion: commentPrivacyBuildContract.publicInputLayoutVersion,
    provingKeySha256: hex(provingKeyDigest),
    wasmSha256: hex(wasmDigest)
};

await mkdir(dirname(manifestPath), { recursive: true })
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`[comment-privacy-prover-manifest] wrote ${manifestPath}`)
