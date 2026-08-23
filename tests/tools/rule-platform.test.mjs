import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
    ComplexityViolations,
    DiscoverRules,
    ExemptionSchema,
    FileCategory,
    MeasureComplexity,
    ReadJson,
    RepositoryInventory,
    SelectAffectedRules,
    Sha256,
    ValidateExemptions,
    ValidateRegistry
} = await import(pathToFileURL(path.join(repositoryRoot, 'tools/governance/rule-platform.mjs')).href);

const policy = ReadJson(path.join(repositoryRoot, 'config/governance/complexity-policy.json'));
const registry = ReadJson(path.join(repositoryRoot, 'config/governance/custom-rule-registry.json'));

test('registry has exact existing custom-check inventory parity and complete metadata', () =>
{
    const inventory = new RepositoryInventory(repositoryRoot, policy.inventory.ignoredPaths);
    const discovered = DiscoverRules(repositoryRoot, policy, inventory);
    assert.deepEqual(ValidateRegistry(repositoryRoot, registry, discovered), []);
    assert.ok(registry.inventory.packageScriptCount > 0);
    assert.ok(registry.inventory.implementationCount > 200);
    assert.ok(registry.rules.some((rule) => rule.category === 'security-privacy'));
    assert.ok(registry.rules.some((rule) => rule.category === 'aeds-wire'));
    assert.ok(registry.rules.some((rule) => rule.category === 'product-governance'));
    assert.ok(registry.rules.every((rule) => rule.engine !== 'text' || rule.textRationale));
});

test('registry rejects duplicate IDs and missing owner, scope or fixture', () =>
{
    const discovered = DiscoverRules(repositoryRoot, policy);
    const broken = structuredClone(registry);
    broken.rules[0].owner = '';
    broken.rules[0].sourceScopes = [];
    broken.rules[0].testFixtures = ['tests/fixtures/governance/rule-platform/missing.txt'];
    broken.rules.push(structuredClone(broken.rules[1]));
    const errors = ValidateRegistry(repositoryRoot, broken, discovered);
    assert.ok(errors.some((entry) => entry.includes('missing owner')));
    assert.ok(errors.some((entry) => entry.includes('requires sourceScopes')));
    assert.ok(errors.some((entry) => entry.includes('fixture does not exist')));
    assert.ok(errors.some((entry) => entry.includes('duplicate rule ID')));
});

test('AST-backed inventory classification is stable across formatting and text debt is explicit', () =>
{
    const compact = 'export function Example(value) { if (value) { return value; } }';
    const allman = `export function Example(value)\n{\n    if (value)\n    {\n        return value;\n    }\n}`;
    const compactMetrics = MeasureComplexity('src/frontend/src/example.ts', compact);
    const allmanMetrics = MeasureComplexity('src/frontend/src/example.ts', allman);
    assert.equal(compactMetrics.cyclomaticComplexity, allmanMetrics.cyclomaticComplexity);
    assert.equal(compactMetrics.functionMethodCount, allmanMetrics.functionMethodCount);
    assert.ok(registry.rules.some((rule) => rule.engine === 'eslint'));
    assert.ok(registry.rules.filter((rule) => rule.engine === 'text').every((rule) => rule.textRationale.includes('Legacy domain rule')));
});

test('changed-file selection includes dependency closure and unsafe rules', () =>
{
    const rules = [
        { id: 'Dependency', changedFileSafe: true, sourceScopes: ['config/**'], dependencies: [] },
        { id: 'Affected', changedFileSafe: true, sourceScopes: ['src/**'], dependencies: ['Dependency'] },
        { id: 'Always', changedFileSafe: false, sourceScopes: ['docs/**'], dependencies: [] },
        { id: 'Skipped', changedFileSafe: true, sourceScopes: ['docs/**'], dependencies: [] }
    ];
    assert.deepEqual(SelectAffectedRules(rules, ['src/example.ts']).map((rule) => rule.id), ['Dependency', 'Affected', 'Always']);
});

test('shared inventory and content cache build and read each source once', (t) =>
{
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-rule-inventory-cache-'));
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: temporaryRoot });
    const firstFile = 'first-source.mjs';
    const secondFile = 'second-source.mjs';
    const initialContent = 'export const state = \"initial\";\n';
    const changedContent = 'export const state = \"changed\";\n';
    const secondContent = 'export const state = \"second\";\n';
    fs.writeFileSync(path.join(temporaryRoot, firstFile), initialContent);
    fs.writeFileSync(path.join(temporaryRoot, secondFile), secondContent);
    execFileSync('git', ['add', '--', firstFile, secondFile], { cwd: temporaryRoot });

    const inventory = new RepositoryInventory(temporaryRoot);
    const files = inventory.Files();
    assert.equal(inventory.Files(), files);
    assert.deepEqual(files, [firstFile, secondFile]);
    const firstRead = inventory.Read(firstFile);
    assert.equal(firstRead, initialContent);
    fs.writeFileSync(path.join(temporaryRoot, firstFile), changedContent);
    assert.equal(fs.readFileSync(path.join(temporaryRoot, firstFile), 'utf8'), changedContent);
    const secondRead = inventory.Read(firstFile);
    assert.equal(secondRead, firstRead);
    assert.equal(inventory.stats.inventoryBuilds, 1);
    assert.equal(inventory.stats.contentReads, 1);
    assert.equal(inventory.stats.contentCacheHits, 1);
    assert.equal(inventory.Read(secondFile), secondContent);
    assert.equal(inventory.stats.contentReads, 2);
    assert.equal(inventory.stats.contentCacheHits, 1);
});

test('repository inventory excludes tracked files deleted from the current worktree', () =>
{
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-rule-inventory-delete-'));
    try
    {
        execFileSync('git', ['init', '-q'], { cwd: temporaryRoot });
        fs.writeFileSync(path.join(temporaryRoot, 'retired-check.mjs'), 'export default true;\n');
        execFileSync('git', ['add', 'retired-check.mjs'], { cwd: temporaryRoot });
        fs.rmSync(path.join(temporaryRoot, 'retired-check.mjs'));

        const inventory = new RepositoryInventory(temporaryRoot);

        assert.deepEqual(inventory.Files(), []);
    }
    finally
    {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('complexity policies use distinct repository categories and complete metrics', () =>
{
    assert.equal(FileCategory('src/backend/Modules/Endpoints/Binary/Example.cs'), 'EndpointComposition');
    assert.equal(FileCategory('src/backend/Services/Example.cs'), 'ServiceDomainLogic');
    assert.equal(FileCategory('src/core/Algorithms/Example.cs'), 'CodecProtocol');
    assert.equal(FileCategory('src/frontend/src/views/Example.vue'), 'VueViewComponent');
    assert.equal(FileCategory('tools/test/example.mjs'), 'BuildTestOrchestrator');
    assert.equal(FileCategory('config/example-registry.json'), 'ManifestRegistry');
    const metrics = MeasureComplexity('src/backend/Services/Example.cs', 'public class Example { public void Run() { if (true) { } } }');
    for (const id of policy.metrics.map((entry) => entry.id))
    {
        assert.ok(Object.hasOwn(metrics, id), `missing metric ${id}`);
    }
    assert.notEqual(policy.categories.EndpointComposition.growthAllowancePercent, policy.categories.BuildTestOrchestrator.growthAllowancePercent);
    assert.equal(policy.complexityEngine.engine, 'text');
    assert.match(policy.complexityEngine.reason, /compiler.*AST.*authoritative/iu);
});

test('complexity type count excludes inline type-only imports', () =>
{
    const metrics = MeasureComplexity(
        'src/frontend/src/example.ts',
        [
            "import { createThing, type Thing, type ThingOptions } from './thing';",
            "import type { OtherThing } from './other';",
            'export interface ExampleContract {}',
            'export type ExampleIdentity = string;',
            'export class Example {}'
        ].join('\n')
    );
    assert.equal(metrics.typeCount, 3);
});

test('new or significantly growing excess fails while legacy excess remains observe-only', () =>
{
    const sample = MeasureComplexity('src/backend/Services/Example.cs', 'public class Example { }');
    sample.fileLines = 500;
    const baseline = {
        categoryStatistics: { ServiceDomainLogic: { budgets: { fileLines: 100 } } },
        files: { 'src/backend/Services/Legacy.cs': { ...sample, fileLines: 500 } }
    };
    const metricPolicy = {
        metrics: [{ id: 'fileLines', hardGate: true, minimumBudget: 100 }],
        categories: { ServiceDomainLogic: { growthAllowancePercent: 10 } }
    };
    assert.equal(ComplexityViolations(metricPolicy, baseline, { 'src/backend/Services/Legacy.cs': sample }, { exemptions: [] }, ['src/backend/Services/Legacy.cs']).length, 0);
    assert.equal(ComplexityViolations(metricPolicy, baseline, { 'src/backend/Services/New.cs': sample }, { exemptions: [] }, ['src/backend/Services/New.cs']).length, 1);
});

test('complexity exemptions require owner, reason, review, expiry and a current source fingerprint', () =>
{
    const file = 'src/backend/Services/Example.cs';
    const metrics = { [file]: MeasureComplexity(file, 'public class Example { }') };
    const currentFingerprint = `sha256:${Sha256(JSON.stringify(metrics[file]))}`;
    const valid = {
        schema: ExemptionSchema,
        exemptions: [{
            file,
            owner: 'BackendOwner',
            reason: 'Temporary decomposition boundary',
            expires: '2099-01-01',
            reviewIssue: 'https://github.com/Ozwasyd/FsusBlog/issues/1162',
            sourceFingerprint: currentFingerprint
        }]
    };
    assert.deepEqual(ValidateExemptions(repositoryRoot, valid, metrics, new Date('2026-07-19T00:00:00Z')), []);
    valid.exemptions[0].expires = '2020-01-01';
    valid.exemptions[0].sourceFingerprint = 'sha256:stale';
    const errors = ValidateExemptions(repositoryRoot, valid, metrics, new Date('2026-07-19T00:00:00Z'));
    assert.ok(errors.some((entry) => entry.includes('expired')));
    assert.ok(errors.some((entry) => entry.includes('stale')));
});

test('failed runs persist a machine-readable partial summary', () =>
{
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-rule-platform-'));
    try
    {
        execFileSync('git', ['init', '-q'], { cwd: temporaryRoot });
        fs.mkdirSync(path.join(temporaryRoot, 'tools/governance'), { recursive: true });
        fs.mkdirSync(path.join(temporaryRoot, 'config/governance'), { recursive: true });
        fs.copyFileSync(path.join(repositoryRoot, 'tools/governance/rule-platform.mjs'), path.join(temporaryRoot, 'tools/governance/rule-platform.mjs'));
        fs.copyFileSync(path.join(repositoryRoot, 'tools/governance/check-rule-platform.mjs'), path.join(temporaryRoot, 'tools/governance/check-rule-platform.mjs'));
        fs.writeFileSync(path.join(temporaryRoot, 'config/governance/complexity-policy.json'), '{ invalid');
        const result = spawnSync(process.execPath, ['tools/governance/check-rule-platform.mjs', '--mode', 'full'], {
            cwd: temporaryRoot,
            encoding: 'utf8'
        });
        assert.notEqual(result.status, 0);
        const summary = JSON.parse(fs.readFileSync(path.join(temporaryRoot, '.tmp/governance/rule-platform-summary.json'), 'utf8'));
        assert.equal(summary.status, 'failed');
        assert.ok(summary.violations.some((entry) => entry.rule === 'Governance.PlatformRuntime'));
    }
    finally
    {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});
