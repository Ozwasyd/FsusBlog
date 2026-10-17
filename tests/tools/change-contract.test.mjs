import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const {default: commitlintConfig} = await import(new URL('../../commitlint.config.mjs', import.meta.url));
const {changeContract, javascriptFormatFingerprint, changedFilesBetween, parseBlameIgnoreRevisions, validateBlameIgnoreRevisions, validateCommitRange, validateCommitMessage, validateFormatOnlyDiff, validateFormatOnlyPullRequest, validatePerformancePullRequest, validateGeneratedRepairPassThroughException, inspectGeneratedRepairDagHistory, validateReviewedGeneratedRepairDagEvents, validateGeneratedRepairDagEventOrder, reviewedDagHistoryAdmission, validatePostMergeGeneratedOutputRepair, validatePostMergeGeneratedOutputDigestRepair, validatePrContract, pullRequestActor, readFileAtRevision, validateRepositoryBlameIgnore, validateRepositorySources} = await import(new URL('../../tools/governance/change-contract.mjs', import.meta.url));
const root = resolve(import.meta.dirname, '../..');
const fixtures = resolve(root, 'tests/fixtures/governance/change-contract');

test('reviewed and later generic DAG events retain one global replay order', () =>
{
    const registered = changeContract.generatedOutputRepairDagReviewedHistories[0].sourceBranches.flatMap((branch) => (
        branch.transitions.map((sourceRevision) => ({
            sourceRevision, mergedPullRequest: branch.mergedPullRequest, mergeCommit: branch.mergeCommit
        }))
    ));
    const later = { sourceRevision: 'a'.repeat(40), mergedPullRequest: 3241, mergeCommit: 'b'.repeat(40) };
    const expected = [...registered, later];
    assert.deepEqual(validateGeneratedRepairDagEventOrder(expected, expected), []);
    for (const actual of [
        [later, ...registered],
        [...registered.slice(0, 8), later, ...registered.slice(8)],
        [...registered.slice(0, 15), later, registered[15]]
    ])
    {
        assert.match(validateGeneratedRepairDagEventOrder(actual, expected).join('\n'), /complete global replay order/u);
    }
});

test('reviewed generated repair DAG policy suffix only moves to the loaded base epoch', () =>
{
    const temporary = mkdtempSync(join(tmpdir(), 'fsusblog-reviewed-policy-epoch-'));
    const registration = changeContract.generatedOutputRepairDagReviewedHistories[0];
    const graph = changeContract.generatedOutputRepairDags[0];
    const historicalBase = registration.reviewedRevision;
    const env = {
        ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_INDEX_FILE: join(temporary, 'index'),
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
    };
    const git = (args, input) => execFileSync('git', args, { cwd: root, env, input, encoding: 'utf8' }).trim();
    const policyPath = 'tools/governance/check-change-contract.mjs';
    const oldPolicy = git(['show', `${historicalBase}:${policyPath}`]);
    const currentPolicy = `${oldPolicy}\n// reviewed current policy epoch\n`;
    const create = (parent, changes) =>
    {
        git(['read-tree', parent]);
        for (const [path, text] of changes)
        {
            const object = git(['hash-object', '-w', '--stdin'], text);
            git(['update-index', '--add', '--cacheinfo', `100644,${object},${path}`]);
        }
        return git(['commit-tree', git(['write-tree']), '-p', parent, '-m', 'fix(governance): bind fixture policy epoch']);
    };
    let base;
    const merge = (head) => git(['commit-tree', git(['rev-parse', `${head}^{tree}`]), '-p', base, '-p', head,
        '-m', 'Merge pull request #3241 from fixture/reviewed-policy']);
    try
    {
        const newlyTrustedPath = 'config/schemas/post-merge-generated-output-digest-repair.schema.json';
        const newlyTrustedContent = git(['show', `HEAD:${newlyTrustedPath}`]);
        base = create(historicalBase, [[newlyTrustedPath, newlyTrustedContent]]);
        const admit = (revision) => reviewedDagHistoryAdmission(root, graph, registration.synchronizedMerge,
            registration.synchronizedRevision, revision);
        const baseAdmission = admit(base);
        assert.ok(baseAdmission);
        assert.equal(baseAdmission.admittedPolicyRevisions.has(base), true);
        const current = create(base, [[policyPath, currentPolicy]]);
        const merged = merge(current);
        assert.ok(admit(merged).admittedPolicyRevisions.has(current));
        const intermediate = create(base, [[policyPath, `${oldPolicy}\n// unregistered intermediate\n`]]);
        assert.throws(() => admit(merge(create(intermediate, [[policyPath, currentPolicy]]))), /unregistered intermediate/u);
        const newPathIntermediate = create(base, [[newlyTrustedPath, 'unregistered intermediate\n']]);
        assert.throws(() => admit(merge(create(newPathIntermediate, [[newlyTrustedPath, newlyTrustedContent]]))),
            /unregistered intermediate/u);
        const rollback = create(current, [[policyPath, `${oldPolicy}\n`]]);
        assert.throws(() => admit(merge(create(rollback, [[policyPath, currentPolicy]]))), /rolled back/u);
        for (const mixedPath of ['tools/test/evidence-location-scanner.mjs', 'config/testing/evidence-location-migration-ledger.json'])
        {
            const content = git(['show', `${base}:${mixedPath}`]);
            const mixed = create(base, [[policyPath, currentPolicy], [mixedPath, `${content}\n \n`]]);
            assert.throws(() => admit(merge(mixed)), /changed generator closure or outputs/u);
        }
    }
    finally
    {
        rmSync(temporary, { recursive: true, force: true });
    }
});

test('reviewed generated repair DAG source events preserve all sixteen historical transitions', () =>
{
    const registration = changeContract.generatedOutputRepairDagReviewedHistories[0];
    const observed = structuredClone(registration.sourceBranches);
    const events = observed.flatMap((branch) => branch.transitions.map((sourceRevision) => ({
        sourceRevision, mergedPullRequest: branch.mergedPullRequest, mergeCommit: branch.mergeCommit
    })));
    assert.equal(events.length, 16);
    assert.equal(observed.length, 2);
    assert.deepEqual(validateReviewedGeneratedRepairDagEvents(registration, observed, events), []);
    for (const mutate of [
        (rows) => rows.pop(),
        (rows) => rows.push(structuredClone(rows[0])),
        (rows) => rows.reverse(),
        (rows) =>
        {
            rows[1].mergeCommit = '380bc3b0114b6b19ac4524a346d46fcf8dd08ef5';
        }
    ])
    {
        const changed = structuredClone(events);
        mutate(changed);
        assert.match(validateReviewedGeneratedRepairDagEvents(registration, observed, changed).join('\n'),
            /every replayed transition exactly once/u);
    }
    const missingObserved = structuredClone(observed);
    missingObserved[1].transitions.pop();
    assert.match(validateReviewedGeneratedRepairDagEvents(registration, missingObserved, events).join('\n'),
        /complete registered order/u);
    assert.match(validateReviewedGeneratedRepairDagEvents(registration, [...observed, observed[0]], events).join('\n'),
        /complete registered order/u);
});

test('reviewed generated repair DAG history seals complete original epoch topology', () =>
{
    const graph = changeContract.generatedOutputRepairDags.find((entry) => entry.id === 'evidence-location-governance');
    const synchronizedMerge = '182ffa102d7c322be9e01e98e2d3ee38554f52b0';
    const reviewedRevision = 'c7084b001a0c220538cbaca8f7305b1f3777493c';
    const synchronizedRevision = 'e805a72c5171916f761701fc4dbd3116953d4d20';
    const history = inspectGeneratedRepairDagHistory(root, graph, synchronizedMerge, reviewedRevision, synchronizedRevision);
    assert.equal(history.sha256, 'a8a4b5205160bc4afc2c71a9b9d2ae583828277b1130b5f6780cf9b1584bd52f');
    const newlyTrustedDigestRepairPolicyPaths = [
        'config/schemas/post-merge-generated-output-digest-repair.schema.json',
        'tools/governance/generate-generated-output-digest-repair-manifest.mjs',
        'tools/governance/generated-output-digest-repair-repository.mjs',
        'tools/governance/generated-output-digest-repair-v2.mjs'
    ];
    assert.deepEqual(
        changeContract.trustedPolicyFiles.filter((path) => newlyTrustedDigestRepairPolicyPaths.includes(path)).sort(),
        newlyTrustedDigestRepairPolicyPaths.slice().sort()
    );
    assert.deepEqual(
        history.protectedPaths.filter((path) => newlyTrustedDigestRepairPolicyPaths.includes(path)).sort(),
        newlyTrustedDigestRepairPolicyPaths.slice().sort()
    );
    const javascriptFormatPolicyPaths = [
        'tools/governance/javascript-format-equivalence.mjs',
        'tools/governance/javascript-format-parser/package.json',
        'tools/governance/javascript-format-parser/package-lock.json'
    ];
    assert.deepEqual(
        history.protectedPaths.filter((path) => javascriptFormatPolicyPaths.includes(path)).sort(),
        javascriptFormatPolicyPaths.slice().sort()
    );
    assert.deepEqual(
        changeContract.generatedOutputDigestRepairProducers[0].protectedPolicyPaths
            .filter((path) => javascriptFormatPolicyPaths.includes(path)).sort(),
        javascriptFormatPolicyPaths.slice().sort()
    );
    assert.equal(history.nodes.length, 83);
    assert.equal(history.outerRevisions.length, 16);
    const oldNode = history.nodes.find((entry) => entry.revision === '6ee54e39cccdd8e7b0b958b3f93bf1c224068155');
    assert.deepEqual(oldNode.entries.find((entry) => entry.path === 'tools/test/evidence-location-scanner.mjs'), {
        path: 'tools/test/evidence-location-scanner.mjs', mode: '100644', object: 'c1a9bf9d5faa8c5271d0c14d5274907e0ac52b5a'
    });
    assert.throws(() => inspectGeneratedRepairDagHistory(root, graph, reviewedRevision, synchronizedMerge, synchronizedRevision),
        /exact first-parent boundaries/u);
    assert.throws(() => inspectGeneratedRepairDagHistory(root, graph, synchronizedMerge, reviewedRevision, synchronizedMerge),
        /synchronized source/u);
    const shortened = inspectGeneratedRepairDagHistory(root, graph, synchronizedMerge,
        '43961f1b7f89c117773ad25dfeb4554bdbba3e72', synchronizedRevision);
    assert.notEqual(shortened.sha256, history.sha256);
});

test('JavaScript formatting compares syntax, raw tokens and anchored comments', () =>
{
    const fingerprint = (source) => javascriptFormatFingerprint(source, 'sample.mjs');
    assert.equal(fingerprint('const f = () => { return 1; };'), fingerprint('const f = () =>\n{\n    return 1;\n};'));
    for (const [before, after] of [
        ['function f(){return 1}', 'function f(){return\n1}'],
        ['let a=1; let b=2; a++\nb', 'let a=1; let b=2; a\n++b'],
        ['const x = /a+/u;', 'const x = /b+/u;'],
        ['const x = a / b / c;', 'const x = a / (b / c);'],
        ['const x = `a ${v}`;', 'const x = `a  ${v}`;'],
        ['"use strict"; f();', '"use sloppy"; f();'],
        ['// eslint-disable-next-line rule\nf();\ng();', 'f();\n// eslint-disable-next-line rule\ng();'],
        ['// eslint-disable-next-line rule\nf();', '// eslint-disable-next-line rule\n\nf();'],
        ['const x = 1;', 'const x = 2;']
    ])
    {
        assert.notEqual(fingerprint(before), fingerprint(after));
    }
    assert.throws(() => fingerprint('const = ;'));
});

test('canonical transaction brace hunks remain equivalent under the trusted parser', () =>
{
    const samples = [
        ['const originals = new Map(transaction.changes.map((change) => {\nreturn change;\n}));', 'const originals = new Map(transaction.changes.map((change) =>\n{\nreturn change;\n}));'],
        ["const options = { verifyAfter: () => { throw new Error('verification failed'); } };", "const options = { verifyAfter: () =>\n{\nthrow new Error('verification failed');\n} };"]
    ];
    for (const [before, after] of samples)
    {
        assert.equal(javascriptFormatFingerprint(before, 'sample.mjs'), javascriptFormatFingerprint(after, 'sample.mjs'));
    }
});

test('JavaScript formatter ignores candidate cwd and NODE_PATH parser substitutions', () =>
{
    const candidate = mkdtempSync(join(tmpdir(), 'fsusblog-format-parser-candidate-'));
    try
    {
        const fake = join(candidate, 'espree');
        mkdirSync(fake);
        writeFileSync(join(fake, 'package.json'), JSON.stringify({ name: 'espree', main: 'index.js' }));
        writeFileSync(join(fake, 'index.js'), 'throw new Error("candidate parser must not execute")');
        const moduleUrl = pathToFileURL(resolve(root, 'tools/governance/javascript-format-equivalence.mjs')).href;
        const code = `import { javascriptFormatFingerprint as fingerprint } from ${JSON.stringify(moduleUrl)}; console.log(fingerprint('const value = 1;', 'sample.mjs'))`;
        const result = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
            cwd: candidate,
            env: { ...process.env, NODE_PATH: candidate },
            encoding: 'utf8'
        });
        assert.equal(result.trim(), javascriptFormatFingerprint('const value = 1;', 'sample.mjs'));
    }
    finally
    {
        rmSync(candidate, { recursive: true, force: true });
    }
});

test('JavaScript formatter fails closed when its own pinned parser is absent', () =>
{
    const isolated = mkdtempSync(join(tmpdir(), 'fsusblog-format-parser-missing-'));
    try
    {
        const parserDirectory = join(isolated, 'javascript-format-parser');
        mkdirSync(parserDirectory);
        for (const file of ['package.json', 'package-lock.json'])
        {
            writeFileSync(join(parserDirectory, file), readFileSync(resolve(root, 'tools/governance/javascript-format-parser', file)));
        }
        writeFileSync(join(isolated, 'javascript-format-equivalence.mjs'), readFileSync(resolve(root, 'tools/governance/javascript-format-equivalence.mjs')));
        const moduleUrl = pathToFileURL(join(isolated, 'javascript-format-equivalence.mjs')).href;
        const code = `import { javascriptFormatFingerprint } from ${JSON.stringify(moduleUrl)}; javascriptFormatFingerprint('const value = 1;', 'sample.mjs')`;
        assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', code], {
            cwd: isolated,
            env: { ...process.env, NODE_PATH: resolve(root, 'tools/governance/javascript-format-parser/node_modules') },
            stdio: 'pipe'
        }), (error) => error.status !== 0 && /ENOENT/u.test(error.stderr.toString()));
    }
    finally
    {
        rmSync(isolated, { recursive: true, force: true });
    }
});

test('checker parser installation is locked, script-free and selected from the trusted checkout', () =>
{
    const workflow = readFileSync(resolve(root, '.github/workflows/change-contract.yml'), 'utf8');
    const install = workflow.slice(workflow.indexOf('- name: Install the selected checker parser'), workflow.indexOf('- name: Validate pull request and squash contract'));
    assert.match(install, /checker_root="\$GITHUB_WORKSPACE\/trusted"/u);
    assert.match(install, /if \[\[ "\$EVENT_NAME" == "pull_request" \]\]; then[\s\S]*?exit 1/u);
    assert.match(install, /npm ci --ignore-scripts --no-audit --no-fund --prefix "\$parser_root"/u);
    const manifest = JSON.parse(readFileSync(resolve(root, 'tools/governance/javascript-format-parser/package.json'), 'utf8'));
    assert.deepEqual(manifest.dependencies, { espree: '10.4.0' });
    assert.equal(manifest.scripts, undefined);
    const lock = JSON.parse(readFileSync(resolve(root, 'tools/governance/javascript-format-parser/package-lock.json'), 'utf8'));
    assert.equal(Object.values(lock.packages).some((entry) => entry.hasInstallScript), false);
    for (const file of ['javascript-format-equivalence.mjs', 'javascript-format-parser/package.json', 'javascript-format-parser/package-lock.json'])
    {
        assert.ok(changeContract.trustedPolicyFiles.includes(`tools/governance/${file}`));
    }
});

test('JavaScript parser rejects direct and transitive entry redirects, symlinks and cached authority drift', () =>
{
    for (const mutation of ['direct', 'transitive', 'symlink', 'cached'])
    {
        const isolated = mkdtempSync(join(tmpdir(), 'fsusblog-format-parser-path-'));
        try
        {
            const parserDirectory = join(isolated, 'javascript-format-parser');
            cpSync(resolve(root, 'tools/governance/javascript-format-parser'), parserDirectory, { recursive: true });
            writeFileSync(join(isolated, 'javascript-format-equivalence.mjs'), readFileSync(resolve(root, 'tools/governance/javascript-format-equivalence.mjs')));
            const moduleUrl = pathToFileURL(join(isolated, 'javascript-format-equivalence.mjs')).href;
            const espreeEntry = join(parserDirectory, 'node_modules/espree/dist/espree.cjs');
            if (mutation === 'direct' || mutation === 'transitive')
            {
                const packageDirectory = join(parserDirectory, 'node_modules', mutation === 'direct' ? 'espree' : 'acorn');
                const packagePath = join(packageDirectory, 'package.json');
                const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
                manifest.exports = './redirect.cjs';
                writeFileSync(packagePath, JSON.stringify(manifest));
                writeFileSync(join(packageDirectory, 'redirect.cjs'), 'throw new Error("redirect must never execute")');
            }
            else if (mutation === 'symlink')
            {
                const outside = join(isolated, 'outside.cjs');
                writeFileSync(outside, readFileSync(espreeEntry));
                unlinkSync(espreeEntry);
                symlinkSync(outside, espreeEntry);
            }
            const code = `import { appendFileSync } from 'node:fs'; import { javascriptFormatFingerprint as fingerprint } from ${JSON.stringify(moduleUrl)}; fingerprint('const value = 1;', 'sample.mjs'); ${mutation === 'cached' ? `appendFileSync(${JSON.stringify(espreeEntry)}, '\\n// changed authority'); fingerprint('const value = 1;', 'sample.mjs')` : ''}`;
            assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', code], { stdio: 'pipe' }), (error) =>
            {
                const stderr = error.stderr.toString();
                return error.status !== 0 && /entry redirected|canonical regular file|authority changed after loading/u.test(stderr) && !stderr.includes('redirect must never execute');
            }, mutation);
        }
        finally
        {
            rmSync(isolated, { recursive: true, force: true });
        }
    }
});

function fixture(kind, name)
{
    return readFileSync(resolve(fixtures, kind, name), 'utf8');
}

function writeRepositoryFile(repository, path, content)
{
    const target = join(repository, path);
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, content);
}

function contentTreeDigest(repository, paths)
{
    const hash = createHash('sha256');
    for (const path of [...paths].sort())
    {
        hash.update(path);
        hash.update('\x00');
        hash.update(readFileSync(join(repository, path)));
        hash.update('\x00');
    }
    return hash.digest('hex');
}

function fileSha256(repository, path)
{
    return createHash('sha256').update(readFileSync(join(repository, path))).digest('hex');
}

function writeFormatEvidence(repository, revision, paths = ['source.cs'])
{
    const digest = contentTreeDigest(repository, paths);
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
    }, null, 4)}\n`);
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
} = {})
{
    const behavior = ['feat', 'fix', 'perf', 'security', 'revert'].includes(type);
    const check = (value) => value ? 'x' : ' ';
    const releaseSummary = category === 'none' ? 'none' : (summary ?? 'expose article reading progress');
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
`;
}

function commitFixture(repository, message)
{
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', message], { cwd: repository });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
}

function commitTreeFixture(repository, tree, parents, message)
{
    return execFileSync('git', [
        'commit-tree',
        tree,
        ...parents.flatMap((parent) => ['-p', parent]),
        '-m',
        message
    ], { cwd: repository, encoding: 'utf8' }).trim();
}

function postMergeRepairBody()
{
    return pullRequestBody({
        type: 'fix',
        generated: true,
        audience: 'internal',
        category: 'Internal/Tooling',
        summary: 'repair omitted generated test documentation',
        generatorSource: 'tests/matrix.yml',
        generatedOutputs: 'docs/testing.generated.md',
        generatedDigest: 'artifacts/change-contract/testing-docs-post-merge-repair.json'
    });
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
} = {})
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-post-merge-generated-repair-'));
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
    writeRepositoryFile(repository, 'tests/matrix.yml', 'base\n');
    writeRepositoryFile(repository, 'tools/docs/generate-testing-docs.mjs', `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
if (outIndex < 0 || !args[outIndex + 1]) throw new Error('missing --out')
const output = resolve(args[outIndex + 1])
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, \`generated:\${readFileSync('tests/matrix.yml', 'utf8')}\`)
`.trimStart());
    writeRepositoryFile(
        repository,
        'docs/testing.generated.md',
        baselineOutputStale ? 'generated:stale\n' : 'generated:base\n'
    );
    commitFixture(repository, 'fixture baseline');

    let sourceCommit;
    let mergeCommit;
    if (sourceRevisionMode === 'single')
    {
        execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: repository });
        writeRepositoryFile(repository, 'tests/matrix.yml', 'expected\n');
        sourceCommit = commitFixture(repository, 'fixture omitted generated source');
        execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository });
        execFileSync('git', [
            'merge',
            '--no-ff',
            '-qm',
            'Merge pull request #2973 from fixture/generated-source',
            'feature'
        ], { cwd: repository });
        mergeCommit = execFileSync(
            'git',
            ['rev-parse', 'HEAD'],
            { cwd: repository, encoding: 'utf8' }
        ).trim();
    }
    else
    {
        const baseline = execFileSync(
            'git',
            ['rev-parse', 'HEAD'],
            { cwd: repository, encoding: 'utf8' }
        ).trim();
        execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: repository });
        writeRepositoryFile(repository, 'tests/matrix.yml', 'feature\n');
        execFileSync('node', [
            'tools/docs/generate-testing-docs.mjs',
            '--out',
            'docs/testing.generated.md'
        ], { cwd: repository });
        const replayParent = commitFixture(repository, 'fixture canonical replay parent');

        execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository });
        writeRepositoryFile(repository, 'tests/matrix.yml', 'base-side\n');
        writeRepositoryFile(repository, 'docs/testing.generated.md', 'generated:feature\n');
        const pullRequestBase = commitFixture(repository, 'fixture exact pull request base');

        execFileSync('git', ['checkout', '-q', 'feature'], { cwd: repository });
        writeRepositoryFile(repository, 'tests/matrix.yml', 'expected\n');
        if (changeGenerator)
        {
            writeRepositoryFile(repository, 'tools/docs/generate-testing-docs.mjs', `${readFileSync(
                join(repository, 'tools/docs/generate-testing-docs.mjs'),
                'utf8'
            )}\n// changed inside the source merge\n`);
        }
        execFileSync('git', ['add', '.'], { cwd: repository });
        const sourceTree = execFileSync(
            'git',
            ['write-tree'],
            { cwd: repository, encoding: 'utf8' }
        ).trim();
        const sourceParents = sourceRevisionMode === 'reversed'
            ? [pullRequestBase, replayParent]
            : sourceRevisionMode === 'wrong-parent'
                ? [replayParent, baseline]
                : sourceRevisionMode === 'multi-parent'
                    ? [replayParent, pullRequestBase, baseline]
                    : [replayParent, pullRequestBase];
        sourceCommit = commitTreeFixture(
            repository,
            sourceTree,
            sourceParents,
            'fixture two-parent source revision'
        );
        execFileSync('git', [
            'update-ref',
            'refs/heads/feature',
            sourceCommit,
            replayParent
        ], { cwd: repository });
        if (sourceRevisionMode === 'side-parent')
        {
            const primaryCommit = commitTreeFixture(
                repository,
                sourceTree,
                [replayParent],
                'fixture primary branch source revision'
            );
            const sideParentMerge = commitTreeFixture(
                repository,
                sourceTree,
                [primaryCommit, sourceCommit],
                'fixture source revision hidden on a side parent'
            );
            execFileSync('git', [
                'update-ref',
                'refs/heads/feature',
                sideParentMerge,
                sourceCommit
            ], { cwd: repository });
        }
        if (sourceRevisionMode === 'ambiguous')
        {
            writeRepositoryFile(repository, 'tests/matrix.yml', 'ambiguous-side-change\n');
            execFileSync('git', ['add', 'tests/matrix.yml'], { cwd: repository });
            const ambiguousTree = execFileSync(
                'git',
                ['write-tree'],
                { cwd: repository, encoding: 'utf8' }
            ).trim();
            const ambiguousSourceCommit = commitTreeFixture(
                repository,
                ambiguousTree,
                [sourceCommit],
                'fixture ambiguous side-parent source change'
            );
            writeRepositoryFile(repository, 'tests/matrix.yml', 'expected\n');
            execFileSync('git', ['add', 'tests/matrix.yml'], { cwd: repository });
            const ambiguousMerge = commitTreeFixture(
                repository,
                sourceTree,
                [sourceCommit, ambiguousSourceCommit],
                'fixture merge preserving first-parent source bytes'
            );
            execFileSync('git', [
                'update-ref',
                'refs/heads/feature',
                ambiguousMerge,
                sourceCommit
            ], { cwd: repository });
        }
        if (postSourceOwnedRoundTrip)
        {
            writeRepositoryFile(repository, 'docs/testing.generated.md', 'transient output\n');
            writeRepositoryFile(repository, 'tools/docs/generate-testing-docs.mjs', `${readFileSync(
                join(repository, 'tools/docs/generate-testing-docs.mjs'),
                'utf8'
            )}\n// transient generator change\n`);
            commitFixture(repository, 'fixture transient owned change');
            writeRepositoryFile(repository, 'docs/testing.generated.md', 'generated:feature\n');
            const generator = readFileSync(
                join(repository, 'tools/docs/generate-testing-docs.mjs'),
                'utf8'
            ).replace('\n// transient generator change\n', '');
            writeRepositoryFile(repository, 'tools/docs/generate-testing-docs.mjs', generator);
            commitFixture(repository, 'fixture restore owned change');
        }
        writeRepositoryFile(repository, 'feature-followup.txt', 'outer head\n');
        const pullRequestHead = commitFixture(repository, 'fixture exact pull request head');
        const mergeTree = execFileSync(
            'git',
            ['rev-parse', `${pullRequestHead}^{tree}`],
            { cwd: repository, encoding: 'utf8' }
        ).trim();
        mergeCommit = commitTreeFixture(
            repository,
            mergeTree,
            [pullRequestBase, pullRequestHead],
            'fix(governance): merge generated source (#2973)'
        );
        execFileSync('git', [
            'update-ref',
            'refs/heads/master',
            mergeCommit,
            pullRequestBase
        ], { cwd: repository });
        execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository });
    }
    if (laterSourceChange)
    {
        writeRepositoryFile(repository, 'tests/matrix.yml', 'later\n');
        commitFixture(repository, 'fixture superseding source change');
    }
    const base = execFileSync(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: repository, encoding: 'utf8' }
    ).trim();
    const baseSha256 = fileSha256(repository, 'docs/testing.generated.md');

    execFileSync('git', ['checkout', '-qb', 'candidate'], { cwd: repository });
    if (outputMode === 'canonical')
    {
        execFileSync('node', [
            'tools/docs/generate-testing-docs.mjs',
            '--out',
            'docs/testing.generated.md'
        ], { cwd: repository });
    }
    else if (outputMode === 'tampered')
    {
        writeRepositoryFile(repository, 'docs/testing.generated.md', 'tampered\n');
    }
    if (changeSource)
    {
        writeRepositoryFile(repository, 'tests/matrix.yml', 'candidate-source-change\n');
    }
    if (changeCandidateGenerator)
    {
        writeRepositoryFile(repository, 'tools/docs/generate-testing-docs.mjs', `${readFileSync(
            join(repository, 'tools/docs/generate-testing-docs.mjs'),
            'utf8'
        )}\n// changed by the repair candidate\n`);
    }

    const canonicalCurrent = createHash('sha256').update('generated:expected\n').digest('hex');
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
    };
    if (mutateManifest)
    {
        mutateManifest(manifest, repository);
    }
    writeRepositoryFile(
        repository,
        'artifacts/change-contract/testing-docs-post-merge-repair.json',
        `${JSON.stringify(manifest, null, 4)}\n`
    );
    const head = commitFixture(repository, 'fixture generated repair candidate');
    return { repository, base, head, manifest };
}

function validatePostMergeRepairFixture(fixtureRepository)
{
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
    });
}

function fixtureRevisionPathIdentity(repository, revision, path)
{
    const entry = execFileSync(
        'git',
        ['ls-tree', revision, '--', path],
        { cwd: repository, encoding: 'utf8' }
    ).trim().match(/^(?<mode>\d{6}) blob (?<object>[0-9a-f]{40})\t/u)?.groups;
    assert.ok(entry, `missing regular fixture blob ${revision}:${path}`);
    return `${entry.mode}:${entry.object}`;
}

function createRegisteredPassThroughFixture({ topology = 'valid', longDistance = 0 } = {})
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-registered-pass-through-'));
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
    writeRepositoryFile(repository, 'source.txt', 'divergent\n');
    writeRepositoryFile(repository, 'generator.mjs', 'export const generator = true\n');
    writeRepositoryFile(repository, 'output.txt', 'old-output\n');
    const baseline = commitFixture(repository, 'fixture pass-through baseline');

    execFileSync('git', ['checkout', '-qb', 'source-owner', baseline], { cwd: repository });
    writeRepositoryFile(repository, 'source.txt', 'authoritative\n');
    const sourceCommit = commitFixture(repository, 'fixture authoritative source owner');
    execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository });
    execFileSync('git', [
        'merge',
        '--no-ff',
        '-qm',
        'Merge pull request #4101 from fixture/source-owner',
        'source-owner'
    ], { cwd: repository });
    const mergeCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8'
    }).trim();

    execFileSync('git', ['checkout', '-qb', 'unrelated-line', baseline], { cwd: repository });
    writeRepositoryFile(repository, 'unrelated.txt', 'independent provenance\n');
    writeRepositoryFile(repository, 'unrelated-followup.txt', 'divergent first-parent line\n');
    const passThroughFirstParent = commitFixture(repository, 'fixture divergent first parent');

    let passThroughSecondParent;
    if (topology === 'wrong-second-parent')
    {
        execFileSync('git', ['checkout', '-qb', 'wrong-second', baseline], { cwd: repository });
        writeRepositoryFile(repository, 'source.txt', 'authoritative\n');
        writeRepositoryFile(repository, 'wrong-second.txt', 'not descended from source merge\n');
        passThroughSecondParent = commitFixture(repository, 'fixture wrong authoritative second parent');
    }
    else
    {
        execFileSync('git', ['checkout', '-qb', 'canonical-second', mergeCommit], { cwd: repository });
        writeRepositoryFile(repository, 'canonical-second.txt', 'canonical second parent\n');
        passThroughSecondParent = commitFixture(repository, 'fixture canonical second parent');
    }
    const passThroughTree = execFileSync('git', ['rev-parse', `${passThroughSecondParent}^{tree}`], {
        cwd: repository,
        encoding: 'utf8'
    }).trim();
    const passThroughCommit = commitTreeFixture(
        repository,
        passThroughTree,
        [passThroughFirstParent, passThroughSecondParent],
        'fixture exact second-parent pass-through'
    );
    execFileSync('git', ['branch', 'pass-through', passThroughCommit], { cwd: repository });

    let outerFirstParent;
    if (topology === 'wrong-second-parent')
    {
        const outerFirstTree = execFileSync('git', ['rev-parse', `${passThroughSecondParent}^{tree}`], {
            cwd: repository,
            encoding: 'utf8'
        }).trim();
        outerFirstParent = commitTreeFixture(
            repository,
            outerFirstTree,
            [passThroughSecondParent, mergeCommit],
            'fixture outer first parent joins the source merge'
        );
        execFileSync('git', ['branch', 'outer-first', outerFirstParent], { cwd: repository });
    }
    else
    {
        execFileSync('git', ['checkout', '-qb', 'outer-first', passThroughSecondParent], { cwd: repository });
        writeRepositoryFile(repository, 'outer-first.txt', 'outer first\n');
        outerFirstParent = commitFixture(repository, 'fixture outer first parent');
    }

    let outerSecondParent;
    if (topology === 'hidden-side-parent')
    {
        const hiddenTree = execFileSync('git', ['rev-parse', `${passThroughCommit}^{tree}`], {
            cwd: repository,
            encoding: 'utf8'
        }).trim();
        outerSecondParent = commitTreeFixture(
            repository,
            hiddenTree,
            [passThroughSecondParent, passThroughCommit],
            'fixture pass-through hidden on side parent'
        );
        execFileSync('git', ['branch', 'outer-second', outerSecondParent], { cwd: repository });
    }
    else
    {
        execFileSync('git', ['checkout', '-qb', 'outer-second', passThroughCommit], { cwd: repository });
        writeRepositoryFile(repository, 'outer-second.txt', 'outer second\n');
        outerSecondParent = commitFixture(repository, 'fixture outer second parent');
        for (let index = 0; index < longDistance; index += 1)
        {
            writeRepositoryFile(repository, 'distance.txt', `${index}\n`);
            outerSecondParent = commitFixture(repository, `fixture bounded distance ${index}`);
        }
    }

    execFileSync('git', ['checkout', '-q', 'outer-first'], { cwd: repository });
    execFileSync('git', [
        'merge',
        '--no-ff',
        '-qm',
        'Merge pull request #4102 from fixture/outer-second',
        'outer-second'
    ], { cwd: repository });
    const outerMergeCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8'
    }).trim();

    if (topology === 'source-round-trip')
    {
        writeRepositoryFile(repository, 'source.txt', 'transient\n');
        commitFixture(repository, 'fixture transient source change');
        writeRepositoryFile(repository, 'source.txt', 'authoritative\n');
        commitFixture(repository, 'fixture restored source change');
    }
    if (topology === 'generator-round-trip' || topology === 'output-round-trip')
    {
        const path = topology === 'generator-round-trip' ? 'generator.mjs' : 'output.txt';
        const original = readFileSync(join(repository, path), 'utf8');
        writeRepositoryFile(repository, path, 'transient\n');
        commitFixture(repository, `fixture transient ${topology}`);
        writeRepositoryFile(repository, path, original);
        commitFixture(repository, `fixture restored ${topology}`);
    }
    if (topology === 'source-mode-drift')
    {
        chmodSync(join(repository, 'source.txt'), 0o755);
        commitFixture(repository, 'fixture source mode drift');
    }
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8'
    }).trim();
    execFileSync('git', ['checkout', '-qb', 'repair-candidate'], { cwd: repository });
    writeRepositoryFile(repository, 'candidate.txt', 'candidate\n');
    const head = commitFixture(repository, 'fixture repair candidate');

    const producer = {
        id: 'fixture-producer',
        source: 'source.txt',
        generator: 'generator.mjs',
        outputs: ['output.txt']
    };
    const evidence = {
        sourceCommit,
        mergedPullRequest: 4101,
        mergeCommit
    };
    const exception = {
        producerId: producer.id,
        repairBase: base,
        repairHead: head,
        sourceCommit,
        mergedPullRequest: evidence.mergedPullRequest,
        mergeCommit,
        historyBoundaries: [mergeCommit, baseline],
        passThroughCommit,
        passThroughParents: [passThroughFirstParent, passThroughSecondParent],
        outerPullRequest: 4102,
        outerMergeCommit,
        outerMergeParents: [outerFirstParent, outerSecondParent],
        sourceIdentity: fixtureRevisionPathIdentity(repository, sourceCommit, producer.source),
        sourceDivergenceIdentity: fixtureRevisionPathIdentity(repository, passThroughFirstParent, producer.source),
        sourceDivergenceRevisions: [baseline, passThroughFirstParent],
        generatorIdentity: fixtureRevisionPathIdentity(repository, sourceCommit, producer.generator),
        outputs: [{
            path: producer.outputs[0],
            identity: fixtureRevisionPathIdentity(repository, sourceCommit, producer.outputs[0])
        }]
    };
    return { repository, producer, evidence, base, head, exception, baseline };
}

function fixtureTrackedInputTreeDigest(repository, revision, excludedPaths)
{
    const excluded = new Set(excludedPaths);
    const entries = execFileSync(
        'git',
        ['ls-tree', '-r', '-z', '--full-tree', revision],
        { cwd: repository }
    ).toString('utf8').split('\x00').filter(Boolean);
    const hash = createHash('sha256');
    for (const entry of entries)
    {
        const match = entry.match(/^(?<mode>\d{6}) (?<type>[a-z]+) (?<object>[0-9a-f]{40})\t(?<path>.+)$/u)?.groups;
        if (excluded.has(match.path))
        {
            continue;
        }
        hash.update(`${match.mode}\x00${match.type}\x00${match.object}\x00${match.path}\x00`);
    }
    return hash.digest('hex');
}

function replayRepairDagFixture(repository, revision)
{
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'fsusblog-repair-dag-fixture-'));
    const worktree = join(temporaryRoot, 'worktree');
    try
    {
        execFileSync('git', ['worktree', 'add', '--detach', worktree, revision], {
            cwd: repository,
            stdio: 'ignore',
            env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
        });
        execFileSync('node', ['tools/test/generate-evidence-location-governance.mjs'], { cwd: worktree });
        execFileSync('node', ['tools/test/generate-current-run-evidence-location-acceptance.mjs'], { cwd: worktree });
        const ledger = JSON.parse(readFileSync(
            join(worktree, 'config/testing/evidence-location-migration-ledger.json'),
            'utf8'
        ));
        const outputs = new Map([
            'config/testing/evidence-locator-registry.json',
            'config/testing/evidence-location-migration-ledger.json',
            'config/testing/current-run-evidence-location-acceptance.json'
        ].map((path) => [path, fileSha256(worktree, path)]));
        return {
            outputs,
            projection: {
                findingCount: ledger.entries?.length ?? 0,
                sha256: /^sha256:[0-9a-f]{64}$/u.test(ledger.scanDigest ?? '')
                    ? ledger.scanDigest.slice('sha256:'.length)
                    : '0'.repeat(64)
            }
        };
    }
    finally
    {
        execFileSync('git', ['worktree', 'remove', '--force', worktree], {
            cwd: repository,
            stdio: 'ignore',
            env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
        });
        rmSync(temporaryRoot, { recursive: true, force: true });
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
} = {})
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-post-merge-generated-repair-dag-'));
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
    writeRepositoryFile(repository, 'semantic-source.txt', 'synchronized\n');
    writeRepositoryFile(repository, 'tools/test/evidence-location-contract.mjs', 'export const fixture = true\n');
    writeRepositoryFile(repository, 'tools/test/evidence-location-scanner.mjs', 'export const fixture = true\n');
    writeRepositoryFile(repository, 'tools/test/generate-evidence-location-governance.mjs', `
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const source = readFileSync('semantic-source.txt', 'utf8').trim()
const digest = createHash('sha256').update(source).digest('hex')
mkdirSync('config/testing', { recursive: true })
writeFileSync('config/testing/evidence-locator-registry.json', JSON.stringify({ stable: true }) + '\\n')
writeFileSync('config/testing/evidence-location-migration-ledger.json', JSON.stringify({ scanDigest: 'sha256:' + digest, entries: source.split(',').map((id) => ({ id })) }) + '\\n')
${producerFault === 'future-output' ? "if (process.env.FSUSBLOG_GENERATED_OUTPUT_REPAIR_REPLAY === '1') writeFileSync('config/testing/current-run-evidence-location-acceptance.json', JSON.stringify({ premature: true }) + '\\n')" : ''}
${producerFault === 'unexpected-write' ? "if (process.env.FSUSBLOG_GENERATED_OUTPUT_REPAIR_REPLAY === '1') writeFileSync('unexpected-output.txt', 'unexpected\\n')" : ''}
${producerFault === 'ignored-write' ? "if (process.env.FSUSBLOG_GENERATED_OUTPUT_REPAIR_REPLAY === '1') { mkdirSync('.tmp', { recursive: true }); writeFileSync('.tmp/unexpected.txt', 'unexpected\\n') }" : ''}
${producerFault === 'staged-write' ? "if (process.env.FSUSBLOG_GENERATED_OUTPUT_REPAIR_REPLAY === '1') { writeFileSync('unexpected-output.txt', 'unexpected\\n'); execFileSync('git', ['add', 'unexpected-output.txt']) }" : ''}
${producerFault === 'nondeterministic' ? "if (process.env.FSUSBLOG_GENERATED_OUTPUT_REPAIR_REPLAY === '1') writeFileSync('config/testing/evidence-location-migration-ledger.json', JSON.stringify({ scanDigest: 'sha256:' + digest, entries: [{ id: String(Math.random()) }] }) + '\\n')" : ''}
${candidateInputExecutionMarker ? `if (existsSync('candidate-extra.ts') || existsSync('candidate-extra.json')) writeFileSync(${JSON.stringify(candidateInputExecutionMarker)}, 'executed\\n')` : ''}
`.trimStart());
    writeRepositoryFile(repository, 'tools/test/generate-current-run-evidence-location-acceptance.mjs', `
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
const registry = readFileSync('config/testing/evidence-locator-registry.json')
const ledger = readFileSync('config/testing/evidence-location-migration-ledger.json')
writeFileSync('config/testing/current-run-evidence-location-acceptance.json', JSON.stringify({ registrySha256: ${producerFault === 'no-consume' ? "'constant'" : "createHash('sha256').update(registry).digest('hex')"}, ledgerSha256: ${producerFault === 'no-consume' ? "'constant'" : "createHash('sha256').update(ledger).digest('hex')"} }) + '\\n')
${producerFault === 'later-overwrite' ? "if (process.env.FSUSBLOG_GENERATED_OUTPUT_REPAIR_REPLAY === '1') writeFileSync('config/testing/evidence-location-migration-ledger.json', JSON.stringify({ overwritten: true }) + '\\n')" : ''}
`.trimStart());
    if (producerFault === 'ignored-write')
    {
        writeRepositoryFile(repository, '.gitignore', '.tmp/\n');
    }
    execFileSync('node', ['tools/test/generate-evidence-location-governance.mjs'], { cwd: repository });
    execFileSync('node', ['tools/test/generate-current-run-evidence-location-acceptance.mjs'], { cwd: repository });
    commitFixture(repository, 'fixture baseline');

    execFileSync('git', ['checkout', '-qb', 'synchronized'], { cwd: repository });
    writeRepositoryFile(repository, 'semantic-source.txt', 'synchronized,anchor\n');
    execFileSync('node', ['tools/test/generate-evidence-location-governance.mjs'], { cwd: repository });
    execFileSync('node', ['tools/test/generate-current-run-evidence-location-acceptance.mjs'], { cwd: repository });
    const synchronizedOutputRevision = commitFixture(repository, 'fixture synchronized graph revision');
    let synchronizedRevision = synchronizedOutputRevision;
    if (synchronizedTail)
    {
        writeRepositoryFile(repository, 'synchronized-note.txt', 'unrelated synchronized tail\n');
        synchronizedRevision = commitFixture(repository, 'fixture unrelated synchronized tail');
    }
    execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository });
    execFileSync('git', [
        'merge', '--no-ff', '-qm',
        'Merge pull request #4001 from fixture/synchronized',
        'synchronized'
    ], { cwd: repository });
    const synchronizedMergeCommit = execFileSync(
        'git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }
    ).trim();

    for (let index = 0; index < outerPaddingCommits; index += 1)
    {
        writeRepositoryFile(repository, 'outer-padding.txt', `${index}\n`);
        commitFixture(repository, `fixture outer padding ${index}`);
    }

    execFileSync('git', ['checkout', '-qb', 'source-event'], { cwd: repository });
    writeRepositoryFile(repository, 'semantic-source.txt', 'synchronized,anchor,event\n');
    if (eventProtectedMutation === 'output')
    {
        writeRepositoryFile(repository, 'config/testing/evidence-location-migration-ledger.json', '{"tampered":true}\n');
    }
    if (eventProtectedMutation === 'closure')
    {
        writeRepositoryFile(repository, 'tools/test/evidence-location-scanner.mjs', 'export const fixture = false\n');
    }
    if (historyExecutionMarker)
    {
        writeRepositoryFile(
            repository,
            'tools/test/generate-evidence-location-governance.mjs',
            `${readFileSync(join(repository, 'tools/test/generate-evidence-location-governance.mjs'), 'utf8')}\nwriteFileSync(${JSON.stringify(historyExecutionMarker)}, 'executed\\n')\n`
        );
    }
    execFileSync('git', ['add', '.'], { cwd: repository });
    const sourceTree = execFileSync('git', ['write-tree'], { cwd: repository, encoding: 'utf8' }).trim();
    let sourceRevision;
    if (sourceRevisionMode === 'single')
    {
        sourceRevision = commitFixture(repository, 'fixture omitted generated graph outputs');
    }
    else
    {
        const rootRevision = execFileSync(
            'git',
            ['rev-list', '--max-parents=0', 'HEAD'],
            { cwd: repository, encoding: 'utf8' }
        ).trim();
        if (sourceRevisionMode === 'wrong-parent')
        {
            sourceRevision = commitTreeFixture(
                repository,
                sourceTree,
                [synchronizedMergeCommit, synchronizedRevision],
                'fixture wrong-parent generated graph source'
            );
            execFileSync('git', ['update-ref', 'refs/heads/source-event', sourceRevision], { cwd: repository });
        }
        else if (sourceRevisionMode === 'multi-parent')
        {
            sourceRevision = commitTreeFixture(
                repository,
                sourceTree,
                [synchronizedMergeCommit, synchronizedRevision, rootRevision],
                'fixture multi-parent generated graph source'
            );
            execFileSync('git', ['update-ref', 'refs/heads/source-event', sourceRevision], { cwd: repository });
        }
        else if (sourceRevisionMode === 'side-parent')
        {
            sourceRevision = commitTreeFixture(
                repository,
                sourceTree,
                [synchronizedMergeCommit],
                'fixture side-parent generated graph source'
            );
            const synchronizedTree = execFileSync(
                'git',
                ['rev-parse', `${synchronizedMergeCommit}^{tree}`],
                { cwd: repository, encoding: 'utf8' }
            ).trim();
            const primaryRevision = commitTreeFixture(
                repository,
                synchronizedTree,
                [synchronizedMergeCommit],
                'fixture primary source branch'
            );
            const sideMerge = commitTreeFixture(
                repository,
                sourceTree,
                [primaryRevision, sourceRevision],
                'fixture source hidden on side parent'
            );
            execFileSync('git', ['update-ref', 'refs/heads/source-event', sideMerge], { cwd: repository });
        }
        else
        {
            throw new Error(`unknown sourceRevisionMode fixture: ${sourceRevisionMode}`);
        }
    }
    if (supersedeSource)
    {
        writeRepositoryFile(repository, 'semantic-source.txt', 'synchronized,anchor,event,superseded\n');
        if (supersedeSource === 'two-parent')
        {
            execFileSync('git', ['add', 'semantic-source.txt'], { cwd: repository });
            const supersedingTree = execFileSync(
                'git', ['write-tree'], { cwd: repository, encoding: 'utf8' }
            ).trim();
            const supersedingRevision = commitTreeFixture(
                repository,
                supersedingTree,
                [sourceRevision, synchronizedMergeCommit],
                'fixture two-parent superseding source event'
            );
            execFileSync('git', ['update-ref', 'refs/heads/source-event', supersedingRevision], { cwd: repository });
        }
        else
        {
            commitFixture(repository, 'fixture superseding source event');
        }
    }
    execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository });
    if (outerProtectedMutation)
    {
        execFileSync('git', ['merge', '--no-ff', '--no-commit', 'source-event'], { cwd: repository });
        writeRepositoryFile(repository, 'config/testing/evidence-location-migration-ledger.json', '{"outer":"tampered"}\n');
        commitFixture(repository, 'Merge pull request #4002 from fixture/source-event');
    }
    else
    {
        execFileSync('git', [
            'merge', '--no-ff', '-qm',
            'Merge pull request #4002 from fixture/source-event',
            'source-event'
        ], { cwd: repository });
    }
    let base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    const sourceEvents = [{
        sourceRevision,
        mergedPullRequest: 4002,
        mergeCommit: base
    }];
    if (secondEvent)
    {
        execFileSync('git', ['checkout', '-qb', 'source-event-2'], { cwd: repository });
        writeRepositoryFile(repository, 'semantic-source.txt', 'synchronized,anchor,event,event-2\n');
        const secondSourceRevision = commitFixture(repository, 'fixture second omitted generated graph outputs');
        execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository });
        execFileSync('git', [
            'merge', '--no-ff', '-qm',
            'Merge pull request #4003 from fixture/source-event-2',
            'source-event-2'
        ], { cwd: repository });
        base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
        sourceEvents.push({
            sourceRevision: secondSourceRevision,
            mergedPullRequest: 4003,
            mergeCommit: base
        });
    }

    const manifestPath = 'artifacts/change-contract/evidence-location-governance-post-merge-repair.json';
    const graphOutputs = [
        'config/testing/evidence-locator-registry.json',
        'config/testing/evidence-location-migration-ledger.json',
        'config/testing/current-run-evidence-location-acceptance.json'
    ];
    const synchronizedReplay = replayRepairDagFixture(repository, synchronizedRevision);
    const baseReplay = replayRepairDagFixture(repository, base);
    const baseDigests = new Map(graphOutputs.map((path) => [path, fileSha256(repository, path)]));
    execFileSync('git', ['checkout', '-qb', 'candidate'], { cwd: repository });
    execFileSync('node', ['tools/test/generate-evidence-location-governance.mjs'], { cwd: repository });
    execFileSync('node', ['tools/test/generate-current-run-evidence-location-acceptance.mjs'], { cwd: repository });
    if (historyExecutionMarker && existsSync(historyExecutionMarker))
    {
        unlinkSync(historyExecutionMarker);
    }
    const closure = (paths) => paths.map((path) => ({
        path,
        baseSha256: fileSha256(repository, path),
        currentSha256: fileSha256(repository, path)
    }));
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
        outputs: graphOutputs.map((path) =>
        {
            const baseSha256 = baseDigests.get(path);
            const expectedSha256 = baseReplay.outputs.get(path);
            const repairRequired = baseSha256 !== expectedSha256;
            return {
                path,
                repairRequired,
                changed: repairRequired,
                baseSha256,
                expectedSha256,
                currentSha256: fileSha256(repository, path)
            };
        })
    };
    if (mutateManifest)
    {
        mutateManifest(manifest, repository);
    }
    writeRepositoryFile(repository, manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
    const head = commitFixture(repository, 'fixture generated repair DAG candidate');
    return { repository, base, head, manifest, manifestPath };
}

function validatePostMergeRepairDagFixture(fixtureRepository, {
    externalExceptionManifest = null,
    externalExceptionPaths = null
} = {})
{
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
            generatedDigest: fixtureRepository.manifestPath,
            externalNaming: externalExceptionManifest !== null,
            externalExceptionManifest: externalExceptionManifest ?? 'none',
            externalExceptionId: externalExceptionManifest === null ? 'none' : 'json-wire-key',
            externalExceptionPaths: externalExceptionPaths ?? 'none',
            externalExceptionReason: externalExceptionManifest === null
                ? 'none'
                : 'preserve the exact fixture JSON wire spelling'
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
    });
}

function postMergeExternalNamingRepairBody()
{
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
    });
}

function createPostMergeExternalNamingRepairFixture({
    mutateManifest = null,
    mutateArtifact = null,
    laterSourceChange = false,
    unmerged = false
} = {})
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-post-merge-external-naming-repair-'));
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
    const sourcePath = 'tools/docs/behavior-doc-static-admission.mjs';
    const artifactPath = 'artifacts/change-contract/external-naming.json';
    const repairPath = 'artifacts/change-contract/external-naming-repair.json';
    const currentSurfacePath = 'docs/architecture/repository-layout.md';
    const reason = 'preserve caller-visible environment variables while moving receipt publication';
    writeRepositoryFile(repository, sourcePath, 'const mode = process.env.FSUSBLOG_MODE\n');
    writeRepositoryFile(repository, currentSurfacePath, 'baseline layout authority\n');
    const originalBase = commitFixture(repository, 'fixture original base');

    execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: repository });
    writeRepositoryFile(repository, sourcePath, 'const mode = process.env.FSUSBLOG_RUNTIME_MODE\n');
    const originalHead = commitFixture(repository, 'fixture changed naming surface');
    execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository });
    execFileSync('git', [
        'merge',
        '--no-ff',
        '-qm',
        'Merge pull request #3031 from fixture/naming-source',
        'feature'
    ], { cwd: repository });
    const mergeCommit = execFileSync(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: repository, encoding: 'utf8' }
    ).trim();
    if (laterSourceChange)
    {
        writeRepositoryFile(repository, sourcePath, 'const mode = process.env.FSUSBLOG_LATER_MODE\n');
        commitFixture(repository, 'fixture later source change');
    }
    const base = unmerged ? originalHead : execFileSync(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: repository, encoding: 'utf8' }
    ).trim();
    execFileSync('git', ['checkout', '-q', '-b', 'candidate', base], { cwd: repository });
    writeRepositoryFile(repository, currentSurfacePath, 'document strict naming repair ownership\n');

    const artifact = {
        schema: changeContract.evidenceSchemas.externalNamingExceptions,
        exceptions: [
            {
                id: 'environment-variable',
                paths: [sourcePath],
                reason
            }
        ]
    };
    if (mutateArtifact)
    {
        mutateArtifact(artifact);
    }
    writeRepositoryFile(repository, artifactPath, `${JSON.stringify(artifact, null, 4)}\n`);
    const sourceDigest = fileSha256(repository, sourcePath);
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
    };
    if (mutateManifest)
    {
        mutateManifest(manifest, {
            repository,
            originalBase,
            originalHead,
            mergeCommit,
            sourcePath,
            artifactPath,
            repairPath,
            currentSurfacePath
        });
    }
    writeRepositoryFile(repository, repairPath, `${JSON.stringify(manifest, null, 4)}\n`);
    const head = commitFixture(repository, 'fixture post-merge naming repair');
    return { repository, base, head };
}

function validatePostMergeExternalNamingRepairFixture(fixtureRepository)
{
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
    });
}

test('registry is the unique ordered type/scope source consumed by commitlint', () =>
{
    assert.deepEqual(changeContract.commitTypes, [
        'feat', 'fix', 'perf', 'refactor', 'style', 'test', 'docs', 'build', 'ci', 'chore', 'security', 'revert'
    ]);
    assert.equal(new Set(changeContract.commitTypes).size, changeContract.commitTypes.length);
    assert.equal(new Set(changeContract.commitScopes).size, changeContract.commitScopes.length);
    assert.deepEqual(commitlintConfig.rules['type-enum'][2], changeContract.commitTypes);
    assert.deepEqual(commitlintConfig.rules['scope-enum'][2], changeContract.commitScopes);
    const externalNamingSchema = JSON.parse(readFileSync(
        resolve(root, 'config/schemas/external-naming-exceptions.schema.json'),
        'utf8'
    ));
    assert.equal(
        externalNamingSchema.properties.schema.const,
        changeContract.evidenceSchemas.externalNamingExceptions
    );
    const repairSchema = JSON.parse(readFileSync(
        resolve(root, 'config/schemas/post-merge-generated-output-repair.schema.json'),
        'utf8'
    ));
    assert.equal(
        repairSchema.properties.schema.const,
        changeContract.evidenceSchemas.postMergeGeneratedOutputRepair
    );
    const repairDagSchema = JSON.parse(readFileSync(
        resolve(root, 'config/schemas/post-merge-generated-output-repair-dag.schema.json'),
        'utf8'
    ));
    assert.equal(
        repairDagSchema.properties.schema.const,
        changeContract.evidenceSchemas.postMergeGeneratedOutputRepairDag
    );
    const digestRepairSchema = JSON.parse(readFileSync(
        resolve(root, 'config/schemas/post-merge-generated-output-digest-repair.schema.json'),
        'utf8'
    ));
    assert.equal(
        digestRepairSchema.properties.schema.const,
        changeContract.evidenceSchemas.postMergeGeneratedOutputDigestRepair
    );
    assert.ok(digestRepairSchema.required.includes('mergeCommit'));
    assert.ok(!digestRepairSchema.required.includes('candidateCommit'));
    assert.deepEqual(changeContract.generatedOutputDigestRepairProducers.map((entry) => entry.id), [
        'correctness-attempt-producers'
    ]);
    assert.deepEqual(changeContract.generatedOutputDigestRepairProducers[0].qualification, {
        sourceParent: 'ba72ac65c7395b876c26aa040f500c677d55678c',
        sourceCommit: 'b3f3e6f108ff3d021a83c1b3b2efb96e0b82ed20',
        mergedPullRequest: 3271,
        mergeCommit: 'a0b44ab7f7096e631f11731b0ac26cd8dea66fc2',
        outerBaseCommit: 'ba72ac65c7395b876c26aa040f500c677d55678c',
        outerHeadCommit: 'd9f4a947f46c83278275f5bbf8fb0d651b3862e5'
    });
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
    });
    const namingRepairSchema = JSON.parse(readFileSync(
        resolve(root, 'config/schemas/post-merge-external-naming-evidence-repair.schema.json'),
        'utf8'
    ));
    assert.equal(
        namingRepairSchema.properties.schema.const,
        changeContract.evidenceSchemas.postMergeExternalNamingEvidenceRepair
    );
    assert.deepEqual(changeContract.generatedOutputRepairProducers.map((entry) => entry.id), [
        'testing-docs',
        'backend-evidence-path-authority'
    ]);
    assert.deepEqual(changeContract.generatedOutputRepairDags.map((entry) => entry.id), [
        'evidence-location-governance'
    ]);
    assert.equal(
        changeContract.generatedOutputRepairDags[0].manifest,
        'artifacts/change-contract/evidence-location-governance-post-merge-repair.json'
    );
    assert.equal(
        changeContract.generatedOutputRepairDags[0].externalNamingManifest,
        'artifacts/change-contract/evidence-location-governance-post-merge-repair-external-naming.json'
    );
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
    ]);
});

test('digest-repair v2 dispatch rejects an untrusted producer before adapter construction', () =>
{
    const errors = [];
    validatePostMergeGeneratedOutputDigestRepair(
        {
            generatedDigest: 'artifacts/change-contract/correctness-producer-inventory-post-merge-repair.json',
            generatorSource: changeContract.generatedOutputDigestRepairProducers[0].closure.join(', '),
            generatedOutputs: changeContract.generatedOutputDigestRepairProducers[0].output
        },
        {
            schema: changeContract.evidenceSchemas.postMergeGeneratedOutputDigestRepair,
            producerId: 'unregistered-producer'
        },
        { root: null, base: null, head: null, changedFiles: [] },
        errors
    );
    assert.deepEqual(errors, [
        'Post-merge generated digest repair producer is not trusted: unregistered-producer'
    ]);
});

test('valid commit fixtures cover ordinary, perf, revert, security, breaking, and mechanical messages', () =>
{
    for (const name of ['feat.txt', 'perf.txt', 'revert.txt', 'security.txt', 'breaking.txt', 'format-only.txt', 'naming-only.txt'])
    {
        assert.deepEqual(validateCommitMessage(fixture('valid', name)), [], name);
    }
});

test('invalid type, scope, generic title, perf evidence, and public security detail are aggregated', () =>
{
    for (const name of ['type.txt', 'scope.txt', 'title.txt', 'perf-missing-evidence.txt', 'security-detail.txt'])
    {
        assert.ok(validateCommitMessage(fixture('invalid', name)).length > 0, name);
    }
    assert.match(validateCommitMessage(fixture('invalid', 'perf-missing-evidence.txt')).join('\n'), /Evidence/u);
    assert.match(validateCommitMessage(fixture('invalid', 'security-detail.txt')).join('\n'), /vulnerability detail/u);
    assert.match(validateCommitMessage(
        'feat(frontend): expose article reading progress\n\nRefs: #1163\n\nTrailing prose is not a footer.'
    ).join('\n'), /Refs/u);
    assert.match(validateCommitMessage(
        'feat(frontend): expose article reading progress\n\nRefs: #1163\nRefs: #1164'
    ).join('\n'), /Refs/u);
});

test('squash title uses the same type/scope/header contract without commit footers', () =>
{
    assert.deepEqual(validateCommitMessage('fix(backend): reject stale session state', { titleOnly: true }), []);
    assert.deepEqual(validateCommitMessage('feat(api)!: remove deprecated article field', { titleOnly: true }), []);
    assert.ok(validateCommitMessage('fix(other): reject stale session state', { titleOnly: true }).length > 0);
    assert.match(
        validateCommitMessage(
            'security(auth): document authentication bypass exploit chain',
            { titleOnly: true }
        ).join('\n'),
        /vulnerability detail/u
    );
    assert.match(
        validateCommitMessage(
            'refactor(cache): improve performance and throughput',
            { titleOnly: true }
        ).join('\n'),
        /must not claim performance/u
    );
});

test('PR Linked Issue accepts one non-closing reference and canonical closing compatibility', () =>
{
    for (const primary of [
        'Refs #1163',
        'Closes #1163',
        'Closes #1163\n\nNative qualification remains WIP.\n\nRelated: [tracking issue](https://github.com/Ozwasyd/FsusBlog/issues/3764)'
    ])
    {
        assert.deepEqual(validatePrContract({
            title: 'feat(frontend): expose article reading progress',
            body: pullRequestBody().replace('Closes #1163', primary),
            labels: ['release-note:added'],
            actor: 'maintainer',
            changedFiles: ['src/frontend/src/composables/useReadingProgress.ts']
        }), []);
    }
});

test('PR Linked Issue rejects duplicate, mixed, and malformed primary declarations', () =>
{
    for (const primary of [
        '',
        'Refs #1163\nRefs #1163',
        'Closes #1163\nCloses #1164',
        'Refs #1163\nCloses #1163',
        'Closes #1163\nRefs #1164',
        'Refs #1163\nRefs #',
        'Closes #1163\nCloses: #1164',
        'Refs #0',
        'Refs #01163',
        'Refs #-1163',
        'Refs #1163, #1164',
        'Refs #1163 trailing text',
        'refs #1163',
        'Refs: #1163',
        '- Refs #1163',
        '> Refs #1163'
    ])
    {
        const errors = validatePrContract({
            title: 'feat(frontend): expose article reading progress',
            body: pullRequestBody().replace('Closes #1163', primary),
            labels: ['release-note:added'],
            actor: 'maintainer',
            changedFiles: ['src/frontend/src/composables/useReadingProgress.ts']
        });
        assert.ok(errors.some((error) => error.includes('Linked Issue requires exactly one')), primary);
    }
});

test('PR Linked Issue retains existing duplicate-heading and fenced-section refusal', () =>
{
    const referenced = pullRequestBody().replace('Closes #1163', 'Refs #1163');
    for (const [body, expected] of [
        [`${referenced}\n## Linked Issue\n\nRefs #1164\n`, 'duplicate section: ## Linked Issue'],
        [referenced.replace('Refs #1163', '```markdown\nRefs #1163\n```'), 'Linked Issue requires exactly one'],
        [referenced.replace('Refs #1163', '<!-- Refs #1163 -->'), 'Linked Issue requires exactly one'],
        ['```markdown\n## Linked Issue\n\nRefs #1163\n```\n' + referenced.replace('## Linked Issue', '### Linked Issue'), 'missing ## Linked Issue'],
        [referenced.replace('Refs #1163', '').replace('## Scope Summary', '## Scope Summary\n\nRefs #1163'), 'Linked Issue requires exactly one']
    ])
    {
        const errors = validatePrContract({
            title: 'feat(frontend): expose article reading progress',
            body,
            labels: ['release-note:added'],
            actor: 'maintainer',
            changedFiles: ['src/frontend/src/composables/useReadingProgress.ts']
        });
        assert.ok(errors.some((error) => error.includes(expected)), expected);
    }
});

test('non-closing PR reference preserves unrelated classification and review gates', () =>
{
    const referenced = pullRequestBody().replace('Closes #1163', 'Refs #1163');
    const errors = validatePrContract({
        title: 'feat(frontend): expose article reading progress',
        body: referenced.replace('- [x] Formatter/linter run', '- [ ] Formatter/linter run'),
        labels: ['release-note:added'],
        actor: 'maintainer',
        changedFiles: ['src/frontend/src/composables/useReadingProgress.ts']
    });
    assert.ok(errors.some((error) => error.includes('requires checked checklist field: Formatter/linter run')));
});

test('PR contract accepts a fully classified user-facing behavior change', () =>
{
    const errors = validatePrContract({
        title: 'feat(frontend): expose article reading progress',
        body: pullRequestBody(),
        labels: ['release-note:added'],
        actor: 'maintainer',
        changedFiles: ['src/frontend/src/composables/useReadingProgress.ts']
    });
    assert.deepEqual(errors, []);
});

test('breaking squash title is bound to explicit public contract impact', () =>
{
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
    }), []);
});

test('PR fixture missing required classifications and fields fails closed', () =>
{
    const errors = validatePrContract({
        title: 'feat(frontend): expose article reading progress',
        body: fixture('invalid', 'pr-missing-classification.txt'),
        labels: ['release-note:added'],
        actor: 'maintainer',
        changedFiles: []
    });
    assert.ok(errors.some((error) => error.includes('classification checkbox')));
    assert.ok(errors.some((error) => error.includes('Performance Claim')));
});

test('PR parser rejects duplicate, fenced, and unchecked contract fields', () =>
{
    const title = 'feat(frontend): expose article reading progress';
    const common = {
        title,
        labels: ['release-note:added'],
        actor: 'maintainer',
        changedFiles: ['src/frontend/src/composables/useReadingProgress.ts']
    };
    const valid = pullRequestBody();

    const duplicateSection = validatePrContract({
        ...common,
        body: `${valid}\n## Release Note\n\n- Audience: user-facing\n- Category: Added\n- Summary: expose article reading progress\n`
    });
    assert.ok(duplicateSection.some((error) => error.includes('duplicate section')));

    const fencedHeading = validatePrContract({
        ...common,
        body: `\`\`\`markdown\n## Performance Claim\n\`\`\`\n${valid.replace('## Performance Claim', '### Performance Claim')}`
    });
    assert.ok(fencedHeading.some((error) => error.includes('missing ## Performance Claim')));

    const unchecked = validatePrContract({
        ...common,
        body: valid.replace('- [x] Formatter/linter run', '- [ ] Formatter/linter run')
    });
    assert.ok(unchecked.some((error) => error.includes('requires checked checklist field')));

    const duplicateField = validatePrContract({
        ...common,
        body: valid.replace(
            '- Summary: expose article reading progress',
            '- Summary: expose article reading progress\n- Summary: forged release text'
        )
    });
    assert.ok(duplicateField.some((error) => error.includes('duplicate field: Summary')));

    const fencedField = validatePrContract({
        ...common,
        body: valid.replace(
            '- [x] Formatter/linter run',
            '```markdown\n- [x] Formatter/linter run\n```'
        )
    });
    assert.ok(fencedField.some((error) => error.includes('Formatter/linter run')));

    const htmlHiddenField = validatePrContract({
        ...common,
        body: valid.replace(
            '- [x] Formatter/linter run',
            '<!-- - [x] Formatter/linter run -->'
        )
    });
    assert.ok(htmlHiddenField.some((error) => error.includes('Formatter/linter run')));

    const shortFenceClose = validatePrContract({
        ...common,
        body: valid.replace(
            '## Performance Claim\n\n- Claim level: none',
            '## Performance Claim\n\n````markdown\n- Claim level: none\n```'
        )
    });
    assert.ok(shortFenceClose.some((error) => error.includes('Claim level')));

    const emptyScope = validatePrContract({
        ...common,
        body: valid.replace(
            '- Implement one reviewed change boundary.',
            '- <!-- scope intentionally omitted -->'
        )
    });
    assert.ok(emptyScope.some((error) => error.includes('substantive Scope Summary')));
});

test('format-only and naming-only changes cannot enter user-facing release notes', () =>
{
    const body = pullRequestBody({
        type: 'style',
        formatOnly: true,
        audience: 'user-facing',
        category: 'Changed'
    });
    const errors = validatePrContract({
        title: 'style(csharp): normalize backend whitespace',
        body,
        labels: ['release-note:changed'],
        actor: 'maintainer',
        changedFiles: ['src/backend/Program.cs']
    });
    assert.ok(errors.some((error) => error.includes('cannot enter user-facing')));
});

test('release note category must agree with type, audience, and unique label', () =>
{
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
    });
    assert.ok(errors.some((error) => error.includes('fix cannot use release note category Added')));
    assert.ok(errors.some((error) => error.includes('exactly the release note label')));
});

test('release-note none is excluded with a literal none summary', () =>
{
    const title = 'chore(governance): document internal review contract';
    const body = pullRequestBody({
        type: 'chore',
        audience: 'none',
        category: 'none'
    });
    assert.deepEqual(validatePrContract({
        title,
        body,
        labels: ['release-note:none'],
        actor: 'maintainer',
        changedFiles: ['docs/development/change-contract.md']
    }), []);

    const drifted = validatePrContract({
        title,
        body: body.replace('- Summary: none', '- Summary: document internal review contract'),
        labels: ['release-note:none'],
        actor: 'maintainer',
        changedFiles: ['docs/development/change-contract.md']
    });
    assert.ok(drifted.some((error) => error.includes('Summary must be none')));
});

test('generated bot exception binds source, digest, and authenticated identity', () =>
{
    const actor = 'fixture-bot[bot]';
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-generated-pr-'));
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
    writeRepositoryFile(repository, 'tools/generate.mjs', 'export const generator = true\n');
    writeRepositoryFile(repository, 'src/generated/output.ts', Buffer.alloc(1_310_720, 0x61));
    const outputSha256 = createHash('sha256')
        .update(readFileSync(join(repository, 'src/generated/output.ts')))
        .digest('hex');
    writeRepositoryFile(repository, 'artifacts/generated/binding.json', `${JSON.stringify({
        schema: changeContract.evidenceSchemas.generatedOutput,
        sources: ['tools/generate.mjs'],
        outputs: [{ path: 'src/generated/output.ts', sha256: outputSha256 }]
    }, null, 4)}\n`);
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture generated head'], { cwd: repository });
    const changedFiles = [
        'tools/generate.mjs',
        'src/generated/output.ts',
        'artifacts/generated/binding.json'
    ];
    const body = pullRequestBody({
        type: 'chore',
        generated: true,
        audience: 'internal',
        category: 'Internal/Tooling',
        summary: 'refresh generated contract fixture',
        actor
    });
    assert.deepEqual(validatePrContract({
        title: 'chore(tooling): refresh generated contract fixture',
        body,
        labels: ['release-note:internal'],
        actor,
        changedFiles,
        root: repository,
        authorityRoot: null
    }), []);

    writeRepositoryFile(repository, 'src/generated/output.ts', 'worktree-only content must not be trusted\n');
    assert.deepEqual(validatePrContract({
        title: 'chore(tooling): refresh generated contract fixture',
        body,
        labels: ['release-note:internal'],
        actor,
        changedFiles,
        root: repository,
        authorityRoot: null
    }), []);
    execFileSync('git', ['restore', 'src/generated/output.ts'], { cwd: repository });

    const wrongActor = validatePrContract({
        title: 'chore(tooling): refresh generated contract fixture',
        body: body.replace(actor, 'other-bot[bot]'),
        labels: ['release-note:internal'],
        actor,
        changedFiles,
        root: repository,
        authorityRoot: null
    });
    assert.ok(wrongActor.some((error) => error.includes('Automation identity')));

    const unboundGenerated = validatePrContract({
        title: 'chore(tooling): refresh generated contract fixture',
        body,
        labels: ['release-note:internal'],
        actor,
        changedFiles: [...changedFiles, 'src/generated/extra.ts'],
        root: repository,
        authorityRoot: null
    });
    assert.ok(unboundGenerated.some((error) => error.includes('missing from source/output bindings')));

    writeRepositoryFile(repository, 'src/generated/output.ts', 'export const generated = false\n');
    execFileSync('git', ['add', 'src/generated/output.ts'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture generated output tamper'], { cwd: repository });
    const tampered = validatePrContract({
        title: 'chore(tooling): refresh generated contract fixture',
        body,
        labels: ['release-note:internal'],
        actor,
        changedFiles,
        root: repository,
        authorityRoot: null
    });
    assert.ok(tampered.some((error) => error.includes('Generated output digest mismatch')));
});

test('revision reader rejects truncated, missing, invalid, and non-file Git objects', () =>
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-revision-reader-'));
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
    writeRepositoryFile(repository, 'large.bin', Buffer.alloc(1_310_720, 0x62));
    symlinkSync('large.bin', join(repository, 'large-link.bin'));
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture revision objects'], { cwd: repository });
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8'
    }).trim();

    writeRepositoryFile(repository, 'large.bin', 'uncommitted worktree content\n');
    assert.equal(readFileAtRevision(repository, revision, 'large.bin').length, 1_310_720);
    assert.throws(
        () => readFileAtRevision(repository, revision, 'large.bin', { maximumBytes: 1024 }),
        /exceeds the 1024-byte revision read limit/u
    );
    assert.throws(
        () => readFileAtRevision(repository, 'not-a-revision', 'large.bin'),
        /repository revision does not resolve to one commit/u
    );
    assert.throws(
        () => readFileAtRevision(repository, revision, '../large.bin'),
        /invalid repository path/u
    );
    assert.throws(
        () => readFileAtRevision(repository, revision, 'missing.bin'),
        /does not resolve to one exact Git object/u
    );
    assert.throws(
        () => readFileAtRevision(repository, revision, 'large-link.bin'),
        /is not a regular Git blob/u
    );

    const gitExecutable = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const wrapperDirectory = join(repository, 'git-wrapper');
    const wrapperPath = join(wrapperDirectory, 'git');
    mkdirSync(wrapperDirectory);
    writeFileSync(wrapperPath, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

if (process.argv[2] === 'cat-file' && process.argv[3] === 'blob') {
    process.stdout.write('truncated')
    process.exit(0)
}
const result = spawnSync(${JSON.stringify(gitExecutable)}, process.argv.slice(2), { stdio: 'inherit' })
process.exit(result.status ?? 1)
`);
    chmodSync(wrapperPath, 0o755);
    const originalPath = process.env.PATH;
    try
    {
        process.env.PATH = `${wrapperDirectory}${delimiter}${originalPath}`;
        assert.throws(
            () => readFileAtRevision(repository, revision, 'large.bin'),
            /Git blob read was truncated/u
        );
    }
    finally
    {
        process.env.PATH = originalPath;
    }
});

test('revision reader ignores commit and blob replacement refs', () =>
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-revision-replace-'));
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
    writeRepositoryFile(repository, 'sample.txt', 'original bytes\n');
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture original revision'], { cwd: repository });
    const originalRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8'
    }).trim();
    const originalBlob = execFileSync('git', ['rev-parse', `${originalRevision}:sample.txt`], {
        cwd: repository,
        encoding: 'utf8'
    }).trim();

    writeRepositoryFile(repository, 'sample.txt', 'replacement bytes are longer\n');
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture replacement revision'], { cwd: repository });
    const replacementRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8'
    }).trim();
    const replacementBlob = execFileSync('git', ['rev-parse', `${replacementRevision}:sample.txt`], {
        cwd: repository,
        encoding: 'utf8'
    }).trim();

    execFileSync('git', ['replace', originalRevision, replacementRevision], { cwd: repository });
    assert.equal(
        execFileSync('git', ['show', `${originalRevision}:sample.txt`], { cwd: repository, encoding: 'utf8' }),
        'replacement bytes are longer\n'
    );
    assert.equal(
        readFileAtRevision(repository, originalRevision, 'sample.txt').toString('utf8'),
        'original bytes\n'
    );

    execFileSync('git', ['replace', '-d', originalRevision], { cwd: repository });
    execFileSync('git', ['replace', originalBlob, replacementBlob], { cwd: repository });
    assert.equal(
        execFileSync('git', ['show', `${originalRevision}:sample.txt`], { cwd: repository, encoding: 'utf8' }),
        'replacement bytes are longer\n'
    );
    assert.equal(
        readFileAtRevision(repository, originalRevision, 'sample.txt').toString('utf8'),
        'original bytes\n'
    );
});

test('post-merge generated repair binds exact history and isolated canonical replays', () =>
{
    const repair = createPostMergeRepairFixture();
    assert.deepEqual(validatePostMergeRepairFixture(repair), []);
});

test('post-merge generated repair accepts the exact two-parent source revision inside the named pull request', () =>
{
    const repair = createPostMergeRepairFixture({ sourceRevisionMode: 'merge' });
    assert.deepEqual(validatePostMergeRepairFixture(repair), []);
});

test('post-merge generated repair accepts only the registered #3203 same-blob pass-through', () =>
{
    const exception = changeContract.generatedOutputRepairPassThroughExceptions.find(
        (entry) => entry.id === 'backend-evidence-path-authority-pr-3203'
    );
    const producer = changeContract.generatedOutputRepairProducers.find(
        (entry) => entry.id === exception.producerId
    );
    const evidencePath = 'artifacts/change-contract/issue-3196-backend-evidence-path-authority-generated-repair.json';
    const evidence = JSON.parse(readFileAtRevision(root, exception.repairHead, evidencePath).toString('utf8'));
    const errors = [];
    validatePostMergeGeneratedOutputRepair(
        {
            generatorSource: producer.source,
            generatedOutputs: producer.outputs.join(', ')
        },
        evidence,
        {
            root,
            base: exception.repairBase,
            head: exception.repairHead,
            changedFiles: changedFilesBetween(root, exception.repairBase, exception.repairHead)
        },
        errors
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(
        validateGeneratedRepairPassThroughException(
            root,
            producer,
            evidence,
            exception.repairBase,
            exception.repairHead,
            exception
        ),
        []
    );

    for (const [name, mutation, expected] of [
        ['reversed pass-through parents', {
            passThroughParents: [...exception.passThroughParents].reverse()
        }, 'pass-through parents do not match'],
        ['wrong outer first parent', {
            outerMergeParents: [exception.outerMergeParents[1], exception.outerMergeParents[0]]
        }, 'outer merge parents do not match'],
        ['source provenance from the wrong parent', {
            sourceIdentity: '100644:1715ef6023d8115b736fb123a82b595aee5930a9'
        }, 'trusted source identity changed'],
        ['output mode drift', {
            outputs: exception.outputs.map((entry) => ({ ...entry, identity: `120000:${entry.identity.slice(7)}` }))
        }, 'protected path identity changed'],
        ['nearby repair base', {
            repairBase: exception.outerMergeCommit
        }, 'repair identity does not match']
    ])
    {
        const mutated = { ...exception, ...mutation };
        const mutationErrors = validateGeneratedRepairPassThroughException(
            root,
            producer,
            evidence,
            exception.repairBase,
            exception.repairHead,
            mutated
        );
        assert.ok(
            mutationErrors.some((error) => error.includes(expected)),
            `${name}: ${mutationErrors.join('\n')}`
        );
    }
});

test('registered generated repair pass-through rejects adversarial Git histories', () =>
{
    const valid = createRegisteredPassThroughFixture();
    assert.deepEqual(validateGeneratedRepairPassThroughException(
        valid.repository,
        valid.producer,
        valid.evidence,
        valid.base,
        valid.head,
        valid.exception
    ), []);
    const shortenedBoundary = {
        ...valid.exception,
        historyBoundaries: [valid.exception.mergeCommit, valid.exception.passThroughParents[0]],
        sourceDivergenceRevisions: [valid.exception.passThroughParents[0]]
    };
    const shortenedBoundaryErrors = validateGeneratedRepairPassThroughException(
        valid.repository,
        valid.producer,
        valid.evidence,
        valid.base,
        valid.head,
        shortenedBoundary
    );
    assert.ok(shortenedBoundaryErrors.some(
        (error) => error.includes('history boundaries do not match the exact source divergence frontier')
    ));

    for (const [topology, options, expected] of [
        [
            'wrong-second-parent',
            { topology: 'wrong-second-parent' },
            'authoritative second parent does not descend from the registered source merge'
        ],
        [
            'hidden-side-parent',
            { topology: 'hidden-side-parent' },
            'pass-through commit is not on the outer pull request head first-parent chain'
        ],
        [
            'source-round-trip',
            { topology: 'source-round-trip' },
            'trusted source identity changed'
        ],
        [
            'generator-round-trip',
            { topology: 'generator-round-trip' },
            'protected path identity changed'
        ],
        [
            'output-round-trip',
            { topology: 'output-round-trip' },
            'protected path identity changed'
        ],
        [
            'source-mode-drift',
            { topology: 'source-mode-drift' },
            'trusted source identity changed'
        ],
        [
            'unbounded-history',
            { longDistance: 129 },
            'registered history exceeds 128 parent edges'
        ]
    ])
    {
        const fixtureRepository = createRegisteredPassThroughFixture(options);
        const errors = validateGeneratedRepairPassThroughException(
            fixtureRepository.repository,
            fixtureRepository.producer,
            fixtureRepository.evidence,
            fixtureRepository.base,
            fixtureRepository.head,
            fixtureRepository.exception
        );
        assert.ok(errors.some((error) => error.includes(expected)), `${topology}: ${errors.join('\n')}`);
    }
});

test('registered generated repair pass-through ignores replacement refs and rejects missing objects', () =>
{
    const fixtureRepository = createRegisteredPassThroughFixture();
    execFileSync('git', [
        'replace',
        fixtureRepository.exception.passThroughCommit,
        fixtureRepository.baseline
    ], { cwd: fixtureRepository.repository });
    const replacementAwareEnvironment = { ...process.env };
    delete replacementAwareEnvironment.GIT_NO_REPLACE_OBJECTS;
    const replacementAwareParents = execFileSync(
        'git',
        ['rev-list', '--parents', '--max-count=1', fixtureRepository.exception.passThroughCommit],
        {
            cwd: fixtureRepository.repository,
            encoding: 'utf8',
            env: replacementAwareEnvironment
        }
    ).trim().split(/\s+/u).slice(1);
    const exactParents = execFileSync(
        'git',
        ['rev-list', '--parents', '--max-count=1', fixtureRepository.exception.passThroughCommit],
        {
            cwd: fixtureRepository.repository,
            encoding: 'utf8',
            env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
        }
    ).trim().split(/\s+/u).slice(1);
    assert.notDeepEqual(replacementAwareParents, exactParents);
    assert.deepEqual(exactParents, fixtureRepository.exception.passThroughParents);
    assert.deepEqual(validateGeneratedRepairPassThroughException(
        fixtureRepository.repository,
        fixtureRepository.producer,
        fixtureRepository.evidence,
        fixtureRepository.base,
        fixtureRepository.head,
        fixtureRepository.exception
    ), []);

    const missingObject = {
        ...fixtureRepository.exception,
        outerMergeCommit: 'ffffffffffffffffffffffffffffffffffffffff'
    };
    const errors = validateGeneratedRepairPassThroughException(
        fixtureRepository.repository,
        fixtureRepository.producer,
        fixtureRepository.evidence,
        fixtureRepository.base,
        fixtureRepository.head,
        missingObject
    );
    assert.ok(errors.some((error) => error.includes('cannot verify registered history')));
});

test('post-merge generated repair rejects reversed, wrong, and multi-parent source revisions', () =>
{
    const reversed = createPostMergeRepairFixture({ sourceRevisionMode: 'reversed' });
    const reversedErrors = validatePostMergeRepairFixture(reversed);
    assert.ok(reversedErrors.some(
        (error) => error.includes('second parent must exactly match the merged pull request base')
    ));
    assert.ok(reversedErrors.some(
        (error) => error.includes('first parent must be the pull request replay parent')
    ));

    const wrongParent = createPostMergeRepairFixture({ sourceRevisionMode: 'wrong-parent' });
    assert.ok(validatePostMergeRepairFixture(wrongParent).some(
        (error) => error.includes('second parent must exactly match the merged pull request base')
    ));

    const multiParent = createPostMergeRepairFixture({ sourceRevisionMode: 'multi-parent' });
    assert.ok(validatePostMergeRepairFixture(multiParent).some(
        (error) => error.includes('must have one parent or an exact two-parent in-PR merge')
    ));
});

test('post-merge generated repair rejects side-parent and ambiguous current source histories', () =>
{
    const sideParent = createPostMergeRepairFixture({ sourceRevisionMode: 'side-parent' });
    assert.ok(validatePostMergeRepairFixture(sideParent).some(
        (error) => error.includes('must be on the exact first-parent chain')
    ));

    const ambiguous = createPostMergeRepairFixture({ sourceRevisionMode: 'ambiguous' });
    assert.ok(validatePostMergeRepairFixture(ambiguous).some(
        (error) => error.includes('must be the unique current last trusted source revision')
    ));
});

test('post-merge generated repair rejects arbitrary outer identity and generator changes in a source merge', () =>
{
    const arbitraryOuter = createPostMergeRepairFixture({
        sourceRevisionMode: 'merge',
        mutateManifest: (manifest) =>
        {
            manifest.mergedPullRequest += 1;
        }
    });
    assert.ok(validatePostMergeRepairFixture(arbitraryOuter).some(
        (error) => error.includes('mergedPullRequest must match the exact merge commit message')
    ));

    const changedGenerator = createPostMergeRepairFixture({
        sourceRevisionMode: 'merge',
        changeGenerator: true
    });
    assert.ok(validatePostMergeRepairFixture(changedGenerator).some(
        (error) => error.includes('generator changed or its current digest is stale')
    ));

    const ownedRoundTrip = createPostMergeRepairFixture({
        sourceRevisionMode: 'merge',
        postSourceOwnedRoundTrip: true
    });
    assert.ok(validatePostMergeRepairFixture(ownedRoundTrip).some(
        (error) => error.includes('outer pull request must not change the trusted generator or outputs after sourceCommit')
    ));
});

test('post-merge generated repair rejects a candidate-side trusted generator mutation', () =>
{
    const repair = createPostMergeRepairFixture({
        sourceRevisionMode: 'merge',
        changeCandidateGenerator: true
    });
    assert.ok(validatePostMergeRepairFixture(repair).some(
        (error) => error.includes('generator changed or its current digest is stale')
    ));
});

test('post-merge generated repair rejects a source revision superseded at the current base', () =>
{
    const singleParent = createPostMergeRepairFixture({ laterSourceChange: true });
    assert.ok(validatePostMergeRepairFixture(singleParent).some(
        (error) => error.includes('sourceCommit must remain the current base owner')
    ));

    const mergedSource = createPostMergeRepairFixture({
        sourceRevisionMode: 'merge',
        laterSourceChange: true
    });
    assert.ok(validatePostMergeRepairFixture(mergedSource).some(
        (error) => error.includes('sourceCommit must remain the current base owner')
    ));
});

test('post-merge generated repair ignores replacement refs across history and replay validation', () =>
{
    for (const revisionField of ['sourceCommit', 'mergeCommit'])
    {
        const repair = createPostMergeRepairFixture({ sourceRevisionMode: 'merge' });
        const replacement = execFileSync(
            'git',
            ['rev-list', '--max-parents=0', 'HEAD'],
            { cwd: repair.repository, encoding: 'utf8' }
        ).trim();
        const original = repair.manifest[revisionField];
        execFileSync('git', ['replace', original, replacement], { cwd: repair.repository });
        const replacementAwareParents = execFileSync(
            'git',
            ['rev-list', '--parents', '--max-count=1', original],
            { cwd: repair.repository, encoding: 'utf8' }
        ).trim().split(/\s+/u).slice(1);
        const exactParents = execFileSync(
            'git',
            ['rev-list', '--parents', '--max-count=1', original],
            {
                cwd: repair.repository,
                encoding: 'utf8',
                env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
            }
        ).trim().split(/\s+/u).slice(1);
        assert.notDeepEqual(
            replacementAwareParents,
            exactParents,
            revisionField
        );
        assert.deepEqual(validatePostMergeRepairFixture(repair), [], revisionField);
    }
});

test('post-merge generated repair rejects drift that predates the bound source revision', () =>
{
    const repair = createPostMergeRepairFixture({ baselineOutputStale: true });
    assert.ok(validatePostMergeRepairFixture(repair).some(
        (error) => error.includes('source parent was already out of sync')
    ));
});

test('post-merge generated repair rejects open discovery, stale bindings, and unknown commands', () =>
{
    const repair = createPostMergeRepairFixture({
        mutateManifest: (manifest) =>
        {
            manifest.latest = 'docs/testing.generated.md';
            manifest.command = 'node tools/docs/generate-testing-docs.mjs --latest';
            manifest.source.sha256 = '0'.repeat(64);
            manifest.outputs[0].baseSha256 = '1'.repeat(64);
            manifest.outputs[0].expectedSha256 = '2'.repeat(64);
            manifest.outputs[0].currentSha256 = '3'.repeat(64);
        }
    });
    const errors = validatePostMergeRepairFixture(repair);
    assert.ok(errors.some((error) => error.includes('contains unsupported fields')));
    assert.ok(errors.some((error) => error.includes('command must match trusted producer')));
    assert.ok(errors.some((error) => error.includes('source changed or its current digest is stale')));
    assert.ok(errors.some((error) => error.includes('base output digest is stale')));
    assert.ok(errors.some((error) => error.includes('expected output digest is stale')));
    assert.ok(errors.some((error) => error.includes('current output digest is stale')));
});

test('post-merge generated repair rejects arbitrary history and extra outputs', () =>
{
    const arbitrary = createPostMergeRepairFixture({
        mutateManifest: (manifest, repository) =>
        {
            manifest.sourceCommit = execFileSync(
                'git',
                ['rev-list', '--max-parents=0', 'HEAD'],
                { cwd: repository, encoding: 'utf8' }
            ).trim();
        }
    });
    assert.ok(validatePostMergeRepairFixture(arbitrary).some(
        (error) => error.includes('must have one parent or an exact two-parent in-PR merge')
    ));

    const extra = createPostMergeRepairFixture({
        mutateManifest: (manifest, repository) =>
        {
            writeRepositoryFile(repository, 'docs/extra.generated.md', 'extra\n');
            manifest.outputs.push({
                path: 'docs/extra.generated.md',
                baseSha256: '0'.repeat(64),
                expectedSha256: '0'.repeat(64),
                currentSha256: fileSha256(repository, 'docs/extra.generated.md')
            });
        }
    });
    const extraErrors = validatePostMergeRepairFixture(extra);
    assert.ok(extraErrors.some((error) => error.includes('outputs must exactly match trusted producer')));
});

test('post-merge generated repair rejects changed sources, unchanged outputs, and non-canonical bytes', () =>
{
    const changedSource = createPostMergeRepairFixture({ changeSource: true });
    const changedSourceErrors = validatePostMergeRepairFixture(changedSource);
    assert.ok(changedSourceErrors.some((error) => error.includes('source must not be changed in this PR')));
    assert.ok(changedSourceErrors.some((error) => error.includes('source changed or its current digest is stale')));

    const unchanged = createPostMergeRepairFixture({ outputMode: 'unchanged' });
    const unchangedErrors = validatePostMergeRepairFixture(unchanged);
    assert.ok(unchangedErrors.some((error) => error.includes('binding path is not changed in this PR')));
    assert.ok(unchangedErrors.some((error) => error.includes('output must be changed by the candidate')));

    const tampered = createPostMergeRepairFixture({ outputMode: 'tampered' });
    assert.ok(validatePostMergeRepairFixture(tampered).some(
        (error) => error.includes('output bytes are not canonical')
    ));
});

test('post-merge generated repair DAG binds an ordered sealed range and canonical fixed point', () =>
{
    const repair = createPostMergeRepairDagFixture();
    assert.deepEqual(validatePostMergeRepairDagFixture(repair), []);
    const multiple = createPostMergeRepairDagFixture({ secondEvent: true });
    assert.deepEqual(validatePostMergeRepairDagFixture(multiple), []);
});

test('post-merge generated repair DAG requires the complete ordered source event range', () =>
{
    for (const [name, mutate] of [
        ['reordered', (manifest) => manifest.sourceEvents.reverse()],
        ['missing', (manifest) => manifest.sourceEvents.pop()],
        ['extra', (manifest) => manifest.sourceEvents.push(structuredClone(manifest.sourceEvents[1]))]
    ])
    {
        const repair = createPostMergeRepairDagFixture({ secondEvent: true, mutateManifest: mutate });
        assert.match(
            validatePostMergeRepairDagFixture(repair).join('\n'),
            /sourceEvents omit, duplicate, or reorder canonical transitions/u,
            name
        );
    }
});

test('post-merge generated repair DAG rejects wrong, multi-parent, and side-parent source topology', () =>
{
    for (const [mode, pattern] of [
        ['wrong-parent', /invalid parent topology/u],
        ['multi-parent', /invalid parent topology/u],
        ['side-parent', /outside its named merge head/u]
    ])
    {
        const repair = createPostMergeRepairDagFixture({ sourceRevisionMode: mode });
        assert.match(validatePostMergeRepairDagFixture(repair).join('\n'), pattern, mode);
    }
});

test('post-merge generated repair DAG rejects untrusted structure and stale sealed bindings', () =>
{
    const cases = [
        {
            name: 'unknown graph',
            mutate: (manifest) =>
            {
                manifest.producerId = 'unknown-graph';
            },
            pattern: /not trusted/u
        },
        {
            name: 'reordered steps',
            mutate: (manifest) =>
            {
                manifest.steps.reverse();
            },
            pattern: /step identity must match|generatorClosure must match/u
        },
        {
            name: 'missing step',
            mutate: (manifest) =>
            {
                manifest.steps.pop();
            },
            pattern: /steps must exactly match/u
        },
        {
            name: 'extra step',
            mutate: (manifest) =>
            {
                manifest.steps.push(structuredClone(manifest.steps[1]));
            },
            pattern: /steps must exactly match/u
        },
        {
            name: 'unknown execution identity',
            mutate: (manifest) =>
            {
                manifest.steps[0].command = 'node unknown.mjs';
                manifest.steps[0].executable = 'unknown';
                manifest.steps[0].arguments = ['unknown.mjs'];
            },
            pattern: /step identity must match|arguments must match/u
        },
        {
            name: 'missing dependency consumption',
            mutate: (manifest) =>
            {
                manifest.steps[1].consumes = [];
            },
            pattern: /consumes must match/u
        },
        {
            name: 'forged closure digest',
            mutate: (manifest) =>
            {
                manifest.steps[0].generatorClosure[0].baseSha256 = '0'.repeat(64);
            },
            pattern: /generator closure changed or is stale/u
        },
        {
            name: 'wrong output roster and flags',
            mutate: (manifest) =>
            {
                manifest.outputs.reverse();
                manifest.outputs[0].changed = false;
                manifest.outputs[0].repairRequired = false;
            },
            pattern: /outputs must exactly match|repair\/change flags are wrong/u
        },
        {
            name: 'missing output',
            mutate: (manifest) =>
            {
                manifest.outputs.pop();
            },
            pattern: /outputs must exactly match/u
        },
        {
            name: 'extra output',
            mutate: (manifest) =>
            {
                manifest.outputs.push({
                    ...structuredClone(manifest.outputs[0]),
                    path: 'config/testing/untrusted-extra.json'
                });
            },
            pattern: /outputs must exactly match/u
        },
        {
            name: 'stale input tree and projection',
            mutate: (manifest) =>
            {
                manifest.inputTree.baseSha256 = '1'.repeat(64);
                manifest.sourceProjection.base.sha256 = '2'.repeat(64);
            },
            pattern: /tracked input tree binding is stale|semantic source projection binding is stale/u
        },
        {
            name: 'duplicate event',
            mutate: (manifest) =>
            {
                manifest.sourceEvents.push(structuredClone(manifest.sourceEvents[0]));
            },
            pattern: /omit, duplicate, or reorder/u
        },
        {
            name: 'event cap',
            mutate: (manifest) =>
            {
                manifest.sourceEvents = Array.from(
                    { length: 65 },
                    () => structuredClone(manifest.sourceEvents[0])
                );
            },
            pattern: /sourceEvents exceeds 64 entries/u
        },
        {
            name: 'wrong pull request',
            mutate: (manifest) =>
            {
                manifest.sourceEvents[0].mergedPullRequest += 1;
            },
            pattern: /source event identity is invalid/u
        },
        {
            name: 'candidate input mutation',
            mutate: (_manifest, repository) =>
            {
                writeRepositoryFile(repository, 'candidate-extra.txt', 'extra\n');
            },
            pattern: /candidate changed unrelated paths before replay/u
        },
        {
            name: 'candidate policy mutation',
            mutate: (_manifest, repository) =>
            {
                writeRepositoryFile(
                    repository,
                    'tools/test/evidence-location-scanner.mjs',
                    'export const fixture = "candidate mutation"\n'
                );
            },
            pattern: /candidate changed executable or trusted policy before replay/u
        },
        {
            name: 'tampered output',
            mutate: (_manifest, repository) =>
            {
                writeRepositoryFile(
                    repository,
                    'config/testing/current-run-evidence-location-acceptance.json',
                    '{"tampered":true}\n'
                );
            },
            pattern: /candidate must be a canonical fixed point|output is not canonical/u
        },
        {
            name: 'symlink output',
            mutate: (_manifest, repository) =>
            {
                const output = join(repository, 'config/testing/current-run-evidence-location-acceptance.json');
                unlinkSync(output);
                symlinkSync('../../semantic-source.txt', output);
            },
            pattern: /not one canonical regular file/u
        }
    ];
    for (const entry of cases)
    {
        const repair = createPostMergeRepairDagFixture({ mutateManifest: entry.mutate });
        assert.match(validatePostMergeRepairDagFixture(repair).join('\n'), entry.pattern, entry.name);
    }
});

test('post-merge generated repair DAG rejects producer write, dependency, and history violations', () =>
{
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
    ];
    for (const entry of cases)
    {
        const repair = createPostMergeRepairDagFixture(entry.options);
        assert.match(validatePostMergeRepairDagFixture(repair).join('\n'), entry.pattern, entry.name);
    }
});

test('post-merge generated repair DAG enforces anchor ownership and aggregate replay budgets', () =>
{
    const tail = createPostMergeRepairDagFixture({ synchronizedTail: true });
    assert.match(
        validatePostMergeRepairDagFixture(tail).join('\n'),
        /synchronized revision must own at least one graph output/u
    );

    const oversizedHistory = createPostMergeRepairDagFixture({ outerPaddingCommits: 129 });
    assert.match(
        validatePostMergeRepairDagFixture(oversizedHistory).join('\n'),
        /first-parent range exceeds 128 revisions|exceeds 128 unique replay revisions/u
    );
});

test('post-merge generated repair DAG rejects oversized nested structures before replay', () =>
{
    for (const [label, mutate] of [
        ['steps', (manifest) =>
        {
            manifest.steps = Array.from({ length: 17 }, () => structuredClone(manifest.steps[0]));
        }],
        ['outputs', (manifest) =>
        {
            manifest.outputs = Array.from({ length: 129 }, () => structuredClone(manifest.outputs[0]));
        }],
        ['arguments', (manifest) =>
        {
            manifest.steps[0].arguments = Array.from({ length: 129 }, () => 'argument');
        }],
        ['closure', (manifest) =>
        {
            manifest.steps[0].generatorClosure = Array.from({ length: 129 }, () => structuredClone(manifest.steps[0].generatorClosure[0]));
        }]
    ])
    {
        const repair = createPostMergeRepairDagFixture({ mutateManifest: mutate });
        assert.match(validatePostMergeRepairDagFixture(repair).join('\n'), /exceeds \d+ entries/u, label);
    }
});

test('post-merge generated repair DAG rejects untrusted candidate and history code before execution', () =>
{
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'fsusblog-repair-dag-no-exec-'));
    try
    {
        const candidateMarker = join(temporaryRoot, 'candidate-executed');
        const candidate = createPostMergeRepairDagFixture({
            mutateManifest: (_manifest, repository) =>
            {
                writeRepositoryFile(
                    repository,
                    'tools/test/generate-evidence-location-governance.mjs',
                    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(candidateMarker)}, 'executed\\n')\n`
                );
            }
        });
        assert.match(
            validatePostMergeRepairDagFixture(candidate).join('\n'),
            /candidate changed executable or trusted policy before replay/u
        );
        assert.equal(existsSync(candidateMarker), false);

        const policyCandidate = createPostMergeRepairDagFixture({
            mutateManifest: (_manifest, repository) =>
            {
                writeRepositoryFile(repository, 'tools/governance/check-change-contract.mjs', '// candidate policy change\n');
            }
        });
        assert.match(validatePostMergeRepairDagFixture(policyCandidate).join('\n'),
            /candidate changed executable or trusted policy before replay/u);

        const historyMarker = join(temporaryRoot, 'history-executed');
        const history = createPostMergeRepairDagFixture({ historyExecutionMarker: historyMarker });
        assert.match(
            validatePostMergeRepairDagFixture(history).join('\n'),
            /outer history changed outputs or policy closure before replay|source branch changed outputs or policy closure before replay|generator closure is not trusted before replay/u
        );
        assert.equal(existsSync(historyMarker), false);

        const candidateInputMarker = join(temporaryRoot, 'candidate-input-executed');
        const candidateInput = createPostMergeRepairDagFixture({
            candidateInputExecutionMarker: candidateInputMarker,
            mutateManifest: (_manifest, repository) =>
            {
                writeRepositoryFile(repository, 'candidate-extra.ts', 'x'.repeat(256 * 1024));
            }
        });
        assert.match(
            validatePostMergeRepairDagFixture(candidateInput).join('\n'),
            /candidate changed unrelated paths before replay/u
        );
        assert.equal(existsSync(candidateInputMarker), false);

        const forgedNamingMarker = join(temporaryRoot, 'forged-naming-executed');
        const forgedNaming = createPostMergeRepairDagFixture({
            candidateInputExecutionMarker: forgedNamingMarker,
            mutateManifest: (_manifest, repository) =>
            {
                writeRepositoryFile(
                    repository,
                    'candidate-extra.json',
                    `${JSON.stringify('x'.repeat(256 * 1024))}\n`
                );
            }
        });
        const forgedNamingErrors = validatePostMergeRepairDagFixture(forgedNaming, {
            externalExceptionManifest: 'candidate-extra.json',
            externalExceptionPaths: 'candidate-extra.json'
        }).join('\n');
        assert.match(forgedNamingErrors, /trusted canonical external naming manifest path/u);
        assert.match(forgedNamingErrors, /candidate changed unrelated paths before replay/u);
        assert.equal(existsSync(forgedNamingMarker), false);
    }
    finally
    {
        rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('post-merge generated repair DAG ignores replacement refs for anchors, events, trees, and blobs', () =>
{
    const revisions = [
        ['synchronizedRevision'],
        ['synchronizedMergeCommit'],
        ['sourceEvents', 0, 'sourceRevision'],
        ['sourceEvents', 0, 'mergeCommit']
    ];
    for (const path of revisions)
    {
        const repair = createPostMergeRepairDagFixture();
        const original = path.reduce((value, key) => value[key], repair.manifest);
        const replacement = execFileSync(
            'git',
            ['rev-list', '--max-parents=0', 'HEAD'],
            { cwd: repair.repository, encoding: 'utf8' }
        ).trim();
        execFileSync('git', ['replace', original, replacement], { cwd: repair.repository });
        assert.deepEqual(validatePostMergeRepairDagFixture(repair), [], path.join('.'));
    }

    const blobRepair = createPostMergeRepairDagFixture();
    const originalBlob = execFileSync(
        'git',
        ['rev-parse', `${blobRepair.base}:semantic-source.txt`],
        { cwd: blobRepair.repository, encoding: 'utf8' }
    ).trim();
    const replacementBlob = execFileSync(
        'git',
        ['hash-object', '-w', '--stdin'],
        { cwd: blobRepair.repository, encoding: 'utf8', input: 'replacement source bytes\n' }
    ).trim();
    execFileSync('git', ['replace', originalBlob, replacementBlob], { cwd: blobRepair.repository });
    assert.deepEqual(validatePostMergeRepairDagFixture(blobRepair), [], 'source blob');

    const treeRepair = createPostMergeRepairDagFixture();
    const originalTree = execFileSync(
        'git',
        ['rev-parse', `${treeRepair.base}^{tree}`],
        { cwd: treeRepair.repository, encoding: 'utf8' }
    ).trim();
    const rootRevision = execFileSync(
        'git',
        ['rev-list', '--max-parents=0', 'HEAD'],
        { cwd: treeRepair.repository, encoding: 'utf8' }
    ).trim();
    const replacementTree = execFileSync(
        'git',
        ['rev-parse', `${rootRevision}^{tree}`],
        { cwd: treeRepair.repository, encoding: 'utf8' }
    ).trim();
    execFileSync('git', ['replace', originalTree, replacementTree], { cwd: treeRepair.repository });
    assert.deepEqual(validatePostMergeRepairDagFixture(treeRepair), [], 'base tree');
});

test('post-merge external naming repair binds exact history, source identity, surface, and missing artifact', () =>
{
    const repair = createPostMergeExternalNamingRepairFixture();
    assert.deepEqual(validatePostMergeExternalNamingRepairFixture(repair), []);
});

test('post-merge external naming repair rejects unmerged and wrong repository or history identities', () =>
{
    const unmerged = createPostMergeExternalNamingRepairFixture({ unmerged: true });
    assert.ok(validatePostMergeExternalNamingRepairFixture(unmerged).some(
        (error) => error.includes('mergeCommit must be an ancestor')
    ));

    const wrongRepository = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) =>
        {
            manifest.repository = 'Wrong/Repository';
        }
    });
    assert.ok(validatePostMergeExternalNamingRepairFixture(wrongRepository).some(
        (error) => error.includes('repository must be Ozwasyd/FsusBlog')
    ));

    for (const [field, mutate, message] of [
        ['base', (manifest) =>
        {
            manifest.originalBase = manifest.originalHead;
        }, 'parents must exactly match'],
        ['head', (manifest) =>
        {
            manifest.originalHead = manifest.originalBase;
        }, 'parents must exactly match'],
        ['merge', (manifest) =>
        {
            manifest.mergeCommit = manifest.originalHead;
        }, 'parents must exactly match']
    ])
    {
        const wrong = createPostMergeExternalNamingRepairFixture({ mutateManifest: mutate });
        assert.ok(
            validatePostMergeExternalNamingRepairFixture(wrong).some((error) => error.includes(message)),
            field
        );
    }
});

test('post-merge external naming repair rejects stale blobs, source drift, and wrong ownership', () =>
{
    const staleCandidate = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) =>
        {
            manifest.source.candidateSha256 = '0'.repeat(64);
        }
    });
    assert.ok(validatePostMergeExternalNamingRepairFixture(staleCandidate).some(
        (error) => error.includes('source blob identity drifted')
    ));
    const staleCurrent = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) =>
        {
            manifest.source.currentSha256 = '1'.repeat(64);
        }
    });
    assert.ok(validatePostMergeExternalNamingRepairFixture(staleCurrent).some(
        (error) => error.includes('source blob identity drifted')
    ));
    const changedSource = createPostMergeExternalNamingRepairFixture({ laterSourceChange: true });
    const changedSourceErrors = validatePostMergeExternalNamingRepairFixture(changedSource);
    assert.ok(changedSourceErrors.some((error) => error.includes('source blob identity drifted')));
    assert.ok(changedSourceErrors.some((error) => error.includes('source revision changed')));

    const wrongPath = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) =>
        {
            manifest.source.path = 'docs/testing.md';
        }
    });
    assert.ok(validatePostMergeExternalNamingRepairFixture(wrongPath).some(
        (error) => error.includes('outside registered surface')
    ));
    const wrongSurface = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) =>
        {
            manifest.namingSurface.id = 'unknown-surface';
        }
    });
    assert.ok(validatePostMergeExternalNamingRepairFixture(wrongSurface).some(
        (error) => error.includes('surface is not registered')
    ));
});

test('post-merge external naming repair rejects malformed, extra, missing, and stale artifact evidence', () =>
{
    const extraField = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) =>
        {
            manifest.unexpected = true;
        }
    });
    assert.ok(validatePostMergeExternalNamingRepairFixture(extraField).some(
        (error) => error.includes('unsupported fields')
    ));
    const missingField = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) =>
        {
            delete manifest.repository;
        }
    });
    assert.ok(validatePostMergeExternalNamingRepairFixture(missingField).some(
        (error) => error.includes('unsupported fields')
    ));
    const staleArtifact = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) =>
        {
            manifest.missingArtifact.sha256 = '2'.repeat(64);
        }
    });
    assert.ok(validatePostMergeExternalNamingRepairFixture(staleArtifact).some(
        (error) => error.includes('missingArtifact digest is stale')
    ));
    const missingArtifact = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) =>
        {
            manifest.missingArtifact.path = 'artifacts/change-contract/not-created.json';
        }
    });
    const missingArtifactErrors = validatePostMergeExternalNamingRepairFixture(missingArtifact);
    assert.ok(missingArtifactErrors.some((error) => error.includes('must be changed by the candidate')));
    const extraDeclaration = createPostMergeExternalNamingRepairFixture({
        mutateArtifact: (artifact) => artifact.exceptions.push(structuredClone(artifact.exceptions[0]))
    });
    assert.ok(validatePostMergeExternalNamingRepairFixture(extraDeclaration).some(
        (error) => error.includes('exactly one exception')
    ));
    const missingCurrentException = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) =>
        {
            manifest.currentExceptions = [];
        }
    });
    assert.ok(validatePostMergeExternalNamingRepairFixture(missingCurrentException).some(
        (error) => error.includes('current exceptions must exactly match')
    ));
    const wrongCurrentException = createPostMergeExternalNamingRepairFixture({
        mutateManifest: (manifest) =>
        {
            manifest.currentExceptions[0].id = 'environment-variable';
        }
    });
    assert.ok(validatePostMergeExternalNamingRepairFixture(wrongCurrentException).some(
        (error) => error.includes('outside registered surface environment-variable')
    ));
});

test('external naming exception binds a trusted registry ID to changed paths', () =>
{
    const title = 'refactor(wasm): preserve exported decoder adapter';
    const changedFiles = ['src/frontend/wasm/aeds/src/exports.cpp'];
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
    });
    assert.deepEqual(accepted, []);
    const legacyBody = pullRequestBody({
        type: 'refactor',
        externalNaming: true,
        audience: 'internal',
        category: 'Internal/Tooling',
        summary: 'preserve exported decoder adapter'
    }).replace('- Exceptions manifest: none\n', '');
    assert.deepEqual(validatePrContract({
        title,
        body: legacyBody,
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles,
        root,
        authorityRoot: root
    }), []);

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
    });
    assert.ok(missingClassification.some((error) => error.includes('require External naming exception')));

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
    });
    assert.ok(unregistered.some((error) => error.includes('is not registered')));

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
    });
    assert.ok(partialBinding.some((error) => error.includes('exactly match all changed registered naming surfaces')));
});

test('external naming manifest binds multiple exception IDs to disjoint governed paths', () =>
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-external-naming-pr-'));
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
    const changedFiles = [
        'src/frontend/wasm/aeds/src/exports.cpp',
        'tools/bootstrap-acceptance-env.sh',
        'tools/test/bundles/runtime-environment.mjs',
        'artifacts/change-contract/external-naming-exceptions.json'
    ];
    for (const path of changedFiles.slice(0, -1))
    {
        writeRepositoryFile(repository, path, 'fixture\n');
    }
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
    }, null, 4)}\n`);
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture candidate'], { cwd: repository });
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
    });
    assert.deepEqual(validatePrContract({
        title: 'fix(governance): bind multiple external naming exceptions',
        body,
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles,
        root: repository,
        authorityRoot: root
    }), []);
});

test('external naming manifest rejects broad, duplicate, and incomplete path assignments', () =>
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-external-naming-negative-'));
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
    const manifestPath = 'artifacts/change-contract/external-naming-exceptions.json';
    const changedFiles = [
        'src/frontend/wasm/aeds/src/exports.cpp',
        'tools/bootstrap-acceptance-env.sh',
        manifestPath
    ];
    for (const path of changedFiles.slice(0, -1))
    {
        writeRepositoryFile(repository, path, 'fixture\n');
    }
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
    }, null, 4)}\n`);
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture candidate'], { cwd: repository });
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
    });
    const errors = validatePrContract({
        title: 'fix(governance): reject broad external naming declarations',
        body,
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles,
        root: repository,
        authorityRoot: root
    });
    assert.ok(errors.some((error) => error.includes('assigned to more than one exception')));
    assert.ok(errors.some((error) => error.includes('outside registered exception shell-environment-variable')));
    assert.ok(errors.some((error) => error.includes('not changed in this PR')));
    assert.ok(errors.some((error) => error.includes('exactly match all changed registered naming surfaces')));
});

test('runtime environment exception atomically binds the canonical projection and shell executor', () =>
{
    const title = 'fix(test): map final-image release root';
    const changedFiles = [
        'tools/test/release-reliability-runtime-environment.mjs',
        'tools/test/run-release-reliability-qualified-local.sh'
    ];
    const body = pullRequestBody({
        type: 'fix',
        externalNaming: true,
        audience: 'internal',
        category: 'Internal/Tooling',
        summary: 'map final-image release root',
        externalExceptionId: 'release-reliability-runtime-environment',
        externalExceptionPaths: changedFiles.join(', '),
        externalExceptionReason: 'keep the same caller-visible process environment keys atomic across their canonical projection and sole shell executor'
    });
    assert.deepEqual(validatePrContract({
        title,
        body,
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles,
        root,
        authorityRoot: root
    }), []);

    const expanded = validatePrContract({
        title,
        body,
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles: [...changedFiles, 'tools/test/another-runtime-owner.mjs'],
        root,
        authorityRoot: root
    });
    assert.ok(expanded.some((error) => error.includes('exactly match all changed registered naming surfaces')));
});

test('acceptance secret exception atomically binds the bootstrap producer and runtime collector', () =>
{
    const title = 'fix(test): generate valid acceptance keys';
    const changedFiles = [
        'tools/bootstrap-acceptance-env.sh',
        'tools/test/bundles/runtime-environment.mjs'
    ];
    const body = pullRequestBody({
        type: 'fix',
        externalNaming: true,
        audience: 'internal',
        category: 'Internal/Tooling',
        summary: 'generate valid acceptance keys',
        externalExceptionId: 'acceptance-secret-runtime-environment',
        externalExceptionPaths: changedFiles.join(', '),
        externalExceptionReason: 'keep the same run-bound secret environment keys atomic across their bootstrap producer and sole runtime collector'
    });
    assert.deepEqual(validatePrContract({
        title,
        body,
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles,
        root,
        authorityRoot: root
    }), []);

    const expanded = validatePrContract({
        title,
        body,
        labels: ['release-note:internal'],
        actor: 'maintainer',
        changedFiles: [...changedFiles, 'tools/test/another-secret-owner.mjs'],
        root,
        authorityRoot: root
    });
    assert.ok(expanded.some((error) => error.includes('exactly match all changed registered naming surfaces')));
});

test('performance claim binds one perf commit and the exact evidence blobs', () =>
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-performance-pr-'));
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
    writeRepositoryFile(repository, '.git-blame-ignore-revs', '');
    writeRepositoryFile(repository, 'src/cache.ts', 'export const cacheReads = 2\n');
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture base'], { cwd: repository });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();

    writeRepositoryFile(repository, 'src/cache.ts', 'export const cacheReads = 1\n');
    execFileSync('git', ['add', 'src/cache.ts'], { cwd: repository });
    execFileSync('git', ['commit', '-qF', resolve(fixtures, 'valid', 'perf.txt')], { cwd: repository });
    const performanceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8'
    }).trim();

    writeRepositoryFile(repository, 'artifacts/performance/hot-read-result.json', '{"p95Ms":12.5}\n');
    writeRepositoryFile(repository, 'artifacts/performance/hot-read.json', `${JSON.stringify({
        schema: changeContract.evidenceSchemas.performanceClaim,
        changeRevision: performanceRevision,
        claimLevel: 'R',
        status: 'measured',
        evidence: [{
            path: 'artifacts/performance/hot-read-result.json',
            sha256: fileSha256(repository, 'artifacts/performance/hot-read-result.json')
        }]
    }, null, 4)}\n`);
    execFileSync('git', ['add', 'artifacts/performance'], { cwd: repository });
    execFileSync('git', [
        'commit',
        '-qm',
        'chore(performance): bind measured performance evidence\n\nRefs: #1163'
    ], { cwd: repository });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    const evidencePath = 'artifacts/performance/hot-read.json';
    const changedFiles = changedFilesBetween(repository, base, head);
    const body = pullRequestBody({
        type: 'perf',
        audience: 'user-facing',
        category: 'Changed',
        summary: 'reduce measured hot-read latency',
        claim: 'R'
    }).replace('artifacts/performance/result.json', evidencePath);

    assert.deepEqual(validatePrContract({
        title: 'perf(cache): reduce measured hot-read latency',
        body,
        labels: ['release-note:changed'],
        actor: 'maintainer',
        changedFiles,
        root: repository,
        head,
        authorityRoot: null
    }), []);
    assert.deepEqual(validatePerformancePullRequest(repository, base, head, evidencePath), []);
    assert.deepEqual(validateCommitRange(repository, `${base}..${head}`), []);

    writeRepositoryFile(repository, 'artifacts/performance/hot-read-result.json', '{"p95Ms":99}\n');
    execFileSync('git', ['add', 'artifacts/performance/hot-read-result.json'], { cwd: repository });
    execFileSync('git', [
        'commit',
        '-qm',
        'test(performance): tamper performance evidence fixture\n\nRefs: #1163'
    ], { cwd: repository });
    assert.match(
        validatePerformancePullRequest(repository, base, 'HEAD', evidencePath).join('\n'),
        /Performance evidence digest mismatch/u
    );

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
    });
    assert.ok(nonPerfClaim.some((error) => error.includes('require a perf PR title')));
});

test('format-only diff rejects semantic contract and test expectation changes', () =>
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-change-contract-'));
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
    writeFileSync(join(repository, 'contract.json'), '{"expected":"alpha"}\n');
    execFileSync('git', ['add', 'contract.json'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture base'], { cwd: repository });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();

    writeFileSync(join(repository, 'contract.json'), '{  "expected":  "alpha"  }\n');
    execFileSync('git', ['add', 'contract.json'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture whitespace'], { cwd: repository });
    const whitespace = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    assert.deepEqual(validateFormatOnlyDiff(repository, base, whitespace), []);

    writeFileSync(join(repository, 'contract.json'), '{  "expected":  "beta"  }\n');
    execFileSync('git', ['add', 'contract.json'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture semantic'], { cwd: repository });
    const semantic = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    assert.match(validateFormatOnlyDiff(repository, whitespace, semantic).join('\n'), /quoted-value tokens/u);

    writeFileSync(join(repository, 'contract.json'), '{  "expected":  "be ta"  }\n');
    execFileSync('git', ['add', 'contract.json'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture quoted whitespace'], { cwd: repository });
    const quotedWhitespace = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    assert.match(validateFormatOnlyDiff(repository, semantic, quotedWhitespace).join('\n'), /quoted-value tokens/u);
});

test('format-only fingerprint rejects joined identifiers, JSON lexical changes, YAML depth, and file types', () =>
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-format-adversarial-'));
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
    writeFileSync(join(repository, 'sample.cs'), 'int x = 1;\n');
    writeFileSync(
        join(repository, 'contract.json'),
        '{"value":1,"value":2,"large":9007199254740993,"escaped":"\\u0061"}\n'
    );
    writeFileSync(join(repository, 'config.yml'), 'parent:\n  child: 1\n');
    writeFileSync(join(repository, 'link.txt'), 'regular\n');
    writeFileSync(join(repository, 'script.ts'), 'export function read() {\n  return 1\n}\n');
    writeFileSync(join(repository, 'script.py'), 'if ready:\n  value = 1\n');
    writeFileSync(join(repository, 'native.h'), '#define VALUE 1\n');
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture base'], { cwd: repository });
    let before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();

    writeFileSync(join(repository, 'sample.cs'), 'int    x    =    1;\n');
    writeFileSync(
        join(repository, 'contract.json'),
        '{  "value" : 1, "value" : 2, "large" : 9007199254740993, "escaped" : "\\u0061"  }\n'
    );
    writeFileSync(join(repository, 'config.yml'), 'parent:\n    child: 1\n');
    writeFileSync(join(repository, 'script.ts'), 'export   function read() {\n    return 1\n}\n');
    writeFileSync(join(repository, 'script.py'), 'if ready:\n    value = 1\n');
    writeFileSync(join(repository, 'native.h'), '#  define   VALUE   1\n');
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture formatting'], { cwd: repository });
    let after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    assert.deepEqual(validateFormatOnlyDiff(repository, before, after), []);

    before = after;
    writeFileSync(join(repository, 'sample.cs'), 'intx = 1;\n');
    execFileSync('git', ['add', 'sample.cs'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture joined identifier'], { cwd: repository });
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /non-whitespace/u);

    before = after;
    writeFileSync(
        join(repository, 'contract.json'),
        '{"value":1,"value":2,"large":9007199254740992,"escaped":"\\u0061"}\n'
    );
    execFileSync('git', ['add', 'contract.json'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture unsafe integer'], { cwd: repository });
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /contract\.json/u);

    before = after;
    writeFileSync(
        join(repository, 'contract.json'),
        '{"value":9,"value":2,"large":9007199254740992,"escaped":"\\u0061"}\n'
    );
    execFileSync('git', ['add', 'contract.json'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture duplicate key value'], { cwd: repository });
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /contract\.json/u);

    before = after;
    writeFileSync(
        join(repository, 'contract.json'),
        '{"value":9,"value":2,"large":9007199254740992,"escaped":"a"}\n'
    );
    execFileSync('git', ['add', 'contract.json'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture escape spelling'], { cwd: repository });
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /contract\.json/u);

    before = after;
    writeFileSync(join(repository, 'config.yml'), 'parent:\nchild: 1\n');
    execFileSync('git', ['add', 'config.yml'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture yaml depth'], { cwd: repository });
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /config\.yml/u);

    before = after;
    unlinkSync(join(repository, 'link.txt'));
    symlinkSync('sample.cs', join(repository, 'link.txt'));
    execFileSync('git', ['add', '-A'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture file type'], { cwd: repository });
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /adds, copies, deletes, or renames/u);

    before = after;
    writeFileSync(join(repository, 'script.ts'), 'export function read() {\n  return\n  1\n}\n');
    execFileSync('git', ['add', 'script.ts'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture automatic semicolon insertion'], { cwd: repository });
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /script\.ts/u);

    before = after;
    writeFileSync(join(repository, 'script.py'), 'if ready:\nvalue = 1\n');
    execFileSync('git', ['add', 'script.py'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture python block depth'], { cwd: repository });
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /script\.py/u);

    before = after;
    writeFileSync(join(repository, 'native.h'), '#define VALUE\n1\n');
    execFileSync('git', ['add', 'native.h'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture preprocessor line split'], { cwd: repository });
    after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    assert.match(validateFormatOnlyDiff(repository, before, after).join('\n'), /native\.h/u);
});

test('changed path calculation uses merge-base and includes only feature-side changes', () =>
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-merge-base-'));
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
    writeFileSync(join(repository, 'common.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture base'], { cwd: repository });
    execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: repository });
    writeFileSync(join(repository, 'feature.txt'), 'feature\n');
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture feature'], { cwd: repository });
    execFileSync('git', ['mv', 'common.txt', 'renamed.txt'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture feature rename'], { cwd: repository });
    const feature = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '-q', 'master'], { cwd: repository });
    writeFileSync(join(repository, 'base-only.txt'), 'advanced base\n');
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture advanced base'], { cwd: repository });
    const advancedBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();

    assert.deepEqual(
        changedFilesBetween(repository, advancedBase, feature).sort(),
        ['common.txt', 'feature.txt', 'renamed.txt']
    );
});

test('blame-ignore parser requires full, unique, reachable, non-merge style revisions', () =>
{
    const revision = '0123456789abcdef0123456789abcdef01234567';
    const inspected = () => ({
        exists: true,
        reachable: true,
        parents: 1,
        subject: 'style(csharp): normalize backend whitespace'
    });
    assert.deepEqual(validateBlameIgnoreRevisions(`${revision}\n`, {
        requiredRevisions: [revision],
        inspectRevision: inspected
    }), []);
    assert.match(validateBlameIgnoreRevisions('', {
        requiredRevisions: [revision],
        inspectRevision: inspected
    }).join('\n'), /missing blame-ignore entry/u);
    assert.deepEqual(parseBlameIgnoreRevisions(`# reviewed\n${revision}\n`), [revision]);
});

test('blame-ignore repository audit rejects naming-only style commits', () =>
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-blame-naming-'));
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
    writeRepositoryFile(repository, '.git-blame-ignore-revs', '');
    writeRepositoryFile(repository, 'source.cpp', 'int old_name = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture base'], { cwd: repository });

    writeRepositoryFile(repository, 'source.cpp', 'int NewName = 1;\n');
    execFileSync('git', ['add', 'source.cpp'], { cwd: repository });
    execFileSync('git', ['commit', '-qF', resolve(fixtures, 'valid', 'naming-only.txt')], { cwd: repository });
    const namingRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8'
    }).trim();

    writeRepositoryFile(repository, '.git-blame-ignore-revs', `${namingRevision}\n`);
    execFileSync('git', ['add', '.git-blame-ignore-revs'], { cwd: repository });
    execFileSync('git', [
        'commit',
        '-qm',
        'chore(governance): register naming fixture revision\n\nRefs: #1163'
    ], { cwd: repository });
    assert.match(
        validateRepositoryBlameIgnore(repository).join('\n'),
        /lacks a format-only commit contract/u
    );
});

test('changed commit range requires format commit idempotence and a later blame-ignore entry', () =>
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-change-range-'));
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
    writeFileSync(join(repository, 'source.cs'), 'class Fixture { }\n');
    writeFileSync(join(repository, '.git-blame-ignore-revs'), '');
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture base'], { cwd: repository });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();

    writeFileSync(join(repository, 'source.cs'), 'class Fixture    {    }\n');
    execFileSync('git', ['add', 'source.cs'], { cwd: repository });
    execFileSync('git', ['commit', '-qF', resolve(fixtures, 'valid', 'format-only.txt')], { cwd: repository });
    const formatRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();

    writeFileSync(join(repository, '.git-blame-ignore-revs'), `${formatRevision}\n`);
    writeFormatEvidence(repository, formatRevision);
    execFileSync('git', ['add', '.git-blame-ignore-revs', 'artifacts/style/idempotence.json'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'chore(governance): register reviewed format revision\n\nRefs: #1163'], { cwd: repository });
    assert.deepEqual(validateCommitRange(repository, `${base}..HEAD`), []);

    const evidencePath = join(repository, 'artifacts/style/idempotence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    evidence.secondPassTreeSha256 = '0'.repeat(64);
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 4)}\n`);
    execFileSync('git', ['add', 'artifacts/style/idempotence.json'], { cwd: repository });
    execFileSync('git', [
        'commit',
        '-qm',
        'test(governance): tamper format evidence fixture\n\nRefs: #1163'
    ], { cwd: repository });
    assert.match(validateCommitRange(repository, `${base}..HEAD`).join('\n'), /first\/second pass digests/u);

    writeFileSync(join(repository, '.git-blame-ignore-revs'), '');
    assert.match(validateCommitRange(repository, `${base}..HEAD`).join('\n'), /missing blame-ignore entry/u);
});

test('format-only PR accepts later blame metadata but rejects any other semantic aggregate change', () =>
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-format-pr-'));
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
    writeFileSync(join(repository, 'source.cs'), 'class Fixture { }\n');
    writeFileSync(join(repository, '.git-blame-ignore-revs'), '');
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture base'], { cwd: repository });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();

    writeFileSync(join(repository, 'source.cs'), 'class Fixture    {    }\n');
    execFileSync('git', ['add', 'source.cs'], { cwd: repository });
    execFileSync('git', ['commit', '-qF', resolve(fixtures, 'valid', 'format-only.txt')], { cwd: repository });
    const formatRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();

    writeFileSync(join(repository, '.git-blame-ignore-revs'), `${formatRevision}\n`);
    writeFormatEvidence(repository, formatRevision);
    execFileSync('git', ['add', '.git-blame-ignore-revs', 'artifacts/style/idempotence.json'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'chore(governance): register reviewed format revision\n\nRefs: #1163'], { cwd: repository });
    const metadataHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();

    assert.notDeepEqual(validateFormatOnlyDiff(repository, base, metadataHead), []);
    assert.deepEqual(validateFormatOnlyPullRequest(
        repository,
        base,
        metadataHead,
        formatRevision,
        'artifacts/style/idempotence.json'
    ), []);
    assert.match(
        validateFormatOnlyPullRequest(
            repository,
            base,
            metadataHead,
            '0'.repeat(40),
            'artifacts/style/idempotence.json'
        ).join('\n'),
        /declared revision must exactly match/u
    );

    writeFileSync(join(repository, 'source.cs'), 'class ChangedFixture { }\n');
    execFileSync('git', ['add', 'source.cs'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fix(governance): alter governed source semantics\n\nRefs: #1163'], { cwd: repository });
    assert.match(
        validateFormatOnlyPullRequest(
            repository,
            base,
            'HEAD',
            formatRevision,
            'artifacts/style/idempotence.json'
        ).join('\n'),
        /non-whitespace or quoted-value tokens/u
    );
});

test('pull request actor authority comes from the PR author rather than the event sender', () =>
{
    assert.equal(pullRequestActor({
        sender: { login: 'maintainer' },
        pull_request: { user: { login: 'generator[bot]' } }
    }), 'generator[bot]');
    assert.equal(pullRequestActor({ sender: { login: 'maintainer' } }), '');
});

test('candidate pull request cannot replace the trusted change-contract policy', () =>
{
    const authority = mkdtempSync(join(tmpdir(), 'fsusblog-policy-authority-'));
    const candidate = mkdtempSync(join(tmpdir(), 'fsusblog-policy-candidate-'));
    const policyPath = 'tools/governance/change-contract.mjs';
    writeRepositoryFile(authority, policyPath, 'export const gate = "trusted"\n');
    writeRepositoryFile(
        authority,
        'config/development/native-tooling-style-exceptions.json',
        '{"exceptions":[]}\n'
    );

    execFileSync('git', ['init', '-q'], { cwd: candidate });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: candidate });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: candidate });
    writeRepositoryFile(candidate, policyPath, 'export const gate = "disabled"\n');
    execFileSync('git', ['add', '.'], { cwd: candidate });
    execFileSync('git', ['commit', '-qm', 'fixture candidate'], { cwd: candidate });

    const errors = validatePrContract({
        title: 'feat(governance): enforce trusted policy transition',
        body: pullRequestBody({ summary: 'enforce trusted policy transition' }),
        labels: ['release-note:added'],
        actor: 'maintainer',
        changedFiles: [policyPath],
        root: candidate,
        authorityRoot: authority
    });
    assert.ok(errors.some((error) => error.includes('cannot replace trusted change-contract policy source')));
});

test('candidate pull request cannot replace any fixed C# parser source or SDK input', () =>
{
    for (const policyPath of changeContract.csharpFormatPolicyFiles)
    {
        const authority = mkdtempSync(join(tmpdir(), 'fsusblog-policy-authority-'));
        const candidate = mkdtempSync(join(tmpdir(), 'fsusblog-policy-candidate-'));
        writeRepositoryFile(authority, policyPath, 'export const gate = "trusted"\n');
        writeRepositoryFile(
            authority,
            'config/development/native-tooling-style-exceptions.json',
            '{"exceptions":[]}\n'
        );

        execFileSync('git', ['init', '-q'], { cwd: candidate });
        execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: candidate });
        execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: candidate });
        writeRepositoryFile(candidate, policyPath, 'export const gate = "disabled"\n');
        execFileSync('git', ['add', '.'], { cwd: candidate });
        execFileSync('git', ['commit', '-qm', 'fixture candidate'], { cwd: candidate });

        const errors = validatePrContract({
            title: 'feat(governance): enforce trusted policy transition',
            body: pullRequestBody({ summary: 'enforce trusted policy transition' }),
            labels: ['release-note:added'],
            actor: 'maintainer',
            changedFiles: [policyPath],
            root: candidate,
            authorityRoot: authority
        });
        assert.ok(errors.some((error) => error.includes(`cannot replace trusted change-contract policy source: ${policyPath}`)));
        rmSync(authority, { recursive: true, force: true });
        rmSync(candidate, { recursive: true, force: true });
    }
});

test('repository contract sources, generated release categories, and current blame history agree', () =>
{
    assert.deepEqual(validateRepositorySources(root), []);
    assert.deepEqual(validateRepositoryBlameIgnore(root), []);
});

const factHistory = await import(new URL('../../tools/governance/fact-section-repair-history.mjs', import.meta.url));
const historyReadCache = new Map();
function finiteHistoryFixture()
{
    const base = factHistory.releaseFactSectionRepairHistory.frontier;
    const head = 'b8f3cd2a999e9e6243109d07700c411c9c06c4ed';
    const original = factHistory.createFactSectionHistoryRepository(root);
    const repository = Object.fromEntries(['blob', 'commit', 'revisionsBetween', 'changedPaths'].map((method) => [method, (...args) =>
    {
        const key = JSON.stringify([method, ...args]);
        if (!historyReadCache.has(key))
        {
            // A synthetic expected head keeps this component fixture runnable
            // without an unmerged local branch. It is not a producer replay.
            let value;
            if (args.includes(head))
            {
                if (method === 'revisionsBetween')
                {
                    value = [head];
                }
                else if (method === 'commit')
                {
                    value = { commit: head, parents: [base], tree: 'f'.repeat(40) };
                }
                else if (method === 'changedPaths')
                {
                    value = [factHistory.releaseFactSectionRepairHistory.document];
                }
                else
                {
                    const source = original.blob(base, args[1]);
                    const text = source.bytes.toString('utf8')
                        .replace('68e30ca22be4f9d0d7a5ee1d7e26cb18a3740246a8f426865b7e59ad8783b79f',
                            'de814266fc58064e3d824e5c298d9d3e1ba2c4ba8abeb420dfca9071b8e3fd03')
                        .replace('4e0b8a954eb47e6487270ec9d9ddde416f58f143072463fa9575bbd7d0341e01',
                            'e79612098d4d345344f7de0bf28011e81e0311194275253f7372071d5ddaeb74');
                    const bytes = Buffer.from(text);
                    value = { mode: source.mode, object: createHash('sha1')
                        .update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), bytes };
                }
            }
            else
            {
                value = original[method](...args);
            }
            historyReadCache.set(key, value);
        }
        const value = historyReadCache.get(key);
        return method === 'blob' ? { ...value, bytes: Buffer.from(value.bytes) } : structuredClone(value);
    }]));
    return { base, head, repository, evidence: {
        schema: factHistory.factSectionRepairHistorySchema,
        historyId: factHistory.releaseFactSectionRepairHistory.id,
        frontierCommit: base,
        candidateCommit: head
    } };
}

test('finite fact-section Git adapter verifies actual objects and retains finite read boundaries', () =>
{
    const temporary = mkdtempSync(join(tmpdir(), 'fsusblog-finite-history-native-'));
    const env = {
        ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null',
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
    };
    const git = (args, input) => execFileSync('git', ['--no-replace-objects', '-c', 'advice.graftFileDeprecated=false', ...args], {
        cwd: temporary, env, input, encoding: 'utf8', maxBuffer: 18 * 1024 * 1024
    }).trim();
    try
    {
        git(['init', '--quiet']);
        const objects = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], {
            cwd: root, encoding: 'utf8'
        }).trim();
        mkdirSync(join(temporary, '.git/objects/info'), { recursive: true });
        writeFileSync(join(temporary, '.git/objects/info/alternates'), `${objects}\n`);
        const registration = factHistory.releaseFactSectionRepairHistory;
        const repository = factHistory.createFactSectionHistoryRepository(temporary);
        const fixture = finiteHistoryFixture();
        const expected = fixture.repository.blob(fixture.head, registration.document);
        git(['read-tree', registration.frontier]);
        const object = git(['hash-object', '-w', '--stdin'], expected.bytes);
        assert.equal(object, registration.expected.object);
        git(['update-index', '--cacheinfo', `100644,${object},${registration.document}`]);
        const tree = git(['write-tree']);
        const head = git(['commit-tree', tree, '-p', registration.frontier,
            '-m', 'fix(governance): bind finite history fixture']);
        const result = factHistory.verifyFactSectionRepairHistoryPreflight({
            base: registration.frontier, head, repository,
            evidence: { ...fixture.evidence, candidateCommit: head }
        });
        assert.equal(result.candidateCommit, head);
        assert.equal(result.status, 'preflight-only');
        assert.equal(result.qualification, false);
        assert.throws(() => repository.commit(head.slice(0, 8)), /complete revision/u);
        assert.throws(() => repository.blob(head, '../docs/releases/release-identity.md'), /exact repository file path/u);
        const child = join(temporary, 'child');
        mkdirSync(child);
        assert.throws(() => factHistory.createFactSectionHistoryRepository(child), /canonical Git checkout root/u);

        let excessive = registration.frontier;
        for (let index = 0; index < 129; index += 1)
        {
            excessive = git(['commit-tree', tree, '-p', excessive,
                '-m', `fix(governance): bind bounded fixture ${index}`]);
        }
        assert.throws(() => repository.revisionsBetween(registration.frontier, excessive), /finite replay bound/u);
        const oversized = git(['hash-object', '-w', '--stdin'], Buffer.alloc(16 * 1024 * 1024 + 1, 65));
        git(['update-index', '--cacheinfo', `100644,${oversized},${registration.document}`]);
        const oversizedHead = git(['commit-tree', git(['write-tree']), '-p', registration.frontier,
            '-m', 'fix(governance): bind oversized fixture']);
        assert.throws(() => repository.blob(oversizedHead, registration.document), /blob exceeds its byte bound/u);
        git(['update-ref', `refs/replace/${head}`, oversizedHead]);
        mkdirSync(join(temporary, '.git/info'), { recursive: true });
        writeFileSync(join(temporary, '.git/info/grafts'), `${head} ${excessive}\n`);
        assert.deepEqual(repository.commit(head).parents, [registration.frontier]);
        assert.equal(repository.blob(head, registration.document).object, registration.expected.object);
        assert.equal(factHistory.verifyFactSectionRepairHistoryPreflight({
            base: registration.frontier, head, repository,
            evidence: { ...fixture.evidence, candidateCommit: head }
        }).qualification, false);
        for (const mode of ['100755', '120000'])
        {
            git(['update-index', '--cacheinfo', `${mode},${object},${registration.document}`]);
            const modeHead = git(['commit-tree', git(['write-tree']), '-p', registration.frontier,
                '-m', 'fix(governance): bind nonregular fixture']);
            assert.throws(() => repository.blob(modeHead, registration.document), /non-executable regular blob/u);
        }
        writeFileSync(join(temporary, '.git/shallow'), `${registration.anchor}\n`);
        assert.throws(() => factHistory.createFactSectionHistoryRepository(temporary), /shallow history/u);
    }
    finally
    {
        rmSync(temporary, { recursive: true, force: true });
    }
});

test('finite fact-section history preflight binds original two-event ancestry without conferring trust', () =>
{
    const schema = JSON.parse(readFileSync(resolve(root, 'config/schemas/fact-section-repair-history-preflight.schema.json'), 'utf8'));
    assert.equal(schema.$id, factHistory.factSectionRepairHistorySchema);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['schema', 'historyId', 'frontierCommit', 'candidateCommit']);
    const result = factHistory.verifyFactSectionRepairHistoryPreflight(finiteHistoryFixture());
    assert.equal(result.status, 'preflight-only');
    assert.equal(result.qualification, false);
    assert.equal(result.graphCount, 22);
    assert.match(result.requiredNextStage, /fresh current-source canonical execution/u);
});

for (const [label, change] of [
    ['unknown schema', (fixture) =>
    {
        fixture.evidence.schema = 'fsusblog.generated-output-binding.v1';
    }],
    ['unregistered history', (fixture) =>
    {
        fixture.evidence.historyId = 'arbitrary-history';
    }],
    ['candidate chooses head', (fixture) =>
    {
        fixture.evidence.candidateCommit = '0'.repeat(40);
    }],
    ['candidate chooses base', (fixture) =>
    {
        fixture.evidence.frontierCommit = '0'.repeat(40);
    }],
    ['future base without governed suffix', (fixture) =>
    {
        fixture.base = fixture.head;
    }],
    ['self-sealed receipt is not execution authority', (fixture) =>
    {
        fixture.evidence.receipt = { status: 'ok' };
    }],
    ['candidate supplied repository override', (fixture) =>
    {
        fixture.evidence.repository = {};
    }],
    ['candidate supplied producer override', (fixture) =>
    {
        fixture.evidence.command = 'node forged.mjs';
    }],
    ['candidate supplied qualification', (fixture) =>
    {
        fixture.evidence.qualification = true;
    }]
])
{
    test(`finite fact-section history rejects ${label}`, () =>
    {
        const fixture = finiteHistoryFixture();
        change(fixture);
        assert.throws(() => factHistory.verifyFactSectionRepairHistoryPreflight(fixture), /fact-section repair history/u);
    });
}

for (const [label, method, mutate] of [
    ['missing side-parent node', 'revisionsBetween', (value, args) => args[0] === factHistory.releaseFactSectionRepairHistory.anchor ? value.slice(1) : value],
    ['duplicated history node', 'revisionsBetween', (value, args) => args[0] === factHistory.releaseFactSectionRepairHistory.anchor ? [value[0], ...value.slice(0, -1)] : value],
    ['history reordering', 'revisionsBetween', (value, args) => args[0] === factHistory.releaseFactSectionRepairHistory.anchor ? value.toReversed() : value],
    ['swapped merge parent', 'commit', (value) => ({ ...value, parents: value.parents.toReversed() })],
    ['unreviewed generator epoch tree', 'commit', (value, args) => args[0] === '3943bbc95711fa968e85eb411ae67644f793242b' ? { ...value, tree: '0'.repeat(40) } : value],
    ['synthetic commit identity', 'commit', (value) => ({ ...value, commit: '0'.repeat(40) })],
    ['executable source mode', 'blob', (value) => ({ ...value, mode: '100755' })],
    ['symlink source mode', 'blob', (value) => ({ ...value, mode: '120000' })],
    ['bytes disagree with Git object', 'blob', (value) => ({ ...value, bytes: Buffer.concat([value.bytes, Buffer.from('forged')]) })],
    ['candidate mutates trusted policy', 'changedPaths', (value) => [...value, 'tools/governance/change-contract.mjs']],
    ['candidate mutates source', 'changedPaths', (value) => [...value, 'tools/test-matrix/required-evidence-catalog.mjs']],
    ['candidate edits unrelated prose document', 'changedPaths', (value) => [...value, 'docs/testing.md']],
    ['candidate adds unregistered naming metadata', 'changedPaths', (value) => [...value, 'artifacts/change-contract/unknown.json']],
    ['candidate omits the entire drift', 'changedPaths', () => []],
    ['repair document restored to stale bytes', 'blob', (value, args) => args[0] === 'b8f3cd2a999e9e6243109d07700c411c9c06c4ed' ? finiteHistoryFixture().repository.blob(factHistory.releaseFactSectionRepairHistory.frontier, args[1]) : value]
])
{
    test(`finite fact-section history rejects ${label}`, () =>
    {
        const fixture = finiteHistoryFixture();
        const original = fixture.repository[method];
        fixture.repository[method] = (...args) => mutate(original(...args), args);
        assert.throws(() => factHistory.verifyFactSectionRepairHistoryPreflight(fixture), /fact-section repair history/u);
    });
}

for (const [label, mutate] of [
    ['transient prose change reverted before head', (text) => `${text}\nTransient unrelated prose\n`],
    ['transient partial digest repair', (text) => text.replace(
        '68e30ca22be4f9d0d7a5ee1d7e26cb18a3740246a8f426865b7e59ad8783b79f',
        'de814266fc58064e3d824e5c298d9d3e1ba2c4ba8abeb420dfca9071b8e3fd03')],
    ['transient generated marker replacement', (text) => text.replace('release.aggregate-contract', 'release.forged-contract')]
])
{
    test(`finite fact-section history rejects ${label}`, () =>
    {
        const fixture = finiteHistoryFixture();
        const original = fixture.repository;
        const intermediate = 'e'.repeat(40);
        fixture.repository = {
            ...original,
            revisionsBetween: (base, head) => base === fixture.base ? [intermediate, head] : original.revisionsBetween(base, head),
            commit: (revision) => revision === intermediate
                ? { commit: revision, parents: [fixture.base], tree: 'e'.repeat(40) }
                : revision === fixture.head ? { ...original.commit(revision), parents: [intermediate] } : original.commit(revision),
            changedPaths: (base, head) => [base, head].includes(intermediate)
                ? [factHistory.releaseFactSectionRepairHistory.document] : original.changedPaths(base, head),
            blob: (revision, file) =>
            {
                if (revision !== intermediate)
                {
                    return original.blob(revision, file);
                }
                const source = original.blob(fixture.base, file);
                const bytes = Buffer.from(mutate(source.bytes.toString('utf8')));
                return { mode: source.mode, object: createHash('sha1')
                    .update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), bytes };
            }
        };
        assert.throws(() => factHistory.verifyFactSectionRepairHistoryPreflight(fixture), /intermediate prose, range or partial-drift mutation/u);
    });
}
