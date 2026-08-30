import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import commitlintConfig from '../../commitlint.config.mjs'
import {
    changeContract,
    changedFilesBetween,
    parseBlameIgnoreRevisions,
    validateBlameIgnoreRevisions,
    validateCommitRange,
    validateCommitMessage,
    validateFormatOnlyDiff,
    validateFormatOnlyPullRequest,
    validatePerformancePullRequest,
    validatePrContract,
    pullRequestActor,
    validateRepositoryBlameIgnore,
    validateRepositorySources
} from '../../tools/governance/change-contract.mjs'

const root = resolve(import.meta.dirname, '../..')
const fixtures = resolve(root, 'tests/fixtures/governance/change-contract')

function fixture(kind, name) {
    return readFileSync(resolve(fixtures, kind, name), 'utf8')
}

function writeRepositoryFile(repository, path, content) {
    const target = join(repository, path)
    mkdirSync(resolve(target, '..'), { recursive: true })
    writeFileSync(target, content)
}

function contentTreeDigest(repository, paths) {
    const hash = createHash('sha256')
    for (const path of [...paths].sort()) {
        hash.update(path)
        hash.update('\x00')
        hash.update(readFileSync(join(repository, path)))
        hash.update('\x00')
    }
    return hash.digest('hex')
}

function fileSha256(repository, path) {
    return createHash('sha256').update(readFileSync(join(repository, path))).digest('hex')
}

function writeFormatEvidence(repository, revision, paths = ['source.cs']) {
    const digest = contentTreeDigest(repository, paths)
    writeRepositoryFile(repository, 'artifacts/style/idempotence.json', `${JSON.stringify({
        schema: changeContract.evidenceSchemas.formatIdempotence,
        revision,
        formatter: {
            identity: 'dotnet-format',
            version: '10.0.0',
            command: 'dotnet format whitespace --no-restore'
        },
        paths,
        firstPassTreeSha256: digest,
        secondPassTreeSha256: digest,
        idempotent: true
    }, null, 4)}\n`)
}

function pullRequestBody({
    type = 'feat',
    formatOnly = false,
    namingOnly = false,
    generated = false,
    publicContract = false,
    externalNaming = false,
    externalExceptionManifest = 'none',
    audience = 'user-facing',
    category = 'Added',
    summary = null,
    claim = 'none',
    actor = 'none',
    generatorSource = 'tools/generate.mjs',
    generatedOutputs = 'src/generated/output.ts',
    generatedDigest = 'artifacts/generated/binding.json',
    externalExceptionId = 'c-abi-wasm-export',
    externalExceptionPaths = 'src/frontend/wasm/aeds/src/exports.cpp',
    externalExceptionReason = 'preserve the caller-visible C ABI spelling',
    contractImpact = publicContract ? 'compatible' : 'none'
} = {}) {
    const behavior = ['feat', 'fix', 'perf', 'security', 'revert'].includes(type)
    const check = (value) => value ? 'x' : ' '
    const releaseSummary = category === 'none' ? 'none' : (summary ?? 'expose article reading progress')
    return `## Linked Issue

Closes #1163

## Scope Summary

- Implement one reviewed change boundary.

## Change Classification

- [${check(behavior)}] Behavior change
- [${check(formatOnly)}] Format-only
- [${check(namingOnly)}] Naming-only
- [${check(generated)}] Generated output
- [${check(publicContract)}] Public contract change
- [${check(externalNaming)}] External naming exception
- Contract impact: ${contractImpact}

## Tests Run

- [x] Targeted governance tests

## UI Evidence

- [ ] Screenshots or video attached for UI changes
- [ ] Mobile layout checked
- [ ] Dark mode checked
- [ ] Accessibility and reduced-motion impact considered

## Coding Convention

- [x] C# mother-style mapping checked
- [x] Formatter/linter run
- [x] No tool default overrides repository style
- [x] Mechanical formatting separated from logic
- [x] \`.git-blame-ignore-revs\` updated when applicable

- Formatter identity: ${formatOnly ? 'dotnet-format' : 'none'}
- Formatter version: ${formatOnly ? '10.0.0' : 'none'}
- Formatter command: ${formatOnly ? 'dotnet format whitespace --no-restore' : 'none'}
- Formatter idempotence evidence: ${formatOnly ? 'artifacts/style/idempotence.json' : 'none'}
- Blame-ignore revision: ${formatOnly ? '0123456789abcdef0123456789abcdef01234567' : 'none'}

## External Naming Exception

- Exceptions manifest: ${externalNaming ? externalExceptionManifest : 'none'}
- Exception ID: ${externalNaming ? externalExceptionId : 'none'}
- Affected paths: ${externalNaming ? externalExceptionPaths : 'none'}
- Reason: ${externalNaming ? externalExceptionReason : 'none'}

## Documentation / Intent

- [x] Public API docs updated
- [x] Ownership/security/performance intent updated
- [x] Historical handoff archived or source-of-truth updated
- [x] TODO/FIXME references valid issues

## Compatibility And Risk

- [x] [Cross-language coding conventions](../docs/development/coding-conventions.md) reviewed
- [x] External wire / ABI / database / third-party names preserved or explicitly adapted
- [x] Public API impact reviewed
- [x] AEDS frame / binary contract impact reviewed
- [x] Database migration impact reviewed
- [x] Security, auth, moderation, PoW, or privacy impact reviewed
- [x] Docs updated or a reason is recorded below
- [x] Known limitations updated if applicable

## Performance Claim

- Claim level: ${claim}
- Evidence path: ${claim === 'none' ? 'none' : 'artifacts/performance/result.json'}
- Non-goals: no unrelated runtime changes

## Release Note

- Audience: ${audience}
- Category: ${category}
- Summary: ${releaseSummary}

## Generated Output

- Generator source: ${generated ? generatorSource : 'none'}
- Generated outputs: ${generated ? generatedOutputs : 'none'}
- Digest/evidence: ${generated ? generatedDigest : 'none'}
- Automation identity: ${actor}

## Rollout / Rollback

- Rollout: merge after the required status check
- Rollback: revert the issue-scoped commit
- Deferred work: none
- Known limitations: none

## Notes For Reviewers

All not-applicable review fields were considered for this fixture.
`
}

function commitFixture(repository, message) {
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', message], { cwd: repository })
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
}

function postMergeRepairBody() {
    return pullRequestBody({
        type: 'fix',
        generated: true,
        audience: 'internal',
        category: 'Internal/Tooling',
        summary: 'repair omitted generated test documentation',
        generatorSource: 'tests/matrix.yml',
        generatedOutputs: 'docs/testing.generated.md',
        generatedDigest: 'artifacts/change-contract/testing-docs-post-merge-repair.json'
    })
}

function createPostMergeRepairFixture({
    outputMode = 'canonical',
    mutateManifest = null,
    changeSource = false,
    laterSourceChange = false,
    baselineOutputStale = false
} = {}) {
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-post-merge-generated-repair-'))
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
    writeRepositoryFile(repository, 'tests/matrix.yml', 'base\n')
    writeRepositoryFile(repository, 'tools/docs/generate-testing-docs.mjs', `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
if (outIndex < 0 || !args[outIndex + 1]) throw new Error('missing --out')
const output = resolve(args[outIndex + 1])
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, \`generated:\${readFileSync('tests/matrix.yml', 'utf8')}\`)
`.trimStart())
    writeRepositoryFile(
        repository,
        'docs/testing.generated.md',
        baselineOutputStale ? 'generated:stale\n' : 'generated:base\n'
    )
    commitFixture(repository, 'fixture baseline')

    execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: repository })
    writeRepositoryFile(repository, 'tests/matrix.yml', 'expected\n')
    const sourceCommit = commitFixture(repository, 'fixture omitted generated source')
    execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository })
    execFileSync('git', [
        'merge',
        '--no-ff',
        '-qm',
        'Merge pull request #2973 from fixture/generated-source',
        'feature'
    ], { cwd: repository })
    const mergeCommit = execFileSync(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: repository, encoding: 'utf8' }
    ).trim()
    if (laterSourceChange) {
        writeRepositoryFile(repository, 'tests/matrix.yml', 'later\n')
        commitFixture(repository, 'fixture superseding source change')
    }
    const base = execFileSync(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: repository, encoding: 'utf8' }
    ).trim()
    const baseSha256 = fileSha256(repository, 'docs/testing.generated.md')

    execFileSync('git', ['checkout', '-qb', 'candidate'], { cwd: repository })
    if (outputMode === 'canonical') {
        execFileSync('node', [
            'tools/docs/generate-testing-docs.mjs',
            '--out',
            'docs/testing.generated.md'
        ], { cwd: repository })
    } else if (outputMode === 'tampered') {
        writeRepositoryFile(repository, 'docs/testing.generated.md', 'tampered\n')
    }
    if (changeSource) writeRepositoryFile(repository, 'tests/matrix.yml', 'candidate-source-change\n')

    const canonicalCurrent = createHash('sha256').update('generated:expected\n').digest('hex')
    const manifest = {
        schema: changeContract.evidenceSchemas.postMergeGeneratedOutputRepair,
        producerId: 'testing-docs',
        sourceCommit,
        mergedPullRequest: 2973,
        mergeCommit,
        source: {
            path: 'tests/matrix.yml',
            sha256: fileSha256(repository, 'tests/matrix.yml')
        },
        generator: {
            path: 'tools/docs/generate-testing-docs.mjs',
            sha256: fileSha256(repository, 'tools/docs/generate-testing-docs.mjs')
        },
        command: 'node tools/docs/generate-testing-docs.mjs --out docs/testing.generated.md',
        outputs: [
            {
                path: 'docs/testing.generated.md',
                baseSha256,
                expectedSha256: canonicalCurrent,
                currentSha256: fileSha256(repository, 'docs/testing.generated.md')
            }
        ]
    }
    if (mutateManifest) mutateManifest(manifest, repository)
    writeRepositoryFile(
        repository,
        'artifacts/change-contract/testing-docs-post-merge-repair.json',
        `${JSON.stringify(manifest, null, 4)}\n`
    )
    const head = commitFixture(repository, 'fixture generated repair candidate')
    return { repository, base, head, manifest }
}

function validatePostMergeRepairFixture(fixtureRepository) {
    return validatePrContract({
        title: 'fix(governance): repair omitted generated test documentation',
        body: postMergeRepairBody(),
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles: changedFilesBetween(
            fixtureRepository.repository,
            fixtureRepository.base,
            fixtureRepository.head
        ),
        root: fixtureRepository.repository,
        base: fixtureRepository.base,
        head: fixtureRepository.head,
        authorityRoot: null
    })
}

test('registry is the unique ordered type/scope source consumed by commitlint', () => {
    assert.deepEqual(changeContract.commitTypes, [
        'feat', 'fix', 'perf', 'refactor', 'style', 'test', 'docs', 'build', 'ci', 'chore', 'security', 'revert'
    ])
    assert.equal(new Set(changeContract.commitTypes).size, changeContract.commitTypes.length)
    assert.equal(new Set(changeContract.commitScopes).size, changeContract.commitScopes.length)
    assert.deepEqual(commitlintConfig.rules['type-enum'][2], changeContract.commitTypes)
    assert.deepEqual(commitlintConfig.rules['scope-enum'][2], changeContract.commitScopes)
    const externalNamingSchema = JSON.parse(readFileSync(
        resolve(root, 'config/schemas/external-naming-exceptions.schema.json'),
        'utf8'
    ))
    assert.equal(
        externalNamingSchema.properties.schema.const,
        changeContract.evidenceSchemas.externalNamingExceptions
    )
    const repairSchema = JSON.parse(readFileSync(
        resolve(root, 'config/schemas/post-merge-generated-output-repair.schema.json'),
        'utf8'
    ))
    assert.equal(
        repairSchema.properties.schema.const,
        changeContract.evidenceSchemas.postMergeGeneratedOutputRepair
    )
    assert.deepEqual(changeContract.generatedOutputRepairProducers.map((entry) => entry.id), [
        'testing-docs'
    ])
})

test('valid commit fixtures cover ordinary, perf, revert, security, breaking, and mechanical messages', () => {
    for (const name of ['feat.txt', 'perf.txt', 'revert.txt', 'security.txt', 'breaking.txt', 'format-only.txt', 'naming-only.txt']) {
        assert.deepEqual(validateCommitMessage(fixture('valid', name)), [], name)
    }
})

test('invalid type, scope, generic title, perf evidence, and public security detail are aggregated', () => {
    for (const name of ['type.txt', 'scope.txt', 'title.txt', 'perf-missing-evidence.txt', 'security-detail.txt']) {
        assert.ok(validateCommitMessage(fixture('invalid', name)).length > 0, name)
    }
    assert.match(validateCommitMessage(fixture('invalid', 'perf-missing-evidence.txt')).join('\n'), /Evidence/u)
    assert.match(validateCommitMessage(fixture('invalid', 'security-detail.txt')).join('\n'), /vulnerability detail/u)
    assert.match(validateCommitMessage(
        'feat(frontend): expose article reading progress\n\nRefs: #1163\n\nTrailing prose is not a footer.'
    ).join('\n'), /Refs/u)
    assert.match(validateCommitMessage(
        'feat(frontend): expose article reading progress\n\nRefs: #1163\nRefs: #1164'
    ).join('\n'), /Refs/u)
})

test('squash title uses the same type/scope/header contract without commit footers', () => {
    assert.deepEqual(validateCommitMessage('fix(backend): reject stale session state', { titleOnly: true }), [])
    assert.deepEqual(validateCommitMessage('feat(api)!: remove deprecated article field', { titleOnly: true }), [])
    assert.ok(validateCommitMessage('fix(other): reject stale session state', { titleOnly: true }).length > 0)
    assert.match(
        validateCommitMessage(
            'security(auth): document authentication bypass exploit chain',
            { titleOnly: true }
        ).join('\n'),
        /vulnerability detail/u
    )
    assert.match(
        validateCommitMessage(
            'refactor(cache): improve performance and throughput',
            { titleOnly: true }
        ).join('\n'),
        /must not claim performance/u
    )
})

test('PR contract accepts a fully classified user-facing behavior change', () => {
    const errors = validatePrContract({
        title: 'feat(frontend): expose article reading progress',
        body: pullRequestBody(),
        labels: ['release-note:added'],
        actor: 'maintainer',
        changedFiles: ['src/frontend/src/composables/useReadingProgress.ts']
    })
    assert.deepEqual(errors, [])
})

test('breaking squash title is bound to explicit public contract impact', () => {
    assert.deepEqual(validatePrContract({
        title: 'feat(api)!: remove deprecated article field',
        body: pullRequestBody({
            publicContract: true,
            contractImpact: 'breaking',
            category: 'Removed',
            summary: 'remove deprecated article field'
        }),
        labels: ['release-note:removed'],
        actor: 'maintainer',
        changedFiles: ['src/shared/Contracts/Outputs/ServerResponseContracts.cs']
    }), [])
})

test('PR fixture missing required classifications and fields fails closed', () => {
    const errors = validatePrContract({
        title: 'feat(frontend): expose article reading progress',
        body: fixture('invalid', 'pr-missing-classification.txt'),
        labels: ['release-note:added'],
        actor: 'maintainer',
        changedFiles: []
    })
    assert.ok(errors.some((error) => error.includes('classification checkbox')))
    assert.ok(errors.some((error) => error.includes('Performance Claim')))
})

test('PR parser rejects duplicate, fenced, and unchecked contract fields', () => {
    const title = 'feat(frontend): expose article reading progress'
    const common = {
        title,
        labels: ['release-note:added'],
        actor: 'maintainer',
        changedFiles: ['src/frontend/src/composables/useReadingProgress.ts']
    }
    const valid = pullRequestBody()

    const duplicateSection = validatePrContract({
        ...common,
        body: `${valid}\n## Release Note\n\n- Audience: user-facing\n- Category: Added\n- Summary: expose article reading progress\n`
    })
    assert.ok(duplicateSection.some((error) => error.includes('duplicate section')))

    const fencedHeading = validatePrContract({
        ...common,
        body: `\`\`\`markdown\n## Performance Claim\n\`\`\`\n${valid.replace('## Performance Claim', '### Performance Claim')}`
    })
    assert.ok(fencedHeading.some((error) => error.includes('missing ## Performance Claim')))

    const unchecked = validatePrContract({
        ...common,
        body: valid.replace('- [x] Formatter/linter run', '- [ ] Formatter/linter run')
    })
    assert.ok(unchecked.some((error) => error.includes('requires checked checklist field')))

    const duplicateField = validatePrContract({
        ...common,
        body: valid.replace(
            '- Summary: expose article reading progress',
            '- Summary: expose article reading progress\n- Summary: forged release text'
        )
    })
    assert.ok(duplicateField.some((error) => error.includes('duplicate field: Summary')))

    const fencedField = validatePrContract({
        ...common,
        body: valid.replace(
            '- [x] Formatter/linter run',
            '```markdown\n- [x] Formatter/linter run\n```'
        )
    })
    assert.ok(fencedField.some((error) => error.includes('Formatter/linter run')))

    const htmlHiddenField = validatePrContract({
        ...common,
        body: valid.replace(
            '- [x] Formatter/linter run',
            '<!-- - [x] Formatter/linter run -->'
        )
    })
    assert.ok(htmlHiddenField.some((error) => error.includes('Formatter/linter run')))

    const shortFenceClose = validatePrContract({
        ...common,
        body: valid.replace(
            '## Performance Claim\n\n- Claim level: none',
            '## Performance Claim\n\n````markdown\n- Claim level: none\n```'
        )
    })
    assert.ok(shortFenceClose.some((error) => error.includes('Claim level')))

    const emptyScope = validatePrContract({
        ...common,
        body: valid.replace(
            '- Implement one reviewed change boundary.',
            '- <!-- scope intentionally omitted -->'
        )
    })
    assert.ok(emptyScope.some((error) => error.includes('substantive Scope Summary')))
})

test('format-only and naming-only changes cannot enter user-facing release notes', () => {
    const body = pullRequestBody({
        type: 'style',
        formatOnly: true,
        audience: 'user-facing',
        category: 'Changed'
    })
    const errors = validatePrContract({
        title: 'style(csharp): normalize backend whitespace',
        body,
        labels: ['release-note:changed'],
        actor: 'maintainer',
        changedFiles: ['src/backend/Program.cs']
    })
    assert.ok(errors.some((error) => error.includes('cannot enter user-facing')))
})

test('release note category must agree with type, audience, and unique label', () => {
    const errors = validatePrContract({
        title: 'fix(frontend): reject stale article projection',
        body: pullRequestBody({
            type: 'fix',
            audience: 'user-facing',
            category: 'Added',
            summary: 'reject stale article projection'
        }),
        labels: ['release-note:fixed', 'release-note:added'],
        actor: 'maintainer',
        changedFiles: ['src/frontend/src/api/article.ts']
    })
    assert.ok(errors.some((error) => error.includes('fix cannot use release note category Added')))
    assert.ok(errors.some((error) => error.includes('exactly the release note label')))
})

test('release-note none is excluded with a literal none summary', () => {
    const title = 'chore(governance): document internal review contract'
    const body = pullRequestBody({
        type: 'chore',
        audience: 'none',
        category: 'none'
    })
    assert.deepEqual(validatePrContract({
        title,
        body,
        labels: ['release-note:none'],
        actor: 'maintainer',
        changedFiles: ['docs/development/change-contract.md']
    }), [])

    const drifted = validatePrContract({
        title,
        body: body.replace('- Summary: none', '- Summary: document internal review contract'),
        labels: ['release-note:none'],
        actor: 'maintainer',
        changedFiles: ['docs/development/change-contract.md']
    })
    assert.ok(drifted.some((error) => error.includes('Summary must be none')))
})

test('generated bot exception binds source, digest, and authenticated identity', () => {
    const actor = 'fixture-bot[bot]'
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-generated-pr-'))
    execFileSync('git', ['init', '-q'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
    writeRepositoryFile(repository, 'tools/generate.mjs', 'export const generator = true\n')
    writeRepositoryFile(repository, 'src/generated/output.ts', 'export const generated = true\n')
    const outputSha256 = createHash('sha256')
        .update(readFileSync(join(repository, 'src/generated/output.ts')))
        .digest('hex')
    writeRepositoryFile(repository, 'artifacts/generated/binding.json', `${JSON.stringify({
        schema: changeContract.evidenceSchemas.generatedOutput,
        sources: ['tools/generate.mjs'],
        outputs: [{ path: 'src/generated/output.ts', sha256: outputSha256 }]
    }, null, 4)}\n`)
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture generated head'], { cwd: repository })
    const changedFiles = [
        'tools/generate.mjs',
        'src/generated/output.ts',
        'artifacts/generated/binding.json'
    ]
    const body = pullRequestBody({
        type: 'chore',
        generated: true,
        audience: 'internal',
        category: 'Internal/Tooling',
        summary: 'refresh generated contract fixture',
        actor
    })
    assert.deepEqual(validatePrContract({
        title: 'chore(tooling): refresh generated contract fixture',
        body,
        labels: ['release-note:internal'],
        actor,
        changedFiles,
        root: repository,
        authorityRoot: null
    }), [])

    const wrongActor = validatePrContract({
        title: 'chore(tooling): refresh generated contract fixture',
        body: body.replace(actor, 'other-bot[bot]'),
        labels: ['release-note:internal'],
        actor,
        changedFiles,
        root: repository,
        authorityRoot: null
    })
    assert.ok(wrongActor.some((error) => error.includes('Automation identity')))

    const unboundGenerated = validatePrContract({
        title: 'chore(tooling): refresh generated contract fixture',
        body,
        labels: ['release-note:internal'],
        actor,
        changedFiles: [...changedFiles, 'src/generated/extra.ts'],
        root: repository,
        authorityRoot: null
    })
    assert.ok(unboundGenerated.some((error) => error.includes('missing from source/output bindings')))

    writeRepositoryFile(repository, 'src/generated/output.ts', 'export const generated = false\n')
    execFileSync('git', ['add', 'src/generated/output.ts'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture generated output tamper'], { cwd: repository })
    const tampered = validatePrContract({
        title: 'chore(tooling): refresh generated contract fixture',
        body,
        labels: ['release-note:internal'],
        actor,
        changedFiles,
        root: repository,
        authorityRoot: null
    })
    assert.ok(tampered.some((error) => error.includes('Generated output digest mismatch')))
})

test('post-merge generated repair binds exact history and isolated canonical replays', () => {
    const repair = createPostMergeRepairFixture()
    assert.deepEqual(validatePostMergeRepairFixture(repair), [])
})

test('post-merge generated repair rejects a source revision superseded at the current base', () => {
    const repair = createPostMergeRepairFixture({ laterSourceChange: true })
    assert.ok(validatePostMergeRepairFixture(repair).some(
        (error) => error.includes('sourceCommit must remain the current base owner')
    ))
})

test('post-merge generated repair rejects drift that predates the bound source revision', () => {
    const repair = createPostMergeRepairFixture({ baselineOutputStale: true })
    assert.ok(validatePostMergeRepairFixture(repair).some(
        (error) => error.includes('source parent was already out of sync')
    ))
})

test('post-merge generated repair rejects open discovery, stale bindings, and unknown commands', () => {
    const repair = createPostMergeRepairFixture({
        mutateManifest: (manifest) => {
            manifest.latest = 'docs/testing.generated.md'
            manifest.command = 'node tools/docs/generate-testing-docs.mjs --latest'
            manifest.source.sha256 = '0'.repeat(64)
            manifest.outputs[0].baseSha256 = '1'.repeat(64)
            manifest.outputs[0].expectedSha256 = '2'.repeat(64)
            manifest.outputs[0].currentSha256 = '3'.repeat(64)
        }
    })
    const errors = validatePostMergeRepairFixture(repair)
    assert.ok(errors.some((error) => error.includes('contains unsupported fields')))
    assert.ok(errors.some((error) => error.includes('command must match trusted producer')))
    assert.ok(errors.some((error) => error.includes('source changed or its current digest is stale')))
    assert.ok(errors.some((error) => error.includes('base output digest is stale')))
    assert.ok(errors.some((error) => error.includes('expected output digest is stale')))
    assert.ok(errors.some((error) => error.includes('current output digest is stale')))
})

test('post-merge generated repair rejects arbitrary history and extra outputs', () => {
    const arbitrary = createPostMergeRepairFixture({
        mutateManifest: (manifest, repository) => {
            manifest.sourceCommit = execFileSync(
                'git',
                ['rev-list', '--max-parents=0', 'HEAD'],
                { cwd: repository, encoding: 'utf8' }
            ).trim()
        }
    })
    assert.ok(validatePostMergeRepairFixture(arbitrary).some(
        (error) => error.includes('sourceCommit must have exactly one parent')
    ))

    const extra = createPostMergeRepairFixture({
        mutateManifest: (manifest, repository) => {
            writeRepositoryFile(repository, 'docs/extra.generated.md', 'extra\n')
            manifest.outputs.push({
                path: 'docs/extra.generated.md',
                baseSha256: '0'.repeat(64),
                expectedSha256: '0'.repeat(64),
                currentSha256: fileSha256(repository, 'docs/extra.generated.md')
            })
        }
    })
    const extraErrors = validatePostMergeRepairFixture(extra)
    assert.ok(extraErrors.some((error) => error.includes('outputs must exactly match trusted producer')))
})

test('post-merge generated repair rejects changed sources, unchanged outputs, and non-canonical bytes', () => {
    const changedSource = createPostMergeRepairFixture({ changeSource: true })
    const changedSourceErrors = validatePostMergeRepairFixture(changedSource)
    assert.ok(changedSourceErrors.some((error) => error.includes('source must not be changed in this PR')))
    assert.ok(changedSourceErrors.some((error) => error.includes('source changed or its current digest is stale')))

    const unchanged = createPostMergeRepairFixture({ outputMode: 'unchanged' })
    const unchangedErrors = validatePostMergeRepairFixture(unchanged)
    assert.ok(unchangedErrors.some((error) => error.includes('binding path is not changed in this PR')))
    assert.ok(unchangedErrors.some((error) => error.includes('output must be changed by the candidate')))

    const tampered = createPostMergeRepairFixture({ outputMode: 'tampered' })
    assert.ok(validatePostMergeRepairFixture(tampered).some(
        (error) => error.includes('output bytes are not canonical')
    ))
})

test('external naming exception binds a trusted registry ID to changed paths', () => {
    const title = 'refactor(wasm): preserve exported decoder adapter'
    const changedFiles = ['src/frontend/wasm/aeds/src/exports.cpp']
    const accepted = validatePrContract({
        title,
        body: pullRequestBody({
            type: 'refactor',
            externalNaming: true,
            audience: 'internal',
            category: 'Internal/Tooling',
            summary: 'preserve exported decoder adapter'
        }),
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles,
        root,
        authorityRoot: root
    })
    assert.deepEqual(accepted, [])
    const legacyBody = pullRequestBody({
        type: 'refactor',
        externalNaming: true,
        audience: 'internal',
        category: 'Internal/Tooling',
        summary: 'preserve exported decoder adapter'
    }).replace('- Exceptions manifest: none\n', '')
    assert.deepEqual(validatePrContract({
        title,
        body: legacyBody,
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles,
        root,
        authorityRoot: root
    }), [])

    const missingClassification = validatePrContract({
        title,
        body: pullRequestBody({
            type: 'refactor',
            audience: 'internal',
            category: 'Internal/Tooling',
            summary: 'preserve exported decoder adapter'
        }),
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles,
        root,
        authorityRoot: root
    })
    assert.ok(missingClassification.some((error) => error.includes('require External naming exception')))

    const unregistered = validatePrContract({
        title,
        body: pullRequestBody({
            type: 'refactor',
            externalNaming: true,
            audience: 'internal',
            category: 'Internal/Tooling',
            summary: 'preserve exported decoder adapter'
        }).replace('c-abi-wasm-export', 'unknown-exception'),
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles,
        root,
        authorityRoot: root
    })
    assert.ok(unregistered.some((error) => error.includes('is not registered')))

    const partialBinding = validatePrContract({
        title,
        body: pullRequestBody({
            type: 'refactor',
            externalNaming: true,
            audience: 'internal',
            category: 'Internal/Tooling',
            summary: 'preserve exported decoder adapter'
        }),
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles: [
            ...changedFiles,
            'src/frontend/wasm/search/src/search_index.cpp'
        ],
        root,
        authorityRoot: root
    })
    assert.ok(partialBinding.some((error) => error.includes('exactly match all changed registered naming surfaces')))
})

test('external naming manifest binds multiple exception IDs to disjoint governed paths', () => {
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-external-naming-pr-'))
    execFileSync('git', ['init', '-q'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
    const changedFiles = [
        'src/frontend/wasm/aeds/src/exports.cpp',
        'tools/bootstrap-acceptance-env.sh',
        'tools/test/bundles/runtime-environment.mjs',
        'artifacts/change-contract/external-naming-exceptions.json'
    ]
    for (const path of changedFiles.slice(0, -1)) writeRepositoryFile(repository, path, 'fixture\n')
    writeRepositoryFile(repository, changedFiles.at(-1), `${JSON.stringify({
        schema: changeContract.evidenceSchemas.externalNamingExceptions,
        exceptions: [
            {
                id: 'c-abi-wasm-export',
                paths: ['src/frontend/wasm/aeds/src/exports.cpp'],
                reason: 'preserve the caller-visible C ABI spelling'
            },
            {
                id: 'acceptance-secret-runtime-environment',
                paths: [
                    'tools/bootstrap-acceptance-env.sh',
                    'tools/test/bundles/runtime-environment.mjs'
                ],
                reason: 'preserve the run-bound secret environment keys across both owners'
            }
        ]
    }, null, 4)}\n`)
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture candidate'], { cwd: repository })
    const body = pullRequestBody({
        type: 'fix',
        externalNaming: true,
        externalExceptionManifest: changedFiles.at(-1),
        externalExceptionId: 'none',
        externalExceptionPaths: 'none',
        externalExceptionReason: 'none',
        audience: 'internal',
        category: 'Internal/Tooling',
        summary: 'bind multiple external naming exceptions'
    })
    assert.deepEqual(validatePrContract({
        title: 'fix(governance): bind multiple external naming exceptions',
        body,
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles,
        root: repository,
        authorityRoot: root
    }), [])
})

test('external naming manifest rejects broad, duplicate, and incomplete path assignments', () => {
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-external-naming-negative-'))
    execFileSync('git', ['init', '-q'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
    const manifestPath = 'artifacts/change-contract/external-naming-exceptions.json'
    const changedFiles = [
        'src/frontend/wasm/aeds/src/exports.cpp',
        'tools/bootstrap-acceptance-env.sh',
        manifestPath
    ]
    for (const path of changedFiles.slice(0, -1)) writeRepositoryFile(repository, path, 'fixture\n')
    writeRepositoryFile(repository, manifestPath, `${JSON.stringify({
        schema: changeContract.evidenceSchemas.externalNamingExceptions,
        exceptions: [
            {
                id: 'c-abi-wasm-export',
                paths: ['src/frontend/wasm/aeds/src/exports.cpp'],
                reason: 'preserve the caller-visible C ABI spelling'
            },
            {
                id: 'shell-environment-variable',
                paths: [
                    'src/frontend/wasm/aeds/src/exports.cpp',
                    'tools/not-changed.sh'
                ],
                reason: 'attempt to broaden one exception across unrelated owners'
            }
        ]
    }, null, 4)}\n`)
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture candidate'], { cwd: repository })
    const body = pullRequestBody({
        type: 'fix',
        externalNaming: true,
        externalExceptionManifest: manifestPath,
        externalExceptionId: 'none',
        externalExceptionPaths: 'none',
        externalExceptionReason: 'none',
        audience: 'internal',
        category: 'Internal/Tooling',
        summary: 'reject broad external naming declarations'
    })
    const errors = validatePrContract({
        title: 'fix(governance): reject broad external naming declarations',
        body,
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles,
        root: repository,
        authorityRoot: root
    })
    assert.ok(errors.some((error) => error.includes('assigned to more than one exception')))
    assert.ok(errors.some((error) => error.includes('outside registered exception shell-environment-variable')))
    assert.ok(errors.some((error) => error.includes('not changed in this PR')))
    assert.ok(errors.some((error) => error.includes('exactly match all changed registered naming surfaces')))
})

test('runtime environment exception atomically binds the canonical projection and shell executor', () => {
    const title = 'fix(test): map final-image release root'
    const changedFiles = [
        'tools/test/release-reliability-runtime-environment.mjs',
        'tools/test/run-release-reliability-qualified-local.sh'
    ]
    const body = pullRequestBody({
        type: 'fix',
        externalNaming: true,
        audience: 'internal',
        category: 'Internal/Tooling',
        summary: 'map final-image release root',
        externalExceptionId: 'release-reliability-runtime-environment',
        externalExceptionPaths: changedFiles.join(', '),
        externalExceptionReason: 'keep the same caller-visible process environment keys atomic across their canonical projection and sole shell executor'
    })
    assert.deepEqual(validatePrContract({
        title,
        body,
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles,
        root,
        authorityRoot: root
    }), [])

    const expanded = validatePrContract({
        title,
        body,
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles: [...changedFiles, 'tools/test/another-runtime-owner.mjs'],
        root,
        authorityRoot: root
    })
    assert.ok(expanded.some((error) => error.includes('exactly match all changed registered naming surfaces')))
})

test('acceptance secret exception atomically binds the bootstrap producer and runtime collector', () => {
    const title = 'fix(test): generate valid acceptance keys'
    const changedFiles = [
        'tools/bootstrap-acceptance-env.sh',
        'tools/test/bundles/runtime-environment.mjs'
    ]
    const body = pullRequestBody({
        type: 'fix',
        externalNaming: true,
        audience: 'internal',
        category: 'Internal/Tooling',
        summary: 'generate valid acceptance keys',
        externalExceptionId: 'acceptance-secret-runtime-environment',
        externalExceptionPaths: changedFiles.join(', '),
        externalExceptionReason: 'keep the same run-bound secret environment keys atomic across their bootstrap producer and sole runtime collector'
    })
    assert.deepEqual(validatePrContract({
        title,
        body,
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles,
        root,
        authorityRoot: root
    }), [])

    const expanded = validatePrContract({
        title,
        body,
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles: [...changedFiles, 'tools/test/another-secret-owner.mjs'],
        root,
        authorityRoot: root
    })
    assert.ok(expanded.some((error) => error.includes('exactly match all changed registered naming surfaces')))
})

test('performance claim binds one perf commit and the exact evidence blobs', () => {
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-performance-pr-'))
    execFileSync('git', ['init', '-q'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
    writeRepositoryFile(repository, '.git-blame-ignore-revs', '')
    writeRepositoryFile(repository, 'src/cache.ts', 'export const cacheReads = 2\n')
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture base'], { cwd: repository })
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()

    writeRepositoryFile(repository, 'src/cache.ts', 'export const cacheReads = 1\n')
    execFileSync('git', ['add', 'src/cache.ts'], { cwd: repository })
    execFileSync('git', ['commit', '-qF', resolve(fixtures, 'valid', 'perf.txt')], { cwd: repository })
    const performanceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8'
    }).trim()

    writeRepositoryFile(repository, 'artifacts/performance/hot-read-result.json', '{"p95Ms":12.5}\n')
    writeRepositoryFile(repository, 'artifacts/performance/hot-read.json', `${JSON.stringify({
        schema: changeContract.evidenceSchemas.performanceClaim,
        changeRevision: performanceRevision,
        claimLevel: 'R',
        status: 'measured',
        evidence: [{
            path: 'artifacts/performance/hot-read-result.json',
            sha256: fileSha256(repository, 'artifacts/performance/hot-read-result.json')
        }]
    }, null, 4)}\n`)
    execFileSync('git', ['add', 'artifacts/performance'], { cwd: repository })
    execFileSync('git', [
        'commit',
        '-qm',
        'chore(performance): bind measured performance evidence\n\nRefs: #1163'
    ], { cwd: repository })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    const evidencePath = 'artifacts/performance/hot-read.json'
    const changedFiles = changedFilesBetween(repository, base, head)
    const body = pullRequestBody({
        type: 'perf',
        audience: 'user-facing',
        category: 'Changed',
        summary: 'reduce measured hot-read latency',
        claim: 'R'
    }).replace('artifacts/performance/result.json', evidencePath)

    assert.deepEqual(validatePrContract({
        title: 'perf(cache): reduce measured hot-read latency',
        body,
        labels: ['release-note:changed'],
        actor: 'maintainer',
        changedFiles,
        root: repository,
        head,
        authorityRoot: null
    }), [])
    assert.deepEqual(validatePerformancePullRequest(repository, base, head, evidencePath), [])
    assert.deepEqual(validateCommitRange(repository, `${base}..${head}`), [])

    writeRepositoryFile(repository, 'artifacts/performance/hot-read-result.json', '{"p95Ms":99}\n')
    execFileSync('git', ['add', 'artifacts/performance/hot-read-result.json'], { cwd: repository })
    execFileSync('git', [
        'commit',
        '-qm',
        'test(performance): tamper performance evidence fixture\n\nRefs: #1163'
    ], { cwd: repository })
    assert.match(
        validatePerformancePullRequest(repository, base, 'HEAD', evidencePath).join('\n'),
        /Performance evidence digest mismatch/u
    )

    const nonPerfClaim = validatePrContract({
        title: 'feat(cache): expose cache read diagnostics',
        body: pullRequestBody({
            summary: 'expose cache read diagnostics',
            claim: 'R'
        }).replace('artifacts/performance/result.json', evidencePath),
        labels: ['release-note:added'],
        actor: 'maintainer',
        changedFiles: changedFilesBetween(repository, base, 'HEAD'),
        root: repository,
        authorityRoot: null
    })
    assert.ok(nonPerfClaim.some((error) => error.includes('require a perf PR title')))
})

test('format-only diff rejects semantic contract and test expectation changes', () => {
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-change-contract-'))
    execFileSync('git', ['init', '-q'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
    writeFileSync(join(repository, 'contract.json'), '{"expected":"alpha"}\n')
    execFileSync('git', ['add', 'contract.json'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture base'], { cwd: repository })
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()

    writeFileSync(join(repository, 'contract.json'), '{  "expected":  "alpha"  }\n')
    execFileSync('git', ['add', 'contract.json'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture whitespace'], { cwd: repository })
    const whitespace = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    assert.deepEqual(validateFormatOnlyDiff(repository, base, whitespace), [])

    writeFileSync(join(repository, 'contract.json'), '{  "expected":  "beta"  }\n')
    execFileSync('git', ['add', 'contract.json'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture semantic'], { cwd: repository })
    const semantic = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    assert.match(validateFormatOnlyDiff(repository, whitespace, semantic).join('\n'), /quoted-value tokens/u)

    writeFileSync(join(repository, 'contract.json'), '{  "expected":  "be ta"  }\n')
    execFileSync('git', ['add', 'contract.json'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture quoted whitespace'], { cwd: repository })
    const quotedWhitespace = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    assert.match(validateFormatOnlyDiff(repository, semantic, quotedWhitespace).join('\n'), /quoted-value tokens/u)
})

test('format-only fingerprint rejects joined identifiers, JSON lexical changes, YAML depth, and file types', () => {
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-format-adversarial-'))
    execFileSync('git', ['init', '-q'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
    writeFileSync(join(repository, 'sample.cs'), 'int x = 1;\n')
    writeFileSync(
        join(repository, 'contract.json'),
        '{"value":1,"value":2,"large":9007199254740993,"escaped":"\\u0061"}\n'
    )
    writeFileSync(join(repository, 'config.yml'), 'parent:\n  child: 1\n')
    writeFileSync(join(repository, 'link.txt'), 'regular\n')
    writeFileSync(join(repository, 'script.ts'), 'export function read() {\n  return 1\n}\n')
    writeFileSync(join(repository, 'script.py'), 'if ready:\n  value = 1\n')
    writeFileSync(join(repository, 'native.h'), '#define VALUE 1\n')
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture base'], { cwd: repository })
    let before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()

    writeFileSync(join(repository, 'sample.cs'), 'int    x    =    1;\n')
    writeFileSync(
        join(repository, 'contract.json'),
        '{  "value" : 1, "value" : 2, "large" : 9007199254740993, "escaped" : "\\u0061"  }\n'
    )
    writeFileSync(join(repository, 'config.yml'), 'parent:\n    child: 1\n')
    writeFileSync(join(repository, 'script.ts'), 'export   function read() {\n    return 1\n}\n')
    writeFileSync(join(repository, 'script.py'), 'if ready:\n    value = 1\n')
    writeFileSync(join(repository, 'native.h'), '#  define   VALUE   1\n')
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture formatting'], { cwd: repository })
    let after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    assert.deepEqual(validateFormatOnlyDiff(repository, before, after), [])

    before = after
    writeFileSync(join(repository, 'sample.cs'), 'intx = 1;\n')
    execFileSync('git', ['add', 'sample.cs'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture joined identifier'], { cwd: repository })
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /non-whitespace/u)

    before = after
    writeFileSync(
        join(repository, 'contract.json'),
        '{"value":1,"value":2,"large":9007199254740992,"escaped":"\\u0061"}\n'
    )
    execFileSync('git', ['add', 'contract.json'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture unsafe integer'], { cwd: repository })
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /contract\.json/u)

    before = after
    writeFileSync(
        join(repository, 'contract.json'),
        '{"value":9,"value":2,"large":9007199254740992,"escaped":"\\u0061"}\n'
    )
    execFileSync('git', ['add', 'contract.json'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture duplicate key value'], { cwd: repository })
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /contract\.json/u)

    before = after
    writeFileSync(
        join(repository, 'contract.json'),
        '{"value":9,"value":2,"large":9007199254740992,"escaped":"a"}\n'
    )
    execFileSync('git', ['add', 'contract.json'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture escape spelling'], { cwd: repository })
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /contract\.json/u)

    before = after
    writeFileSync(join(repository, 'config.yml'), 'parent:\nchild: 1\n')
    execFileSync('git', ['add', 'config.yml'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture yaml depth'], { cwd: repository })
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /config\.yml/u)

    before = after
    unlinkSync(join(repository, 'link.txt'))
    symlinkSync('sample.cs', join(repository, 'link.txt'))
    execFileSync('git', ['add', '-A'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture file type'], { cwd: repository })
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /adds, copies, deletes, or renames/u)

    before = after
    writeFileSync(join(repository, 'script.ts'), 'export function read() {\n  return\n  1\n}\n')
    execFileSync('git', ['add', 'script.ts'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture automatic semicolon insertion'], { cwd: repository })
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /script\.ts/u)

    before = after
    writeFileSync(join(repository, 'script.py'), 'if ready:\nvalue = 1\n')
    execFileSync('git', ['add', 'script.py'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture python block depth'], { cwd: repository })
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /script\.py/u)

    before = after
    writeFileSync(join(repository, 'native.h'), '#define VALUE\n1\n')
    execFileSync('git', ['add', 'native.h'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture preprocessor line split'], { cwd: repository })
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /native\.h/u)
})

test('changed path calculation uses merge-base and includes only feature-side changes', () => {
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-merge-base-'))
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
    writeFileSync(join(repository, 'common.txt'), 'base\n')
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture base'], { cwd: repository })
    execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: repository })
    writeFileSync(join(repository, 'feature.txt'), 'feature\n')
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture feature'], { cwd: repository })
    execFileSync('git', ['mv', 'common.txt', 'renamed.txt'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture feature rename'], { cwd: repository })
    const feature = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository })
    writeFileSync(join(repository, 'base-only.txt'), 'advanced base\n')
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture advanced base'], { cwd: repository })
    const advancedBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()

    assert.deepEqual(
        changedFilesBetween(repository, advancedBase, feature).sort(),
        ['common.txt', 'feature.txt', 'renamed.txt']
    )
})

test('blame-ignore parser requires full, unique, reachable, non-merge style revisions', () => {
    const revision = '0123456789abcdef0123456789abcdef01234567'
    const inspected = () => ({
        exists: true,
        reachable: true,
        parents: 1,
        subject: 'style(csharp): normalize backend whitespace'
    })
    assert.deepEqual(validateBlameIgnoreRevisions(`${revision}\n`, {
        requiredRevisions: [revision],
        inspectRevision: inspected
    }), [])
    assert.match(validateBlameIgnoreRevisions('', {
        requiredRevisions: [revision],
        inspectRevision: inspected
    }).join('\n'), /missing blame-ignore entry/u)
    assert.deepEqual(parseBlameIgnoreRevisions(`# reviewed\n${revision}\n`), [revision])
})

test('blame-ignore repository audit rejects naming-only style commits', () => {
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-blame-naming-'))
    execFileSync('git', ['init', '-q'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
    writeRepositoryFile(repository, '.git-blame-ignore-revs', '')
    writeRepositoryFile(repository, 'source.cpp', 'int old_name = 1;\n')
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture base'], { cwd: repository })

    writeRepositoryFile(repository, 'source.cpp', 'int NewName = 1;\n')
    execFileSync('git', ['add', 'source.cpp'], { cwd: repository })
    execFileSync('git', ['commit', '-qF', resolve(fixtures, 'valid', 'naming-only.txt')], { cwd: repository })
    const namingRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8'
    }).trim()

    writeRepositoryFile(repository, '.git-blame-ignore-revs', `${namingRevision}\n`)
    execFileSync('git', ['add', '.git-blame-ignore-revs'], { cwd: repository })
    execFileSync('git', [
        'commit',
        '-qm',
        'chore(governance): register naming fixture revision\n\nRefs: #1163'
    ], { cwd: repository })
    assert.match(
        validateRepositoryBlameIgnore(repository).join('\n'),
        /lacks a format-only commit contract/u
    )
})

test('changed commit range requires format commit idempotence and a later blame-ignore entry', () => {
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-change-range-'))
    execFileSync('git', ['init', '-q'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
    writeFileSync(join(repository, 'source.cs'), 'class Fixture { }\n')
    writeFileSync(join(repository, '.git-blame-ignore-revs'), '')
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture base'], { cwd: repository })
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()

    writeFileSync(join(repository, 'source.cs'), 'class Fixture    {    }\n')
    execFileSync('git', ['add', 'source.cs'], { cwd: repository })
    execFileSync('git', ['commit', '-qF', resolve(fixtures, 'valid', 'format-only.txt')], { cwd: repository })
    const formatRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()

    writeFileSync(join(repository, '.git-blame-ignore-revs'), `${formatRevision}\n`)
    writeFormatEvidence(repository, formatRevision)
    execFileSync('git', ['add', '.git-blame-ignore-revs', 'artifacts/style/idempotence.json'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'chore(governance): register reviewed format revision\n\nRefs: #1163'], { cwd: repository })
    assert.deepEqual(validateCommitRange(repository, `${base}..HEAD`), [])

    const evidencePath = join(repository, 'artifacts/style/idempotence.json')
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
    evidence.secondPassTreeSha256 = '0'.repeat(64)
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 4)}\n`)
    execFileSync('git', ['add', 'artifacts/style/idempotence.json'], { cwd: repository })
    execFileSync('git', [
        'commit',
        '-qm',
        'test(governance): tamper format evidence fixture\n\nRefs: #1163'
    ], { cwd: repository })
    assert.match(validateCommitRange(repository, `${base}..HEAD`).join('\n'), /first\/second pass digests/u)

    writeFileSync(join(repository, '.git-blame-ignore-revs'), '')
    assert.match(validateCommitRange(repository, `${base}..HEAD`).join('\n'), /missing blame-ignore entry/u)
})

test('format-only PR accepts later blame metadata but rejects any other semantic aggregate change', () => {
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-format-pr-'))
    execFileSync('git', ['init', '-q'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
    writeFileSync(join(repository, 'source.cs'), 'class Fixture { }\n')
    writeFileSync(join(repository, '.git-blame-ignore-revs'), '')
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture base'], { cwd: repository })
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()

    writeFileSync(join(repository, 'source.cs'), 'class Fixture    {    }\n')
    execFileSync('git', ['add', 'source.cs'], { cwd: repository })
    execFileSync('git', ['commit', '-qF', resolve(fixtures, 'valid', 'format-only.txt')], { cwd: repository })
    const formatRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()

    writeFileSync(join(repository, '.git-blame-ignore-revs'), `${formatRevision}\n`)
    writeFormatEvidence(repository, formatRevision)
    execFileSync('git', ['add', '.git-blame-ignore-revs', 'artifacts/style/idempotence.json'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'chore(governance): register reviewed format revision\n\nRefs: #1163'], { cwd: repository })
    const metadataHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()

    assert.notDeepEqual(validateFormatOnlyDiff(repository, base, metadataHead), [])
    assert.deepEqual(validateFormatOnlyPullRequest(
        repository,
        base,
        metadataHead,
        formatRevision,
        'artifacts/style/idempotence.json'
    ), [])
    assert.match(
        validateFormatOnlyPullRequest(
            repository,
            base,
            metadataHead,
            '0'.repeat(40),
            'artifacts/style/idempotence.json'
        ).join('\n'),
        /declared revision must exactly match/u
    )

    writeFileSync(join(repository, 'source.cs'), 'class ChangedFixture { }\n')
    execFileSync('git', ['add', 'source.cs'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fix(governance): alter governed source semantics\n\nRefs: #1163'], { cwd: repository })
    assert.match(
        validateFormatOnlyPullRequest(
            repository,
            base,
            'HEAD',
            formatRevision,
            'artifacts/style/idempotence.json'
        ).join('\n'),
        /non-whitespace or quoted-value tokens/u
    )
})

test('pull request actor authority comes from the PR author rather than the event sender', () => {
    assert.equal(pullRequestActor({
        sender: { login: 'maintainer' },
        pull_request: { user: { login: 'generator[bot]' } }
    }), 'generator[bot]')
    assert.equal(pullRequestActor({ sender: { login: 'maintainer' } }), '')
})

test('candidate pull request cannot replace the trusted change-contract policy', () => {
    const authority = mkdtempSync(join(tmpdir(), 'fsusblog-policy-authority-'))
    const candidate = mkdtempSync(join(tmpdir(), 'fsusblog-policy-candidate-'))
    const policyPath = 'tools/governance/change-contract.mjs'
    writeRepositoryFile(authority, policyPath, 'export const gate = "trusted"\n')
    writeRepositoryFile(
        authority,
        'config/development/native-tooling-style-exceptions.json',
        '{"exceptions":[]}\n'
    )

    execFileSync('git', ['init', '-q'], { cwd: candidate })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: candidate })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: candidate })
    writeRepositoryFile(candidate, policyPath, 'export const gate = "disabled"\n')
    execFileSync('git', ['add', '.'], { cwd: candidate })
    execFileSync('git', ['commit', '-qm', 'fixture candidate'], { cwd: candidate })

    const errors = validatePrContract({
        title: 'feat(governance): enforce trusted policy transition',
        body: pullRequestBody({ summary: 'enforce trusted policy transition' }),
        labels: ['release-note:added'],
        actor: 'maintainer',
        changedFiles: [policyPath],
        root: candidate,
        authorityRoot: authority
    })
    assert.ok(errors.some((error) => error.includes('cannot replace trusted change-contract policy source')))
})

test('repository contract sources, generated release categories, and current blame history agree', () => {
    assert.deepEqual(validateRepositorySources(root), [])
    assert.deepEqual(validateRepositoryBlameIgnore(root), [])
})
