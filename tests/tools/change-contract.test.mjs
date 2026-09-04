import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
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
    readFileAtRevision,
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

function commitTreeFixture(repository, tree, parents, message) {
    return execFileSync('git', [
        'commit-tree',
        tree,
        ...parents.flatMap((parent) => ['-p', parent]),
        '-m',
        message
    ], { cwd: repository, encoding: 'utf8' }).trim()
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
    changeGenerator = false,
    changeCandidateGenerator = false,
    laterSourceChange = false,
    baselineOutputStale = false,
    postSourceOwnedRoundTrip = false,
    sourceRevisionMode = 'single'
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

    let sourceCommit
    let mergeCommit
    if (sourceRevisionMode === 'single') {
        execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: repository })
        writeRepositoryFile(repository, 'tests/matrix.yml', 'expected\n')
        sourceCommit = commitFixture(repository, 'fixture omitted generated source')
        execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository })
        execFileSync('git', [
            'merge',
            '--no-ff',
            '-qm',
            'Merge pull request #2973 from fixture/generated-source',
            'feature'
        ], { cwd: repository })
        mergeCommit = execFileSync(
            'git',
            ['rev-parse', 'HEAD'],
            { cwd: repository, encoding: 'utf8' }
        ).trim()
    } else {
        const baseline = execFileSync(
            'git',
            ['rev-parse', 'HEAD'],
            { cwd: repository, encoding: 'utf8' }
        ).trim()
        execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: repository })
        writeRepositoryFile(repository, 'tests/matrix.yml', 'feature\n')
        execFileSync('node', [
            'tools/docs/generate-testing-docs.mjs',
            '--out',
            'docs/testing.generated.md'
        ], { cwd: repository })
        const replayParent = commitFixture(repository, 'fixture canonical replay parent')

        execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository })
        writeRepositoryFile(repository, 'tests/matrix.yml', 'base-side\n')
        writeRepositoryFile(repository, 'docs/testing.generated.md', 'generated:feature\n')
        const pullRequestBase = commitFixture(repository, 'fixture exact pull request base')

        execFileSync('git', ['checkout', '-q', 'feature'], { cwd: repository })
        writeRepositoryFile(repository, 'tests/matrix.yml', 'expected\n')
        if (changeGenerator) {
            writeRepositoryFile(repository, 'tools/docs/generate-testing-docs.mjs', `${readFileSync(
                join(repository, 'tools/docs/generate-testing-docs.mjs'),
                'utf8'
            )}\n// changed inside the source merge\n`)
        }
        execFileSync('git', ['add', '.'], { cwd: repository })
        const sourceTree = execFileSync(
            'git',
            ['write-tree'],
            { cwd: repository, encoding: 'utf8' }
        ).trim()
        const sourceParents = sourceRevisionMode === 'reversed'
            ? [pullRequestBase, replayParent]
            : sourceRevisionMode === 'wrong-parent'
                ? [replayParent, baseline]
                : sourceRevisionMode === 'multi-parent'
                    ? [replayParent, pullRequestBase, baseline]
                    : [replayParent, pullRequestBase]
        sourceCommit = commitTreeFixture(
            repository,
            sourceTree,
            sourceParents,
            'fixture two-parent source revision'
        )
        execFileSync('git', [
            'update-ref',
            'refs/heads/feature',
            sourceCommit,
            replayParent
        ], { cwd: repository })
        if (sourceRevisionMode === 'side-parent') {
            const primaryCommit = commitTreeFixture(
                repository,
                sourceTree,
                [replayParent],
                'fixture primary branch source revision'
            )
            const sideParentMerge = commitTreeFixture(
                repository,
                sourceTree,
                [primaryCommit, sourceCommit],
                'fixture source revision hidden on a side parent'
            )
            execFileSync('git', [
                'update-ref',
                'refs/heads/feature',
                sideParentMerge,
                sourceCommit
            ], { cwd: repository })
        }
        if (sourceRevisionMode === 'ambiguous') {
            writeRepositoryFile(repository, 'tests/matrix.yml', 'ambiguous-side-change\n')
            execFileSync('git', ['add', 'tests/matrix.yml'], { cwd: repository })
            const ambiguousTree = execFileSync(
                'git',
                ['write-tree'],
                { cwd: repository, encoding: 'utf8' }
            ).trim()
            const ambiguousSourceCommit = commitTreeFixture(
                repository,
                ambiguousTree,
                [sourceCommit],
                'fixture ambiguous side-parent source change'
            )
            writeRepositoryFile(repository, 'tests/matrix.yml', 'expected\n')
            execFileSync('git', ['add', 'tests/matrix.yml'], { cwd: repository })
            const ambiguousMerge = commitTreeFixture(
                repository,
                sourceTree,
                [sourceCommit, ambiguousSourceCommit],
                'fixture merge preserving first-parent source bytes'
            )
            execFileSync('git', [
                'update-ref',
                'refs/heads/feature',
                ambiguousMerge,
                sourceCommit
            ], { cwd: repository })
        }
        if (postSourceOwnedRoundTrip) {
            writeRepositoryFile(repository, 'docs/testing.generated.md', 'transient output\n')
            writeRepositoryFile(repository, 'tools/docs/generate-testing-docs.mjs', `${readFileSync(
                join(repository, 'tools/docs/generate-testing-docs.mjs'),
                'utf8'
            )}\n// transient generator change\n`)
            commitFixture(repository, 'fixture transient owned change')
            writeRepositoryFile(repository, 'docs/testing.generated.md', 'generated:feature\n')
            const generator = readFileSync(
                join(repository, 'tools/docs/generate-testing-docs.mjs'),
                'utf8'
            ).replace('\n// transient generator change\n', '')
            writeRepositoryFile(repository, 'tools/docs/generate-testing-docs.mjs', generator)
            commitFixture(repository, 'fixture restore owned change')
        }
        writeRepositoryFile(repository, 'feature-followup.txt', 'outer head\n')
        const pullRequestHead = commitFixture(repository, 'fixture exact pull request head')
        const mergeTree = execFileSync(
            'git',
            ['rev-parse', `${pullRequestHead}^{tree}`],
            { cwd: repository, encoding: 'utf8' }
        ).trim()
        mergeCommit = commitTreeFixture(
            repository,
            mergeTree,
            [pullRequestBase, pullRequestHead],
            'fix(governance): merge generated source (#2973)'
        )
        execFileSync('git', [
            'update-ref',
            'refs/heads/master',
            mergeCommit,
            pullRequestBase
        ], { cwd: repository })
        execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository })
    }
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
    if (changeCandidateGenerator) {
        writeRepositoryFile(repository, 'tools/docs/generate-testing-docs.mjs', `${readFileSync(
            join(repository, 'tools/docs/generate-testing-docs.mjs'),
            'utf8'
        )}\n// changed by the repair candidate\n`)
    }

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

function fixtureTrackedInputTreeDigest(repository, revision, excludedPaths) {
    const excluded = new Set(excludedPaths)
    const entries = execFileSync(
        'git',
        ['ls-tree', '-r', '-z', '--full-tree', revision],
        { cwd: repository }
    ).toString('utf8').split('\x00').filter(Boolean)
    const hash = createHash('sha256')
    for (const entry of entries) {
        const match = entry.match(/^(?<mode>\d{6}) (?<type>[a-z]+) (?<object>[0-9a-f]{40})\t(?<path>.+)$/u)?.groups
        if (excluded.has(match.path)) continue
        hash.update(`${match.mode}\x00${match.type}\x00${match.object}\x00${match.path}\x00`)
    }
    return hash.digest('hex')
}

function replayRepairDagFixture(repository, revision) {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'fsusblog-repair-dag-fixture-'))
    const worktree = join(temporaryRoot, 'worktree')
    try {
        execFileSync('git', ['worktree', 'add', '--detach', worktree, revision], {
            cwd: repository,
            stdio: 'ignore',
            env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
        })
        execFileSync('node', ['tools/test/generate-evidence-location-governance.mjs'], { cwd: worktree })
        execFileSync('node', ['tools/test/generate-current-run-evidence-location-acceptance.mjs'], { cwd: worktree })
        const ledger = JSON.parse(readFileSync(
            join(worktree, 'config/testing/evidence-location-migration-ledger.json'),
            'utf8'
        ))
        const outputs = new Map([
            'config/testing/evidence-locator-registry.json',
            'config/testing/evidence-location-migration-ledger.json',
            'config/testing/current-run-evidence-location-acceptance.json'
        ].map((path) => [path, fileSha256(worktree, path)]))
        return {
            outputs,
            projection: {
                findingCount: ledger.entries?.length ?? 0,
                sha256: /^sha256:[0-9a-f]{64}$/u.test(ledger.scanDigest ?? '')
                    ? ledger.scanDigest.slice('sha256:'.length)
                    : '0'.repeat(64)
            }
        }
    } finally {
        execFileSync('git', ['worktree', 'remove', '--force', worktree], {
            cwd: repository,
            stdio: 'ignore',
            env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
        })
        rmSync(temporaryRoot, { recursive: true, force: true })
    }
}

function createPostMergeRepairDagFixture({
    mutateManifest = null,
    producerFault = null,
    eventProtectedMutation = null,
    supersedeSource = false,
    secondEvent = false,
    sourceRevisionMode = 'single',
    synchronizedTail = false,
    outerProtectedMutation = false,
    outerPaddingCommits = 0,
    historyExecutionMarker = null,
    candidateInputExecutionMarker = null
} = {}) {
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-post-merge-generated-repair-dag-'))
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
    writeRepositoryFile(repository, 'semantic-source.txt', 'synchronized\n')
    writeRepositoryFile(repository, 'tools/test/evidence-location-contract.mjs', 'export const fixture = true\n')
    writeRepositoryFile(repository, 'tools/test/evidence-location-scanner.mjs', 'export const fixture = true\n')
    writeRepositoryFile(repository, 'tools/test/generate-evidence-location-governance.mjs', `
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const source = readFileSync('semantic-source.txt', 'utf8').trim()
const digest = createHash('sha256').update(source).digest('hex')
mkdirSync('config/testing', { recursive: true })
writeFileSync('config/testing/evidence-locator-registry.json', JSON.stringify({ stable: true }) + '\\n')
writeFileSync('config/testing/evidence-location-migration-ledger.json', JSON.stringify({ scanDigest: 'sha256:' + digest, entries: source.split(',').map((id) => ({ id })) }) + '\\n')
${producerFault === 'future-output' ? "if (source.includes('event')) writeFileSync('config/testing/current-run-evidence-location-acceptance.json', JSON.stringify({ premature: true }) + '\\n')" : ''}
${producerFault === 'unexpected-write' ? "if (source.includes('event')) writeFileSync('unexpected-output.txt', 'unexpected\\n')" : ''}
${producerFault === 'ignored-write' ? "if (source.includes('event')) { mkdirSync('.tmp', { recursive: true }); writeFileSync('.tmp/unexpected.txt', 'unexpected\\n') }" : ''}
${producerFault === 'staged-write' ? "if (source.includes('event')) { writeFileSync('unexpected-output.txt', 'unexpected\\n'); execFileSync('git', ['add', 'unexpected-output.txt']) }" : ''}
${producerFault === 'nondeterministic' ? "if (source.includes('event')) writeFileSync('config/testing/evidence-location-migration-ledger.json', JSON.stringify({ scanDigest: 'sha256:' + digest, entries: [{ id: String(Math.random()) }] }) + '\\n')" : ''}
${candidateInputExecutionMarker ? `if (existsSync('candidate-extra.ts')) writeFileSync(${JSON.stringify(candidateInputExecutionMarker)}, 'executed\\n')` : ''}
`.trimStart())
    writeRepositoryFile(repository, 'tools/test/generate-current-run-evidence-location-acceptance.mjs', `
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
const registry = readFileSync('config/testing/evidence-locator-registry.json')
const ledger = readFileSync('config/testing/evidence-location-migration-ledger.json')
writeFileSync('config/testing/current-run-evidence-location-acceptance.json', JSON.stringify({ registrySha256: ${producerFault === 'no-consume' ? "'constant'" : "createHash('sha256').update(registry).digest('hex')"}, ledgerSha256: ${producerFault === 'no-consume' ? "'constant'" : "createHash('sha256').update(ledger).digest('hex')"} }) + '\\n')
${producerFault === 'later-overwrite' ? "if (readFileSync('semantic-source.txt', 'utf8').includes('event')) writeFileSync('config/testing/evidence-location-migration-ledger.json', JSON.stringify({ overwritten: true }) + '\\n')" : ''}
`.trimStart())
    if (producerFault === 'ignored-write') writeRepositoryFile(repository, '.gitignore', '.tmp/\n')
    execFileSync('node', ['tools/test/generate-evidence-location-governance.mjs'], { cwd: repository })
    execFileSync('node', ['tools/test/generate-current-run-evidence-location-acceptance.mjs'], { cwd: repository })
    commitFixture(repository, 'fixture baseline')

    execFileSync('git', ['checkout', '-qb', 'synchronized'], { cwd: repository })
    writeRepositoryFile(repository, 'semantic-source.txt', 'synchronized,anchor\n')
    execFileSync('node', ['tools/test/generate-evidence-location-governance.mjs'], { cwd: repository })
    execFileSync('node', ['tools/test/generate-current-run-evidence-location-acceptance.mjs'], { cwd: repository })
    const synchronizedOutputRevision = commitFixture(repository, 'fixture synchronized graph revision')
    let synchronizedRevision = synchronizedOutputRevision
    if (synchronizedTail) {
        writeRepositoryFile(repository, 'synchronized-note.txt', 'unrelated synchronized tail\n')
        synchronizedRevision = commitFixture(repository, 'fixture unrelated synchronized tail')
    }
    execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository })
    execFileSync('git', [
        'merge', '--no-ff', '-qm',
        'Merge pull request #4001 from fixture/synchronized',
        'synchronized'
    ], { cwd: repository })
    const synchronizedMergeCommit = execFileSync(
        'git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }
    ).trim()

    for (let index = 0; index < outerPaddingCommits; index += 1) {
        writeRepositoryFile(repository, 'outer-padding.txt', `${index}\n`)
        commitFixture(repository, `fixture outer padding ${index}`)
    }

    execFileSync('git', ['checkout', '-qb', 'source-event'], { cwd: repository })
    writeRepositoryFile(repository, 'semantic-source.txt', 'synchronized,anchor,event\n')
    if (eventProtectedMutation === 'output') {
        writeRepositoryFile(repository, 'config/testing/evidence-location-migration-ledger.json', '{"tampered":true}\n')
    }
    if (eventProtectedMutation === 'closure') {
        writeRepositoryFile(repository, 'tools/test/evidence-location-scanner.mjs', 'export const fixture = false\n')
    }
    if (historyExecutionMarker) {
        writeRepositoryFile(
            repository,
            'tools/test/generate-evidence-location-governance.mjs',
            `${readFileSync(join(repository, 'tools/test/generate-evidence-location-governance.mjs'), 'utf8')}\nwriteFileSync(${JSON.stringify(historyExecutionMarker)}, 'executed\\n')\n`
        )
    }
    execFileSync('git', ['add', '.'], { cwd: repository })
    const sourceTree = execFileSync('git', ['write-tree'], { cwd: repository, encoding: 'utf8' }).trim()
    let sourceRevision
    if (sourceRevisionMode === 'single') {
        sourceRevision = commitFixture(repository, 'fixture omitted generated graph outputs')
    } else {
        const rootRevision = execFileSync(
            'git',
            ['rev-list', '--max-parents=0', 'HEAD'],
            { cwd: repository, encoding: 'utf8' }
        ).trim()
        if (sourceRevisionMode === 'wrong-parent') {
            sourceRevision = commitTreeFixture(
                repository,
                sourceTree,
                [synchronizedMergeCommit, synchronizedRevision],
                'fixture wrong-parent generated graph source'
            )
            execFileSync('git', ['update-ref', 'refs/heads/source-event', sourceRevision], { cwd: repository })
        } else if (sourceRevisionMode === 'multi-parent') {
            sourceRevision = commitTreeFixture(
                repository,
                sourceTree,
                [synchronizedMergeCommit, synchronizedRevision, rootRevision],
                'fixture multi-parent generated graph source'
            )
            execFileSync('git', ['update-ref', 'refs/heads/source-event', sourceRevision], { cwd: repository })
        } else if (sourceRevisionMode === 'side-parent') {
            sourceRevision = commitTreeFixture(
                repository,
                sourceTree,
                [synchronizedMergeCommit],
                'fixture side-parent generated graph source'
            )
            const synchronizedTree = execFileSync(
                'git',
                ['rev-parse', `${synchronizedMergeCommit}^{tree}`],
                { cwd: repository, encoding: 'utf8' }
            ).trim()
            const primaryRevision = commitTreeFixture(
                repository,
                synchronizedTree,
                [synchronizedMergeCommit],
                'fixture primary source branch'
            )
            const sideMerge = commitTreeFixture(
                repository,
                sourceTree,
                [primaryRevision, sourceRevision],
                'fixture source hidden on side parent'
            )
            execFileSync('git', ['update-ref', 'refs/heads/source-event', sideMerge], { cwd: repository })
        } else {
            throw new Error(`unknown sourceRevisionMode fixture: ${sourceRevisionMode}`)
        }
    }
    if (supersedeSource) {
        writeRepositoryFile(repository, 'semantic-source.txt', 'synchronized,anchor,event,superseded\n')
        if (supersedeSource === 'two-parent') {
            execFileSync('git', ['add', 'semantic-source.txt'], { cwd: repository })
            const supersedingTree = execFileSync(
                'git', ['write-tree'], { cwd: repository, encoding: 'utf8' }
            ).trim()
            const supersedingRevision = commitTreeFixture(
                repository,
                supersedingTree,
                [sourceRevision, synchronizedMergeCommit],
                'fixture two-parent superseding source event'
            )
            execFileSync('git', ['update-ref', 'refs/heads/source-event', supersedingRevision], { cwd: repository })
        } else {
            commitFixture(repository, 'fixture superseding source event')
        }
    }
    execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository })
    if (outerProtectedMutation) {
        execFileSync('git', ['merge', '--no-ff', '--no-commit', 'source-event'], { cwd: repository })
        writeRepositoryFile(repository, 'config/testing/evidence-location-migration-ledger.json', '{"outer":"tampered"}\n')
        commitFixture(repository, 'Merge pull request #4002 from fixture/source-event')
    } else {
        execFileSync('git', [
            'merge', '--no-ff', '-qm',
            'Merge pull request #4002 from fixture/source-event',
            'source-event'
        ], { cwd: repository })
    }
    let base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
    const sourceEvents = [{
        sourceRevision,
        mergedPullRequest: 4002,
        mergeCommit: base
    }]
    if (secondEvent) {
        execFileSync('git', ['checkout', '-qb', 'source-event-2'], { cwd: repository })
        writeRepositoryFile(repository, 'semantic-source.txt', 'synchronized,anchor,event,event-2\n')
        const secondSourceRevision = commitFixture(repository, 'fixture second omitted generated graph outputs')
        execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository })
        execFileSync('git', [
            'merge', '--no-ff', '-qm',
            'Merge pull request #4003 from fixture/source-event-2',
            'source-event-2'
        ], { cwd: repository })
        base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
        sourceEvents.push({
            sourceRevision: secondSourceRevision,
            mergedPullRequest: 4003,
            mergeCommit: base
        })
    }

    const manifestPath = 'artifacts/change-contract/evidence-location-governance-post-merge-repair.json'
    const graphOutputs = [
        'config/testing/evidence-locator-registry.json',
        'config/testing/evidence-location-migration-ledger.json',
        'config/testing/current-run-evidence-location-acceptance.json'
    ]
    const synchronizedReplay = replayRepairDagFixture(repository, synchronizedRevision)
    const baseReplay = replayRepairDagFixture(repository, base)
    const baseDigests = new Map(graphOutputs.map((path) => [path, fileSha256(repository, path)]))
    execFileSync('git', ['checkout', '-qb', 'candidate'], { cwd: repository })
    execFileSync('node', ['tools/test/generate-evidence-location-governance.mjs'], { cwd: repository })
    execFileSync('node', ['tools/test/generate-current-run-evidence-location-acceptance.mjs'], { cwd: repository })
    if (historyExecutionMarker && existsSync(historyExecutionMarker)) unlinkSync(historyExecutionMarker)
    const closure = (paths) => paths.map((path) => ({
        path,
        baseSha256: fileSha256(repository, path),
        currentSha256: fileSha256(repository, path)
    }))
    const manifest = {
        schema: changeContract.evidenceSchemas.postMergeGeneratedOutputRepairDag,
        producerId: 'evidence-location-governance',
        synchronizedRevision,
        synchronizedPullRequest: 4001,
        synchronizedMergeCommit,
        synchronizedOutputOwners: graphOutputs.map((path) => ({
            path,
            revision: execFileSync(
                'git', ['log', '-1', '--format=%H', synchronizedRevision, '--', path],
                { cwd: repository, encoding: 'utf8' }
            ).trim()
        })),
        baseCommit: base,
        inputTree: {
            synchronizedSha256: fixtureTrackedInputTreeDigest(repository, synchronizedRevision, [
                ...graphOutputs,
                manifestPath
            ]),
            baseSha256: fixtureTrackedInputTreeDigest(repository, base, [...graphOutputs, manifestPath]),
            currentSha256: fixtureTrackedInputTreeDigest(repository, base, [...graphOutputs, manifestPath])
        },
        sourceProjection: {
            projectionId: 'fsusblog.evidence-location-scan.v1',
            synchronized: synchronizedReplay.projection,
            base: baseReplay.projection,
            current: baseReplay.projection
        },
        sourceEvents,
        steps: [
            {
                id: 'evidence-location-governance',
                command: 'node tools/test/generate-evidence-location-governance.mjs',
                executable: 'node',
                arguments: ['tools/test/generate-evidence-location-governance.mjs'],
                dependsOn: [],
                consumes: [],
                generatorClosure: closure([
                    'tools/test/evidence-location-contract.mjs',
                    'tools/test/evidence-location-scanner.mjs',
                    'tools/test/generate-evidence-location-governance.mjs'
                ]),
                outputs: graphOutputs.slice(0, 2)
            },
            {
                id: 'current-run-evidence-location-acceptance',
                command: 'node tools/test/generate-current-run-evidence-location-acceptance.mjs',
                executable: 'node',
                arguments: ['tools/test/generate-current-run-evidence-location-acceptance.mjs'],
                dependsOn: ['evidence-location-governance'],
                consumes: [
                    'config/testing/evidence-locator-registry.json',
                    'config/testing/evidence-location-migration-ledger.json'
                ],
                generatorClosure: closure([
                    'tools/test/evidence-location-contract.mjs',
                    'tools/test/evidence-location-scanner.mjs',
                    'tools/test/generate-evidence-location-governance.mjs',
                    'tools/test/generate-current-run-evidence-location-acceptance.mjs'
                ]),
                outputs: graphOutputs.slice(2)
            }
        ],
        outputs: graphOutputs.map((path) => {
            const baseSha256 = baseDigests.get(path)
            const expectedSha256 = baseReplay.outputs.get(path)
            const repairRequired = baseSha256 !== expectedSha256
            return {
                path,
                repairRequired,
                changed: repairRequired,
                baseSha256,
                expectedSha256,
                currentSha256: fileSha256(repository, path)
            }
        })
    }
    if (mutateManifest) mutateManifest(manifest, repository)
    writeRepositoryFile(repository, manifestPath, `${JSON.stringify(manifest, null, 4)}\n`)
    const head = commitFixture(repository, 'fixture generated repair DAG candidate')
    return { repository, base, head, manifest, manifestPath }
}

function validatePostMergeRepairDagFixture(fixtureRepository) {
    return validatePrContract({
        title: 'chore(governance): repair omitted evidence location projections',
        body: pullRequestBody({
            type: 'chore',
            generated: true,
            audience: 'internal',
            category: 'Internal/Tooling',
            summary: 'repair omitted evidence location projections',
            generatorSource: [
                'tools/test/generate-evidence-location-governance.mjs',
                'tools/test/generate-current-run-evidence-location-acceptance.mjs'
            ].join(', '),
            generatedOutputs: [
                'config/testing/evidence-location-migration-ledger.json',
                'config/testing/current-run-evidence-location-acceptance.json'
            ].join(', '),
            generatedDigest: fixtureRepository.manifestPath
        }),
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

function postMergeExternalNamingRepairBody() {
    return pullRequestBody({
        type: 'fix',
        externalNaming: true,
        externalExceptionManifest: 'artifacts/change-contract/external-naming-repair.json',
        externalExceptionId: 'none',
        externalExceptionPaths: 'none',
        externalExceptionReason: 'none',
        audience: 'internal',
        category: 'Internal/Tooling',
        summary: 'repair omitted external naming evidence'
    })
}

function createPostMergeExternalNamingRepairFixture({
    mutateManifest = null,
    mutateArtifact = null,
    laterSourceChange = false,
    unmerged = false
} = {}) {
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-post-merge-external-naming-repair-'))
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
    const sourcePath = 'tools/docs/behavior-doc-static-admission.mjs'
    const artifactPath = 'artifacts/change-contract/external-naming.json'
    const repairPath = 'artifacts/change-contract/external-naming-repair.json'
    const currentSurfacePath = 'docs/architecture/repository-layout.md'
    const reason = 'preserve caller-visible environment variables while moving receipt publication'
    writeRepositoryFile(repository, sourcePath, 'const mode = process.env.FSUSBLOG_MODE\n')
    writeRepositoryFile(repository, currentSurfacePath, 'baseline layout authority\n')
    const originalBase = commitFixture(repository, 'fixture original base')

    execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: repository })
    writeRepositoryFile(repository, sourcePath, 'const mode = process.env.FSUSBLOG_RUNTIME_MODE\n')
    const originalHead = commitFixture(repository, 'fixture changed naming surface')
    execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository })
    execFileSync('git', [
        'merge',
        '--no-ff',
        '-qm',
        'Merge pull request #3031 from fixture/naming-source',
        'feature'
    ], { cwd: repository })
    const mergeCommit = execFileSync(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: repository, encoding: 'utf8' }
    ).trim()
    if (laterSourceChange) {
        writeRepositoryFile(repository, sourcePath, 'const mode = process.env.FSUSBLOG_LATER_MODE\n')
        commitFixture(repository, 'fixture later source change')
    }
    const base = unmerged ? originalHead : execFileSync(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: repository, encoding: 'utf8' }
    ).trim()
    execFileSync('git', ['checkout', '-q', '-b', 'candidate', base], { cwd: repository })
    writeRepositoryFile(repository, currentSurfacePath, 'document strict naming repair ownership\n')

    const artifact = {
        schema: changeContract.evidenceSchemas.externalNamingExceptions,
        exceptions: [
            {
                id: 'environment-variable',
                paths: [sourcePath],
                reason
            }
        ]
    }
    if (mutateArtifact) mutateArtifact(artifact)
    writeRepositoryFile(repository, artifactPath, `${JSON.stringify(artifact, null, 4)}\n`)
    const sourceDigest = fileSha256(repository, sourcePath)
    const manifest = {
        schema: changeContract.evidenceSchemas.postMergeExternalNamingEvidenceRepair,
        repository: changeContract.repository,
        originalPullRequest: 3031,
        originalBase,
        originalHead,
        mergeCommit,
        source: {
            path: sourcePath,
            candidateSha256: createHash('sha256')
                .update(execFileSync('git', ['show', `${originalHead}:${sourcePath}`], { cwd: repository }))
                .digest('hex'),
            currentSha256: sourceDigest
        },
        namingSurface: {
            id: 'environment-variable',
            reason
        },
        missingArtifact: {
            path: artifactPath,
            sha256: fileSha256(repository, artifactPath)
        },
        currentExceptions: [
            {
                id: 'content-doc-exactness-authority',
                paths: [currentSurfacePath],
                reason: 'preserve repository layout authority identifiers while documenting strict repair ownership'
            }
        ]
    }
    if (mutateManifest) mutateManifest(manifest, {
        repository,
        originalBase,
        originalHead,
        mergeCommit,
        sourcePath,
        artifactPath,
        repairPath,
        currentSurfacePath
    })
    writeRepositoryFile(repository, repairPath, `${JSON.stringify(manifest, null, 4)}\n`)
    const head = commitFixture(repository, 'fixture post-merge naming repair')
    return { repository, base, head }
}

function validatePostMergeExternalNamingRepairFixture(fixtureRepository) {
    return validatePrContract({
        title: 'fix(governance): repair omitted external naming evidence',
        body: postMergeExternalNamingRepairBody(),
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
        authorityRoot: root
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
    const repairDagSchema = JSON.parse(readFileSync(
        resolve(root, 'config/schemas/post-merge-generated-output-repair-dag.schema.json'),
        'utf8'
    ))
    assert.equal(
        repairDagSchema.properties.schema.const,
        changeContract.evidenceSchemas.postMergeGeneratedOutputRepairDag
    )
    assert.deepEqual(changeContract.generatedOutputRepairProducers[1], {
        id: 'backend-evidence-path-authority',
        source: 'tests/matrix.yml',
        generator: 'tools/test/generate-backend-evidence-path-authority.mjs',
        command: 'node tools/test/generate-backend-evidence-path-authority.mjs --write',
        executable: 'node',
        arguments: [
            'tools/test/generate-backend-evidence-path-authority.mjs',
            '--write'
        ],
        outputs: [
            'tests/backend/Fixtures/backend-evidence-path-authority.generated.json'
        ]
    })
    const namingRepairSchema = JSON.parse(readFileSync(
        resolve(root, 'config/schemas/post-merge-external-naming-evidence-repair.schema.json'),
        'utf8'
    ))
    assert.equal(
        namingRepairSchema.properties.schema.const,
        changeContract.evidenceSchemas.postMergeExternalNamingEvidenceRepair
    )
    assert.deepEqual(changeContract.generatedOutputRepairProducers.map((entry) => entry.id), [
        'testing-docs',
        'backend-evidence-path-authority'
    ])
    assert.deepEqual(changeContract.generatedOutputRepairDags.map((entry) => entry.id), [
        'evidence-location-governance'
    ])
    assert.equal(
        changeContract.generatedOutputRepairDags[0].manifest,
        'artifacts/change-contract/evidence-location-governance-post-merge-repair.json'
    )
    assert.deepEqual(changeContract.generatedOutputRepairDags[0].steps.map((step) => ({
        id: step.id,
        dependsOn: step.dependsOn,
        consumes: step.consumes,
        outputs: step.outputs
    })), [
        {
            id: 'evidence-location-governance',
            dependsOn: [],
            consumes: [],
            outputs: [
                'config/testing/evidence-locator-registry.json',
                'config/testing/evidence-location-migration-ledger.json'
            ]
        },
        {
            id: 'current-run-evidence-location-acceptance',
            dependsOn: ['evidence-location-governance'],
            consumes: [
                'config/testing/evidence-locator-registry.json',
                'config/testing/evidence-location-migration-ledger.json'
            ],
            outputs: ['config/testing/current-run-evidence-location-acceptance.json']
        }
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
    writeRepositoryFile(repository, 'src/generated/output.ts', Buffer.alloc(1_310_720, 0x61))
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

    writeRepositoryFile(repository, 'src/generated/output.ts', 'worktree-only content must not be trusted\n')
    assert.deepEqual(validatePrContract({
        title: 'chore(tooling): refresh generated contract fixture',
        body,
        labels: ['release-note:internal'],
        actor,
        changedFiles,
        root: repository,
        authorityRoot: null
    }), [])
    execFileSync('git', ['restore', 'src/generated/output.ts'], { cwd: repository })

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

test('revision reader rejects truncated, missing, invalid, and non-file Git objects', () => {
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-revision-reader-'))
    execFileSync('git', ['init', '-q'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
    writeRepositoryFile(repository, 'large.bin', Buffer.alloc(1_310_720, 0x62))
    symlinkSync('large.bin', join(repository, 'large-link.bin'))
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture revision objects'], { cwd: repository })
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8'
    }).trim()

    writeRepositoryFile(repository, 'large.bin', 'uncommitted worktree content\n')
    assert.equal(readFileAtRevision(repository, revision, 'large.bin').length, 1_310_720)
    assert.throws(
        () => readFileAtRevision(repository, revision, 'large.bin', { maximumBytes: 1024 }),
        /exceeds the 1024-byte revision read limit/u
    )
    assert.throws(
        () => readFileAtRevision(repository, 'not-a-revision', 'large.bin'),
        /repository revision does not resolve to one commit/u
    )
    assert.throws(
        () => readFileAtRevision(repository, revision, '../large.bin'),
        /invalid repository path/u
    )
    assert.throws(
        () => readFileAtRevision(repository, revision, 'missing.bin'),
        /does not resolve to one exact Git object/u
    )
    assert.throws(
        () => readFileAtRevision(repository, revision, 'large-link.bin'),
        /is not a regular Git blob/u
    )

    const gitExecutable = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    const wrapperDirectory = join(repository, 'git-wrapper')
    const wrapperPath = join(wrapperDirectory, 'git')
    mkdirSync(wrapperDirectory)
    writeFileSync(wrapperPath, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

if (process.argv[2] === 'cat-file' && process.argv[3] === 'blob') {
    process.stdout.write('truncated')
    process.exit(0)
}
const result = spawnSync(${JSON.stringify(gitExecutable)}, process.argv.slice(2), { stdio: 'inherit' })
process.exit(result.status ?? 1)
`)
    chmodSync(wrapperPath, 0o755)
    const originalPath = process.env.PATH
    try {
        process.env.PATH = `${wrapperDirectory}${delimiter}${originalPath}`
        assert.throws(
            () => readFileAtRevision(repository, revision, 'large.bin'),
            /Git blob read was truncated/u
        )
    } finally {
        process.env.PATH = originalPath
    }
})

test('revision reader ignores commit and blob replacement refs', () => {
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-revision-replace-'))
    execFileSync('git', ['init', '-q'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository })
    writeRepositoryFile(repository, 'sample.txt', 'original bytes\n')
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture original revision'], { cwd: repository })
    const originalRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8'
    }).trim()
    const originalBlob = execFileSync('git', ['rev-parse', `${originalRevision}:sample.txt`], {
        cwd: repository,
        encoding: 'utf8'
    }).trim()

    writeRepositoryFile(repository, 'sample.txt', 'replacement bytes are longer\n')
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '-qm', 'fixture replacement revision'], { cwd: repository })
    const replacementRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8'
    }).trim()
    const replacementBlob = execFileSync('git', ['rev-parse', `${replacementRevision}:sample.txt`], {
        cwd: repository,
        encoding: 'utf8'
    }).trim()

    execFileSync('git', ['replace', originalRevision, replacementRevision], { cwd: repository })
    assert.equal(
        execFileSync('git', ['show', `${originalRevision}:sample.txt`], { cwd: repository, encoding: 'utf8' }),
        'replacement bytes are longer\n'
    )
    assert.equal(
        readFileAtRevision(repository, originalRevision, 'sample.txt').toString('utf8'),
        'original bytes\n'
    )

    execFileSync('git', ['replace', '-d', originalRevision], { cwd: repository })
    execFileSync('git', ['replace', originalBlob, replacementBlob], { cwd: repository })
    assert.equal(
        execFileSync('git', ['show', `${originalRevision}:sample.txt`], { cwd: repository, encoding: 'utf8' }),
        'replacement bytes are longer\n'
    )
    assert.equal(
        readFileAtRevision(repository, originalRevision, 'sample.txt').toString('utf8'),
        'original bytes\n'
    )
})

test('post-merge generated repair binds exact history and isolated canonical replays', () => {
    const repair = createPostMergeRepairFixture()
    assert.deepEqual(validatePostMergeRepairFixture(repair), [])
})

test('post-merge generated repair accepts the exact two-parent source revision inside the named pull request', () => {
    const repair = createPostMergeRepairFixture({ sourceRevisionMode: 'merge' })
    assert.deepEqual(validatePostMergeRepairFixture(repair), [])
})

test('post-merge generated repair rejects reversed, wrong, and multi-parent source revisions', () => {
    const reversed = createPostMergeRepairFixture({ sourceRevisionMode: 'reversed' })
    const reversedErrors = validatePostMergeRepairFixture(reversed)
    assert.ok(reversedErrors.some(
        (error) => error.includes('second parent must exactly match the merged pull request base')
    ))
    assert.ok(reversedErrors.some(
        (error) => error.includes('first parent must be the pull request replay parent')
    ))

    const wrongParent = createPostMergeRepairFixture({ sourceRevisionMode: 'wrong-parent' })
    assert.ok(validatePostMergeRepairFixture(wrongParent).some(
        (error) => error.includes('second parent must exactly match the merged pull request base')
    ))

    const multiParent = createPostMergeRepairFixture({ sourceRevisionMode: 'multi-parent' })
    assert.ok(validatePostMergeRepairFixture(multiParent).some(
        (error) => error.includes('must have one parent or an exact two-parent in-PR merge')
    ))
})

test('post-merge generated repair rejects side-parent and ambiguous current source histories', () => {
    const sideParent = createPostMergeRepairFixture({ sourceRevisionMode: 'side-parent' })
    assert.ok(validatePostMergeRepairFixture(sideParent).some(
        (error) => error.includes('must be on the exact first-parent chain')
    ))

    const ambiguous = createPostMergeRepairFixture({ sourceRevisionMode: 'ambiguous' })
    assert.ok(validatePostMergeRepairFixture(ambiguous).some(
        (error) => error.includes('must be the unique current last trusted source revision')
    ))
})

test('post-merge generated repair rejects arbitrary outer identity and generator changes in a source merge', () => {
    const arbitraryOuter = createPostMergeRepairFixture({
        sourceRevisionMode: 'merge',
        mutateManifest: (manifest) => {
            manifest.mergedPullRequest += 1
        }
    })
    assert.ok(validatePostMergeRepairFixture(arbitraryOuter).some(
        (error) => error.includes('mergedPullRequest must match the exact merge commit message')
    ))

    const changedGenerator = createPostMergeRepairFixture({
        sourceRevisionMode: 'merge',
        changeGenerator: true
    })
    assert.ok(validatePostMergeRepairFixture(changedGenerator).some(
        (error) => error.includes('generator changed or its current digest is stale')
    ))

    const ownedRoundTrip = createPostMergeRepairFixture({
        sourceRevisionMode: 'merge',
        postSourceOwnedRoundTrip: true
    })
    assert.ok(validatePostMergeRepairFixture(ownedRoundTrip).some(
        (error) => error.includes('outer pull request must not change the trusted generator or outputs after sourceCommit')
    ))
})

test('post-merge generated repair rejects a candidate-side trusted generator mutation', () => {
    const repair = createPostMergeRepairFixture({
        sourceRevisionMode: 'merge',
        changeCandidateGenerator: true
    })
    assert.ok(validatePostMergeRepairFixture(repair).some(
        (error) => error.includes('generator changed or its current digest is stale')
    ))
})

test('post-merge generated repair rejects a source revision superseded at the current base', () => {
    const singleParent = createPostMergeRepairFixture({ laterSourceChange: true })
    assert.ok(validatePostMergeRepairFixture(singleParent).some(
        (error) => error.includes('sourceCommit must remain the current base owner')
    ))

    const mergedSource = createPostMergeRepairFixture({
        sourceRevisionMode: 'merge',
        laterSourceChange: true
    })
    assert.ok(validatePostMergeRepairFixture(mergedSource).some(
        (error) => error.includes('sourceCommit must remain the current base owner')
    ))
})

test('post-merge generated repair ignores replacement refs across history and replay validation', () => {
    for (const revisionField of ['sourceCommit', 'mergeCommit']) {
        const repair = createPostMergeRepairFixture({ sourceRevisionMode: 'merge' })
        const replacement = execFileSync(
            'git',
            ['rev-list', '--max-parents=0', 'HEAD'],
            { cwd: repair.repository, encoding: 'utf8' }
        ).trim()
        const original = repair.manifest[revisionField]
        execFileSync('git', ['replace', original, replacement], { cwd: repair.repository })
        const replacementAwareParents = execFileSync(
            'git',
            ['rev-list', '--parents', '--max-count=1', original],
            { cwd: repair.repository, encoding: 'utf8' }
        ).trim().split(/\s+/u).slice(1)
        const exactParents = execFileSync(
            'git',
            ['rev-list', '--parents', '--max-count=1', original],
            {
                cwd: repair.repository,
                encoding: 'utf8',
                env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
            }
        ).trim().split(/\s+/u).slice(1)
        assert.notDeepEqual(
            replacementAwareParents,
            exactParents,
            revisionField
        )
        assert.deepEqual(validatePostMergeRepairFixture(repair), [], revisionField)
    }
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
        (error) => error.includes('must have one parent or an exact two-parent in-PR merge')
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

test('post-merge generated repair DAG binds an ordered sealed range and canonical fixed point', () => {
    const repair = createPostMergeRepairDagFixture()
    assert.deepEqual(validatePostMergeRepairDagFixture(repair), [])
    const multiple = createPostMergeRepairDagFixture({ secondEvent: true })
    assert.deepEqual(validatePostMergeRepairDagFixture(multiple), [])
})

test('post-merge generated repair DAG requires the complete ordered source event range', () => {
    for (const [name, mutate] of [
        ['reordered', (manifest) => manifest.sourceEvents.reverse()],
        ['missing', (manifest) => manifest.sourceEvents.pop()],
        ['extra', (manifest) => manifest.sourceEvents.push(structuredClone(manifest.sourceEvents[1]))]
    ]) {
        const repair = createPostMergeRepairDagFixture({ secondEvent: true, mutateManifest: mutate })
        assert.match(
            validatePostMergeRepairDagFixture(repair).join('\n'),
            /sourceEvents omit, duplicate, or reorder canonical transitions/u,
            name
        )
    }
})

test('post-merge generated repair DAG rejects wrong, multi-parent, and side-parent source topology', () => {
    for (const [mode, pattern] of [
        ['wrong-parent', /invalid parent topology/u],
        ['multi-parent', /invalid parent topology/u],
        ['side-parent', /outside its named merge head/u]
    ]) {
        const repair = createPostMergeRepairDagFixture({ sourceRevisionMode: mode })
        assert.match(validatePostMergeRepairDagFixture(repair).join('\n'), pattern, mode)
    }
})

test('post-merge generated repair DAG rejects untrusted structure and stale sealed bindings', () => {
    const cases = [
        {
            name: 'unknown graph',
            mutate: (manifest) => { manifest.producerId = 'unknown-graph' },
            pattern: /not trusted/u
        },
        {
            name: 'reordered steps',
            mutate: (manifest) => { manifest.steps.reverse() },
            pattern: /step identity must match|generatorClosure must match/u
        },
        {
            name: 'missing step',
            mutate: (manifest) => { manifest.steps.pop() },
            pattern: /steps must exactly match/u
        },
        {
            name: 'extra step',
            mutate: (manifest) => { manifest.steps.push(structuredClone(manifest.steps[1])) },
            pattern: /steps must exactly match/u
        },
        {
            name: 'unknown execution identity',
            mutate: (manifest) => {
                manifest.steps[0].command = 'node unknown.mjs'
                manifest.steps[0].executable = 'unknown'
                manifest.steps[0].arguments = ['unknown.mjs']
            },
            pattern: /step identity must match|arguments must match/u
        },
        {
            name: 'missing dependency consumption',
            mutate: (manifest) => { manifest.steps[1].consumes = [] },
            pattern: /consumes must match/u
        },
        {
            name: 'forged closure digest',
            mutate: (manifest) => { manifest.steps[0].generatorClosure[0].baseSha256 = '0'.repeat(64) },
            pattern: /generator closure changed or is stale/u
        },
        {
            name: 'wrong output roster and flags',
            mutate: (manifest) => {
                manifest.outputs.reverse()
                manifest.outputs[0].changed = false
                manifest.outputs[0].repairRequired = false
            },
            pattern: /outputs must exactly match|repair\/change flags are wrong/u
        },
        {
            name: 'missing output',
            mutate: (manifest) => { manifest.outputs.pop() },
            pattern: /outputs must exactly match/u
        },
        {
            name: 'extra output',
            mutate: (manifest) => {
                manifest.outputs.push({
                    ...structuredClone(manifest.outputs[0]),
                    path: 'config/testing/untrusted-extra.json'
                })
            },
            pattern: /outputs must exactly match/u
        },
        {
            name: 'stale input tree and projection',
            mutate: (manifest) => {
                manifest.inputTree.baseSha256 = '1'.repeat(64)
                manifest.sourceProjection.base.sha256 = '2'.repeat(64)
            },
            pattern: /tracked input tree binding is stale|semantic source projection binding is stale/u
        },
        {
            name: 'duplicate event',
            mutate: (manifest) => { manifest.sourceEvents.push(structuredClone(manifest.sourceEvents[0])) },
            pattern: /omit, duplicate, or reorder/u
        },
        {
            name: 'event cap',
            mutate: (manifest) => {
                manifest.sourceEvents = Array.from(
                    { length: 65 },
                    () => structuredClone(manifest.sourceEvents[0])
                )
            },
            pattern: /sourceEvents exceeds 64 entries/u
        },
        {
            name: 'wrong pull request',
            mutate: (manifest) => { manifest.sourceEvents[0].mergedPullRequest += 1 },
            pattern: /source event identity is invalid/u
        },
        {
            name: 'candidate input mutation',
            mutate: (_manifest, repository) => { writeRepositoryFile(repository, 'candidate-extra.txt', 'extra\n') },
            pattern: /candidate changed unrelated paths before replay/u
        },
        {
            name: 'candidate policy mutation',
            mutate: (_manifest, repository) => {
                writeRepositoryFile(
                    repository,
                    'tools/test/evidence-location-scanner.mjs',
                    'export const fixture = "candidate mutation"\n'
                )
            },
            pattern: /candidate changed executable or trusted policy before replay/u
        },
        {
            name: 'tampered output',
            mutate: (_manifest, repository) => {
                writeRepositoryFile(
                    repository,
                    'config/testing/current-run-evidence-location-acceptance.json',
                    '{"tampered":true}\n'
                )
            },
            pattern: /candidate must be a canonical fixed point|output is not canonical/u
        },
        {
            name: 'symlink output',
            mutate: (_manifest, repository) => {
                const output = join(repository, 'config/testing/current-run-evidence-location-acceptance.json')
                unlinkSync(output)
                symlinkSync('../../semantic-source.txt', output)
            },
            pattern: /not one canonical regular file/u
        }
    ]
    for (const entry of cases) {
        const repair = createPostMergeRepairDagFixture({ mutateManifest: entry.mutate })
        assert.match(validatePostMergeRepairDagFixture(repair).join('\n'), entry.pattern, entry.name)
    }
})

test('post-merge generated repair DAG rejects producer write, dependency, and history violations', () => {
    const cases = [
        {
            name: 'future step output',
            options: { producerFault: 'future-output' },
            pattern: /producer step wrote another step's output/u
        },
        {
            name: 'unexpected untracked output',
            options: { producerFault: 'unexpected-write' },
            pattern: /producer DAG wrote unregistered outputs/u
        },
        {
            name: 'unexpected ignored output',
            options: { producerFault: 'ignored-write' },
            pattern: /producer DAG wrote unregistered outputs/u
        },
        {
            name: 'unexpected staged output',
            options: { producerFault: 'staged-write' },
            pattern: /producer DAG wrote unregistered outputs/u
        },
        {
            name: 'later overwrite',
            options: { producerFault: 'later-overwrite' },
            pattern: /producer step wrote another step's output/u
        },
        {
            name: 'declared but unconsumed dependency',
            options: { producerFault: 'no-consume' },
            pattern: /does not consume its declared dependency output/u
        },
        {
            name: 'non-deterministic producer',
            options: { producerFault: 'nondeterministic' },
            pattern: /not fixed-point|not deterministic/u
        },
        {
            name: 'event output mutation',
            options: { eventProtectedMutation: 'output' },
            pattern: /history changed outputs or policy closure/u
        },
        {
            name: 'event closure mutation',
            options: { eventProtectedMutation: 'closure' },
            pattern: /history changed outputs or policy closure|generator closure changed or is stale/u
        },
        {
            name: 'superseded event source',
            options: { supersedeSource: true },
            pattern: /must contain one exact canonical transition/u
        },
        {
            name: 'two-parent superseded event source',
            options: { supersedeSource: 'two-parent' },
            pattern: /must contain one exact canonical transition/u
        },
        {
            name: 'outer merge result mutation',
            options: { outerProtectedMutation: true },
            pattern: /outer history changed outputs or policy closure before replay/u
        }
    ]
    for (const entry of cases) {
        const repair = createPostMergeRepairDagFixture(entry.options)
        assert.match(validatePostMergeRepairDagFixture(repair).join('\n'), entry.pattern, entry.name)
    }
})

test('post-merge generated repair DAG enforces anchor ownership and aggregate replay budgets', () => {
    const tail = createPostMergeRepairDagFixture({ synchronizedTail: true })
    assert.match(
        validatePostMergeRepairDagFixture(tail).join('\n'),
        /synchronized revision must own at least one graph output/u
    )

    const oversizedHistory = createPostMergeRepairDagFixture({ outerPaddingCommits: 129 })
    assert.match(
        validatePostMergeRepairDagFixture(oversizedHistory).join('\n'),
        /first-parent range exceeds 128 revisions|exceeds 128 unique replay revisions/u
    )
})

test('post-merge generated repair DAG rejects oversized nested structures before replay', () => {
    for (const [label, mutate] of [
        ['steps', (manifest) => { manifest.steps = Array.from({ length: 17 }, () => structuredClone(manifest.steps[0])) }],
        ['outputs', (manifest) => { manifest.outputs = Array.from({ length: 129 }, () => structuredClone(manifest.outputs[0])) }],
        ['arguments', (manifest) => { manifest.steps[0].arguments = Array.from({ length: 129 }, () => 'argument') }],
        ['closure', (manifest) => { manifest.steps[0].generatorClosure = Array.from({ length: 129 }, () => structuredClone(manifest.steps[0].generatorClosure[0])) }]
    ]) {
        const repair = createPostMergeRepairDagFixture({ mutateManifest: mutate })
        assert.match(validatePostMergeRepairDagFixture(repair).join('\n'), /exceeds \d+ entries/u, label)
    }
})

test('post-merge generated repair DAG rejects untrusted candidate and history code before execution', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'fsusblog-repair-dag-no-exec-'))
    try {
        const candidateMarker = join(temporaryRoot, 'candidate-executed')
        const candidate = createPostMergeRepairDagFixture({
            mutateManifest: (_manifest, repository) => {
                writeRepositoryFile(
                    repository,
                    'tools/test/generate-evidence-location-governance.mjs',
                    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(candidateMarker)}, 'executed\\n')\n`
                )
            }
        })
        assert.match(
            validatePostMergeRepairDagFixture(candidate).join('\n'),
            /candidate changed executable or trusted policy before replay/u
        )
        assert.equal(existsSync(candidateMarker), false)

        const historyMarker = join(temporaryRoot, 'history-executed')
        const history = createPostMergeRepairDagFixture({ historyExecutionMarker: historyMarker })
        assert.match(
            validatePostMergeRepairDagFixture(history).join('\n'),
            /outer history changed outputs or policy closure before replay|source branch changed outputs or policy closure before replay|generator closure is not trusted before replay/u
        )
        assert.equal(existsSync(historyMarker), false)

        const candidateInputMarker = join(temporaryRoot, 'candidate-input-executed')
        const candidateInput = createPostMergeRepairDagFixture({
            candidateInputExecutionMarker: candidateInputMarker,
            mutateManifest: (_manifest, repository) => {
                writeRepositoryFile(repository, 'candidate-extra.ts', 'x'.repeat(256 * 1024))
            }
        })
        assert.match(
            validatePostMergeRepairDagFixture(candidateInput).join('\n'),
            /candidate changed unrelated paths before replay/u
        )
        assert.equal(existsSync(candidateInputMarker), false)
    } finally {
        rmSync(temporaryRoot, { recursive: true, force: true })
    }
})

test('post-merge generated repair DAG ignores replacement refs for anchors, events, trees, and blobs', () => {
    const revisions = [
        ['synchronizedRevision'],
        ['synchronizedMergeCommit'],
        ['sourceEvents', 0, 'sourceRevision'],
        ['sourceEvents', 0, 'mergeCommit']
    ]
    for (const path of revisions) {
        const repair = createPostMergeRepairDagFixture()
        const original = path.reduce((value, key) => value[key], repair.manifest)
        const replacement = execFileSync(
            'git',
            ['rev-list', '--max-parents=0', 'HEAD'],
            { cwd: repair.repository, encoding: 'utf8' }
        ).trim()
        execFileSync('git', ['replace', original, replacement], { cwd: repair.repository })
        assert.deepEqual(validatePostMergeRepairDagFixture(repair), [], path.join('.'))
    }

    const blobRepair = createPostMergeRepairDagFixture()
    const originalBlob = execFileSync(
        'git',
        ['rev-parse', `${blobRepair.base}:semantic-source.txt`],
        { cwd: blobRepair.repository, encoding: 'utf8' }
    ).trim()
    const replacementBlob = execFileSync(
        'git',
        ['hash-object', '-w', '--stdin'],
        { cwd: blobRepair.repository, encoding: 'utf8', input: 'replacement source bytes\n' }
    ).trim()
    execFileSync('git', ['replace', originalBlob, replacementBlob], { cwd: blobRepair.repository })
    assert.deepEqual(validatePostMergeRepairDagFixture(blobRepair), [], 'source blob')

    const treeRepair = createPostMergeRepairDagFixture()
    const originalTree = execFileSync(
        'git',
        ['rev-parse', `${treeRepair.base}^{tree}`],
        { cwd: treeRepair.repository, encoding: 'utf8' }
    ).trim()
    const rootRevision = execFileSync(
        'git',
        ['rev-list', '--max-parents=0', 'HEAD'],
        { cwd: treeRepair.repository, encoding: 'utf8' }
    ).trim()
    const replacementTree = execFileSync(
        'git',
        ['rev-parse', `${rootRevision}^{tree}`],
        { cwd: treeRepair.repository, encoding: 'utf8' }
    ).trim()
    execFileSync('git', ['replace', originalTree, replacementTree], { cwd: treeRepair.repository })
    assert.deepEqual(validatePostMergeRepairDagFixture(treeRepair), [], 'base tree')
})

test('post-merge external naming repair binds exact history, source identity, surface, and missing artifact', () => {
    const repair = createPostMergeExternalNamingRepairFixture()
    assert.deepEqual(validatePostMergeExternalNamingRepairFixture(repair), [])
})

test('post-merge external naming repair rejects unmerged and wrong repository or history identities', () => {
    const unmerged = createPostMergeExternalNamingRepairFixture({ unmerged: true })
    assert.ok(validatePostMergeExternalNamingRepairFixture(unmerged).some(
        (error) => error.includes('mergeCommit must be an ancestor')
    ))

    const wrongRepository = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) => { manifest.repository = 'Wrong/Repository' }
    })
    assert.ok(validatePostMergeExternalNamingRepairFixture(wrongRepository).some(
        (error) => error.includes('repository must be Ozwasyd/FsusBlog')
    ))

    for (const [field, mutate, message] of [
        ['base', (manifest) => { manifest.originalBase = manifest.originalHead }, 'parents must exactly match'],
        ['head', (manifest) => { manifest.originalHead = manifest.originalBase }, 'parents must exactly match'],
        ['merge', (manifest) => { manifest.mergeCommit = manifest.originalHead }, 'parents must exactly match']
    ]) {
        const wrong = createPostMergeExternalNamingRepairFixture({ mutateManifest: mutate })
        assert.ok(
            validatePostMergeExternalNamingRepairFixture(wrong).some((error) => error.includes(message)),
            field
        )
    }
})

test('post-merge external naming repair rejects stale blobs, source drift, and wrong ownership', () => {
    const staleCandidate = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) => { manifest.source.candidateSha256 = '0'.repeat(64) }
    })
    assert.ok(validatePostMergeExternalNamingRepairFixture(staleCandidate).some(
        (error) => error.includes('source blob identity drifted')
    ))
    const staleCurrent = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) => { manifest.source.currentSha256 = '1'.repeat(64) }
    })
    assert.ok(validatePostMergeExternalNamingRepairFixture(staleCurrent).some(
        (error) => error.includes('source blob identity drifted')
    ))
    const changedSource = createPostMergeExternalNamingRepairFixture({ laterSourceChange: true })
    const changedSourceErrors = validatePostMergeExternalNamingRepairFixture(changedSource)
    assert.ok(changedSourceErrors.some((error) => error.includes('source blob identity drifted')))
    assert.ok(changedSourceErrors.some((error) => error.includes('source revision changed')))

    const wrongPath = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) => { manifest.source.path = 'docs/testing.md' }
    })
    assert.ok(validatePostMergeExternalNamingRepairFixture(wrongPath).some(
        (error) => error.includes('outside registered surface')
    ))
    const wrongSurface = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) => { manifest.namingSurface.id = 'unknown-surface' }
    })
    assert.ok(validatePostMergeExternalNamingRepairFixture(wrongSurface).some(
        (error) => error.includes('surface is not registered')
    ))
})

test('post-merge external naming repair rejects malformed, extra, missing, and stale artifact evidence', () => {
    const extraField = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) => { manifest.unexpected = true }
    })
    assert.ok(validatePostMergeExternalNamingRepairFixture(extraField).some(
        (error) => error.includes('unsupported fields')
    ))
    const missingField = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) => { delete manifest.repository }
    })
    assert.ok(validatePostMergeExternalNamingRepairFixture(missingField).some(
        (error) => error.includes('unsupported fields')
    ))
    const staleArtifact = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) => { manifest.missingArtifact.sha256 = '2'.repeat(64) }
    })
    assert.ok(validatePostMergeExternalNamingRepairFixture(staleArtifact).some(
        (error) => error.includes('missingArtifact digest is stale')
    ))
    const missingArtifact = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) => {
            manifest.missingArtifact.path = 'artifacts/change-contract/not-created.json'
        }
    })
    const missingArtifactErrors = validatePostMergeExternalNamingRepairFixture(missingArtifact)
    assert.ok(missingArtifactErrors.some((error) => error.includes('must be changed by the candidate')))
    const extraDeclaration = createPostMergeExternalNamingRepairFixture({
        mutateArtifact: (artifact) => artifact.exceptions.push(structuredClone(artifact.exceptions[0]))
    })
    assert.ok(validatePostMergeExternalNamingRepairFixture(extraDeclaration).some(
        (error) => error.includes('exactly one exception')
    ))
    const missingCurrentException = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) => { manifest.currentExceptions = [] }
    })
    assert.ok(validatePostMergeExternalNamingRepairFixture(missingCurrentException).some(
        (error) => error.includes('current exceptions must exactly match')
    ))
    const wrongCurrentException = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) => {
            manifest.currentExceptions[0].id = 'environment-variable'
        }
    })
    assert.ok(validatePostMergeExternalNamingRepairFixture(wrongCurrentException).some(
        (error) => error.includes('outside registered surface environment-variable')
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
