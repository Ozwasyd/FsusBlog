import { describe, expect, it } from 'vitest'
import {
  normalizeManualScreenshotShardName,
  resolveDocsScreenshotRoot
} from '../../support/playwright/manualScreenshotConfiguration'

const namespace = 'public-preview-docs-4101'
const staging = `/repo/.tmp/public-preview-screenshots/${namespace}/staging`
const environment = {
  FSUSBLOG_PUBLIC_PREVIEW_STAGING_DIR: staging,
  FSUSBLOG_PUBLIC_PREVIEW_WRITER_NAMESPACE: namespace,
  FSUSBLOG_PUBLIC_PREVIEW_WRITER_PID: '4101',
  FSUSBLOG_REPOSITORY_ROOT: '/repo'
}

describe('manual screenshot writer configuration', () => {
  it('accepts only explicit shard-safe output names', () => {
    expect(normalizeManualScreenshotShardName(undefined)).toBeNull()
    expect(normalizeManualScreenshotShardName('desktop-light')).toBe('desktop-light')
    expect(() => normalizeManualScreenshotShardName('../docs')).toThrow(/must match/u)
    expect(() => normalizeManualScreenshotShardName('Desktop Light')).toThrow(/must match/u)
  })

  it('keeps ordinary manual shards outside the docs writer boundary', () => {
    expect(resolveDocsScreenshotRoot({
      publicPreviewDocsCapture: false,
      environment: {}
    })).toBeNull()
  })

  it('binds formal staging to the lock-owning namespace and pid', () => {
    expect(resolveDocsScreenshotRoot({
      publicPreviewDocsCapture: true,
      environment,
      readOwner: () => ({ namespace, pid: 4101 })
    })).toBe(staging)

    expect(() => resolveDocsScreenshotRoot({
      publicPreviewDocsCapture: true,
      environment: { ...environment, FSUSBLOG_PUBLIC_PREVIEW_STAGING_DIR: '/repo/docs/assets/screenshots' },
      readOwner: () => ({ namespace, pid: 4101 })
    })).toThrow(/staging path mismatch/u)

    expect(() => resolveDocsScreenshotRoot({
      publicPreviewDocsCapture: true,
      environment,
      readOwner: () => ({ namespace: 'another-writer', pid: 4102 })
    })).toThrow(/writer lock identity mismatch/u)
  })

  it('fails closed when formal writer identity is incomplete', () => {
    expect(() => resolveDocsScreenshotRoot({
      publicPreviewDocsCapture: true,
      environment: {},
      readOwner: () => ({ namespace, pid: 4101 })
    })).toThrow(/FSUSBLOG_PUBLIC_PREVIEW_WRITER_NAMESPACE is required/u)
  })
})
