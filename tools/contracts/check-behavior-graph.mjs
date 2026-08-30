#!/usr/bin/env node
/**
 * CLI: join sealed BehaviorGraph inputs. Never runs producers, scanners, or tests.
 *
 * Required inputs (paths to JSON receipts):
 *   --catalog
 *   --owner
 *   --test-evidence
 *   --doc-claim-parse
 *   --doc-claim-verification
 *   --generated-section-check
 *   --mutation-evidence
 *   --fact-observation (repeatable)
 *
 * Optional:
 *   --out <path>
 *   --json
 *   --assert
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertBehaviorGraphQualified,
  joinBehaviorGraph,
  root
} from './behavior-graph-join.mjs'

function parseArgs (argv)
{
  const options = {
    catalog: null,
    factExtractorRegistry: null,
    owner: null,
    testEvidence: null,
    docClaimParse: null,
    docClaimVerification: null,
    generatedSectionCheck: null,
    mutationEvidence: null,
    factObservations: [],
    out: null,
    json: false,
    assert: false,
    help: false
  }
  for (let index = 0; index < argv.length; index += 1)
  {
    const argument = argv[index]
    const next = () =>
    {
      const value = argv[++index]
      if (!value) throw new Error(`${argument} requires a value`)
      return path.resolve(root, value)
    }
    if (argument === '--catalog') options.catalog = next()
    else if (argument === '--fact-extractor-registry') options.factExtractorRegistry = next()
    else if (argument === '--owner') options.owner = next()
    else if (argument === '--test-evidence') options.testEvidence = next()
    else if (argument === '--doc-claim-parse') options.docClaimParse = next()
    else if (argument === '--doc-claim-verification') options.docClaimVerification = next()
    else if (argument === '--generated-section-check') options.generatedSectionCheck = next()
    else if (argument === '--mutation-evidence') options.mutationEvidence = next()
    else if (argument === '--fact-observation') options.factObservations.push(next())
    else if (argument === '--out') options.out = next()
    else if (argument === '--json') options.json = true
    else if (argument === '--assert') options.assert = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

function printHelp ()
{
  console.log(`Usage: node tools/contracts/check-behavior-graph.mjs [options]

Join sealed BehaviorCatalog / owner / fact / test / doc receipts into BehaviorGraphReceipt.
Does not scan source, parse Markdown, run tests, or invoke extractors.

Options:
  --catalog <path>
  --fact-extractor-registry <path>
  --owner <path>
  --test-evidence <path>
  --doc-claim-parse <path>
  --doc-claim-verification <path>
  --generated-section-check <path>
  --mutation-evidence <path>
  --fact-observation <path>   (repeatable)
  --out <path>
  --json
  --assert                    exit non-zero unless status=ok and all active behaviors qualify
`)
}

function requirePath (value, label)
{
  if (!value) throw new Error(`${label} is required`)
  if (!fs.existsSync(value)) throw new Error(`${label} not found: ${value}`)
  return value
}

const options = parseArgs(process.argv.slice(2))
if (options.help)
{
  printHelp()
  process.exit(0)
}

try
{
  const receipt = joinBehaviorGraph({
    catalog: requirePath(options.catalog, '--catalog'),
    factExtractorRegistry: requirePath(options.factExtractorRegistry, '--fact-extractor-registry'),
    ownerReceipt: requirePath(options.owner, '--owner'),
    testEvidenceReceipt: requirePath(options.testEvidence, '--test-evidence'),
    docClaimParseReceipt: requirePath(options.docClaimParse, '--doc-claim-parse'),
    docClaimVerificationReceipt: requirePath(options.docClaimVerification, '--doc-claim-verification'),
    generatedSectionCheckReceipt: requirePath(options.generatedSectionCheck, '--generated-section-check'),
    ...(options.mutationEvidence != null
      ? { mutationEvidenceReceipt: requirePath(options.mutationEvidence, '--mutation-evidence') }
      : {}),
    factObservationReceipts: options.factObservations.map((entry, index) =>
      requirePath(entry, `--fact-observation[${index}]`))
  })

  if (options.out)
  {
    fs.mkdirSync(path.dirname(options.out), { recursive: true })
    fs.writeFileSync(options.out, `${JSON.stringify(receipt, null, 2)}\n`)
  }

  if (options.json)
  {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  }
  else if (receipt.status === 'ok')
  {
    console.log(`[behavior-graph] ok behaviors=${receipt.behaviorNodes.length} digest=${receipt.contentDigest.slice(0, 12)}`)
  }
  else
  {
    console.error(`[behavior-graph] failed reasons=${receipt.failureReasons.length}`)
    for (const reason of receipt.failureReasons)
    {
      console.error(`- ${reason}`)
    }
  }

  if (options.assert)
  {
    assertBehaviorGraphQualified(receipt)
  }
  else if (receipt.status !== 'ok')
  {
    process.exitCode = 1
  }
}
catch (error)
{
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

export { joinBehaviorGraph, assertBehaviorGraphQualified }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
  // CLI entry already executed above.
}
