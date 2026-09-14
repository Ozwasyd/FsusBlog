import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {verifyProductionBuildReceipt} = await import(new URL('../ci/production-build-artifacts.mjs', import.meta.url));
const {createPublicShellLocaleMatrix, validatePublicShellLocaleMatrix} = await import(new URL('../../tests/browser-contract/public-shell-locale-matrix.mjs', import.meta.url));
export const publicShellLocaleGateSchema = 'fsusblog.public-shell-locale-gate.v1';
export const publicShellLocaleSubResultsSchema = 'fsusblog.public-shell-locale-sub-results.v1';
export const publicShellLocaleSubResultSchema = 'fsusblog.public-shell-locale-sub-result.v1';
export const publicShellLocaleQualificationSchema = 'fsusblog.public-shell-locale-qualification.v1';
export const publicShellLocaleFontPlanSchema = 'fsusblog.public-shell-locale-font-plan.v1';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const configRelativePath = 'config/testing/public-shell-locale-gate.json';
const forbiddenAuthorityKeys = new Set([
    'locales', 'locale', 'languages', 'language', 'scenes', 'scene', 'scenario', 'scenarios',
    'negotiationCases', 'expectedCopy', 'expectedText', 'copy', 'routes', 'stages', 'viewports',
    'authContexts', 'failureModes', 'selectorItems'
]);

function canonical(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonical);
    }
    if (value !== null && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
}

export function gateDigest(value)
{
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function assertInside(root, relative, label)
{
    const normalized = String(relative ?? '').trim().replace(/^\.\//u, '').replaceAll('\\', '/');
    if (!normalized || path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../'))
    {
        throw new Error(`${label} path is unsafe: ${normalized || '<empty>'}`);
    }
    const absolute = path.resolve(root, normalized);
    if (absolute === root || !absolute.startsWith(`${root}${path.sep}`))
    {
        throw new Error(`${label} path escapes repository root: ${relative}`);
    }
    return absolute;
}

function scanForbiddenAuthorityKeys(value, location = 'config')
{
    if (Array.isArray(value))
    {
        value.forEach((item, index) => scanForbiddenAuthorityKeys(item, `${location}[${index}]`));
        return;
    }
    if (!value || typeof value !== 'object')
    {
        return;
    }
    for (const [key, child] of Object.entries(value))
    {
        if (forbiddenAuthorityKeys.has(key))
        {
            throw new Error(`${location}.${key} would create a second locale/scenario authority`);
        }
        scanForbiddenAuthorityKeys(child, `${location}.${key}`);
    }
}

function requireString(value, label)
{
    assert.equal(typeof value, 'string', `${label} must be a string`);
    assert.ok(value.trim(), `${label} must not be empty`);
    return value;
}

function assertExactKeys(value, expected, label)
{
    const actual = Object.keys(value ?? {}).sort();
    const allowed = [...expected].sort();
    assert.deepEqual(actual, allowed, `${label} has an unregistered wrapper/authority field`);
}

export async function loadPublicShellLocaleGateConfig(root = defaultRoot, file = configRelativePath)
{
    const resolvedRoot = path.resolve(root);
    const configFile = path.isAbsolute(file) ? file : assertInside(resolvedRoot, file, 'gate config');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    assertExactKeys(config, ['schema', 'matrix', 'runner', 'subResults', 'build', 'output', 'commands', 'legacy'], 'gate config');
    assertExactKeys(config.matrix, ['module', 'schema'], 'gate matrix');
    assertExactKeys(config.runner, ['path', 'kind'], 'gate runner');
    assertExactKeys(config.subResults, ['inputSchema', 'resultSchema', 'inputPath'], 'gate sub-results');
    assertExactKeys(config.build, ['receiptPath', 'requiredDomains'], 'gate build');
    assertExactKeys(config.output, ['path', 'schema'], 'gate output');
    assertExactKeys(config.commands, ['aggregate', 'verify'], 'gate commands');
    assertExactKeys(config.legacy, ['paths', 'forbiddenTokens'], 'gate legacy inventory');
    assert.equal(config.schema, publicShellLocaleGateSchema, 'PublicShell locale gate schema mismatch');
    assert.equal(config.matrix?.schema, 'fsusblog.public-shell-locale-matrix.v1', 'gate matrix schema mismatch');
    assert.equal(config.matrix?.module, 'tests/browser-contract/public-shell-locale-matrix.mjs', 'gate matrix module mismatch');
    assert.equal(config.runner?.kind, 'browser-contract', 'gate runner kind mismatch');
    assert.equal(config.runner?.path, 'tests/browser-contract/run.mjs', 'gate runner must be canonical Browser Contract');
    assert.equal(config.subResults?.inputSchema, publicShellLocaleSubResultsSchema, 'gate input schema mismatch');
    assert.equal(config.subResults?.resultSchema, publicShellLocaleSubResultSchema, 'gate sub-result schema mismatch');
    assert.equal(config.output?.schema, publicShellLocaleQualificationSchema, 'gate output schema mismatch');
    requireString(config.build?.receiptPath, 'gate build.receiptPath');
    assert.ok(Array.isArray(config.build?.requiredDomains) && config.build.requiredDomains.length > 0,
        'gate build.requiredDomains must be non-empty');
    assert.equal(new Set(config.build.requiredDomains).size, config.build.requiredDomains.length,
        'gate build.requiredDomains must be unique');
    assert.equal(config.commands?.aggregate, 'node tools/test-matrix/aggregate-public-shell-locale.mjs',
        'gate aggregate command mismatch');
    assert.equal(config.commands?.verify, 'node tools/test-matrix/verify-public-shell-locale.mjs <receipt>',
        'gate verifier command mismatch');
    assert.ok(Array.isArray(config.legacy?.paths), 'gate legacy inventory is required');
    assert.ok(Array.isArray(config.legacy?.forbiddenTokens), 'gate legacy token inventory is required');
    scanForbiddenAuthorityKeys(config, 'config');
    return config;
}

export function resolveGatePath(root, relative, label)
{
    const resolvedRoot = path.resolve(root);
    if (path.isAbsolute(relative))
    {
        const absolute = path.resolve(relative);
        if (absolute === resolvedRoot || !absolute.startsWith(`${resolvedRoot}${path.sep}`))
        {
            throw new Error(`${label} path escapes repository root: ${relative}`);
        }
        return absolute;
    }
    return assertInside(resolvedRoot, relative, label);
}

export async function loadPublicShellLocaleGate({ root = defaultRoot, buildReceiptFile = null } = {})
{
    root = await fs.promises.realpath(root);
    const config = await loadPublicShellLocaleGateConfig(root);
    const matrix = await createPublicShellLocaleMatrix(root);
    await validatePublicShellLocaleMatrix(matrix, root);
    assert.equal(matrix.fontPlan?.schema, publicShellLocaleFontPlanSchema, 'matrix font plan schema mismatch');
    assert.ok(/^[a-f0-9]{64}$/u.test(matrix.fontPlan?.digest ?? ''), 'matrix font plan digest is missing');
    assert.equal(matrix.identity.fontPlanDigest, matrix.fontPlan.digest, 'matrix font plan identity mismatch');
    const receiptFile = buildReceiptFile
        ? resolveGatePath(root, buildReceiptFile, 'build receipt')
        : resolveGatePath(root, config.build.receiptPath, 'build receipt');
    return { root, config, matrix, receiptFile };
}

export function verifyPublicShellLocaleBuild(gate, expectedSourceState = {
    commit: gate.matrix.identity.sourceCommit,
    worktreeFingerprint: gate.matrix.identity.worktreeFingerprint
})
{
    const result = verifyProductionBuildReceipt({
        artifactRoot: path.dirname(gate.receiptFile),
        receiptFile: path.basename(gate.receiptFile),
        expectedSourceState
    });
    const required = new Set(gate.config.build.requiredDomains);
    const actual = new Set(result.receipt.domains.map((domain) => domain.name));
    const missing = [...required].filter((domain) => !actual.has(domain));
    if (missing.length > 0)
    {
        throw new Error(`immutable PublicShell locale build is missing domains: ${missing.join(', ')}`);
    }
    return {
        receipt: result.receipt,
        evidence: result.evidence,
        digest: result.receipt.contentDigest,
        sourceState: result.receipt.sourceState,
        domains: [...required].sort()
    };
}

export function sceneMap(matrix)
{
    return new Map(matrix.scenes.map((scene) => [scene.id, scene]));
}

export function sortedUnique(values)
{
    return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right)));
}

export function stableJson(value)
{
    return JSON.stringify(canonical(value));
}
