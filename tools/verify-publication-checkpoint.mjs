import { verifyPublicationCheckpoint, runCli } from './publication-attestation.mjs'
import { isCliEntry, readJson } from './verify-publication-proof.mjs'

export { verifyPublicationCheckpoint }

if (isCliEntry(import.meta)) runCli(([origin, keyFile, headFile, input, ...scopeArgs]) => {
  const kind = scopeArgs[0] === '--daily' ? 'daily' : 'release'
  if (kind === 'daily') scopeArgs.shift()
  const [scope, sequence, entrySha256, ...extra] = scopeArgs
  if (!scope || extra.length || ((sequence === undefined) !== (entrySha256 === undefined)))
    throw new Error('Usage: verify-publication-checkpoint.mjs HTTPS_ORIGIN KEYS_JSON HEAD_JSON CHECKPOINT_JSON RELEASE_ID|--daily YYYY-MM-DD [SEQ ENTRY_SHA256]')
  const expected = sequence === undefined ? undefined : { sequence, entrySha256 }
  return verifyPublicationCheckpoint(readJson(input), readJson(keyFile), readJson(headFile), origin, scope, expected, kind)
})
