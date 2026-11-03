import assert from 'node:assert/strict';
import test from 'node:test';

const { inventoryBlockLinkLegacySources } = await import(
    new URL('../../tools/governance/inventory-block-link-legacy.mjs', import.meta.url)
);

test('enumerates legacy syntax, identities and fallback candidates across every supplied domain', () =>
{
    const sources = new Map([
        ['src/frontend/link.ts', '"/posts/title#^intro"; "[[Article#intro]]"; "{#intro}"'],
        ['src/backend/block.cs', 'database block ID; block_id; historical rewrite'],
        ['src/shared/contract.json', 'sidecar anchor; content hash target'],
        ['docs/anchors.md', '<p id="intro">; regex anchor scan'],
        ['tools/import.mjs', 'auto anchor; global replace'],
        ['tests/denial.ts', 'DOM target; random suffix']
    ]);
    const inventory = inventoryBlockLinkLegacySources(sources);
    assert.equal(inventory.scannedFiles, 6);
    assert.deepEqual(new Set(inventory.entries.map(entry => entry.category)), new Set([
        'caret-url', 'wikilink', 'attribute-anchor', 'html-anchor', 'sidecar-identity',
        'derived-identity', 'anchor-scanner', 'automatic-anchor', 'refactor-fallback', 'anchor-reference', 'block-identity'
    ]));
    assert.deepEqual(new Set(inventory.entries.map(entry => entry.path)), new Set(sources.keys()));
    assert.ok(inventory.entries.every(entry => entry.classification === 'unreviewed'));
    assert.equal(inventory.issueAcceptance, false);
    assert.equal(inventory.deletionAuthorized, false);
});

test('does not classify negative tests or documentation mentions as resolved production residue', () =>
{
    const inventory = inventoryBlockLinkLegacySources(new Map([
        ['tests/deny.ts', 'deny #^intro'],
        ['docs/contract.md', 'wikilink unsupported: [[Article#intro]]']
    ]));
    assert.equal(inventory.unresolvedCandidates, 2);
    assert.equal(inventory.entries[0].classification, 'unreviewed');
    assert.equal(inventory.entries[1].classification, 'unreviewed');
});

test('stable digest is independent of source enumeration order and changes with candidate bytes', () =>
{
    const sources = [['b.ts', '#^b'], ['a.ts', '#^a']];
    const forward = inventoryBlockLinkLegacySources(new Map(sources));
    const backward = inventoryBlockLinkLegacySources(new Map([...sources].reverse()));
    assert.deepEqual(forward, backward);
    const changed = inventoryBlockLinkLegacySources(new Map([['a.ts', '#^changed'], ['b.ts', '#^b']]));
    assert.notEqual(changed.contentDigest, forward.contentDigest);
});

test('retains exact source locations and digests without source text in inventory output', () =>
{
    const inventory = inventoryBlockLinkLegacySources(new Map([['a.ts', 'private fixture prose\n#^intro\n#^other']]));
    assert.deepEqual(inventory.entries.map(entry => entry.line), [2, 3]);
    assert.deepEqual(inventory.entries.map(entry => entry.start), [22, 30]);
    assert.ok(inventory.entries.every(entry => entry.sourceDigest.length === 64 && entry.matchDigest.length === 64));
    assert.equal(JSON.stringify(inventory).includes('private fixture prose'), false);
});

test('empty input cannot authorize deletion or terminal acceptance', () =>
{
    const inventory = inventoryBlockLinkLegacySources(new Map());
    assert.equal(inventory.unresolvedCandidates, 0);
    assert.equal(inventory.deletionAuthorized, false);
    assert.equal(inventory.issueAcceptance, false);
});
