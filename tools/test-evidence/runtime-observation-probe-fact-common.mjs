import { createHash } from 'node:crypto'

export const digestPattern = /^sha256:[a-f0-9]{64}$/u
export const fail = (message) => { throw new Error(`[runtime-observation-probe] ${message}`) }
export const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`

export function refreshHashDigest(value)
{
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/u.test(value))
  {
    fail('invalid observed refresh hash')
  }
  return sha(value.toLowerCase())
}
