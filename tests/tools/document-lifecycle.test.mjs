import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { behaviorTest } from '../../tools/contracts/behavior-test.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
    BuildDocumentInventory,
    DocumentLifecycleSchema,
    ReadDocumentLifecyclePolicy,
    RenderDocumentIndex,
    ValidateDocumentLifecycle,
    WriteDocumentLifecycle
} = await import(pathToFileURL(path.join(root, 'tools/docs/document-lifecycle.mjs')).href);

function Write(rootDirectory, relative, content)
{
    const target = path.join(rootDirectory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

function Fixture(t)
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-document-lifecycle-'));
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    Write(fixtureRoot, 'docs/index.md', '# Documentation Index\n');
    Write(fixtureRoot, 'docs/current.md', '# Current\n\n```text\ncurrent\n```\n');
    Write(fixtureRoot, 'docs/development/document-lifecycle.md', '# Documentation Lifecycle\n');
    Write(fixtureRoot, 'docs/history/retired-migration-record.md', '# Historical\n');
    Write(fixtureRoot, 'docs/generated.md', '# Generated\n');
    Write(fixtureRoot, 'tools/generate.mjs', 'export {};\n');
    const policy = {
        schema: DocumentLifecycleSchema,
        lastVerifiedCommit: 'a'.repeat(40),
        maximumVerificationDistance: 100,
        documents: [
            'docs/index.md',
            'docs/current.md',
            'docs/development/document-lifecycle.md'
        ].map((documentPath) => ({
            path: documentPath,
            status: 'current',
            owner: 'governance',
            relatedIssues: [],
            supersedes: [],
            supersededBy: null
        })).concat([
            {
                path: 'docs/history/retired-migration-record.md',
                status: 'historical',
                owner: 'governance',
                relatedIssues: [1042],
                supersedes: [],
                supersededBy: null
            },
            {
                path: 'docs/generated.md',
                status: 'generated',
                owner: 'governance',
                relatedIssues: [],
                supersedes: [],
                supersededBy: null,
                producer: 'tools/generate.mjs'
            }
        ]),
        legacyNamingCompatibility: [],
        authorityClaims: [{ id: 'current', path: 'docs/current.md' }],
        retiredReferences: [{ token: 'RetiredSymbol' }],
        brokenLinkExceptions: [],
        pathMigrations: []
    };
    Write(fixtureRoot, 'config/development/document-lifecycle.json', `${JSON.stringify(policy, null, 4)}\n`);
    WriteDocumentLifecycle(fixtureRoot, policy);
    return { fixtureRoot, policy };
}

function Validate(fixtureRoot, policy)
{
    const inventory = BuildDocumentInventory(fixtureRoot, policy);
    return ValidateDocumentLifecycle(fixtureRoot, policy, inventory, RenderDocumentIndex(inventory), { validateGit: false });
}

behaviorTest('document-lifecycle-governance', 'positive', 'repository document lifecycle inventory and generated index are current', () =>
{
    const policy = ReadDocumentLifecyclePolicy(root);
    const inventory = BuildDocumentInventory(root, policy);
    assert.equal(ValidateDocumentLifecycle(root, policy, inventory, RenderDocumentIndex(inventory)).length, 0);
    assert.ok(inventory.documents.length >= 300);
    assert.ok(inventory.documents.every((document) => document.owner && document.status && document.lastVerifiedCommit));
    assert.equal(policy.closedIssues, undefined);
    assert.equal(policy.statusRules, undefined);
});

test('explicit issue metadata does not derive authority from a filename and generated documents require a live producer', (t) =>
{
    const { fixtureRoot, policy } = Fixture(t);
    const historical = policy.documents.find((document) => document.path === 'docs/history/retired-migration-record.md');
    assert.deepEqual(historical.relatedIssues, [1042]);
    assert.equal(BuildDocumentInventory(fixtureRoot, policy).documents
        .find((document) => document.path === historical.path).status, 'historical');

    const missingProducer = structuredClone(policy);
    missingProducer.documents.find((document) => document.path === 'docs/generated.md').producer = 'tools/missing.mjs';
    WriteDocumentLifecycle(fixtureRoot, missingProducer);
    assert.ok(Validate(fixtureRoot, missingProducer).some((error) => error.includes('generated producer does not exist')));
});

behaviorTest('document-lifecycle-governance', 'negative', {
    title: 'duplicate authority, retired references and broken internal links fail closed',
    invariantIds: ['document-lifecycle-fail-closed']
}, (t) =>
{
    const { fixtureRoot, policy } = Fixture(t);
    const duplicate = structuredClone(policy);
    duplicate.authorityClaims.push({ id: 'current', path: 'docs/index.md' });
    WriteDocumentLifecycle(fixtureRoot, duplicate);
    assert.ok(Validate(fixtureRoot, duplicate).some((error) => error.includes('duplicate source-of-truth authority ID')));

    Write(fixtureRoot, 'docs/current.md', '# Current\n\nRetiredSymbol\n\n[missing](missing.md)\n');
    const errors = Validate(fixtureRoot, policy);
    assert.ok(errors.some((error) => error.includes('retired reference RetiredSymbol')));
    assert.ok(errors.some((error) => error.includes('missing internal link missing.md')));
});

behaviorTest('document-lifecycle-governance', 'migration', {
    title: 'path migration registry records removed sources without claiming runtime redirects',
    invariantIds: ['document-path-migration-registry']
}, (t) =>
{
    const { fixtureRoot, policy } = Fixture(t);
    const valid = structuredClone(policy);
    valid.pathMigrations = [{ from: 'docs/old.md', to: 'docs/current.md' }];
    WriteDocumentLifecycle(fixtureRoot, valid);
    assert.deepEqual(Validate(fixtureRoot, valid), []);

    const invalid = structuredClone(policy);
    invalid.pathMigrations = [
        { from: 'docs/current.md', to: 'docs/generated.md' },
        { from: 'docs/missing.md', to: 'docs/also-missing.md' }
    ];
    WriteDocumentLifecycle(fixtureRoot, invalid);
    const errors = Validate(fixtureRoot, invalid);
    assert.equal(errors.filter((error) => error.includes('invalid document path migration')).length, 2);
});

test('semantic document names pass while issue, PR and implementation-stage identities fail closed', (t) =>
{
    const { fixtureRoot, policy } = Fixture(t);
    Write(fixtureRoot, 'docs/testing/browser-correctness-topology.md', '# Browser Correctness Topology\n');
    policy.documents.push({
        path: 'docs/testing/browser-correctness-topology.md',
        status: 'current',
        owner: 'release',
        relatedIssues: [1427],
        supersedes: [],
        supersededBy: null
    });
    WriteDocumentLifecycle(fixtureRoot, policy);
    assert.deepEqual(Validate(fixtureRoot, policy), []);

    for (const offending of [
        'docs/issue-1234-new.md',
        'docs/testing/pr-88-report.md',
        'docs/testing/runtime-handoff.md',
        'docs/testing/release-final.md'
    ])
    {
        const candidate = structuredClone(policy);
        Write(fixtureRoot, offending, '# Invalid Long-Term Identity\n');
        candidate.documents.push({
            path: offending,
            status: 'current',
            owner: 'governance',
            relatedIssues: [],
            supersedes: [],
            supersededBy: null
        });
        WriteDocumentLifecycle(fixtureRoot, candidate);
        assert.ok(Validate(fixtureRoot, candidate).some((error) => error.includes('forbidden long-term name')), offending);
        fs.rmSync(path.join(fixtureRoot, offending));
    }
});

test('supersession metadata is reciprocal, acyclic and references live documents', (t) =>
{
    const { fixtureRoot, policy } = Fixture(t);
    Write(fixtureRoot, 'docs/history/old-contract.md', '# Old Contract\n');
    const current = policy.documents.find((document) => document.path === 'docs/current.md');
    current.supersedes = ['docs/history/old-contract.md'];
    policy.documents.push({
        path: 'docs/history/old-contract.md',
        status: 'historical',
        owner: 'governance',
        relatedIssues: [1427],
        supersedes: [],
        supersededBy: 'docs/current.md'
    });
    WriteDocumentLifecycle(fixtureRoot, policy);
    assert.deepEqual(Validate(fixtureRoot, policy), []);

    const missing = structuredClone(policy);
    missing.documents.find((document) => document.path === 'docs/current.md').supersedes = ['docs/history/missing.md'];
    WriteDocumentLifecycle(fixtureRoot, missing);
    assert.ok(Validate(fixtureRoot, missing).some((error) => error.includes('supersedes missing target')));

    const cycle = structuredClone(policy);
    cycle.documents.find((document) => document.path === 'docs/current.md').supersededBy = 'docs/history/old-contract.md';
    cycle.documents.find((document) => document.path === 'docs/history/old-contract.md').supersedes = ['docs/current.md'];
    WriteDocumentLifecycle(fixtureRoot, cycle);
    assert.ok(Validate(fixtureRoot, cycle).some((error) => error.includes('supersession cycle')));
});

test('historical assets are aggregated by topic instead of flooding the main index', (t) =>
{
    const { fixtureRoot, policy } = Fixture(t);
    Write(fixtureRoot, 'docs/history/screenshots/public-home.png', 'png');
    policy.documents.push({
        path: 'docs/history/screenshots/public-home.png',
        status: 'historical',
        owner: 'frontend',
        relatedIssues: [1427],
        supersedes: [],
        supersededBy: null
    });
    const inventory = WriteDocumentLifecycle(fixtureRoot, policy);
    const index = RenderDocumentIndex(inventory);
    assert.match(index, /`history\/screenshots`: 1 asset/u);
    assert.doesNotMatch(index, /public-home\.png/u);
    assert.deepEqual(Validate(fixtureRoot, policy), []);
});
