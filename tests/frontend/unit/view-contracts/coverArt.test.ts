import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PUBLIC_COVER_OBJECT_POSITION,
  PUBLIC_COVER_SAFE_AREA,
  PUBLIC_COVER_SAFE_AREA_TOKEN,
  normalizePublicCoverUrl,
  resolvePublicCoverPresentation
} from '@/view-contracts/coverArt'

type CoverArtManifest = Readonly<{
  cropSafeArea: Readonly<{
    token: string
    leftPercent: number
    topPercent: number
    rightPercent: number
    bottomPercent: number
  }>
  positiveExamples: ReadonlyArray<Readonly<{
    id: string
    path: string
    concept: string
    contentType: string
    embeddedArticleCopy: boolean
    darkSafe: boolean
  }>>
  negativeExamples: ReadonlyArray<Readonly<{
    id: string
    reason: string
  }>>
}>

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('public cover art contract', () => {
  it('normalizes a usable source and returns null for the text-first path', () => {
    expect(normalizePublicCoverUrl(null)).toBeNull()
    expect(normalizePublicCoverUrl('')).toBeNull()
    expect(normalizePublicCoverUrl('   ')).toBeNull()
    expect(normalizePublicCoverUrl('  /fixtures/evidence.svg  ')).toBe('/fixtures/evidence.svg')

    expect(resolvePublicCoverPresentation('   ')).toBeNull()
    expect(resolvePublicCoverPresentation('/fixtures/evidence.svg')).toEqual({
      url: '/fixtures/evidence.svg',
      objectPosition: PUBLIC_COVER_OBJECT_POSITION,
      safeArea: PUBLIC_COVER_SAFE_AREA_TOKEN
    })
  })

  it('keeps the shared crop contract at the center eighty-percent safe area', () => {
    expect(PUBLIC_COVER_SAFE_AREA_TOKEN).toBe('center-80')
    expect(PUBLIC_COVER_OBJECT_POSITION).toBe('50% 50%')
    expect(PUBLIC_COVER_SAFE_AREA).toEqual({
      leftPercent: 10,
      topPercent: 10,
      rightPercent: 90,
      bottomPercent: 90
    })
  })

  it('registers distinct semantic positive examples and explicit negative examples', () => {
    const manifest = JSON.parse(
      readRepoFile('src/frontend/public/fixtures/cover-art-manifest.json')
    ) as CoverArtManifest

    expect(manifest.cropSafeArea).toEqual({
      token: 'center-80',
      leftPercent: 10,
      topPercent: 10,
      rightPercent: 90,
      bottomPercent: 90
    })
    expect(manifest.positiveExamples).toHaveLength(5)
    expect(new Set(manifest.positiveExamples.map((example) => example.concept)).size).toBe(5)
    expect(new Set(manifest.positiveExamples.map((example) => example.contentType)).size).toBe(5)
    expect(manifest.positiveExamples.every((example) => example.embeddedArticleCopy === false)).toBe(true)
    expect(manifest.positiveExamples.every((example) => example.darkSafe)).toBe(true)
    expect(manifest.negativeExamples.map((example) => example.id)).toEqual([
      'article-title-card',
      'recolored-abstract-curve',
      'decorative-gradient-glow',
      'empty-media-placeholder'
    ])
  })

  it('keeps every reviewed SVG free of embedded article UI copy and decorative effects', () => {
    const manifest = JSON.parse(
      readRepoFile('src/frontend/public/fixtures/cover-art-manifest.json')
    ) as CoverArtManifest
    const articleCopy = [
      'Acceptance Public Article',
      'Acceptance Focus Smoke Note',
      'Acceptance Hot Read Note',
      'Public Preview Walkthrough',
      'AEDS And Public AOT Notes',
      '阅读全文'
    ]

    for (const example of manifest.positiveExamples) {
      const assetPath = `src/frontend/public${example.path}`
      const source = readRepoFile(assetPath)
      expect(source, assetPath).toContain(`data-cover-concept="${example.concept}"`)
      expect(source, assetPath).not.toContain('<text')
      expect(source, assetPath).not.toContain('<linearGradient')
      expect(source, assetPath).not.toContain('<radialGradient')
      expect(source, assetPath).not.toContain('<filter')
      expect(source, assetPath).not.toContain('<feDropShadow')
      for (const copy of articleCopy) {
        expect(source, `${assetPath} should not embed ${copy}`).not.toContain(copy)
      }
    }
  })
})
