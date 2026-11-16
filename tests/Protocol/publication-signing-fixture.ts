import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { fixtureText } from './fixture-source.ts'

// Each caller gets independent test keys, never keys or serialization from the verifier.
export function publicationSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const fingerprint = createHash('sha256').update(spki).digest('hex')
  const signed = (file: string, project = (input: string) => input) => {
    const transcript = project(fixtureText(`${file}.txt`))
      .replace(/^keySha256:h:[a-f0-9]{64}$/m, `keySha256:h:${fingerprint}`)
    return sign('sha256', Buffer.from(transcript), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  }
  return { spki, fingerprint, signed }
}
