export const PUBLIC_COVER_SAFE_AREA = Object.freeze({
  leftPercent: 10,
  topPercent: 10,
  rightPercent: 90,
  bottomPercent: 90
})

export const PUBLIC_COVER_SAFE_AREA_TOKEN = 'center-80'
export const PUBLIC_COVER_OBJECT_POSITION = '50% 50%'

export type PublicCoverPresentation = Readonly<{
  url: string
  objectPosition: typeof PUBLIC_COVER_OBJECT_POSITION
  safeArea: typeof PUBLIC_COVER_SAFE_AREA_TOKEN
}>

export function normalizePublicCoverUrl(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim()
  return normalized || null
}

/**
 * Resolves the shared public-cover presentation used by the home lead and
 * article detail. Returning null is intentional: no usable asset means a
 * text-first layout, never an empty media placeholder.
 */
export function resolvePublicCoverPresentation(
  value: string | null | undefined
): PublicCoverPresentation | null {
  const url = normalizePublicCoverUrl(value)
  if (!url) {
    return null
  }

  return {
    url,
    objectPosition: PUBLIC_COVER_OBJECT_POSITION,
    safeArea: PUBLIC_COVER_SAFE_AREA_TOKEN
  }
}
