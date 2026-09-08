import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPublicShellLocaleGateConfig, resolveGatePath } from './public-shell-locale-gate.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const canonicalLegacyPaths = [
    'tests/frontend/e2e/public-shell-locale-lifecycle.spec.ts',
    'tests/frontend/fixtures/publicShellLocaleLifecycle.ts'
];
const canonicalForbiddenTokens = [
    '__public-shell-locale-fixture',
    '__advancePublicShellPhase',
    'resetLocaleRuntimeForTests',
    'requestLocale',
    'LocaleToggle',
    'waitForTimeout',
    'flakyAllowlist',
    'warningFilter',
    'second-runner'
];

function readText(root, relative)
{
    return readFile(resolveGatePath(root, relative, 'legacy inventory')).then((value) => value.toString('utf8'));
}

export async function checkPublicShellLocaleLegacyGovernance({ root = defaultRoot, configFile = null } = {})
{
    root = await fs.promises.realpath(root);
    const config = await loadPublicShellLocaleGateConfig(root, configFile ?? 'config/testing/public-shell-locale-gate.json');
    const errors = [];
    if (JSON.stringify(config.legacy.paths) !== JSON.stringify(canonicalLegacyPaths))
    {
        errors.push('legacy path inventory has been tampered');
    }
    if (JSON.stringify(config.legacy.forbiddenTokens) !== JSON.stringify(canonicalForbiddenTokens))
    {
        errors.push('legacy forbidden-token inventory has been tampered');
    }
    for (const relative of config.legacy.paths)
    {
        const absolute = resolveGatePath(root, relative, 'legacy inventory');
        if (fs.existsSync(absolute))
        {
            errors.push(`legacy runner or fixture remains: ${relative}`);
            let stat;
            try
            {
                stat = fs.lstatSync(absolute);
            }
            catch
            {
                continue;
            }
            if (stat.isFile())
            {
                const source = await readText(root, relative);
                for (const token of config.legacy.forbiddenTokens)
                {
                    if (source.includes(token))
                    {
                        errors.push(`${relative} contains forbidden legacy token: ${token}`);
                    }
                }
            }
        }
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    return {
        schema: 'fsusblog.public-shell-locale-legacy-governance.v1',
        status: 'pass',
        legacyPaths: config.legacy.paths,
        forbiddenTokens: config.legacy.forbiddenTokens
    };
}
