import { readFileSync } from 'node:fs'
import path from 'node:path'

type Environment = Readonly<Record<string, string | undefined>>
type WriterOwner = Readonly<{ namespace?: unknown, pid?: unknown }>

function requiredEnvironment(environment: Environment, name: string): string {
  const value = environment[name]?.trim()
  if (!value) {
    throw new Error(`${name} is required for public-preview docs capture`)
  }
  return value
}

export function normalizeManualScreenshotShardName(raw: string | undefined): string | null {
  const value = raw?.trim()
  if (!value) {
    return null
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(value)) {
    throw new Error('FSUSBLOG_MANUAL_SCREENSHOT_SHARD_NAME must match ^[a-z0-9][a-z0-9_-]*$')
  }
  return value
}

export function resolveDocsScreenshotRoot({
  publicPreviewDocsCapture,
  environment = process.env,
  cwd = process.cwd(),
  readOwner
}: {
  publicPreviewDocsCapture: boolean
  environment?: Environment
  cwd?: string
  readOwner?: (file: string) => WriterOwner
}): string | null {
  if (!publicPreviewDocsCapture) {
    return null
  }

  const repositoryRoot = path.resolve(cwd, '../..')
  const namespace = requiredEnvironment(environment, 'FSUSBLOG_PUBLIC_PREVIEW_WRITER_NAMESPACE')
  const ownerPid = Number.parseInt(requiredEnvironment(environment, 'FSUSBLOG_PUBLIC_PREVIEW_WRITER_PID'), 10)
  const staging = path.resolve(requiredEnvironment(environment, 'FSUSBLOG_PUBLIC_PREVIEW_STAGING_DIR'))
  const expectedStaging = path.join(repositoryRoot, '.tmp/public-preview-screenshots', namespace, 'staging')
  if (staging !== expectedStaging) {
    throw new Error(`public-preview docs staging path mismatch: expected=${expectedStaging} actual=${staging}`)
  }
  const ownerFile = path.join(repositoryRoot, '.tmp/locks/public-preview-docs.lock/owner.json')
  const owner = readOwner
    ? readOwner(ownerFile)
    : JSON.parse(readFileSync(ownerFile, 'utf8')) as WriterOwner
  if (owner.namespace !== namespace || owner.pid !== ownerPid) {
    throw new Error(`public-preview docs writer lock identity mismatch: expected=${namespace} pid=${ownerPid}`)
  }
  return staging
}
