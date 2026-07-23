#!/usr/bin/env node
import {
  canonicalJson,
  requireChangedCriticalSourceState,
  sha256
} from './changed-critical-mutation-identity.mjs'
import {
  matchesChangedPath,
  normalizeChangedPath,
  resolveChangedCriticalSourceProject
} from './changed-critical-mutation-support.mjs'

export function validateChangedCriticalCatalog(catalog) {
  if (catalog?.schema !== 'fsusblog.changed-critical-mutation-catalog.v1' || catalog.version !== 1) {
    throw new Error('changed-critical mutation catalog must use schema version 1')
  }
  if (!Array.isArray(catalog.criticalSourcePatterns) || catalog.criticalSourcePatterns.length === 0) {
    throw new Error('catalog criticalSourcePatterns must be non-empty')
  }
  if (!Array.isArray(catalog.domains) || catalog.domains.length < 4) {
    throw new Error('catalog must declare at least four critical domains')
  }
  const ids = new Set()
  for (const domain of catalog.domains) {
    if (!domain?.id || ids.has(domain.id)) throw new Error(`catalog domain id is missing or duplicated: ${domain?.id}`)
    ids.add(domain.id)
    if (!domain.risk) throw new Error(`catalog domain ${domain.id} is missing risk`)
    if (!Array.isArray(domain.sourcePatterns) || domain.sourcePatterns.length === 0) {
      throw new Error(`catalog domain ${domain.id} is missing sourcePatterns`)
    }
    if (!Array.isArray(domain.testOwners) || domain.testOwners.length === 0) {
      throw new Error(`catalog domain ${domain.id} is missing testOwners`)
    }
    for (const owner of domain.testOwners) {
      if (!owner?.id || !owner?.filter) {
        throw new Error(`catalog domain ${domain.id} has an incomplete test owner`)
      }
    }
    if (
      !Array.isArray(domain.mutationPolicy?.sourceProjects)
      || domain.mutationPolicy.sourceProjects.length === 0
      || domain.mutationPolicy.requireExecutedMutants !== true
    ) {
      throw new Error(`catalog domain ${domain.id} has an incomplete mutationPolicy`)
    }
  }
  const defaults = catalog.defaults
  if (
    !defaults?.configuration
    || !defaults?.mutationLevel
    || !Number.isFinite(defaults?.thresholds?.high)
    || !Number.isFinite(defaults?.thresholds?.low)
    || !Number.isFinite(defaults?.thresholds?.break)
  ) {
    throw new Error('catalog defaults must declare configuration, mutationLevel, and thresholds')
  }
  return catalog
}

export function selectChangedCriticalMutation({
  catalog,
  rawCatalog,
  changedPaths,
  sourceState
}) {
  validateChangedCriticalCatalog(catalog)
  const normalizedSourceState = requireChangedCriticalSourceState(sourceState)
  const uniquePaths = [...new Set(changedPaths.map(normalizeChangedPath))].sort()
  const catalogBytes = rawCatalog ?? Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`)
  const catalogDigest = sha256(catalogBytes)
  const selectedDomains = new Map()
  const unmappedCriticalPaths = []

  for (const path of uniquePaths) {
    const domains = catalog.domains.filter((domain) => matchesChangedPath(path, domain.sourcePatterns))
    if (matchesChangedPath(path, catalog.criticalSourcePatterns) && domains.length === 0) {
      unmappedCriticalPaths.push(path)
      continue
    }
    for (const domain of domains) {
      const current = selectedDomains.get(domain.id) ?? {
        id: domain.id,
        risk: domain.risk,
        reasons: [],
        mutateFiles: [],
        sourceMappings: [],
        testOwners: domain.testOwners.map(({ id, filter }) => ({ id, filter }))
      }
      const sourceProject = resolveChangedCriticalSourceProject(path, domain.mutationPolicy.sourceProjects)
      current.reasons.push(`changed:${path}`)
      current.mutateFiles.push(path)
      current.sourceMappings.push({
        path,
        sourceProject,
        mutateFile: path.slice(sourceProject.length + 1)
      })
      selectedDomains.set(domain.id, current)
    }
  }

  if (unmappedCriticalPaths.length > 0) {
    throw new Error(
      `critical changed source is missing domain/test mapping: ${unmappedCriticalPaths.join(', ')}; missing fields: domain, testOwners, mutationPolicy`
    )
  }

  const domains = [...selectedDomains.values()]
    .map((domain) => ({
      ...domain,
      reasons: [...new Set(domain.reasons)].sort(),
      mutateFiles: [...new Set(domain.mutateFiles)].sort(),
      sourceMappings: [...new Map(
        domain.sourceMappings.map((mapping) => [`${mapping.sourceProject}:${mapping.path}`, mapping])
      ).values()].sort((left, right) => left.path.localeCompare(right.path)),
      testOwners: [...domain.testOwners].sort((left, right) => left.id.localeCompare(right.id))
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  const mutateFiles = [...new Set(domains.flatMap((domain) => domain.mutateFiles))].sort()
  const testOwners = [...new Map(
    domains.flatMap((domain) => domain.testOwners).map((owner) => [owner.id, owner])
  ).values()].sort((left, right) => left.id.localeCompare(right.id))
  const testFilter = [...new Set(testOwners.map((owner) => owner.filter))].sort().join('|')
  const sourceProjects = [...new Set(
    domains.flatMap((domain) => domain.sourceMappings.map(({ sourceProject }) => sourceProject))
  )].sort()
  const projectClosures = sourceProjects.map((sourceProject) => {
    const projectDomains = domains.filter((domain) =>
      domain.sourceMappings.some((mapping) => mapping.sourceProject === sourceProject))
    const projectTestOwners = [...new Map(
      projectDomains.flatMap((domain) => domain.testOwners).map((owner) => [owner.id, owner])
    ).values()].sort((left, right) => left.id.localeCompare(right.id))
    return {
      sourceProject,
      domains: projectDomains.map(({ id, risk }) => ({ id, risk })),
      mutateFiles: [...new Set(
        projectDomains.flatMap((domain) => domain.sourceMappings
          .filter((mapping) => mapping.sourceProject === sourceProject)
          .map(({ mutateFile }) => mutateFile))
      )].sort(),
      testOwners: projectTestOwners,
      testFilter: [...new Set(projectTestOwners.map((owner) => owner.filter))].sort().join('|')
    }
  })
  const base = {
    schema: 'fsusblog.changed-critical-mutation-selection.v1',
    status: domains.length === 0 ? 'empty' : 'selected',
    sourceState: normalizedSourceState,
    catalog: {
      path: 'config/testing/mutation/changed-critical-domains.v1.json',
      sha256: catalogDigest,
      version: catalog.version
    },
    changedPaths: uniquePaths,
    domains,
    mutateFiles,
    testOwners,
    testFilter,
    projectClosures,
    reasons: domains.flatMap((domain) => domain.reasons).sort()
  }
  return {
    ...base,
    closureDigest: sha256(canonicalJson(base))
  }
}

export function createChangedCriticalStrykerConfig(selection, catalog, sourceProject = null) {
  if (selection.status !== 'selected' || selection.mutateFiles.length === 0 || !selection.testFilter) {
    throw new Error('cannot generate Stryker config for an empty critical closure')
  }
  validateChangedCriticalCatalog(catalog)
  const selectedProject = sourceProject ?? selection.projectClosures[0]?.sourceProject
  const closure = selection.projectClosures.find((entry) => entry.sourceProject === selectedProject)
  if (!closure) throw new Error(`selection has no source-project closure for ${selectedProject}`)
  return {
    'stryker-config': {
      'test-projects': ['../../tests/backend/FsusBlog.Server.Tests.csproj'],
      configuration: catalog.defaults.configuration,
      'test-case-filter': closure.testFilter,
      'mutation-level': catalog.defaults.mutationLevel,
      thresholds: catalog.defaults.thresholds,
      'break-on-initial-test-failure': true,
      reporters: ['progress', 'html', 'json'],
      'report-file-name': 'changed-critical-mutation',
      mutate: closure.mutateFiles,
      'ignore-methods': catalog.defaults.ignoreMethods
    }
  }
}
