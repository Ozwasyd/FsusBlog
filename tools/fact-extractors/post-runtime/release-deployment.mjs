import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { produceObservationReceipt, runObservationCli, validateObservationReceipt } from './adapter.mjs'

export function produceReleaseDeploymentObservation(inputs)
{
  return produceObservationReceipt({ ...inputs, scope: 'release-deployment' })
}

export function validateReleaseDeploymentObservation(receipt, options)
{
  const validated = validateObservationReceipt(receipt, options)
  if (validated.scope !== 'release-deployment') throw new Error('[release-deployment-observation] scope mismatch')
  return validated
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
  try
  {
    runObservationCli({
      argv: process.argv.slice(2),
      scope: 'release-deployment'
    })
  }
  catch (error)
  {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
