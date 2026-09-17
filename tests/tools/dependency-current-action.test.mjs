import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const { extractCurrentVersion } = await import(new URL('../../tools/governance/dependency-freshness.mjs', import.meta.url));
function fixture(t, sources)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-action-current-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const files = sources.map((source, index) =>
    {
        const file = `${index}.yml`;
        fs.writeFileSync(path.join(root, file), source);
        return file;
    });
    return { root, item: { id: 'codeql', manager: 'github-actions', packageName: 'github/codeql-action', files } };
}

test('actual pinned commit owns current identity, never the comment or disabled steps', t =>
{
    const sha = 'a'.repeat(40);
    const { root, item } = fixture(t, [
        `# - uses: github/codeql-action/init@${'b'.repeat(40)} # v5\n- uses: github/codeql-action/init@${sha} # v4\n  uses: 'github/codeql-action/analyze@${sha}' # misleading label\n`
    ]);
    assert.equal(extractCurrentVersion(root, item, {}), sha);
});

test('all workflow occurrences must agree even when version comments agree', t =>
{
    const { root, item } = fixture(t, [
        `- uses: github/codeql-action/init@${'a'.repeat(40)} # v4`,
        `- uses: github/codeql-action/analyze@${'b'.repeat(40)} # v4`
    ]);
    assert.throws(() => extractCurrentVersion(root, item, {}), /references-disagree/);
});

test('unpinned release tags remain literal and absent actions cannot be fabricated from comments', t =>
{
    const tag = fixture(t, ['- uses: github/codeql-action/init@v4.37.9 # v4']);
    assert.equal(extractCurrentVersion(tag.root, tag.item, {}), 'v4.37.9');
    const absent = fixture(t, ['# uses: github/codeql-action/init@v4.37.9']);
    assert.equal(extractCurrentVersion(absent.root, absent.item, {}), undefined);
});
