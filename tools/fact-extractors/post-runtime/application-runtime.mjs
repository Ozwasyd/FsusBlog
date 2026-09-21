import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { produceObservationReceipt, runObservationCli, validateObservationReceipt } from './adapter.mjs'

export function produceApplicationRuntimeObservation(inputs)
{
  return produceObservationReceipt({ ...inputs, scope: 'application' })
}

export function validateApplicationRuntimeObservation(receipt, options)
{
  const validated = validateObservationReceipt(receipt, options)
  if (validated.scope !== 'application') throw new Error('[application-runtime-observation] scope mismatch')
  return validated
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
  try
  {
    runObservationCli({
      argv: process.argv.slice(2),
      scope: 'application'
    })
  }
  catch (error)
  {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
