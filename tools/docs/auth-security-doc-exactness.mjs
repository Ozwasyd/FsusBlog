#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { digestPath, digestValue, sealSourceIdentity } from '../fact-extractors/identity.mjs'
import { parseRepositoryClaims } from './doc-claim.mjs'
import { readBehaviorDocStaticAdmissionReceipt } from './behavior-doc-static-admission-contract.mjs'
import {
  buildBehaviorDocExactnessReceipt,
  validateBehaviorDocExactnessReceipt,
  verifyBehaviorDocExactnessReplay
} from './behavior-doc-exactness.mjs'
import { processGeneratedFactSections } from './generated-fact-sections/generator.mjs'
import { verifyProseClaims } from './prose-claim-verifier/verifier.mjs'

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scopeId = 'auth-security-configuration-admin-error'
const behaviorIds = ['authentication-session-permission', 'configuration-error-security-policy']

const readJson = (root, relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'))

function parseArguments(argv)
{
  const result = { mode: null, receipts: [], admission: null, output: null }
  for (let index = 0; index < argv.length; index += 1)
  {
    const argument = argv[index]
    if (argument === 'produce' || argument === 'verify') result.mode = argument
    else if (argument === '--receipt') result.receipts.push(argv[++index])
    else if (argument === '--admission') result.admission = argv[++index]
    else if (argument === '--output') result.output = argv[++index]
    else throw new Error(`unknown argument ${argument}`)
  }
  if (!result.mode || result.receipts.length === 0 || !result.admission || !result.output)
    throw new Error('usage: auth-security-doc-exactness.mjs produce|verify --admission <path> --receipt <path>... --output <path>')
  return result
}

export function loadCurrentExactnessInputs(root, receiptPaths, admissionPath)
{
  const catalog = readJson(root, 'config/contracts/behavior-contracts.json')
  const lifecycle = readJson(root, 'config/development/document-lifecycle.json')
  const migrationLedger = readJson(root, 'config/contracts/document-claim-migration-ledger.json')
  const sectionCatalog = readJson(root, 'config/contracts/generated-fact-sections.json')
  const claimReceipt = parseRepositoryClaims(root, { catalog })
  const identity = sealSourceIdentity(root)
  const admission = readBehaviorDocStaticAdmissionReceipt(path.resolve(root, admissionPath), {
    expectedSourceIdentity: identity,
    expectedWorktree: root
  })
  const receipts = receiptPaths.map((receiptPath) => JSON.parse(readFileSync(path.resolve(root, receiptPath), 'utf8')))
  const selectedContracts = catalog.contracts.filter((contract) => behaviorIds.includes(contract.id))
  const documentPaths = new Set(selectedContracts.flatMap((contract) => contract.documents))
  const scopedSectionCatalog = {
    ...sectionCatalog,
    sections: sectionCatalog.sections.filter((section) => documentPaths.has(section.documentPath))
  }
  const generated = processGeneratedFactSections({
    repositoryRoot: root,
    mode: 'check',
    catalog: scopedSectionCatalog,
    receipts,
    expectedIdentity: identity
  })
  const selectedClaims = claimReceipt.claims.filter((claim) => behaviorIds.includes(claim.declaration.behaviorId))
  const prose = verifyProseClaims({ claims: selectedClaims, receipts })
  if (!prose.ok) throw new Error(`prose exactness failed: ${prose.diagnostics.map((entry) => entry.message).join('; ')}`)
  const verifierDigests = {
    admission: admission.contentDigest,
    exactness: digestPath(root, 'tools/docs/behavior-doc-exactness.mjs'),
    generatedExecutor: digestPath(root, 'tools/docs/generated-fact-sections/generator.mjs'),
    generatedResult: digestValue(generated),
    proseExecutor: digestPath(root, 'tools/docs/prose-claim-verifier/verifier.mjs'),
    proseResult: digestValue(prose),
    mutationTests: digestPath(root, 'tests/tools/behavior-doc-exactness.test.mjs')
  }
  return {
    repositoryRoot: root, catalog, lifecycle, migrationLedger, claimReceipt, sectionCatalog,
    observationReceipts: receipts, domains: ['security'], selectedBehaviorIds: behaviorIds,
    sourceCommit: identity.sourceCommit, worktreeFingerprint: identity.worktreeFingerprint,
    scopeId, verifierDigests
  }
}

export function produceCurrentExactnessReceipt(root, receiptPaths, admissionPath)
{
  const inputs = loadCurrentExactnessInputs(root, receiptPaths, admissionPath)
  const receipt = buildBehaviorDocExactnessReceipt(inputs)
  validateBehaviorDocExactnessReceipt(receipt, {
    expectedSourceIdentity: {
      sourceCommit: inputs.sourceCommit,
      worktreeFingerprint: inputs.worktreeFingerprint
    }
  })
  return receipt
}

export function verifyCurrentExactnessReceipt(root, receiptPaths, admissionPath, expectedReceipt)
{
  return verifyBehaviorDocExactnessReplay(expectedReceipt, loadCurrentExactnessInputs(root, receiptPaths, admissionPath))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
  try
  {
    const options = parseArguments(process.argv.slice(2))
    if (options.mode === 'produce')
    {
      const receipt = produceCurrentExactnessReceipt(repositoryRoot, options.receipts, options.admission)
      writeFileSync(path.resolve(repositoryRoot, options.output), `${JSON.stringify(receipt, null, 2)}\n`)
      console.log(`[auth-security-doc-exactness] produced rows=${receipt.counts.verified} mutations=${receipt.mutationEvidence.killed}/${receipt.mutationEvidence.total}`)
    }
    else
    {
      const expected = JSON.parse(readFileSync(path.resolve(repositoryRoot, options.output), 'utf8'))
      const receipt = verifyCurrentExactnessReceipt(repositoryRoot, options.receipts, options.admission, expected)
      console.log(`[auth-security-doc-exactness] verified rows=${receipt.counts.verified} warnings=${receipt.counts.warnings}`)
    }
  }
  catch (error)
  {
    console.error(`[auth-security-doc-exactness] ${error.message}`)
    process.exitCode = 1
  }
}
