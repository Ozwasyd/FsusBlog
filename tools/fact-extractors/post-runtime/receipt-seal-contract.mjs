import { digestValue, stable } from '../lib/canonicalize.mjs'

export function seal(value)
{
  const receipt = { ...stable(value), contentDigest: null }
  receipt.contentDigest = `sha256:${digestValue(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest')))}`
  return receipt
}
