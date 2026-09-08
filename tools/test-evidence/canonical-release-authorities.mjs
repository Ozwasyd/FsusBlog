import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { verifyCanonicalReleaseAuthorityValues } from './canonical-release-authorities-value-contract.mjs'

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
      const current = fs.lstatSync(absolute, { bigint: true })
      if (resolve(file) !== absolute || !current.isFile() || current.isSymbolicLink()
        || current.nlink !== 1n || BigInt(bytes.length) !== before.size
        || ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].some(field =>
          before[field] !== after[field] || after[field] !== current[field]))
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

export function verifyCanonicalReleaseAuthorities({ candidatePlan: plan, rolloutEvidence, runtimeRoleAdmission, repositoryRoot })
{
  if (!plan || !repositoryRoot) fail('candidate plan and repository root are required')
  return verifyCanonicalReleaseAuthorityValues({
    candidatePlan: plan, rolloutEvidence, runtimeRoleAdmission, repositoryRoot,
    ...createCanonicalReleaseAuthorityReader(repositoryRoot),
    now: Date.now()
  })
}
