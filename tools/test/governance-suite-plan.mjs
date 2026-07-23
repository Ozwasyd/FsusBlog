import path from 'node:path'

export const governanceSuites = [
  {
    id: 'lifecycle-retention',
    isolation: 'none',
    patterns: [/test-(?:asset|lifecycle|suite)/u, /flaky/u, /observation/u, /historical-topology/u, /command-manifest/u]
  },
  {
    id: 'privacy-security',
    isolation: 'process',
    patterns: [/security/u, /privacy/u, /\bzk\b/u, /zap/u, /rights/u, /auth/u]
  },
  {
    id: 'matrix-producer',
    isolation: 'none',
    patterns: [/matrix/u, /resource/u, /build/u, /production/u, /worker-admission/u, /mutation/u, /run-once/u]
  },
  {
    id: 'artifact-receipt-evidence',
    isolation: 'none',
    patterns: [/artifact/u, /receipt/u, /evidence/u, /aeds-frame/u, /pod-binary/u, /wasm/u]
  },
  {
    id: 'release-fresh-projection',
    isolation: 'process',
    patterns: [/release/u, /deployment/u, /gateway/u, /runtime-publish/u, /public-aot/u, /performance/u, /migration/u, /backup/u]
  },
  {
    id: 'source-layout-naming',
    isolation: 'none',
    patterns: []
  }
]

function fileName(value) {
  return path.posix.basename(String(value).replaceAll('\\', '/')).toLowerCase()
}

export function governanceOwner(value) {
  const name = fileName(value)
  return governanceSuites.find((suite) => suite.patterns.some((pattern) => pattern.test(name)))
    ?? governanceSuites.at(-1)
}

export function buildGovernanceSuitePlan(files) {
  const unique = [...new Set(files)].sort()
  if (unique.length !== files.length) throw new Error('governance suite input contains duplicate files')
  const suites = governanceSuites.map((suite) => ({
    id: suite.id,
    isolation: suite.isolation,
    files: unique.filter((file) => governanceOwner(file).id === suite.id)
  })).filter((suite) => suite.files.length > 0)
  const assigned = suites.flatMap((suite) => suite.files)
  if (assigned.length !== unique.length) throw new Error('governance suite plan is not exact-once')
  return suites
}

export function serializeGovernanceSuitePlan(root, suites, source) {
  const portableSuites = suites.map((suite) => ({
    ...suite,
    files: suite.files.map((file) => path.relative(root, file).split(path.sep).join('/'))
  }))
  return {
    schema: 'fsusblog.node-governance-suite-plan.v1',
    source,
    suites: portableSuites,
    counts: {
      suites: portableSuites.length,
      files: portableSuites.reduce((count, suite) => count + suite.files.length, 0)
    }
  }
}

export function buildGovernancePolicyInventory(records) {
  return records
    .filter((record) => ['node-test', 'node-script', 'shell'].includes(record.framework))
    .map((record) => ({
      testId: record.id,
      path: record.path,
      framework: record.framework,
      policyOwner: governanceOwner(record.path).id,
      invariants: record.assertionTargets?.length > 0 ? record.assertionTargets : [`behavior:${path.posix.basename(record.path)}`],
      coverageIds: record.coverageIds ?? [],
      tierIds: record.tierIds ?? []
    }))
    .sort((left, right) => left.testId.localeCompare(right.testId))
}
