import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { produceObservationReceipt, runObservationCli } from './adapter.mjs'

export function produceReleaseDeploymentObservation(inputs)
{
  return produceObservationReceipt({ ...inputs, scope: 'release-deployment' })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
  try
  {
    runObservationCli({
      argv: process.argv.slice(2),
      scope: 'release-deployment',
      defaultOutput: '.tmp/post-runtime-observations/release-deployment.json'
    })
  }
  catch (error)
  {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
