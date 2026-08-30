export const commitTypes = Object.freeze([
    'feat',
    'fix',
    'perf',
    'refactor',
    'style',
    'test',
    'docs',
    'build',
    'ci',
    'chore',
    'security',
    'revert'
])

export const commitScopes = Object.freeze([
    'admin',
    'aeds',
    'api',
    'auth',
    'backend',
    'build',
    'cache',
    'ci',
    'cmake',
    'contracts',
    'core',
    'cpp',
    'csharp',
    'database',
    'deployment',
    'docs',
    'frontend',
    'governance',
    'json',
    'markdown',
    'operations',
    'performance',
    'privacy',
    'public',
    'release',
    'security',
    'shared',
    'shell',
    'style',
    'test',
    'tooling',
    'wasm',
    'yaml',
    'zk'
])

export const changeClassifications = Object.freeze([
    'Behavior change',
    'Format-only',
    'Naming-only',
    'Generated output',
    'Public contract change',
    'External naming exception'
])

export const releaseNoteCategories = Object.freeze([
    Object.freeze({ category: 'Added', audience: 'user-facing', label: 'release-note:added' }),
    Object.freeze({ category: 'Changed', audience: 'user-facing', label: 'release-note:changed' }),
    Object.freeze({ category: 'Fixed', audience: 'user-facing', label: 'release-note:fixed' }),
    Object.freeze({ category: 'Security', audience: 'user-facing', label: 'release-note:security' }),
    Object.freeze({ category: 'Deprecated', audience: 'user-facing', label: 'release-note:deprecated' }),
    Object.freeze({ category: 'Removed', audience: 'user-facing', label: 'release-note:removed' }),
    Object.freeze({ category: 'Internal/Tooling', audience: 'internal', label: 'release-note:internal' }),
    Object.freeze({ category: 'none', audience: 'none', label: 'release-note:none' })
])

export const machineIdentifierExceptions = Object.freeze([
    Object.freeze({ kind: 'git-branch', convention: 'lowercase/kebab-case' }),
    Object.freeze({ kind: 'github-label', convention: 'lowercase/kebab-case with namespace colon' }),
    Object.freeze({ kind: 'test-id', convention: 'lowercase/kebab-case' }),
    Object.freeze({ kind: 'cli-key', convention: 'lowercase/kebab-case' })
])

// These migrations predate the executable footer contract introduced by
// #1163. Their immutable SHAs were independently reviewed and are the only
// grandfathered entries; every later blame-ignore revision must prove the
// current format-only contract from its own commit and diff.
export const reviewedLegacyFormatRevisions = Object.freeze([
    '892489472e27c85d277fb98c2c35969851294b58',
    'b5c116cd54e7a0a86fd243059502a3e23f364074',
    '4839b4e1bc9f8c181fad14889414c729cba3108c',
    '6e140ce9def52fb5120c48a377ef7a4a4fdf16c9',
    'dc804d61a416c12306724dc8fa8a251bc04da833',
    '98b7f65b0df3715ef21a5f4b9c6c9d6b39cfa01e',
    '2af86bc584f263d4177a5596da110ebbe8c67081',
    '5108de15b762877205b30527c0cdedccc2fe84c2',
    'b3dab49538a9b24d0047e387f20595b58c39c0c8',
    '553a3f4fafb7bcd2c8cb048a62d8378f153d59d7',
    '2d4101efba4e9b056a291ca4d1eed50cec07168f',
    '494b36e41942402cc35c5997bb0a6840e846af57',
    '465c8b3cf0387f157d5f82cf8bab5df1964ddf5a'
])

export const generatedPathPatterns = Object.freeze([
    '(?:^|/)generated(?:/|$)',
    '\\.generated\\.[^/]+$',
    '(?:^|/)cross-stack-contract-matrix\\.generated\\.json$'
])

export const generatedOutputRepairProducers = Object.freeze([
    Object.freeze({
        id: 'testing-docs',
        source: 'tests/matrix.yml',
        generator: 'tools/docs/generate-testing-docs.mjs',
        command: 'node tools/docs/generate-testing-docs.mjs --out docs/testing.generated.md',
        executable: 'node',
        arguments: Object.freeze([
            'tools/docs/generate-testing-docs.mjs',
            '--out',
            'docs/testing.generated.md'
        ]),
        outputs: Object.freeze([
            'docs/testing.generated.md'
        ])
    })
])

// A pull request is evaluated by the checker from its trusted base revision.
// These files define that checker or one of its release/review adapters, so a
// candidate PR cannot replace them while relying on the old checker to approve
// the replacement. They are advanced through an owner-controlled bootstrap
// push until GitHub branch protection can make the status check preventive.
export const trustedPolicyFiles = Object.freeze([
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/release.yml',
    '.github/workflows/change-contract.yml',
    'commitlint.config.mjs',
    'tools/governance/change-contract-registry.mjs',
    'tools/governance/change-contract.mjs',
    'tools/governance/check-change-contract.mjs'
])

export const changeContract = Object.freeze({
    schema: 'fsusblog.change-contract.v1',
    repository: 'Ozwasyd/FsusBlog',
    commitTypes,
    commitScopes,
    changeClassifications,
    releaseNoteCategories,
    machineIdentifierExceptions,
    reviewedLegacyFormatRevisions,
    generatedPathPatterns,
    generatedOutputRepairProducers,
    trustedPolicyFiles,
    evidenceSchemas: Object.freeze({
        externalNamingExceptions: 'fsusblog.external-naming-exceptions.v1',
        formatIdempotence: 'fsusblog.format-idempotence-evidence.v1',
        generatedOutput: 'fsusblog.generated-output-binding.v1',
        postMergeGeneratedOutputRepair: 'fsusblog.post-merge-generated-output-repair.v1',
        postMergeExternalNamingEvidenceRepair: 'fsusblog.post-merge-external-naming-evidence-repair.v1',
        performanceClaim: 'fsusblog.performance-claim-evidence.v1'
    }),
    summaryMaximumLength: 100,
    summaryMinimumLength: 12,
    performanceClaimLevels: Object.freeze(['none', 'S', 'M', 'R', 'C'])
})
