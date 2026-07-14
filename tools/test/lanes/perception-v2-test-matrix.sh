#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/security/check-security-matrices.mjs"

if [[ -n "${FSUSBLOG_LOCAL_PROFILE:-}" ]]; then
  "${FSUSBLOG_NODE:-node}" --input-type=module - "$ROOT_DIR" <<'NODE'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2])
const runId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim()
if (!runId) throw new Error('Perception union projection requires FSUSBLOG_TEST_RUN_ID')

const trxRoot = path.join(root, '.tmp/test-results/backend/production')
const summaryFile = path.join(trxRoot, 'summary.json')
const markerFile = path.join(root, '.tmp/test-runs', runId, 'backend-tests-ready.json')
const projectionFile = path.join(trxRoot, 'perception-v2-union-projection.json')
const testDll = path.resolve(process.env.FSUSBLOG_BACKEND_TEST_DLL || path.join(root, 'tests/backend/bin/Release/net10.0/FsusBlog.Server.Tests.dll'))
const expectedTests = [
  'FsusBlog.Server.Tests.Unit.PerceptionChallengeV2E2eTests.CommentCreateFlow_FailsClosedForWrongAnswerExpiredReplayAndBindingMismatch',
  'FsusBlog.Server.Tests.Unit.PerceptionChallengeV2E2eTests.CommentCreateFlow_IssueRenderVerifyProofResume_WritesReleaseEvidence'
].sort()

function readJson(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} is missing: ${path.relative(root, file)}`)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function digest(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`Perception union projection artifact is missing: ${path.relative(root, file)}`)
  }
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}

function decodeXml(value) {
  return String(value)
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
}

function attribute(text, name) {
  const match = String(text).match(new RegExp(`\\b${name}="([^"]*)"`, 'u'))
  return match ? decodeXml(match[1]) : ''
}

function perceptionResults(file) {
  const xml = fs.readFileSync(file, 'utf8')
  const definitions = new Map()
  for (const match of xml.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/gu)) {
    const method = match[2].match(/<TestMethod\b([^>]*)\/?\s*>/u)?.[1] ?? ''
    const canonicalId = `${attribute(method, 'className')}.${attribute(method, 'name')}`
    definitions.set(attribute(match[1], 'id'), canonicalId)
  }
  return [...xml.matchAll(/<UnitTestResult\b([^>]*)>/gu)].flatMap((match) => {
    const canonicalId = definitions.get(attribute(match[1], 'testId')) ?? ''
    return canonicalId.startsWith('FsusBlog.Server.Tests.Unit.PerceptionChallengeV2E2eTests.')
      ? [{ id: canonicalId, outcome: attribute(match[1], 'outcome') }]
      : []
  })
}

function listTrx(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name)
    if (entry.isDirectory()) return listTrx(child)
    return entry.isFile() && entry.name.endsWith('.trx') ? [child] : []
  })
}

const summary = readJson(summaryFile, 'backend production union summary')
if (summary.schema !== 'fsusblog.backend-production-shards.v2' || summary.status !== 'success') {
  throw new Error('backend production union summary is not a successful v2 result')
}
if (summary.producer?.runId !== runId) {
  throw new Error(`backend production union summary runId mismatch: expected ${runId}, received ${summary.producer?.runId ?? '<missing>'}`)
}

const marker = readJson(markerFile, 'backend build marker')
const dllPath = relative(testDll)
const dllDigest = digest(testDll)
if (marker.schema !== 'fsusblog.local-production.backend-tests-ready.v1'
  || marker.status !== 'success'
  || marker.schedulerRunId !== runId
  || marker.testDll?.path !== dllPath
  || marker.testDll?.digest !== dllDigest) {
  throw new Error('backend tests-ready marker is not bound to the current runId and test DLL digest')
}

const declaredTrx = (summary.partitions ?? []).map((partition) => partition?.trx)
if (declaredTrx.length === 0 || declaredTrx.some((file) => typeof file !== 'string' || !file.endsWith('.trx'))) {
  throw new Error('backend production union summary has no complete TRX partition set')
}
const actualTrx = listTrx(trxRoot).map(relative).sort()
if (new Set(declaredTrx).size !== declaredTrx.length
  || JSON.stringify([...declaredTrx].sort()) !== JSON.stringify(actualTrx)) {
  throw new Error('backend production union TRX set does not exactly match its partition summary')
}

const trxFiles = actualTrx.map((file) => ({ path: file, digest: digest(path.join(root, file)) }))
const tests = actualTrx.flatMap((file) => perceptionResults(path.join(root, file))).sort((left, right) => left.id.localeCompare(right.id))
if (tests.length === 0) throw new Error('backend production union contains no PerceptionChallengeV2E2eTests results')
if (tests.some((entry) => entry.outcome !== 'Passed')) {
  const failed = tests.filter((entry) => entry.outcome !== 'Passed').map((entry) => `${entry.id}:${entry.outcome || '<missing>'}`)
  throw new Error(`backend production union contains non-passing Perception results: ${failed.join(', ')}`)
}
if (new Set(tests.map((entry) => entry.id)).size !== tests.length
  || JSON.stringify(tests.map((entry) => entry.id)) !== JSON.stringify(expectedTests)) {
  throw new Error(`backend production union Perception test IDs do not exactly match the canonical set: ${tests.map((entry) => entry.id).join(', ')}`)
}

const projection = {
  schema: 'fsusblog.perception-v2.union-projection.v1',
  status: 'success',
  producer: {
    runId,
    sourceCommit: summary.producer?.sourceCommit ?? null,
    sourceFingerprint: summary.producer?.sourceFingerprint ?? null
  },
  testDll: { path: dllPath, digest: dllDigest },
  unionSummary: { path: relative(summaryFile), digest: digest(summaryFile) },
  trxFiles,
  tests,
  generatedAt: new Date().toISOString()
}
fs.mkdirSync(path.dirname(projectionFile), { recursive: true })
const temporary = `${projectionFile}.next-${process.pid}`
fs.writeFileSync(temporary, `${JSON.stringify(projection, null, 2)}\n`)
fs.renameSync(temporary, projectionFile)
console.log(`[perception-v2-test-matrix] projected ${tests.length} passing tests from ${trxFiles.length} union TRX files`)
NODE
  exit 0
fi

dotnet_args=()
FSUSBLOG_REPO_ROOT="$ROOT_DIR" "$ROOT_DIR/tools/build-with-data-env.sh" dotnet test \
  "$ROOT_DIR/tests/backend/FsusBlog.Server.Tests.csproj" \
  -c Debug \
  -v minimal \
  "${dotnet_args[@]}" \
  --filter "FullyQualifiedName~PerceptionChallengeV2E2eTests"
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/security/check-perception-v2-e2e-evidence.mjs"
