#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const {
    ProductPolicyPaths,
    ValidateProductVersionGovernance
} = await import(pathToFileURL(path.join(root, 'tools/docs/check-public-preview-docs.mjs')).href);

test('repository product-version governance passes', () =>
{
    const result = spawnSync(process.execPath, ['tools/docs/check-public-preview-docs.mjs'], {
        cwd: root,
        encoding: 'utf8'
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('active policy sources reject product SemVer promises', () =>
{
    for (const path of ProductPolicyPaths)
    {
        const errors = ValidateProductVersionGovernance(new Map([[path, 'Stable from v9.8.7 onward.']]));
        assert.ok(errors.some((error) => error.includes(`${path} uses product SemVer v9.8.7`)), path);
    }
    const readmeErrors = ValidateProductVersionGovernance(new Map([['README.md', 'FsusBlog v9.8.7 is the current release.']]));
    assert.ok(readmeErrors.includes('README.md uses product SemVer as a current status or compatibility boundary'));
});

test('README governance does not require the retired preview status banner', () =>
{
    const errors = ValidateProductVersionGovernance(new Map([
        ['README.md', [
            '| Public preview entry | Link |',
            '[Policy](docs/releases/public-preview-policy.md)',
            'See CHANGELOG.md for the canonical ReleaseId.'
        ].join('\n')]
    ]));
    assert.ok(!errors.some((error) => (
        error.includes('**Public Preview**')
        || error.includes('API Stability: Experimental')
        || error.includes('Deployment: Self-hosting preview')
        || error.includes('Production SLA: none')
    )), errors.join('\n'));
});

test('governance does not confuse protocol, schema, runtime, dependency, or provenance versions with product SemVer', () =>
{
    const exemptEvidence = [
        'AEDS v2',
        'fsusblog.release-manifest.v3',
        'schema version 2',
        '.NET 10',
        'Node.js 20',
        'Vue 3.5.32',
        'RFC 6238',
        'docs/reports/open-source-readiness/v1.1.0-public-preview/ is historical provenance'
    ].join('\n');
    const errors = ValidateProductVersionGovernance(new Map([['README.md', exemptEvidence]]));
    assert.ok(!errors.some((error) => error.includes('uses product SemVer')), errors.join('\n'));
});

test('legacy preview authority follows explicit inventory metadata instead of an expanded historical index', () =>
{
    const contents = new Map([
        ['docs/index.md', '## Current sources of truth\n\n- [Policy](releases/public-preview-policy.md)\n\n## Historical\n\n- `releases`: 1 document\n'],
        ['docs/releases/v1.1.0-public-preview.md', 'Historical / Legacy\nnot current master policy'],
        ['config/development/document-inventory.generated.json', JSON.stringify({
            documents: [{
                path: 'docs/releases/v1.1.0-public-preview.md',
                status: 'historical',
                sourceOfTruth: false
            }]
        })]
    ]);
    const valid = ValidateProductVersionGovernance(contents);
    assert.ok(!valid.some((error) => error.includes('legacy preview policy')), valid.join('\n'));

    contents.set('config/development/document-inventory.generated.json', JSON.stringify({
        documents: [{
            path: 'docs/releases/v1.1.0-public-preview.md',
            status: 'current',
            sourceOfTruth: true
        }]
    }));
    assert.ok(ValidateProductVersionGovernance(contents)
        .some((error) => error.includes('historical and non-authoritative')));
});
