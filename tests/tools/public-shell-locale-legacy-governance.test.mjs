import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { checkPublicShellLocaleLegacyGovernance } = await import(new URL('../../tools/test-matrix/public-shell-locale-legacy-governance.mjs', import.meta.url));
const root = path.resolve(new URL('../../', import.meta.url).pathname);

test('PublicShell locale gate has one canonical matrix/runner and no legacy runner or fixture', async () =>
{
    const result = await checkPublicShellLocaleLegacyGovernance({ root });
    assert.equal(result.status, 'pass');
    assert.deepEqual(result.legacyPaths, [
        'tests/frontend/e2e/public-shell-locale-lifecycle.spec.ts',
        'tests/frontend/fixtures/publicShellLocaleLifecycle.ts'
    ]);
});

test('legacy governance rejects an inventory that reintroduces a runner or forbidden hook', async () =>
{
    const temporaryRoot = fs.mkdtempSync(path.join(root, '.tmp/public-shell-locale-legacy-'));
    const relativeLegacy = path.relative(root, path.join(temporaryRoot, 'legacy-runner.mjs')).replaceAll(path.sep, '/');
    const configFile = path.join(temporaryRoot, 'gate.json');
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/public-shell-locale-gate.json'), 'utf8'));
    fs.writeFileSync(path.join(temporaryRoot, 'legacy-runner.mjs'), 'page.waitForTimeout(1); __advancePublicShellPhase();\n');
    config.legacy.paths = [relativeLegacy];
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    await assert.rejects(
        checkPublicShellLocaleLegacyGovernance({ root, configFile }),
        /legacy runner or fixture remains|forbidden legacy token/u
    );
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('gate configuration rejects a second locale or scenario authority', async () =>
{
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-public-shell-locale-gate-'));
    const configFile = path.join(temporaryRoot, 'gate.json');
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/public-shell-locale-gate.json'), 'utf8'));
    config.scenes = ['handwritten-second-runner-authority'];
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    await assert.rejects(
        checkPublicShellLocaleLegacyGovernance({ root, configFile }),
        /second locale\/scenario authority|unregistered wrapper\/authority/u
    );
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
});
