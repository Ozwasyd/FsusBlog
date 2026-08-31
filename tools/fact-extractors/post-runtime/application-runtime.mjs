import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { produceObservationReceipt, runObservationCli } from './adapter.mjs'

export function produceApplicationRuntimeObservation(inputs)
{
  return produceObservationReceipt({ ...inputs, scope: 'application' })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
  try
  {
    runObservationCli({
      argv: process.argv.slice(2),
      scope: 'application',
      defaultOutput: '.tmp/post-runtime-observations/application-runtime.json'
    })
  }
  catch (error)
  {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
