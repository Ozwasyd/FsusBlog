import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { scanWritingAidLegacyInventory, verifyWritingAidLegacyInventory } from './writing-aid-legacy-inventory.mjs';

function fixture(t, files)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writing-aid-inventory-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet', root]);
    for (const [name, content] of Object.entries(files))
    {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), content);
    }
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Inventory Test', '-c', 'user.email=inventory@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: root });
    return root;
}

test('discovers unknown legacy identifiers without inventing storage keys or a migration rule', (t) =>
{
    const root = fixture(t, { 'src/frontend/src/services/preferences.ts': 'localStorage.setItem("new-discovered-key", zenMode);\n' });
    const inventory = scanWritingAidLegacyInventory(root);
    assert.equal(inventory.unresolvedSourceCandidates, 1);
    assert.equal(inventory.candidates[0].storageKey, null);
    assert.equal(inventory.candidates[0].migrationRule, null);
    assert.equal(inventory.migrationEligible, false);
    assert.equal(inventory.deletionEligible, false);
    assert.equal(inventory.runtimeBrowserStorageInspected, false);
    assert.equal(verifyWritingAidLegacyInventory(root, inventory), true);
});

test('preserves the independently owned comment focus state and binds backend field observations', (t) =>
{
    const root = fixture(t, {
        'src/frontend/src/components/article/ArticleCommentComposer.vue': 'const focusModeVisible = ref(false);\n',
        'src/backend/Entities/Legacy.cs': 'public string WritingMode { get; set; }\n'
    });
    const inventory = scanWritingAidLegacyInventory(root);
    assert.equal(inventory.candidates.length, 2);
    assert.equal(inventory.unresolvedSourceCandidates, 1);
    assert.equal(inventory.candidates.find((entry) => entry.path.endsWith('.vue')).classification, 'comment-composer-owner-1794');
    assert.ok(inventory.candidates.every((entry) => /^[0-9a-f]{64}$/u.test(entry.fileDigest) && /^[0-9a-f]{64}$/u.test(entry.lineDigest)));
});

test('rejects receipt, source and indexed input-set tamper by re-enumeration', (t) =>
{
    const root = fixture(t, { 'src/backend/Entities/Legacy.cs': 'string WritingMode;\n' });
    const inventory = scanWritingAidLegacyInventory(root);
    assert.equal(verifyWritingAidLegacyInventory(root, { ...inventory, ownedLegacyKeys: ['invented-key'] }), false);
    fs.appendFileSync(path.join(root, 'src/backend/Entities/Legacy.cs'), 'bool ZenMode;\n');
    assert.equal(verifyWritingAidLegacyInventory(root, inventory), false);
    fs.writeFileSync(path.join(root, 'extra.ts'), 'const mode = "write";\n');
    execFileSync('git', ['add', 'extra.ts'], { cwd: root });
    assert.equal(verifyWritingAidLegacyInventory(root, scanWritingAidLegacyInventory(root)), true);
    assert.equal(verifyWritingAidLegacyInventory(root, inventory), false);
});

test('binary inputs stay explicit and cannot be interpreted as a zero-residue receipt', (t) =>
{
    const root = fixture(t, { 'legacy.bin': Buffer.from([0, 255, 128]) });
    const inventory = scanWritingAidLegacyInventory(root);
    assert.equal(inventory.files[0].status, 'binary-not-scanned');
    assert.equal(inventory.deletionEligible, false);
    assert.equal(inventory.migrationEligible, false);
});
