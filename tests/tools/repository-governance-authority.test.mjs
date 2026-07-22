import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
    createGovernanceReceipt,
    loadAuthorityManifest,
    main,
    validateAuthorityManifest,
    verifyGovernanceReceipt
} = await import(pathToFileURL(path.join(
    repositoryRoot,
    'tools/governance/repository-governance-authority.mjs'
)).href);
const authorityIds = [
    'application-static-governance',
    'test-asset-governance',
    'workflow-lint',
    'document-governance',
    'community-governance'
];

function runGit(root, args)
{
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function write(root, relativePath, content)
{
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-governance-authority-'));
    write(root, '.gitignore', '.cache/\n');
    const authorities = authorityIds.map((id, index) =>
    {
        const slug = `authority-${index}`;
        write(root, `inputs/${slug}.txt`, `${id}-input\n`);
        write(root, `checkers/${slug}.mjs`, `console.log(${JSON.stringify(`${id} ok`)})\n`);
        write(root, `toolchains/${slug}.json`, `${JSON.stringify({ parser: index + 1 })}\n`);
        return {
            id,
            canonicalOwner: `owner:${slug}`,
            inputs: [`inputs/${slug}.txt`, `checkers/${slug}.mjs`, `toolchains/${slug}.json`],
            toolchain: {
                runtimes: ['git', 'node'],
                parsers: [`fixture-parser:${index + 1}`],
                identityFiles: [`toolchains/${slug}.json`]
            },
            commands: [{
                id: `command:${slug}`,
                argv: ['node', `checkers/${slug}.mjs`],
                checkerSources: [`checkers/${slug}.mjs`],
                ruleIds: [`rule:${slug}`]
            }]
        };
    });
    const manifest = {
        schema: 'fsusblog.repository-governance-authorities.v1',
        expirationPolicy: 'content-identity-only-no-ttl',
        authorities
    };
    write(root, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    runGit(root, ['init', '-q']);
    runGit(root, ['config', 'user.email', 'governance@example.invalid']);
    runGit(root, ['config', 'user.name', 'Governance Fixture']);
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-qm', 'fixture']);
    return { root, manifest };
}

test('authority manifest has five exclusive canonical owners and complete identities', () =>
{
    const manifest = loadAuthorityManifest(repositoryRoot);
    assert.deepEqual(manifest.authorities.map((authority) => authority.id), authorityIds);
    assert.equal(manifest.expirationPolicy, 'content-identity-only-no-ttl');
    assert.deepEqual(validateAuthorityManifest(manifest), []);
    for (const authority of manifest.authorities)
    {
        assert.ok(authority.canonicalOwner);
        assert.ok(authority.inputs.length > 0);
        assert.ok(authority.commands.every((command) =>
            command.argv.length > 0 && command.checkerSources.length > 0 && command.ruleIds.length > 0));
        assert.ok(authority.toolchain.runtimes.length > 0);
        assert.ok(authority.toolchain.parsers.length > 0);
        assert.ok(authority.toolchain.identityFiles.length > 0);
    }
});

test('manifest rejects checker and rule ownership shared across authorities', () =>
{
    const { manifest } = fixture();
    manifest.authorities[1].commands[0].checkerSources = manifest.authorities[0].commands[0].checkerSources;
    manifest.authorities[2].commands[0].ruleIds = manifest.authorities[0].commands[0].ruleIds;
    const errors = validateAuthorityManifest(manifest);
    assert.ok(errors.some((error) => error.includes('checker is owned by both')));
    assert.ok(errors.some((error) => error.includes('rule/test ID is owned by both')));
});

test('receipt seals source, complete inputs, checker, toolchain, rules and output content', async (context) =>
{
    const { root, manifest } = fixture();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const receipt = await createGovernanceReceipt({
        root,
        manifest,
        authorityId: 'workflow-lint',
        write: false
    });
    assert.match(receipt.sourceState.commit, /^[0-9a-f]{40}$/u);
    assert.match(receipt.sourceState.worktreeFingerprint, /^[0-9a-f]{64}$/u);
    assert.match(receipt.inputs.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.match(receipt.checkers.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.match(receipt.toolchain.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(receipt.ruleIds, ['rule:authority-2']);
    assert.match(receipt.outputContentDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.match(receipt.contentDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(Object.hasOwn(receipt, 'generatedAt'), false);
    assert.equal(Object.hasOwn(receipt, 'expiresAt'), false);
    assert.equal(Object.hasOwn(receipt, 'ttl'), false);
    assert.equal((await verifyGovernanceReceipt({
        root,
        manifest,
        authorityId: 'workflow-lint',
        receipt
    })).valid, true);
});

test('input-only change invalidates an otherwise internally consistent receipt', async (context) =>
{
    const { root, manifest } = fixture();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const receipt = await createGovernanceReceipt({ root, manifest, authorityId: 'test-asset-governance', write: false });
    write(root, 'inputs/authority-1.txt', 'changed test asset\n');
    const result = await verifyGovernanceReceipt({ root, manifest, authorityId: 'test-asset-governance', receipt });
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes('input tree digest mismatch'));
});

test('checker-source change invalidates checker identity even when receipt bytes are untouched', async (context) =>
{
    const { root, manifest } = fixture();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const receipt = await createGovernanceReceipt({ root, manifest, authorityId: 'community-governance', write: false });
    write(root, 'checkers/authority-4.mjs', 'console.log("changed checker")\n');
    const result = await verifyGovernanceReceipt({ root, manifest, authorityId: 'community-governance', receipt });
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes('checker source digest mismatch'));
});

test('parser and toolchain identity change invalidates reuse', async (context) =>
{
    const { root, manifest } = fixture();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const receipt = await createGovernanceReceipt({ root, manifest, authorityId: 'document-governance', write: false });
    write(root, 'toolchains/authority-3.json', '{"parser":99}\n');
    const result = await verifyGovernanceReceipt({ root, manifest, authorityId: 'document-governance', receipt });
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes('parser/toolchain identity mismatch'));
});

test('tampered rule IDs or command-output digests cannot be repaired by retaining the old outer digest', async (context) =>
{
    const { root, manifest } = fixture();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const original = await createGovernanceReceipt({ root, manifest, authorityId: 'application-static-governance', write: false });
    const ruleTamper = structuredClone(original);
    ruleTamper.ruleIds = ['rule:forged'];
    const ruleResult = await verifyGovernanceReceipt({ root, manifest, authorityId: 'application-static-governance', receipt: ruleTamper });
    assert.ok(ruleResult.errors.includes('rule/test IDs mismatch'));
    assert.ok(ruleResult.errors.includes('receipt content digest mismatch'));

    const outputTamper = structuredClone(original);
    outputTamper.outputs[0].stdoutDigest = `sha256:${'0'.repeat(64)}`;
    const outputResult = await verifyGovernanceReceipt({ root, manifest, authorityId: 'application-static-governance', receipt: outputTamper });
    assert.ok(outputResult.errors.includes('output content digest mismatch'));
    assert.ok(outputResult.errors.includes('receipt content digest mismatch'));
});

test('receipt validation has no wall-clock age path but remains source/worktree exact', async (context) =>
{
    const { root } = fixture();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await main(['run', 'workflow-lint', '--manifest', 'manifest.json'], { root });
    const current = path.join(root, '.cache/repository-governance/workflow-lint/current.json');
    const old = new Date('2000-01-01T00:00:00.000Z');
    fs.utimesSync(current, old, old);
    await main(['verify', 'workflow-lint', '--manifest', 'manifest.json'], { root });

    write(root, 'unrelated.txt', 'dirty worktree\n');
    await assert.rejects(
        main(['verify', 'workflow-lint', '--manifest', 'manifest.json'], { root }),
        /source worktree fingerprint mismatch/u
    );
});

test('ensure reuses test-asset receipt until an exact declared input changes', async (context) =>
{
    const { root } = fixture();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    write(root, 'checkers/authority-1.mjs', [
        "import fs from 'node:fs'",
        "fs.mkdirSync('.cache', { recursive: true })",
        "fs.appendFileSync('.cache/test-asset-executions.log', 'run\\n')"
    ].join('\n'));
    runGit(root, ['add', 'checkers/authority-1.mjs']);
    runGit(root, ['commit', '-qm', 'count checker executions']);

    await main(['ensure', 'test-asset-governance', '--manifest', 'manifest.json'], { root });
    await main(['ensure', 'test-asset-governance', '--manifest', 'manifest.json'], { root });
    const executionLog = path.join(root, '.cache/test-asset-executions.log');
    assert.equal(fs.readFileSync(executionLog, 'utf8'), 'run\n');

    write(root, 'inputs/authority-1.txt', 'changed test asset input\n');
    await main(['ensure', 'test-asset-governance', '--manifest', 'manifest.json'], { root });
    assert.equal(fs.readFileSync(executionLog, 'utf8'), 'run\nrun\n');
});

test('Production and release-final topology consume authorities without rerunning repository-only checkers', () =>
{
    const bundle = fs.readFileSync(path.join(repositoryRoot, 'tools/test/bundles/run-bundle.mjs'), 'utf8');
    const releaseFinal = fs.readFileSync(path.join(repositoryRoot, 'tools/test/lanes/release-final.sh'), 'utf8');
    const staticLane = fs.readFileSync(path.join(repositoryRoot, 'tools/test/lanes/static-governance.sh'), 'utf8');
    const frontendStart = bundle.indexOf('async function runFrontendTests()');
    const frontendEnd = bundle.indexOf('\nasync function ', frontendStart + 1);
    const productionFrontend = bundle.slice(frontendStart, frontendEnd < 0 ? bundle.length : frontendEnd);

    assert.match(productionFrontend, /run application-static-governance/u);
    assert.match(productionFrontend, /ensure test-asset-governance/u);
    assert.doesNotMatch(productionFrontend, /check-community-workflow|check-authoritative-development-docs|check-workflow-matrix-sync/u);
    assert.doesNotMatch(productionFrontend, /static-governance\.sh post-vitest/u);
    assert.doesNotMatch(staticLane, /StaticCsharpStyle\(\)[\s\S]*--mode changed[\s\S]*--mode full/u);
    for (const authorityId of authorityIds)
    {
        assert.match(releaseFinal, new RegExp(`\\b${authorityId}\\b[\\s\\S]*repository-governance-authority\\.mjs[^\\n]*verify`, 'u'));
    }
    assert.doesNotMatch(releaseFinal, /repository-governance-authority\.mjs" run|repository-governance-authority\.mjs" ensure/u);
});
