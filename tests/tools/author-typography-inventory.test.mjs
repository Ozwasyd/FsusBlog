import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { scanAuthorTypographyInventory, verifyAuthorTypographyInventory } = await import(
    new URL('../../tools/frontend/author-typography-inventory.mjs', import.meta.url)
);

function fixture(context, sources)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'author-typography-inventory-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    for (const [filePath, content] of Object.entries(sources))
    {
        fs.mkdirSync(path.dirname(path.join(root, filePath)), { recursive: true });
        fs.writeFileSync(path.join(root, filePath), content);
    }
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Inventory Test', '-c', 'user.email=inventory@example.test', 'commit', '-qm', 'fixture'], { cwd: root });
    return root;
}

test('discovers unknown keys across runtime, server, CSS, policy and test paths without authorizing deletion', (context) =>
{
    const root = fixture(context, {
        'src/frontend/src/store/unexpected.ts': 'localStorage.setItem("surprising-prose-width", "81ch");\n',
        'src/backend/Entities/Old.cs': 'public string FontFamily { get; set; }\n',
        'src/frontend/src/views/admin/article/Old.vue': ':deep(.private-editor) { line-height: 1.9; }\n',
        'src/frontend/src/components/public/Article.vue': 'font-size: 16px;\n',
        'src/shared/Contracts/Fonts/Font.cs': 'font-family owner\n',
        'docs/old.md': 'per-mode typography\n',
        'tests/old.test.ts': 'paragraphSpacing\n',
        'neutral.txt': 'no matching preference\n'
    });
    const inventory = scanAuthorTypographyInventory(root);
    assert.equal(inventory.files.length, 8);
    assert.equal(inventory.candidates.length, 7);
    assert.equal(inventory.refusals.length, 0);
    assert.equal(inventory.migrationEligible, false);
    assert.equal(inventory.deletionEligible, false);
    assert.equal(inventory.status, 'discovery-only');
    assert.equal(inventory.candidates.find((row) => row.path.includes('/public/')).ownerClassification, 'public-or-export-owner');
    assert.equal(inventory.candidates.find((row) => row.path.includes('/Fonts/')).ownerClassification, 'system-or-public-font-owner');
    assert.equal(inventory.candidates.find((row) => row.path.includes('/store/')).ownerClassification, 'ambiguous-owner');
    assert.equal(verifyAuthorTypographyInventory(root, inventory), true);
});

test('replay rejects line, whole-file, source, receipt and input-set tampering', (context) =>
{
    const root = fixture(context, { 'source.css': 'font-family: serif;\nneutral line\n' });
    const inventory = scanAuthorTypographyInventory(root);
    assert.equal(verifyAuthorTypographyInventory(root, { ...inventory, deletionEligible: true }), false);
    assert.equal(verifyAuthorTypographyInventory(root, { ...inventory, sourceCommit: 'a'.repeat(40) }), false);
    assert.equal(verifyAuthorTypographyInventory(root, { ...inventory, candidates: [] }), false);
    fs.appendFileSync(path.join(root, 'source.css'), 'different neutral line\n');
    assert.equal(verifyAuthorTypographyInventory(root, inventory), false);
    fs.writeFileSync(path.join(root, 'new.css'), 'font-size: 11px;\n');
    execFileSync('git', ['add', 'new.css'], { cwd: root });
    assert.equal(verifyAuthorTypographyInventory(root, inventory), false);
});

test('reports binaries, missing files, symlinks and oversized files instead of silently declaring residue zero', (context) =>
{
    const root = fixture(context, {
        'binary.bin': Buffer.from([0, 255]),
        'missing.css': 'font-size: 14px;\n',
        'link.css': 'font-family: serif;\n',
        'oversized.css': 'line-height: 2;\n'
    });
    fs.rmSync(path.join(root, 'missing.css'));
    fs.rmSync(path.join(root, 'link.css'));
    fs.symlinkSync('/etc/hosts', path.join(root, 'link.css'));
    fs.truncateSync(path.join(root, 'oversized.css'), 16 * 1024 * 1024 + 1);
    const inventory = scanAuthorTypographyInventory(root);
    assert.equal(inventory.files[0].status, 'binary-not-scanned');
    assert.equal(inventory.refusals.length, 3);
    assert.equal(inventory.deletionEligible, false);
});
