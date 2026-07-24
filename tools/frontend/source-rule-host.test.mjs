import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    buildFrontendStaticOwnerRegistry,
    validateFrontendStaticOwnerRegistry
} from './frontend-static-owner-registry.mjs';
import { fontSizeContractRule } from './rules/font-size-contract.mjs';
import { fontWeightContractRule } from './rules/font-weight-contract.mjs';
import {
    buildFrontendSourceIndex,
    validateFrontendSourceIndex
} from './source-index.mjs';
import {
    executeSourceRules,
    validateRuleHostEvidence
} from './source-rule-host.mjs';

const repositoryRoot = join(fileURLToPath(new URL('../..', import.meta.url)));

async function withFixture(callback)
{
    const root = mkdtempSync(join(tmpdir(), 'fsusblog-source-index-'));
    try
    {
        mkdirSync(join(root, 'src/frontend/src/components'), { recursive: true });
        mkdirSync(join(root, 'src/frontend/public'), { recursive: true });
        mkdirSync(join(root, 'docs/design'), { recursive: true });
        writeFileSync(join(root, 'src/frontend/package.json'), `${JSON.stringify({
            scripts: {
                'check:font-size-contract': 'node size.mjs',
                'check:font-weight-contract': 'node weight.mjs',
                'check:writer': 'node writer.mjs'
            }
        })}\n`);
        writeFileSync(join(root, 'src/frontend/src/components/Card.vue'), `<script setup lang="ts">
import Badge from './Badge.vue'
const route = '/articles'
</script>
<template><section class="card primary" aria-label="Article card">Read more</section></template>
<style scoped>
.card { color: var(--fsus-color-text); font-size: 14px; font-weight: 500; }
</style>
`);
        writeFileSync(join(root, 'src/frontend/src/model.ts'), `import type { Ref } from 'vue'
export const value: Ref<string> | null = null
`);
        writeFileSync(join(root, 'src/frontend/public/public-shell-emergency.css'), '.shell { font-size: 14px; }\n');
        writeFileSync(join(root, 'docs/design/reading-typography.md'), '# Typography\n');
        return await callback(root);
    }
    finally
    {
        rmSync(root, { recursive: true, force: true });
    }
}

test('canonical index inventories and parses each source once with source spans and identity', async () =>
{
    await withFixture((root) =>
    {
        const index = buildFrontendSourceIndex({
            repoRoot: root,
            parserRoot: repositoryRoot,
            runId: 'source-index-test',
            commit: '0123456789abcdef0123456789abcdef01234567',
            worktreeFingerprint: 'fixture-worktree'
        });
        assert.deepEqual(validateFrontendSourceIndex(index), []);
        assert.equal(index.metrics.inventoryCount, index.metrics.readCount);
        assert.equal(index.metrics.inventoryCount, index.metrics.primaryParseCount);
        assert.ok(index.metrics.inventoryCount >= 4);

        const card = index.files.find(({ path }) => path.endsWith('Card.vue'));
        assert.ok(card);
        assert.match(card.contentDigest, /^[a-f0-9]{64}$/u);
        assert.deepEqual(card.vue.blocks.map(({ type }) => type), ['script', 'template', 'style']);
        assert.deepEqual(card.typescript.imports.map(({ specifier }) => specifier), ['./Badge.vue']);
        assert.ok(card.template.classes.some(({ value }) => value === 'card'));
        assert.ok(card.template.aria.some(({ name, value }) => name === 'aria-label' && value === 'Article card'));
        assert.ok(card.template.text.some(({ value }) => value === 'Read more'));
        assert.ok(card.template.routes.some(({ value }) => value === '/articles'));
        assert.ok(card.template.components.some(({ value }) => value === 'Badge'));
        assert.ok(card.css.declarations.some(({ property, value }) => property === 'font-size' && value === '14px'));
        assert.ok(card.css.tokens.some(({ value }) => value === '--fsus-color-text'));
        assert.ok(card.css.declarations.every(({ span }) => span.line >= 1 && span.column >= 1));
    });
});

test('any Vue, TypeScript, or CSS input mutation invalidates the source digest', async () =>
{
    await withFixture((root) =>
    {
        const options = {
            repoRoot: root,
            parserRoot: repositoryRoot,
            runId: 'source-index-mutation',
            commit: '0123456789abcdef0123456789abcdef01234567',
            worktreeFingerprint: 'fixture-worktree'
        };
        const before = buildFrontendSourceIndex(options);
        const target = join(root, 'src/frontend/src/model.ts');
        writeFileSync(target, `${readFileSync(target, 'utf8')}\nexport const changed = true\n`);
        const after = buildFrontendSourceIndex(options);
        assert.notEqual(after.identity.inputTreeDigest, before.identity.inputTreeDigest);
        assert.notEqual(
            after.files.find(({ path }) => path.endsWith('model.ts')).contentDigest,
            before.files.find(({ path }) => path.endsWith('model.ts')).contentDigest
        );
    });
});

test('rule host preserves finding identity and uses one index read pass', async () =>
{
    await withFixture(async (root) =>
    {
        const badPath = join(root, 'src/frontend/src/components/Card.vue');
        writeFileSync(badPath, readFileSync(badPath, 'utf8')
            .replace('font-size: 14px', 'font-size: 13px')
            .replace('font-weight: 500', 'font-weight: 600'));
        const index = buildFrontendSourceIndex({
            repoRoot: root,
            parserRoot: repositoryRoot,
            runId: 'source-rule-equivalence',
            commit: '0123456789abcdef0123456789abcdef01234567',
            worktreeFingerprint: 'fixture-worktree'
        });
        const hosted = await executeSourceRules({
            index,
            rules: [fontSizeContractRule, fontWeightContractRule],
            ruleOptions: { scanOnly: true }
        });
        assert.deepEqual(validateRuleHostEvidence(hosted, index, {
            expectedRuleIds: ['font-size-contract', 'font-weight-contract']
        }), []);
        assert.equal(hosted.status, 'failure');
        assert.equal(hosted.metrics.nodeProcessCount, 1);
        assert.equal(hosted.metrics.sourceReadCount, index.metrics.readCount);
        assert.equal(hosted.receipts.length, 2);
        assert.ok(hosted.receipts.every(({ findings }) => findings.length === 1));

        for (const receipt of hosted.receipts)
        {
            const direct = await receipt.ruleCompatibility.directEvaluation(index, { scanOnly: true });
            assert.equal(receipt.status, direct.status);
            assert.equal(receipt.findingIdentityDigest, direct.findingIdentityDigest);
            assert.deepEqual(receipt.findings, direct.findings);
        }
    });
});

test('rule host fails closed for parser drift, missing receipts, crashes, and invalid spans', async () =>
{
    await withFixture(async (root) =>
    {
        const index = buildFrontendSourceIndex({
            repoRoot: root,
            parserRoot: repositoryRoot,
            runId: 'source-rule-fail-closed',
            commit: '0123456789abcdef0123456789abcdef01234567',
            worktreeFingerprint: 'fixture-worktree'
        });
        const parserDrift = {
            ...index,
            identity: {
                ...index.identity,
                parsers: { ...index.identity.parsers }
            }
        };
        parserDrift.identity.parsers.typescript = '0.0.0';
        assert.ok(validateFrontendSourceIndex(parserDrift).some((error) => error.includes('parser')));

        const crashed = await executeSourceRules({
            index,
            rules: [{ id: 'crash', coverageIds: ['RULE-HOST-CRASH'], evaluate()
            {
                throw new Error('boom');
            } }]
        });
        assert.equal(crashed.status, 'failure');
        assert.match(crashed.receipts[0].error, /boom/u);

        const invalidSpan = await executeSourceRules({
            index,
            rules: [{
                id: 'invalid-span',
                coverageIds: ['RULE-HOST-SPAN'],
                evaluate()
                {
                    return {
                        findings: [{
                            id: 'bad-span',
                            message: 'bad',
                            path: 'src/frontend/src/missing.ts',
                            span: { start: 0, end: 1, line: 1, column: 1 }
                        }]
                    };
                }
            }]
        });
        assert.equal(invalidSpan.status, 'failure');
        assert.ok(invalidSpan.validationErrors.some((error) => error.includes('source span')));

        const missing = structuredClone(crashed);
        missing.receipts = [];
        assert.ok(validateRuleHostEvidence(missing, index, { expectedRuleIds: ['crash'] })
            .some((error) => error.includes('missing rule receipt')));
    });
});

test('migration owner registry assigns every check command exactly once', async () =>
{
    await withFixture((root) =>
    {
        const registry = buildFrontendStaticOwnerRegistry({ repoRoot: root });
        assert.deepEqual(validateFrontendStaticOwnerRegistry(registry), []);
        assert.deepEqual(registry.summary, {
            commandCount: 3,
            sharedHost: 2,
            isolatedWriter: 1,
            isolatedFixture: 0,
            retainedProcess: 0
        });
        assert.deepEqual(
            registry.commands.map(({ id }) => id),
            ['check:font-size-contract', 'check:font-weight-contract', 'check:writer']
        );
    });
});

test('repository migration registry binds the full static inventory and specialized command baseline', () =>
{
    const registry = buildFrontendStaticOwnerRegistry({ repoRoot: repositoryRoot });
    assert.deepEqual(validateFrontendStaticOwnerRegistry(registry), []);
    assert.equal(registry.summary.sharedHost, 2);
    assert.equal(registry.commands.filter(({ owner }) => owner === 'shared-host').length, 2);
    assert.equal(registry.specializedGovernance.commandCount, 197);
    assert.equal(
        registry.summary.commandCount,
        registry.summary.sharedHost
        + registry.summary.isolatedWriter
        + registry.summary.isolatedFixture
        + registry.summary.retainedProcess
    );
});
