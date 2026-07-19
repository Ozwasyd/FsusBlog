#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
const fail = message => {
  throw new Error(`[comment-privacy-contract-boundaries] ${message}`)
}

const contractsPath = 'src/frontend/src/privacy/commentPrivacyContracts.ts'
const providerPath = 'src/frontend/src/privacy/commentPrivacyCredentialProvider.ts'
const suitePath = 'src/frontend/src/privacy/commentPrivacyBlindRsaSuite.ts'
const contracts = read(contractsPath)
const provider = read(providerPath)
const suite = read(suitePath)

const imports = source => [...source.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map(match => match[1])
const contractImports = imports(contracts)
if (contractImports.length !== 0) {
  fail(`contracts must be implementation-independent; imports: ${contractImports.join(', ')}`)
}
if (!imports(provider).includes('./commentPrivacyContracts')) {
  fail('provider must consume the independent contracts module')
}
if (!imports(provider).includes('./commentPrivacyBlindRsaSuite')) {
  fail('provider must remain the concrete suite composition owner')
}
if (!imports(suite).includes('./commentPrivacyContracts')) {
  fail('Blind-RSA suite must consume the independent contracts module')
}
if (imports(suite).some(specifier => specifier.includes('commentPrivacyCredentialProvider'))) {
  fail('Blind-RSA suite must not import provider')
}

const exportedContracts = [...contracts.matchAll(/export\s+(?:interface|type)\s+(CommentPrivacy[A-Za-z0-9]+)/gu)]
  .map(match => match[1])
  .sort()
const expectedSnapshot = [
  'CommentPrivacyCredentialIssuePayload',
  'CommentPrivacyCredentialIssueRequest',
  'CommentPrivacyCredentialIssueResponse',
  'CommentPrivacyCredentialIssuerMetadata',
  'CommentPrivacyCredentialMaterial',
  'CommentPrivacyCredentialProvider',
  'CommentPrivacyCredentialSuite',
  'CommentPrivacyCredentialSuiteFailureCategory',
  'CommentPrivacyCredentialSuiteResult',
  'CommentPrivacyRevocationDistribution'
].sort()
if (JSON.stringify(exportedContracts) !== JSON.stringify(expectedSnapshot)) {
  fail(`public contract snapshot drifted: ${JSON.stringify(exportedContracts)}`)
}

for (const forbidden of ['@/api/', '@/stores/', 'vue', 'commentPrivacyBlindRsaSuite', 'commentPrivacyCredentialProvider']) {
  if (contracts.includes(forbidden)) fail(`contracts contain forbidden dependency ${forbidden}`)
}

console.log('[comment-privacy-contract-boundaries] provider -> suite/contracts DAG and public snapshot OK')
