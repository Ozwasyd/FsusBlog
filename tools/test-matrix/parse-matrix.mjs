export function parseMatrixValue(raw) {
  const value = String(raw ?? '').trim()
  if (value === '[]') return []
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((item) => parseMatrixValue(item))
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

export function parseMatrix(text) {
  const matrix = { localProfiles: {}, tiers: [] }
  let section = null
  let currentProfile = null
  let currentBundle = null
  let currentTier = null
  let currentTierListField = null

  for (const rawLine of text.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, '')
    if (!withoutComment.trim()) continue

    const topMatch = withoutComment.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (topMatch && !rawLine.startsWith(' ')) {
      const [, key, value] = topMatch
      section = key
      currentProfile = null
      currentBundle = null
      currentTier = null
      currentTierListField = null
      if (key !== 'tiers' && key !== 'localProfiles') matrix[key] = parseMatrixValue(value)
      continue
    }

    if (section === 'localProfiles') {
      const profileMatch = withoutComment.match(/^\s{2}([A-Za-z][A-Za-z0-9_-]*):\s*$/)
      if (profileMatch) {
        currentProfile = { bundles: [] }
        matrix.localProfiles[profileMatch[1]] = currentProfile
        currentBundle = null
        continue
      }
      const profileFieldMatch = withoutComment.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
      if (profileFieldMatch && currentProfile) {
        const [, key, value] = profileFieldMatch
        if (key === 'bundles') {
          currentProfile.bundles = []
          currentBundle = null
        } else {
          currentProfile[key] = parseMatrixValue(value)
        }
        continue
      }
      const bundleMatch = withoutComment.match(/^\s{6}-\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
      if (bundleMatch && currentProfile) {
        currentBundle = {}
        currentProfile.bundles.push(currentBundle)
        currentBundle[bundleMatch[1]] = parseMatrixValue(bundleMatch[2])
        continue
      }
      const bundleFieldMatch = withoutComment.match(/^\s{8}([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
      if (bundleFieldMatch && currentBundle) {
        currentBundle[bundleFieldMatch[1]] = parseMatrixValue(bundleFieldMatch[2])
      }
      continue
    }

    if (section !== 'tiers') continue
    const itemMatch = withoutComment.match(/^\s{2}-\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (itemMatch) {
      currentTier = {}
      currentTierListField = null
      matrix.tiers.push(currentTier)
      currentTier[itemMatch[1]] = parseMatrixValue(itemMatch[2])
      continue
    }
    const fieldMatch = withoutComment.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (fieldMatch && currentTier) {
      const [, key, value] = fieldMatch
      if (value === '') {
        currentTier[key] = []
        currentTierListField = key
      } else {
        currentTier[key] = parseMatrixValue(value)
        currentTierListField = null
      }
      continue
    }
    const listItemMatch = withoutComment.match(/^\s{6}-\s+(.*?)\s*$/)
    if (listItemMatch && currentTier && currentTierListField) {
      currentTier[currentTierListField].push(parseMatrixValue(listItemMatch[1]))
    }
  }

  return matrix
}
