import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const frontendPackage = new URL('../../src/frontend/package.json', import.meta.url);
const require = createRequire(frontendPackage);
const ts = require('typescript');
const sourcePath = fileURLToPath(new URL('../frontend/support/playwright/acceptance-shared.ts', import.meta.url));
const configPath = fileURLToPath(new URL('../../src/frontend/tsconfig.playwright.json', import.meta.url));
const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic)
    {
        assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    }
});
assert.deepEqual(config.errors, []);
const original = ts.createSourceFile(sourcePath, readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true);
const functions = original.statements.filter((node) => ts.isFunctionDeclaration(node)
    && node.name?.text === 'normalizeFixtureStorageState');
assert.equal(functions.length, 1);
const compiled = ts.transpileModule(functions[0].getText(original), {
    fileName: sourcePath,
    compilerOptions: config.options,
    reportDiagnostics: true
});
assert.deepEqual(compiled.diagnostics ?? [], []);
const executable = ts.createSourceFile('acceptance-cookie-function.js', compiled.outputText,
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functionBody = executable.statements.find((node) => ts.isFunctionDeclaration(node)
    && node.name?.text === 'normalizeFixtureStorageState');
assert.ok(functionBody);

function normalize(storageState, baseUrl)
{
    const actual = runInNewContext(`(${functionBody.getText(executable)})`, {
        URL,
        process: { env: { PLAYWRIGHT_BASE_URL: baseUrl } }
    });
    return JSON.parse(JSON.stringify(actual(storageState)));
}

const hostCookie = Object.freeze({
    name: '__Host-SessionId', value: 'synthetic-cookie-value', domain: '.foreign.invalid',
    path: '/foreign', expires: 2000000000, httpOnly: true, secure: false, sameSite: 'Strict'
});

test('HTTPS acceptance host cookies use canonical stored fields without weakening cookie values', () =>
{
    const input = Object.freeze({ cookies: Object.freeze([hostCookie]), origins: Object.freeze([]) });
    assert.deepEqual(normalize(input, 'https://acceptance.example.test:4443/nested/path'), {
        cookies: [{ name: '__Host-SessionId', value: 'synthetic-cookie-value',
            domain: 'acceptance.example.test', path: '/', expires: 2000000000,
            httpOnly: true, secure: true, sameSite: 'Strict' }],
        origins: []
    });
    assert.equal(hostCookie.domain, '.foreign.invalid');
    assert.equal(hostCookie.path, '/foreign');
    assert.equal(hostCookie.secure, false);
});

test('HTTP acceptance state excludes host-prefixed cookies and preserves ordinary cookie normalization', () =>
{
    const origins = [{ origin: 'http://acceptance.example.test:3000', localStorage: [] }];
    assert.deepEqual(normalize({ cookies: [hostCookie, { name: 'ordinary', value: 'value' }], origins },
        'http://acceptance.example.test:3000/nested'), {
        cookies: [{ name: 'ordinary', value: 'value', domain: 'acceptance.example.test', path: '/',
            expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
        origins
    });
});

test('stored host cookies bind the exact URL hostname and root path independently of port or base path', () =>
{
    for (const baseUrl of ['https://localhost:4443/a', 'https://127.0.0.1:4443/a', 'https://[::1]:4443/a'])
    {
        const cookie = normalize({ cookies: [hostCookie], origins: [] }, baseUrl).cookies[0];
        assert.equal(cookie.domain, new URL(baseUrl).hostname);
        assert.equal(cookie.path, '/');
        assert.equal(cookie.secure, true);
        assert.equal(Object.hasOwn(cookie, 'url'), false);
        assert.equal(cookie.domain.startsWith('.'), false);
    }
});
