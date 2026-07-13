import fs from 'node:fs'
import path from 'node:path'

const messageMarker = 'sending data from testhost: '

function parseMessage(line) {
  const markerIndex = line.indexOf(messageMarker)
  if (markerIndex < 0) return null
  const raw = line.slice(markerIndex + messageMarker.length)
  try {
    return JSON.parse(raw)
  } catch (error) {
    if (raw.includes('"MessageType":"TestDiscovery.')) {
      throw new Error(`VSTest discovery diagnostic contains malformed protocol JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    return null
  }
}

function traitsForTest(test) {
  const traitProperties = (test?.Properties ?? []).filter((property) => property?.Key?.Id === 'TestObject.Traits')
  if (traitProperties.length > 1) throw new Error(`VSTest discovery repeated TestObject.Traits for ${test?.FullyQualifiedName ?? '<missing>'}`)
  const values = traitProperties[0]?.Value ?? []
  if (!Array.isArray(values)) throw new Error(`VSTest discovery emitted invalid traits for ${test?.FullyQualifiedName ?? '<missing>'}`)
  const traits = {}
  for (const trait of values) {
    const key = String(trait?.Key ?? '').trim()
    const value = String(trait?.Value ?? '').trim()
    if (!key || !value) throw new Error(`VSTest discovery emitted an empty trait for ${test?.FullyQualifiedName ?? '<missing>'}`)
    const entries = traits[key] ?? []
    entries.push(value)
    traits[key] = entries
  }
  return Object.fromEntries(Object.entries(traits).map(([key, entries]) => [key, [...new Set(entries)].sort()]))
}

export function parseVstestDiscoveryDiagnostic(text, { expectedSource } = {}) {
  const discovered = []
  let completed = null
  for (const line of String(text).split(/\r?\n/u)) {
    const message = parseMessage(line)
    if (!message) continue
    if (message.MessageType === 'TestDiscovery.TestFound') {
      if (!Array.isArray(message.Payload)) throw new Error('VSTest TestDiscovery.TestFound payload must be an array')
      discovered.push(...message.Payload)
    } else if (message.MessageType === 'TestDiscovery.Completed') {
      if (completed) throw new Error('VSTest discovery diagnostic contains multiple completion messages')
      completed = message.Payload
    }
  }
  if (!completed) throw new Error('VSTest discovery diagnostic is missing TestDiscovery.Completed')
  if (completed.IsAborted === true) throw new Error('VSTest discovery was aborted')
  if (!Array.isArray(completed.LastDiscoveredTests)) {
    throw new Error('VSTest discovery completion is missing LastDiscoveredTests')
  }
  discovered.push(...completed.LastDiscoveredTests)
  if (!Number.isInteger(completed.TotalTests) || completed.TotalTests <= 0 || completed.TotalTests !== discovered.length) {
    throw new Error(`VSTest discovery count mismatch: completed=${completed.TotalTests ?? '<missing>'} records=${discovered.length}`)
  }
  if (!Array.isArray(completed.FullyDiscoveredSources) || completed.FullyDiscoveredSources.length !== 1
    || (completed.PartiallyDiscoveredSources?.length ?? 0) !== 0
    || (completed.NotDiscoveredSources?.length ?? 0) !== 0
    || (completed.SkippedDiscoverySources?.length ?? 0) !== 0) {
    throw new Error('VSTest discovery did not fully discover exactly one source')
  }
  if (expectedSource && path.resolve(completed.FullyDiscoveredSources[0]) !== path.resolve(expectedSource)) {
    throw new Error('VSTest discovery completed for an unexpected source')
  }

  const ids = new Set()
  return discovered.map((test) => {
    const id = String(test?.Id ?? '').trim()
    const fullyQualifiedName = String(test?.FullyQualifiedName ?? '').trim()
    const displayName = String(test?.DisplayName ?? '').trim()
    const source = String(test?.Source ?? '').trim()
    if (!id || !fullyQualifiedName || !displayName || !source) {
      throw new Error('VSTest discovery emitted a test without ID, fully qualified name, display name, or source')
    }
    if (ids.has(id)) throw new Error(`VSTest discovery repeated test ID ${id}`)
    ids.add(id)
    if (expectedSource && path.resolve(source) !== path.resolve(expectedSource)) {
      throw new Error(`VSTest discovery test ${fullyQualifiedName} belongs to an unexpected source`)
    }
    return { id, fullyQualifiedName, displayName, source, traits: traitsForTest(test) }
  })
}

export function readVstestDiscoveryDiagnostic(directory, { expectedSource } = {}) {
  const hostFiles = fs.readdirSync(directory)
    .filter((name) => /^union\.host\..+\.txt$/u.test(name))
    .sort()
  if (hostFiles.length !== 1) {
    throw new Error(`expected exactly one VSTest union host diagnostic, received ${hostFiles.length}`)
  }
  const file = path.join(directory, hostFiles[0])
  return {
    file,
    records: parseVstestDiscoveryDiagnostic(fs.readFileSync(file, 'utf8'), { expectedSource })
  }
}

export function projectTraitMembership(records, traitName, expectedValues) {
  if (!Array.isArray(records) || records.length === 0) throw new Error('VSTest trait projection requires discovered tests')
  const expected = new Set(expectedValues)
  if (expected.size !== expectedValues.length || [...expected].some((value) => typeof value !== 'string' || !value)) {
    throw new Error('VSTest trait projection requires unique non-empty expected values')
  }
  const membership = Object.fromEntries(expectedValues.map((value) => [value, []]))
  for (const record of records) {
    for (const value of record.traits?.[traitName] ?? []) {
      if (expected.has(value)) membership[value].push(record.displayName)
    }
  }
  for (const [value, testNames] of Object.entries(membership)) {
    if (testNames.length === 0) throw new Error(`VSTest trait projection returned no tests for ${traitName}=${value}`)
  }
  return membership
}
