#!/usr/bin/env node

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  explicitJson,
  produceAcceptedClaims,
  produceCandidateContext,
  produceCandidatePlan,
  produceClassReceipt,
  validateAcceptedClaims,
  validateCandidatePlan,
  writeReceipt
} from './adapter.mjs'

function fail(message) { throw new Error(`[post-runtime-current-run] ${message}`) }

function parse(argv)
{
  const [command, ...args] = argv
  const options = { observations: {} }
  for (let index = 0; index < args.length; index += 2)
  {
    const key = args[index]
    const value = args[index + 1]
    if (!value) fail(`${key} requires a value`)
    if (key === '--terminal') options.terminalReceipt = value
    else if (key === '--pre-runtime') options.preRuntimeReceipt = value
    else if (key === '--accepted-claims') options.acceptedClaimsReceipt = value
    else if (key === '--build') options.buildReceipt = value
    else if (key === '--context') options.context = value
    else if (key === '--class') options.classId = value
    else if (key === '--result') options.result = value
    else if (key === '--receipt') options.receipt = value
    else if (key === '--out') options.out = value
    else if (key === '--run-id') options.runId = value
    else if (key === '--attempt-id') options.attemptId = value
    else if (key === '--observation')
    {
      const separator = value.indexOf('=')
      if (separator < 1) fail('--observation must use class=path')
      options.observations[value.slice(0, separator)] = value.slice(separator + 1)
    }
    else fail(`unknown option ${key}`)
  }
  return { command, options }
}

export function runCurrentRunCli(argv, repositoryRoot)
{
  const { command, options } = parse(argv)
  let receipt
  if (command === 'accepted-claims')
  {
    receipt = produceAcceptedClaims({ terminalReceipt: options.terminalReceipt, repositoryRoot })
  }
  else if (command === 'candidate-context')
  {
    receipt = produceCandidateContext({
      preRuntimeReceipt: options.preRuntimeReceipt,
      runId: options.runId,
      attemptId: options.attemptId,
      repositoryRoot
    })
  }
  else if (command === 'candidate-plan')
  {
    if (!options.out) fail('candidate-plan requires --out so typed identity authorities have a canonical location')
    receipt = produceCandidatePlan({
      preRuntimeReceipt: options.preRuntimeReceipt,
      acceptedClaimsReceipt: options.acceptedClaimsReceipt,
      buildReceipt: options.buildReceipt,
      context: options.context,
      identityAuthorityDirectory: path.posix.join(path.posix.dirname(options.out.replaceAll(path.sep, '/')), 'identity-authorities'),
      observationPaths: options.observations,
      repositoryRoot
    })
  }
  else if (command === 'class-receipt')
  {
    receipt = produceClassReceipt({
      candidatePlan: options.receipt,
      classId: options.classId,
      result: options.result,
      repositoryRoot
    })
  }
  else if (command === 'verify-accepted-claims')
  {
    receipt = validateAcceptedClaims(explicitJson(options.receipt, 'accepted claims receipt', repositoryRoot).value, { repositoryRoot })
  }
  else if (command === 'verify-candidate-plan')
  {
    receipt = validateCandidatePlan(explicitJson(options.receipt, 'candidate plan', repositoryRoot).value, { repositoryRoot })
  }
  else fail('command must be accepted-claims, candidate-context, candidate-plan, class-receipt, verify-accepted-claims, or verify-candidate-plan')

  if (options.out) writeReceipt(options.out, receipt, repositoryRoot)
  console.log(`[post-runtime-current-run] ${command} status=${receipt.status} digest=${receipt.contentDigest}`)
  return receipt
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
  try { runCurrentRunCli(process.argv.slice(2), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')) }
  catch (error)
  {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
