import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { verifyCanonicalReleaseAuthorityValues } from './canonical-release-authorities-value-contract.mjs'
import { currentSchemaAuthorityReference, requireCurrentSchemaReceiptReference } from './release-authority-bundle-contract.mjs'

const fail = (message) => { throw new Error(`[canonical-release-authorities] ${message}`) }
const bytesDigest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
export const canonicalAuthorityMaxBytes = 64 * 1024 * 1024

export function createCanonicalReleaseAuthorityReader(repositoryRoot)
{
  const root = path.resolve(repositoryRoot)
  const resolve = (file) => {
    if (typeof file !== 'string' || file.length === 0 || file.includes('\\')
      || file.split('/').includes('..')) fail('evidence path contains traversal or is invalid')
    const absolute = path.resolve(root, file)
    if (!absolute.startsWith(`${root}${path.sep}`)
      || /(?:^|[/\\])(?:latest|history|historical)(?:[/\\]|$)/iu.test(file))
      fail('evidence path must be a current-run file inside the repository')
    if (fs.realpathSync(root) !== root) fail('repository root must be canonical and non-symlink')
    for (let cursor = absolute; cursor !== root; cursor = path.dirname(cursor))
    {
      const stat = fs.lstatSync(cursor)
      if (stat.isSymbolicLink()) fail('evidence path must not traverse a symlink')
      if (cursor === absolute && !stat.isFile()) fail('evidence input must be a regular file')
    }
    if (fs.realpathSync(absolute) !== absolute) fail('evidence path must be canonical and non-symlink')
    return absolute
  }
  const readBytes = (file) => {
    const absolute = resolve(file)
    const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try
    {
      const before = fs.fstatSync(descriptor, { bigint: true })
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(canonicalAuthorityMaxBytes))
        fail('evidence input must be a bounded regular single-link file')
      const bytes = fs.readFileSync(descriptor)
      const after = fs.fstatSync(descriptor, { bigint: true })
      const verificationDescriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      let verificationBefore
      let verificationAfter
      let verificationBytes
      try
      {
        verificationBefore = fs.fstatSync(verificationDescriptor, { bigint: true })
        verificationBytes = fs.readFileSync(verificationDescriptor)
        verificationAfter = fs.fstatSync(verificationDescriptor, { bigint: true })
      }
      finally
      {
        fs.closeSync(verificationDescriptor)
      }
      const current = fs.lstatSync(absolute, { bigint: true })
      if (resolve(file) !== absolute || !current.isFile() || current.isSymbolicLink()
        || current.nlink !== 1n || BigInt(bytes.length) !== before.size
        || !verificationBefore.isFile() || verificationBefore.nlink !== 1n
        || !bytes.equals(verificationBytes)
        || ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].some(field =>
          before[field] !== after[field]
          || after[field] !== verificationBefore[field]
          || verificationBefore[field] !== verificationAfter[field]
          || verificationAfter[field] !== current[field]))
        fail('evidence input changed while reading')
      return bytes
    }
    finally
    {
      fs.closeSync(descriptor)
    }
  }
  const readJson = (relative, label) => {
    if (typeof relative !== 'string' || !relative.endsWith('.json'))
      fail(`${label} requires a persisted current-run JSON file`)
    const absolute = resolve(relative)
    const bytes = readBytes(relative)
    const value = JSON.parse(bytes.toString('utf8'))
    return { value, ref: {
      path: path.relative(root, absolute).replaceAll(path.sep, '/'),
      fileDigest: bytesDigest(bytes), contentDigest: value?.contentDigest ?? null
    } }
  }
  return { readJson, readBytes }
}

export function verifyCanonicalReleaseAuthorities({ candidatePlan: plan, rolloutEvidence, runtimeRoleAdmission,
  currentSchemaReceiptRef, repositoryRoot })
{
  if (!plan || !repositoryRoot) fail('candidate plan and repository root are required')
  const reference = requireCurrentSchemaReceiptReference(currentSchemaReceiptRef)
  const authorities = verifyCanonicalReleaseAuthorityValues({
    candidatePlan: plan, rolloutEvidence, runtimeRoleAdmission, currentSchemaReceiptRef: reference, repositoryRoot,
    ...createCanonicalReleaseAuthorityReader(repositoryRoot),
    now: Date.now()
  })
  const verifiedReference = currentSchemaAuthorityReference(authorities)
  if (Object.keys(reference).some((field) => verifiedReference[field] !== reference[field]))
  {
    fail('current-schema verified reference differs from the explicit input')
  }
  // The pure value contract proves immutable bindings only. Neither those
  // values nor a pre-runtime code-model fixture proves that the owned native
  // command ran under this candidate's admitted post-runtime execution.
  // The original collector has no such typed consumer seam yet; until that
  // original owner is connected, do not emit any qualifying authority bundle.
  fail('current-schema post-runtime admitted native collector is not connected')
}
