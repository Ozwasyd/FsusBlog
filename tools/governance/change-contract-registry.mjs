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
    }),
    Object.freeze({
        id: 'backend-evidence-path-authority',
        source: 'tests/matrix.yml',
        generator: 'tools/test/generate-backend-evidence-path-authority.mjs',
        command: 'node tools/test/generate-backend-evidence-path-authority.mjs --write',
        executable: 'node',
        arguments: Object.freeze([
            'tools/test/generate-backend-evidence-path-authority.mjs',
            '--write'
        ]),
        outputs: Object.freeze([
            'tests/backend/Fixtures/backend-evidence-path-authority.generated.json'
        ])
    })
])

// Historical exception for the exact #3203 repair candidate. The source blob
// was carried unchanged through #3201's second-parent merge, so Git's
// full-history path owner differs from the semantic source owner recorded by
// the repair. This immutable tuple does not define reusable policy: the
// checker must re-prove every named parent, first-parent edge, and path
// identity before accepting it.
export const generatedOutputRepairPassThroughExceptions = Object.freeze([
    Object.freeze({
        id: 'backend-evidence-path-authority-pr-3203',
        producerId: 'backend-evidence-path-authority',
        repairBase: '1ea60cecdc954e21cdfc9f9cafaa59e9e2e6582d',
        repairHead: '7a7095e576a78599d8121d9d5f022df3bae57e41',
        sourceCommit: '01828fc6e4e6c5769129b044e9de8490ed1ca29d',
        mergedPullRequest: 3195,
        mergeCommit: 'db1102e1171f15be970d60dc808c820e0ffe8dae',
        historyBoundaries: Object.freeze([
            'db1102e1171f15be970d60dc808c820e0ffe8dae',
            'c0e3127b5f88ea959dac31c13c8c06418f7b9905'
        ]),
        passThroughCommit: 'ea763f87c5c4c16b280140dbdb4dec5207bcdfdb',
        passThroughParents: Object.freeze([
            '1c0ddb634f3932419fbe549f7e4e225b74a15689',
            '179351a150241bd86eecb1a18d118b35f82edcc1'
        ]),
        outerPullRequest: 3201,
        outerMergeCommit: '2c52a0fd505ab79fc31171cb14981aeb8f065939',
        outerMergeParents: Object.freeze([
            '57c6380420933a6e40c477c88e2105533523e886',
            'eb55c976124f8c69f68717fdd65bc95ff53f9892'
        ]),
        sourceIdentity: '100644:0e576ed10e1280cb6a1a74cecb84ff39ebfef49b',
        sourceDivergenceIdentity: '100644:1715ef6023d8115b736fb123a82b595aee5930a9',
        sourceDivergenceRevisions: Object.freeze([
            'c0e3127b5f88ea959dac31c13c8c06418f7b9905',
            '1c0ddb634f3932419fbe549f7e4e225b74a15689'
        ]),
        generatorIdentity: '100644:c2babae5f58fee3b693a23e4203d0bcf34fbe227',
        outputs: Object.freeze([
            Object.freeze({
                path: 'tests/backend/Fixtures/backend-evidence-path-authority.generated.json',
                identity: '100644:36aa194319fc0c1ea6785982f86639a6f43a82a4'
            })
        ])
    })
])

// Reviewed #3241 history is an exact, finite exception, not an ancestry waiver.
// The seal includes ordered parents and regular object/mode entries at every
// reachable reviewed node. Replays retain each epoch's original tracked tree.
export const generatedOutputRepairDagReviewedHistories = Object.freeze([
    Object.freeze({
        producerId: 'evidence-location-governance',
        synchronizedRevision: 'e805a72c5171916f761701fc4dbd3116953d4d20',
        synchronizedMerge: '182ffa102d7c322be9e01e98e2d3ee38554f52b0',
        reviewedRevision: 'c7084b001a0c220538cbaca8f7305b1f3777493c',
        historySha256: '5c19bf753b05cceeb66fad8ef35994feb3b3e2ea45b73efa39c8f2eeda81e80a',
        legacyClosure: Object.freeze([
            Object.freeze({ path: 'tools/test/evidence-location-contract.mjs', mode: '100644', object: '84def85f972e8e9bc5e137b51847f7f71108c85d' }),
            Object.freeze({ path: 'tools/test/evidence-location-scanner.mjs', mode: '100644', object: 'c1a9bf9d5faa8c5271d0c14d5274907e0ac52b5a' }),
            Object.freeze({ path: 'tools/test/generate-evidence-location-governance.mjs', mode: '100644', object: '3db3e70048c2135ebde9c0903078835eaafe10ba' }),
            Object.freeze({ path: 'tools/test/generate-current-run-evidence-location-acceptance.mjs', mode: '100644', object: 'c65104f6c3cdb0d195196c27f4c9b981bcb7b3d2' })
        ]),
        sourceBranches: Object.freeze([
            Object.freeze({
                mergeCommit: '1cfc4db8ce0efffc14709884e6e01c4d01491bab',
                mergedPullRequest: 3217,
                transitions: Object.freeze(['ddb5af162b1c27aef341e32b748dc0a40ac872f2'])
            }),
            Object.freeze({
                mergeCommit: 'a43d256a50656475ab245db086010b4984227fea',
                mergedPullRequest: 3114,
                transitions: Object.freeze([
                    '15d52e8c3b4b8fbd349164bdef7872058d3506b5',
                    '23929008e1fda59bd770b12c6b3f618fa3d0838f',
                    'b15acc5b66a5b15238606f900d39e1447d846ff1',
                    '97acdd98ed87ba4c77a3be882dd7ec05f7d4e1f8',
                    'e6f1a2a8e207844dd834fa6e9834e9402d8ea660',
                    '319225fab0c02c5c126f20c607aaaadf01a22f25',
                    'c8b25af8eac90089a800f675b67a769461d600ad',
                    '6bbbc342ea2f852dd14da3961ee5d5c6eca2b413',
                    '7ff042276bcaa55d1bc935adf3d24d622c91734b',
                    '60796d0b808586ec08e69be1120f3023b741d64e',
                    '49845348385a1b2525e21ed7857cc5c2e648980e',
                    'b18ebb8c3a32bebfcb3f73ca94656b523056c1cb',
                    '1fb71faf6718b4b1f4bb3201f663b0293995e852',
                    'f155f8b2e2720420cce4b6bf61a7a7e671fbd866',
                    '94e4e8ca049eea384540da92b24310eb67973c29'
                ])
            })
        ])
    })
]);

// #3288 established a canonical source-head fixed point, but its ordinary
// outer merge integrated unrelated first-parent inputs and was therefore not
// itself a fixed point. This exact epoch anchor lets an owner bootstrap start
// after the already sealed #3241 history without turning stale outer merges or
// arbitrary policy/output commits into a reusable exception.
export const generatedOutputRepairDagEpochAnchors = Object.freeze([
    Object.freeze({
        schema: 'fsusblog.generated-output-repair-dag-epoch-anchor.v1',
        id: 'evidence-location-governance-pr-3288',
        producerId: 'evidence-location-governance',
        synchronizedRevision: '33b56d553a13c84c9c288acc92a75b9c0c86c3d7',
        synchronizedParent: '2d64d60d3bc2d91b87fe8975db5c5e2585b2f290',
        synchronizedTree: '6f7d95cd05e241f4013dc10b14f99d33fd4d6056',
        synchronizedMerge: '7a940a9990a5686c9a612c7c88c8e9acaba1e13d',
        synchronizedPullRequest: 3288,
        mergeParents: Object.freeze([
            '9fa2f72a550a5366e076094fbb346c6db6b697e5',
            '33b56d553a13c84c9c288acc92a75b9c0c86c3d7'
        ]),
        mergeTree: 'fdf0d9035b2fe0a4756e70ef54be0914acd67d45',
        historySha256: '5249baf2188ecf4c6afea247d5b6985ae20240903890ed657d9a5de8f101d75e',
        staleOuterOutputs: Object.freeze([
            'config/testing/evidence-location-migration-ledger.json',
            'config/testing/current-run-evidence-location-acceptance.json'
        ]),
        bootstrapBase: 'e0aac1abb1fd78b0e1774d50463093b35745bc14',
        bootstrapHistorySha256: 'e8360bac9c07ac4c9dc3d8b63ba41ff9d59e5ef7e2a919517e0c4d46887cd5ec',
        bootstrapOutputs: Object.freeze([
            'config/testing/evidence-locator-registry.json',
            'config/testing/evidence-location-migration-ledger.json',
            'config/testing/current-run-evidence-location-acceptance.json'
        ]),
        bootstrapChangedOutputs: Object.freeze([
            'config/testing/evidence-location-migration-ledger.json',
            'config/testing/current-run-evidence-location-acceptance.json'
        ]),
        bootstrapBindingManifest: 'artifacts/change-contract/generated-repair-history-bootstrap-binding.json',
        bootstrapExternalNamingManifest: 'artifacts/change-contract/generated-repair-history-bootstrap-external-naming.json',
        bootstrapSources: Object.freeze([
            'tools/governance/change-contract.mjs',
            'tools/governance/change-contract-registry.mjs'
        ]),
        bootstrapPaths: Object.freeze([
            'artifacts/change-contract/generated-repair-history-bootstrap-binding.json',
            'artifacts/change-contract/generated-repair-history-bootstrap-external-naming.json',
            'config/testing/current-run-evidence-location-acceptance.json',
            'config/testing/evidence-location-migration-ledger.json',
            'docs/development/change-contract.md',
            'tests/tools/change-contract.test.mjs',
            'tools/governance/change-contract-registry.mjs',
            'tools/governance/change-contract.mjs'
        ]),
        legacyClosure: Object.freeze([
            Object.freeze({ path: 'tools/test/evidence-location-contract.mjs', mode: '100644', object: '84def85f972e8e9bc5e137b51847f7f71108c85d' }),
            Object.freeze({ path: 'tools/test/evidence-location-scanner.mjs', mode: '100644', object: 'b6947e6697a087580bfcb20b4f31dde5ed36c880' }),
            Object.freeze({ path: 'tools/test/generate-evidence-location-governance.mjs', mode: '100644', object: 'fe127b3c6d6293a9ffe49854e533a0833cfb3822' }),
            Object.freeze({ path: 'tools/test/generate-current-run-evidence-location-acceptance.mjs', mode: '100644', object: 'c65104f6c3cdb0d195196c27f4c9b981bcb7b3d2' })
        ]),
        sourceBranches: Object.freeze([])
    })
]);

export const generatedOutputRepairDags = Object.freeze([
    Object.freeze({
        id: 'evidence-location-governance',
        manifest: 'artifacts/change-contract/evidence-location-governance-post-merge-repair.json',
        externalNamingManifest: 'artifacts/change-contract/evidence-location-governance-post-merge-repair-external-naming.json',
        semanticProjection: Object.freeze({
            id: 'fsusblog.evidence-location-scan.v1',
            output: 'config/testing/evidence-location-migration-ledger.json',
            digestField: 'scanDigest',
            entriesField: 'entries'
        }),
        steps: Object.freeze([
            Object.freeze({
                id: 'evidence-location-governance',
                generator: 'tools/test/generate-evidence-location-governance.mjs',
                command: 'node tools/test/generate-evidence-location-governance.mjs',
                executable: 'node',
                arguments: Object.freeze([
                    'tools/test/generate-evidence-location-governance.mjs'
                ]),
                generatorClosure: Object.freeze([
                    'tools/test/evidence-location-contract.mjs',
                    'tools/test/evidence-location-scanner.mjs',
                    'tools/test/generate-evidence-location-governance.mjs'
                ]),
                dependsOn: Object.freeze([]),
                consumes: Object.freeze([]),
                outputs: Object.freeze([
                    'config/testing/evidence-locator-registry.json',
                    'config/testing/evidence-location-migration-ledger.json'
                ])
            }),
            Object.freeze({
                id: 'current-run-evidence-location-acceptance',
                generator: 'tools/test/generate-current-run-evidence-location-acceptance.mjs',
                command: 'node tools/test/generate-current-run-evidence-location-acceptance.mjs',
                executable: 'node',
                arguments: Object.freeze([
                    'tools/test/generate-current-run-evidence-location-acceptance.mjs'
                ]),
                generatorClosure: Object.freeze([
                    'tools/test/evidence-location-contract.mjs',
                    'tools/test/evidence-location-scanner.mjs',
                    'tools/test/generate-evidence-location-governance.mjs',
                    'tools/test/generate-current-run-evidence-location-acceptance.mjs'
                ]),
                dependsOn: Object.freeze([
                    'evidence-location-governance'
                ]),
                consumes: Object.freeze([
                    'config/testing/evidence-locator-registry.json',
                    'config/testing/evidence-location-migration-ledger.json'
                ]),
                outputs: Object.freeze([
                    'config/testing/current-run-evidence-location-acceptance.json'
                ])
            })
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
    'config/schemas/post-merge-generated-output-repair-dag.schema.json',
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
    generatedOutputRepairPassThroughExceptions,
    generatedOutputRepairDags,
    generatedOutputRepairDagReviewedHistories,
    generatedOutputRepairDagEpochAnchors,
    trustedPolicyFiles,
    evidenceSchemas: Object.freeze({
        externalNamingExceptions: 'fsusblog.external-naming-exceptions.v1',
        formatIdempotence: 'fsusblog.format-idempotence-evidence.v1',
        generatedOutput: 'fsusblog.generated-output-binding.v1',
        postMergeGeneratedOutputRepair: 'fsusblog.post-merge-generated-output-repair.v1',
        postMergeGeneratedOutputRepairDag: 'fsusblog.post-merge-generated-output-repair-dag.v2',
        postMergeExternalNamingEvidenceRepair: 'fsusblog.post-merge-external-naming-evidence-repair.v1',
        performanceClaim: 'fsusblog.performance-claim-evidence.v1'
    }),
    summaryMaximumLength: 100,
    summaryMinimumLength: 12,
    performanceClaimLevels: Object.freeze(['none', 'S', 'M', 'R', 'C'])
})
