import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import { parseMatrix } from '../test-matrix/parse-matrix.mjs'

// This is the last trusted master before retrospective post-baseline admission.
// Moving the anchor is a governance change, not a candidate-ledger operation.
export const POST_BASELINE_HISTORY_ANCHOR = 'd653afbde02b75814d8384777886b10419fb38a1'
// Freeze the compact before-snapshot cutoff for retrospective admission.
export const POST_BASELINE_BEFORE_ANCHOR = 'b144a2e54e655b6e363948cb9f6773a59cbf7be7'

const fullCommit = /^[0-9a-f]{40}$/u
const blobOid = /^[0-9a-f]{40}$/u
const testPath = /^tests\/(?:backend\/Unit\/[A-Za-z0-9_.-]+\.cs|[A-Za-z0-9_./-]+-baseline\.json)$/u

function git(root, args)
{
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
  })
}

function gitText(root, args, label)
{
  const result = git(root, args)
  if (result.status !== 0)
  {
    throw new Error(`${label}: ${String(result.stderr || `git exited ${result.status}`).trim()}`)
  }
  return result.stdout
}

function safePath(path)
{
  return typeof path === 'string' && testPath.test(path) && !path.split('/').includes('..')
}

function readRegularFile(root, path)
{
  const absolute = resolve(root, path)
  if (!lstatSync(absolute).isFile()) throw new Error('snapshot must be a regular file, not a symlink or directory')
  return readFileSync(absolute, 'utf8')
}

export function historicalXunitMethodPresent(source, className, methodName)
{
  if (typeof source !== 'string') return false
  const lines = source.split(/\r?\n/u)
  const classDeclaration = /^\s*(?:public|internal|private)\s+(?:sealed\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b/u
  const declaration = new RegExp(
    `^\\s*public\\s+(?:async\\s+)?(?:void|Task(?:<[^>]+>)?|ValueTask(?:<[^>]+>)?)\\s+${methodName}\\s*\\(`,
    'u'
  )
  let owner = null
  return lines.some((line, index) =>
  {
    const foundClass = classDeclaration.exec(line)
    if (foundClass) owner = foundClass[1]
    if (owner !== className || !declaration.test(line)) return false
    let previous = index - 1
    while (previous >= 0 && !lines[previous].trim()) previous -= 1
    return previous >= 0 && /^\s*\[(?:Fact|Theory)\]\s*$/u.test(lines[previous])
  })
}

function validateV2Record({ root, record, baseline, anchorCommit })
{
  const errors = []
  const match = /^xunit:(tests\/backend\/Unit\/[A-Za-z0-9_.-]+\.cs)#([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/u.exec(String(record?.id ?? ''))
  if (!match || !safePath(record?.path) || match[1] !== record.path || basename(record.path) !== `${match[2]}.cs`)
  {
    return [`${record?.id ?? '<missing id>'}: v2 history requires an exact legacy xUnit method and owner path`]
  }
  const [, path, className, methodName] = match
  let source
  let sourceOid
  let result
  let resultOid = null
  let anchor
  try
  {
    source = gitText(root, ['show', `${baseline.sourceCommit}:${path}`], `${record.id} source`)
    sourceOid = gitText(root, ['rev-parse', `${baseline.sourceCommit}:${path}`], `${record.id} source blob`).trim()
    const resultListedOid = gitText(root, ['ls-tree', '--object-only', baseline.deletionCommit, '--', path], `${record.id} deletion tree`).trim()
    if (resultListedOid)
    {
      result = gitText(root, ['show', `${baseline.deletionCommit}:${path}`], `${record.id} deletion result`)
      resultOid = resultListedOid
    }
    const anchorListedOid = gitText(root, ['ls-tree', '--object-only', anchorCommit, '--', path], `${record.id} trusted anchor tree`).trim()
    if (anchorListedOid)
    {
      anchor = gitText(root, ['show', `${anchorCommit}:${path}`], `${record.id} trusted anchor`)
    }
  }
  catch (error)
  {
    return [`${record.id}: ${error.message}`]
  }
  if (!blobOid.test(String(record.sourceBlobOid ?? '')) || record.sourceBlobOid !== sourceOid)
    errors.push(`${record.id}: source blob binding differs from Git history`)
  if (record.resultBlobOid !== resultOid)
    errors.push(`${record.id}: deletion-result blob binding differs from Git history`)
  if (!historicalXunitMethodPresent(source, className, methodName))
    errors.push(`${record.id}: old attributed method is absent from source commit`)
  if (historicalXunitMethodPresent(result, className, methodName))
    errors.push(`${record.id}: old attributed method survives deletion commit`)
  if (historicalXunitMethodPresent(anchor, className, methodName))
    errors.push(`${record.id}: old attributed method survives trusted master anchor`)
  if (sourceOid === resultOid)
    errors.push(`${record.id}: source and deletion-result blobs are identical`)
  return errors
}

export function validatePostBaselineHistory({
  root,
  paths,
  replacements,
  anchorCommit = POST_BASELINE_HISTORY_ANCHOR,
  beforeCommit = POST_BASELINE_BEFORE_ANCHOR,
  readCurrent = (path) => readRegularFile(root, path)
})
{
  const errors = []
  const ids = []
  const sources = []
  const replacementById = new Map(replacements.map((entry) => [entry.id, entry]))
  const observedIds = new Set()
  if (!Array.isArray(paths))
    return { ids, sources, errors: ['post-baseline paths must be an array'] }
  if (!fullCommit.test(anchorCommit) || !fullCommit.test(beforeCommit))
    return { ids, sources, errors: ['post-baseline history anchors must be full commits'] }

  let legacyPaths
  try
  {
    const anchorMatrix = parseMatrix(gitText(root, ['show', `${anchorCommit}:tests/matrix.yml`], 'trusted matrix'))
    legacyPaths = new Set(anchorMatrix.governance?.retention?.postBaselines ?? [])
  }
  catch (error)
  {
    return { ids, sources, errors: [`trusted post-baseline matrix unavailable: ${error.message}`] }
  }
  const currentPaths = new Set(paths)
  if (currentPaths.size !== paths.length)
    errors.push('post-baseline paths contain duplicates')
  for (const legacyPath of legacyPaths)
  {
    if (!currentPaths.has(legacyPath)) errors.push(`trusted post-baseline path removed: ${legacyPath}`)
  }
  for (const path of paths)
  {
    if (!safePath(path) || !path.endsWith('-baseline.json'))
    {
      errors.push(`unsafe post-baseline path: ${path}`)
      continue
    }
    let source
    let baseline
    try
    {
      source = readCurrent(path)
      baseline = JSON.parse(source)
    }
    catch (error)
    {
      errors.push(`${path}: cannot read post-baseline snapshot: ${error.message}`)
      continue
    }
    if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline))
    {
      errors.push(`${path}: post-baseline snapshot must be an object`)
      continue
    }
    const legacy = legacyPaths.has(path)
    if (legacy)
    {
      try
      {
        const trusted = gitText(root, ['show', `${anchorCommit}:${path}`], `${path} trusted blob`)
        if (source !== trusted) errors.push(`${path}: trusted v1 post-baseline bytes changed`)
      }
      catch (error)
      {
        errors.push(`${path}: ${error.message}`)
      }
    }
    else if (baseline.schema !== 'fsusblog.issue-acceptance-baseline.v2')
    {
      errors.push(`${path}: new post-baseline snapshot requires exact-history v2 schema`)
      continue
    }
    if (legacy && baseline.schema !== 'fsusblog.issue-acceptance-baseline.v1')
      errors.push(`${path}: trusted v1 post-baseline schema changed`)
    if (!legacy)
    {
      const sourceCommit = baseline.sourceCommit
      const deletionCommit = baseline.deletionCommit
      if (!fullCommit.test(String(sourceCommit ?? '')) || !fullCommit.test(String(deletionCommit ?? '')))
      {
        errors.push(`${path}: source and deletion commits must be full Git object IDs`)
        continue
      }
      try
      {
        const parents = gitText(root, ['rev-list', '--parents', '-n', '1', deletionCommit], `${path} deletion ancestry`).trim().split(' ')
        if (parents.length !== 2 || parents[0] !== deletionCommit || parents[1] !== sourceCommit)
          errors.push(`${path}: deletion commit must have source commit as its sole immediate parent`)
        const ancestor = git(root, ['merge-base', '--is-ancestor', deletionCommit, anchorCommit])
        if (ancestor.status !== 0) errors.push(`${path}: deletion commit is not in trusted master history`)
        const afterBefore = git(root, ['merge-base', '--is-ancestor', beforeCommit, sourceCommit])
        if (afterBefore.status !== 0) errors.push(`${path}: source commit predates trusted before snapshot`)
      }
      catch (error)
      {
        errors.push(`${path}: ${error.message}`)
        continue
      }
    }
    if (!Array.isArray(baseline.records) || baseline.records.length === 0)
    {
      errors.push(`${path}: post-baseline records are empty`)
      continue
    }
    if (!legacy && (baseline.expectedRecords !== baseline.records.length
      || baseline.expectedMigrated !== baseline.records.length))
      errors.push(`${path}: v2 expected counts must equal the exact migrated record count`)
    let accepted = 0
    for (const record of baseline.records)
    {
      if (record?.disposition !== 'migrated')
      {
        if (!legacy) errors.push(`${path}: v2 record is not migrated: ${record?.id ?? '<missing id>'}`)
        continue
      }
      const replacement = replacementById.get(record?.id)
      if (!replacement || replacement.path !== record?.path)
      {
        errors.push(`${path}: migrated record lacks an exact central replacement: ${record?.id ?? '<missing id>'}`)
        continue
      }
      if (observedIds.has(record.id)) errors.push(`${path}: duplicate post-baseline migrated ID: ${record.id}`)
      observedIds.add(record.id)
      if (!legacy)
        errors.push(...validateV2Record({ root, record, baseline, anchorCommit }))
      ids.push(record.id)
      accepted += 1
    }
    if (Number.isInteger(baseline.expectedMigrated) && accepted !== baseline.expectedMigrated)
      errors.push(`${path}: expected ${baseline.expectedMigrated} migrated records, found ${accepted}`)
    sources.push({ source: path, issue: baseline.issue, accepted })
  }
  return { ids: [...new Set(ids)], sources, errors }
}
