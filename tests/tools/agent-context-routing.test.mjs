import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skillPath = '.agents/skills/fsusblog-design-conformance';
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const manifest = JSON.parse(read('config/development/authoritative-development-docs.json'));
const symbolIds = new Set([
    'banned-user-middleware', 'binary-frame-result', 'binary-preencoded-frame-result',
    'pod-binary-codec', 'aeds-frame-buffer-writer', 'binary-results-frame'
]);

test('implementation symbols belong to current architecture rather than the agent entry', () =>
{
    const symbols = manifest.symbols.filter((entry) => symbolIds.has(entry.id));
    assert.equal(symbols.length, symbolIds.size);
    for (const symbol of symbols)
    {
        assert.deepEqual(symbol.documents, ['docs/architecture.md']);
        assert.ok(read(symbol.source).includes(symbol.sourceToken));
        assert.ok(read('docs/architecture.md').includes(symbol.documentToken));
        assert.ok(!read('AGENTS.md').includes(symbol.documentToken));
    }
    const lifecycle = JSON.parse(read('config/development/document-lifecycle.json'));
    assert.equal(lifecycle.documents.find((entry) => entry.path === 'docs/architecture.md').status, 'current');
});

test('all six migrated symbol bindings still reject missing architecture documentation', (t) =>
{
    const overlay = mkdtempSync(path.join(tmpdir(), 'fsusblog-agent-docs-'));
    t.after(() => rmSync(overlay, { recursive: true, force: true }));
    mkdirSync(path.join(overlay, 'docs'));
    const architecture = read('docs/architecture.md');
    for (const symbol of manifest.symbols.filter((entry) => symbolIds.has(entry.id)))
    {
        writeFileSync(path.join(overlay, 'docs/architecture.md'), architecture.replaceAll(symbol.documentToken, 'RemovedForNegativeControl'));
        const result = spawnSync(process.execPath, ['tools/docs/check-authoritative-development-docs.mjs', '--overlay', overlay], {
            cwd: root, encoding: 'utf8', timeout: 15000
        });
        assert.notEqual(result.status, 0, symbol.id);
        assert.ok(`${result.stdout}\n${result.stderr}`.includes(symbol.documentToken), symbol.id);
    }
});

test('entry documents route tasks without prescribing concrete model profiles or a full reading stack', () =>
{
    const agents = read('AGENTS.md');
    const skill = read(`${skillPath}/SKILL.md`);
    assert.doesNotMatch(agents + skill, /gpt-[0-9]|Sol\/(?:low|medium|high)|Luna\//u);
    assert.ok(!skill.includes('Read, in order:'));
    assert.match(skill, /Excludes backend-only and non-visual runtime work/u);
    for (const name of ['design-change', 'rendered-review', 'orchestrated-ui', 'baseline-resolution', 'execution-policy'])
    {
        assert.ok(skill.includes(`references/${name}.md`), name);
    }
    assert.ok(agents.includes('task scope'));
    assert.ok(agents.includes('no production access'));
    assert.ok(agents.includes('do not by themselves authorize a merge'));
});

test('every local Skill and reference link resolves to its actual source', () =>
{
    const paths = [
        `${skillPath}/SKILL.md`,
        ...readdirSync(path.join(root, skillPath, 'references')).filter((entry) => entry.endsWith('.md')).map((entry) => `${skillPath}/references/${entry}`)
    ];
    for (const relative of paths)
    {
        for (const match of read(relative).matchAll(/\[[^\]]*\]\(([^)]+)\)/gu))
        {
            const target = match[1].split('#')[0];
            if (!target || /^[a-z]+:/iu.test(target))
            {
                continue;
            }
            assert.ok(existsSync(path.resolve(root, path.dirname(relative), target)), `${relative}: ${target}`);
        }
    }
});

test('governance separates editorial tooling review and observable implementation completion', () =>
{
    const governance = read('docs/design/governance.md');
    for (const term of [
        '## Task routing', 'Editorial-only', 'Semantic design-document', 'scheduler-policy',
        'Read-only rendered review', 'Observable UI implementation', 'Backend-only',
        'A mixed task retains the stronger requirements', 'Shared orchestration authority is external'
    ])
    {
        assert.ok(governance.includes(term), term);
    }
    assert.ok(read('docs/security.md').includes('notification stream'));
    assert.ok(read(`${skillPath}/references/rendered-review.md`).includes('self-tests are not application render evidence'));
});

test('new routing and policy regressions are registered with the existing governance runner', () =>
{
    const registry = JSON.parse(read('tests/governance/test-lifecycle-registry.json'));
    for (const name of ['agent-context-routing', 'blog-ui-orchestration'])
    {
        const entries = registry.nodeTests.filter((entry) => entry.file === `tests/tools/${name}.test.mjs`);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].physicalExecutionCount, 1);
        assert.equal(entries[0].staticGovernance.id, name);
        assert.ok(read('tests/matrix.yml').includes(entries[0].file));
        assert.ok(read('docs/testing.generated.md').includes(entries[0].file));
    }
});

test('testing documentation remains bound to its ordinary canonical producer', () =>
{
    const binding = JSON.parse(read('artifacts/change-contract/agent-context-generated-binding.json'));
    assert.equal(binding.schema, 'fsusblog.generated-output-binding.v1');
    assert.ok(binding.sources.includes('tests/matrix.yml'));
    const output = binding.outputs.find((entry) => entry.path === 'docs/testing.generated.md');
    assert.ok(output);
    const digest = createHash('sha256')
        .update(read('docs/testing.generated.md'))
        .digest('hex');
    assert.equal(output.sha256, digest);
});
