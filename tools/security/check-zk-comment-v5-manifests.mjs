#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const circuitId = 'fsus.anonymous.comment.v5'
const layoutVersion = 6
const transcriptDomain = `${circuitId}.public-inputs`
const publicInputs = [
  'action_context',
  'scope',
  'circuit_id',
  'verifying_key_hash',
  'public_input_layout_version',
  'nullifier_hash',
  'credential_root',
  'revocation_root',
  'issuer_public_key_hash',
  'policy_hash',
  'is_eligible',
  'may_comment',
  'rate_class',
  'requires_moderation'
]
const forbiddenPublicInputs = [
  'credential_epoch',
  'credential_level',
  'reputation_bucket',
  'account_age',
  'account_age_bucket',
  'credential_commitment',
  'credential_serial',
  'member_id'
]
const requiredTamperCases = [
  'tamper-is-eligible',
  'tamper-may-comment',
  'tamper-rate-class',
  'tamper-requires-moderation',
  'tamper-private-credential-level',
  'tamper-private-reputation',
  'tamper-private-account-age',
  'tamper-root',
  'tamper-revocation-root',
  'tamper-scope',
  'tamper-non-current-layout',
  'inject-exact-attribute-public-input'
]
const failures = []

const files = {
  circuit: resolveInput('FSUSBLOG_ZK_V5_CIRCUIT_MANIFEST', 'security/zk/contracts/comment-v5-circuit.manifest.json'),
  source: resolveInput('FSUSBLOG_ZK_V5_CIRCUIT_SOURCE', 'src/zk/circuits/anonymous-comment-v5/comment_v5.circuit.json'),
  setup: resolveInput('FSUSBLOG_ZK_V5_TRUSTED_SETUP_MANIFEST', 'security/zk/provenance/comment-v5-trusted-setup.manifest.json'),
  config: resolveInput('FSUSBLOG_ZK_V5_VERIFYING_KEY_CONFIG', 'config/zk/anonymous-comment-v5-verifying-key.manifest.json'),
  tamper: resolveInput('FSUSBLOG_ZK_V5_TAMPER_MANIFEST', 'security/zk/contracts/comment-v5-tamper-cases.manifest.json')
}

const circuit = readJson(files.circuit, 'circuit manifest')
const source = readJson(files.source, 'circuit source')
const setup = readJson(files.setup, 'trusted setup manifest')
const config = readJson(files.config, 'verifying key config')
const tamper = readJson(files.tamper, 'tamper manifest')

for (const [label, document] of [['circuit', circuit], ['source', source], ['setup', setup], ['config', config], ['tamper', tamper]]) {
  equal(document.circuit_id, circuitId, `${label}.circuit_id`)
  equal(Number(document.public_input_layout_version), layoutVersion, `${label}.public_input_layout_version`)
}

equal(circuit.source, 'src/zk/circuits/anonymous-comment-v5/comment_v5.circuit.json', 'circuit.source')
equal(circuit.source_sha256, sha256File(files.source), 'circuit.source_sha256')
equal(circuit.artifact_status, 'source-only', 'circuit.artifact_status')
equal(circuit.production_usable, false, 'circuit.production_usable')
equal(circuit.reject_non_current_layout, true, 'circuit.reject_non_current_layout')
exactArray(circuit.public_inputs, publicInputs, 'circuit.public_inputs')
exactArray(source.public_inputs, publicInputs, 'source.public_inputs')
exactArray(source.forbidden_public_inputs, forbiddenPublicInputs, 'source.forbidden_public_inputs')
equal(source.domain_separators?.public_input_transcript, transcriptDomain, 'source public-input transcript domain')
equal(source.domain_separators?.nullifier_prf, `${circuitId}:nullifier:v1`, 'source nullifier domain')

equal(setup.circuit_manifest_path, 'security/zk/contracts/comment-v5-circuit.manifest.json', 'setup.circuit_manifest_path')
equal(setup.ceremony_status, 'not-run', 'setup.ceremony_status')
equal(setup.production_usable, false, 'setup.production_usable')
nonEmpty(setup.fail_closed_reason, 'setup.fail_closed_reason')
equal(setup.verifying_key_hash, '', 'setup.verifying_key_hash')
for (const [name, artifact] of Object.entries(setup.artifacts ?? {})) {
  equal(artifact?.status, 'required', `setup.artifacts.${name}.status`)
  equal(artifact?.sha256, '', `setup.artifacts.${name}.sha256`)
}

equal(config.schema, 'fsusblog.zk.verifying-key-config.v2', 'config.schema')
equal(config.circuit_manifest, 'security/zk/contracts/comment-v5-circuit.manifest.json', 'config.circuit_manifest')
equal(config.trusted_setup_manifest, 'security/zk/provenance/comment-v5-trusted-setup.manifest.json', 'config.trusted_setup_manifest')
equal(config.production_usable, false, 'config.production_usable')
equal(config.verifying_key_hash, '', 'config.verifying_key_hash')

const tamperCases = new Map(array(tamper.tamper_cases).map((entry) => [entry?.id, entry]))
for (const id of requiredTamperCases) {
  const entry = tamperCases.get(id)
  if (!entry) {
    fail(`tamper manifest missing ${id}`)
    continue
  }
  equal(entry.expected, 'reject', `tamper case ${id}.expected`)
  if (array(entry.mutates).length === 0) fail(`tamper case ${id} must mutate at least one field`)
}

for (const file of [
  'src/backend/Services/Security/NativeGroth16ZkProofBackend.cs',
  'src/frontend/src/privacy/commentPrivacyWasmProver.ts'
]) {
  const sourceText = readText(path.join(root, file), file)
  if (!sourceText.includes(transcriptDomain)) fail(`${file} must use ${transcriptDomain}`)
  if (/fsus[.]anonymous[.]comment[.]v(?!5\b)[0-9]+[.]public-inputs/u.test(sourceText)) {
    fail(`${file} retains a non-current transcript domain`)
  }
}

for (const file of [
  'src/frontend/wasm/comment_privacy/comment-privacy-prover.js',
  'src/frontend/src/privacy/commentPrivacyBlindRsaSuite.ts',
  'src/shared/Contracts/Validation/AnonymousPrivacyContract.cs',
  'tools/dev/start.sh'
]) {
  const sourceText = readText(path.join(root, file), file)
  if (sourceText.includes(['fsus.anonymous.comment.', 'v', '3'].join(''))) {
    fail(`${file} retains a retired circuit identity`)
  }
}

checkTrackedResidue()

for (const file of [
  'src/backend/appsettings.json',
  'src/backend/appsettings.Production.json'
]) {
  const settings = readText(path.join(root, file), file)
  if (!settings.includes(`"CircuitId": "${circuitId}"`)) fail(`${file} must select ${circuitId}`)
  if (!settings.includes(`"PublicInputLayoutVersion": ${layoutVersion}`)) fail(`${file} must select layout ${layoutVersion}`)
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[zk-comment-v5-manifest] ${failure}`)
  process.exit(1)
}

console.log('[zk-comment-v5-manifest] active layout-6 source, fail-closed setup, runtime config and tamper contracts are aligned')

function resolveInput(envName, fallback) {
  const selected = process.env[envName] || fallback
  return path.isAbsolute(selected) ? selected : path.join(root, selected)
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`${label} is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

function readText(file, label) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    fail(`${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

function sha256File(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch (error) {
    fail(`circuit source hash is unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

function exactArray(actual, expected, label) {
  if (JSON.stringify(array(actual)) !== JSON.stringify(expected)) {
    fail(`${label} must use the exact layout-6 order`)
  }
}

function equal(actual, expected, label) {
  if (actual !== expected) fail(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} is required`)
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function checkTrackedResidue() {
  const retiredCircuit = ['fsus.anonymous.comment.', 'v', '3'].join('')
  const retiredPath = ['comment', '-', 'v', '2'].join('')
  const retiredSymbols = [['ZkComment', 'V2'].join(''), ['Circuit', 'Native'].join('')]
  const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  for (const file of tracked) {
    if (file.toLowerCase().includes(retiredPath)) fail(`${file} retains a retired proving-system path`)
    let content
    try {
      content = readFileSync(path.join(root, file))
    } catch {
      continue
    }
    if (content.includes(0)) continue
    const text = content.toString('utf8')
    if (text.includes(retiredCircuit) || retiredSymbols.some((symbol) => text.includes(symbol))) {
      fail(`${file} retains retired proving-system text`)
    }
  }
}

function fail(message) {
  failures.push(message)
}
