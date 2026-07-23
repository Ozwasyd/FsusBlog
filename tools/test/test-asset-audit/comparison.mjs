function replacementMap(manifest) {
  return new Map((manifest?.deletedTests ?? []).map((entry) => [entry.id, entry.replacementTestIds ?? []]))
}

function replacementAssertions(manifest) {
  return new Map((manifest?.assertionReplacements ?? []).map((entry) => [entry.before, entry.after ?? []]))
}

function replacementTiers(manifest) {
  return new Map((manifest?.tierReplacements ?? []).map((entry) => [entry.from, [entry.to]]))
}

function lostValues(field, previous, replacementRecords, replacementLookup = new Map()) {
  const live = new Set(replacementRecords.flatMap((entry) => entry[field] ?? []))
  return previous.filter((value) => {
    if (live.has(value)) return false
    const mapped = replacementLookup.get(value) ?? []
    return mapped.length === 0 || mapped.some((replacement) => !live.has(replacement))
  })
}

function compareReplacementEvidence(errors, id, previous, replacementRecords, replacements) {
  const lostAssertions = lostValues('assertionTargets', previous.assertionTargets ?? [], replacementRecords, replacementAssertions(replacements))
  if (lostAssertions.length > 0) errors.push(`replacement loses assertion or negative evidence for ${id}: ${lostAssertions.join(', ')}`)
  const lostCoverage = lostValues('coverageIds', previous.coverageIds ?? [], replacementRecords)
  if (lostCoverage.length > 0) errors.push(`replacement loses coverage evidence for ${id}: ${lostCoverage.join(', ')}`)
  const lostTiers = lostValues('tierIds', previous.tierIds ?? [], replacementRecords, replacementTiers(replacements))
  if (lostTiers.length > 0) errors.push(`replacement loses producer or release evidence for ${id}: ${lostTiers.join(', ')}`)
}

function compareRemovedTests(errors, before, after, replacements) {
  const afterIds = new Set(after.testIds)
  const beforeRecords = new Map((before.assignments ?? []).map((entry) => [entry.id, entry]))
  const afterRecords = new Map((after.assignments ?? []).map((entry) => [entry.id, entry]))
  const mapped = replacementMap(replacements)
  for (const id of before.testIds) {
    if (afterIds.has(id)) continue
    const replacementIds = mapped.get(id) ?? []
    if (replacementIds.length === 0 || replacementIds.some((replacement) => !afterIds.has(replacement))) {
      errors.push(`removed test ID has no live authoritative replacement: ${id}`)
      continue
    }
    const replacementRecords = replacementIds.map((replacement) => afterRecords.get(replacement)).filter(Boolean)
    compareReplacementEvidence(errors, id, beforeRecords.get(id) ?? {}, replacementRecords, replacements)
  }
}

export function compareAuditSnapshots(before, after, replacements) {
  const errors = []
  compareRemovedTests(errors, before, after, replacements)
  const afterCoverage = new Set(after.frontendCoverageUniverse.files)
  for (const file of before.frontendCoverageUniverse.files) {
    if (!afterCoverage.has(file)) errors.push(`frontend coverage universe shrank without an explicit production-file migration: ${file}`)
  }
  return errors
}
