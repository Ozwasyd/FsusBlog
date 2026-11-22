import { verifyPublicationHead, runCli } from './publication-attestation.mjs'
import { isCliEntry, readJson } from './verify-publication-proof.mjs'

export { verifyPublicationHead }

if (isCliEntry(import.meta)) runCli(([origin, keyFile, input]) => {
  if (process.argv.length !== 5) throw new Error('Usage: verify-publication-head.mjs HTTPS_ORIGIN KEYS_JSON HEAD_JSON')
  return verifyPublicationHead(readJson(input), readJson(keyFile), origin)
})
