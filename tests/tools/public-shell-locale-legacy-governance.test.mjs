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

// These isolated source/command models exercise governance, not browser qualification.
function activeClosureFixture(t)
{
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-locale-active-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/public-shell-locale-gate.json'), 'utf8'));
    const write = (file, source) =>
    {
        const target = path.join(directory, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, source);
    };
    write('config/testing/public-shell-locale-gate.json', JSON.stringify(config));
    write('src/shared/Contracts/Localization/locale-catalog.json', fs.readFileSync(path.join(root,
        'src/shared/Contracts/Localization/locale-catalog.json')));
    write('src/frontend/package.json', JSON.stringify({ scripts: {
        'check:browser-contract': 'bash ../../tools/test/lanes/browser-contract.sh'
    } }));
    write('tests/matrix.yml', 'tiers:\n    - id: browser-contract\n      command: bash tools/test/lanes/browser-contract.sh\n      executionDependsOn: []\n');
    write('tests/coverage-registry.json', JSON.stringify({ entries: [{
        id: 'release-browser-contract', tierIds: ['browser-contract'],
        evidencePaths: [config.runner.path, '.github/workflows/quality-gate.yml']
    }] }));
    write('tests/governance/test-lifecycle-registry.json', JSON.stringify({ entries: [{
        file: 'tests/tools/public-shell-locale-legacy-governance.test.mjs',
        owner: 'manual-diagnostic:tests/tools/public-shell-locale-legacy-governance.test.mjs',
        physicalExecutionCount: 0
    }] }));
    write('.github/workflows/quality-gate.yml', 'jobs:\n    browser-contract:\n        steps:\n            - run: ./tools/test.sh ci-tier browser-contract --no-deps\n');
    write('tools/test/lanes/browser-contract.sh', '#!/usr/bin/env bash\nnode "$ROOT_DIR/tests/browser-contract/run.mjs"\n');
    write(config.runner.path, "import './renamed-observer.mjs';\n");
    write('tests/browser-contract/renamed-observer.mjs', 'export const observed = true;\n');
    write(config.matrix.module, 'export const plan = { evidenceKind: "plan" };\n');
    write('tools/test-matrix/aggregate-public-shell-locale.mjs', 'export const aggregate = true;\n');
    write('tools/test-matrix/verify-public-shell-locale.mjs', 'export const verify = true;\n');
    return { directory, write, config };
}

test('active closure derives roots from canonical bindings without executing them', async (t) =>
{
    const value = activeClosureFixture(t);
    const result = await checkPublicShellLocaleLegacyGovernance({ root: value.directory });
    assert.equal(result.status, 'pass');
    assert.ok(result.activeFiles.includes('tests/browser-contract/renamed-observer.mjs'));
    assert.equal(result.browserSpawnCount, 0);
});

for (const [name, source, expected] of [
    ['renamed static wrapper', "import './run.mjs';", /runner wrapper/u],
    ['renamed dynamic URL wrapper', "await import(new URL('./run.mjs', import.meta.url));", /runner wrapper/u],
    ['literal data wrapper', "await import('data:text/javascript,globalThis.requestLocale()');", /internal locale call/u],
    ['second launch under renamed helper', 'export async function probe(browser) { await browser.launch(); }', /browser launch/u],
    ['aliased internal phase call', "import { requestLocale as advance } from './phase.mjs'; advance('ja-JP');", /internal locale call/u],
    ['computed internal call', "runtime['__advancePublicShellPhase']();", /internal locale call/u],
    ['destructured internal alias', 'const { resetLocaleRuntimeForTests: renamed } = runtime; renamed();', /internal locale call/u],
    ['fixed browser sleep', 'export async function scene(page) { await page.waitForTimeout(10); }', /browser sleep/u],
    ['renamed sleep promise', 'export async function scene(page) { await page.goto("/"); await new Promise(resolve => setTimeout(resolve, 10)); }', /browser sleep/u],
    ['browser retry loop', 'export async function scene(page) { for (let attempt=0; attempt<2; attempt++) { await page.goto("/"); } }', /browser retry/u],
    ['retry hidden through callback', 'export async function scene(page) { await retry(() => page.goto("/")); }', /browser retry/u],
    ['renamed callback retry', 'async function again(operation) { for(let count=0; count<2; count++) { await operation(); } } export async function scene(page) { await again(() => page.goto("/")); }', /browser retry/u],
    ['hardcoded expected copy', 'export const expectedCopy = { home: "Home", login: "Login" };', /handwritten copy/u],
    ['dual-language list', "export const renamedLocales = ['en-US', 'zh-CN'];", /second locale authority/u],
    ['dual-language type', "export type FixtureLocale = 'en-US' | 'zh-CN';", /second locale authority/u],
    ['old selector literal', 'page.locator("[data-locale-toggle]").click();', /legacy selector/u],
    ['smoke-only success', 'export const proof = { qualificationEligible: true, status: "success", url: "/", htmlLang: "ja-JP" };', /smoke authority/u],
    ['compatibility result schema', 'export const result = { schema: "fsusblog.public-shell-locale-sub-result.compat.v1" };', /compat schema/u],
    ['renamed compatibility schema', 'export const result = { schema: "renamed.locale.v1", qualificationEligible: true };', /compat schema/u],
    ['flaky allowlist', 'export const flakyAllowlist = ["scene"];', /failure filter/u],
    ['warning filter', 'export function warningFilter(issue) { return true; }', /failure filter/u],
    ['default entity fallback', 'export const publicArticle = { id: 1, url: "/article/1" };', /fixture fallback/u],
    ['direct database fixture', 'database.query("INSERT INTO article VALUES (1)");', /direct database fixture/u],
    ['unresolved active import', "import './missing.mjs';", /missing active/u],
    ['nonliteral local import', 'await import(dynamicModule);', /unresolved active import/u]
])
{
    test(`active closure rejects ${name}`, async (t) =>
    {
        const value = activeClosureFixture(t);
        value.write('tests/browser-contract/renamed-observer.mjs', source);
        value.write('tests/browser-contract/phase.mjs', 'export function requestLocale() {}\n');
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), expected);
    });
}

test('active closure rejects a compatibility authority imported as JSON', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tests/browser-contract/renamed-observer.mjs', "import authority from './moved.json' with { type: 'json' };\n");
    value.write('tests/browser-contract/moved.json', JSON.stringify({ schema: 'renamed.locale.v1', qualificationEligible: true }));
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /compat schema/u);
});

for (const [name, file, source, expected] of [
    ['local wrapper', 'src/frontend/package.json', JSON.stringify({ scripts: {
        'check:browser-contract': 'node ../../tests/browser-contract/moved-runner.mjs'
    } }), /local command/u],
    ['matrix wrapper', 'tests/matrix.yml', 'tiers:\n    - id: browser-contract\n      command: node tests/browser-contract/moved-runner.mjs\n      executionDependsOn: []\n', /matrix command/u],
    ['CI second command', '.github/workflows/quality-gate.yml', 'jobs:\n    browser-contract:\n        steps:\n            - run: node tests/browser-contract/moved-runner.mjs\n', /CI command/u],
    ['lane second command', 'tools/test/lanes/browser-contract.sh', 'node "$ROOT_DIR/tests/browser-contract/run.mjs"\nnode "$ROOT_DIR/tests/browser-contract/moved-runner.mjs"\n', /lane command/u],
    ['retired active inventory', 'tests/coverage-registry.json', JSON.stringify({ entries: [{
        id: 'release-browser-contract', tierIds: ['browser-contract'], evidencePaths: ['tests/frontend/e2e/public-shell-locale-lifecycle.spec.ts']
    }] }), /authority binding/u]
])
{
    test(`active closure rejects ${name} binding`, async (t) =>
    {
        const value = activeClosureFixture(t);
        value.write(file, source);
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), expected);
    });
}

test('cleanup retry, resource deadlines, comments and public telemetry are not browser retries or hooks', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tests/browser-contract/renamed-observer.mjs', `
// requestLocale, waitForTimeout and LocaleToggle are documentation, not calls.
export const diagnostic = { qualificationEligible: false, url: '/', htmlLang: 'ja-JP' };
export async function cleanup(remove) {
    for (let attempt=0; attempt<2; attempt++) { await remove(); }
    await new Promise(resolve => setTimeout(resolve, 10));
}
export function observe(page) {
    page.on('console', message => message.type());
    window.addEventListener('fsus:telemetry', event => events.push(event.detail));
    return new Promise((resolve, reject) => setTimeout(() => reject(new Error('deadline')), 10));
}
`);
    assert.equal((await checkPublicShellLocaleLegacyGovernance({ root: value.directory })).status, 'pass');
});

test('active reachability admits unused tool definitions but follows named aliases and exported maps', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tests/browser-contract/renamed-observer.mjs', `
import { plan as currentPlan, actions } from './generic-tool.mjs';
currentPlan(); actions.observe();
`);
    value.write('tests/browser-contract/generic-tool.mjs', `
import { fileURLToPath } from 'node:url';
export function plan() { return { evidenceKind: 'plan' }; }
function observe() { return true; }
export const actions = { observe };
export async function measurement(page) { await page.waitForTimeout(100); }
export async function validateBrowsers(browser) { await browser.launch(); }
export async function importPlugin(entrypoint) { return await import(entrypoint); }
if (process.argv[1] === fileURLToPath(import.meta.url)) { validateBrowsers(browser); importPlugin(dynamicModule); }
`);
    assert.equal((await checkPublicShellLocaleLegacyGovernance({ root: value.directory })).status, 'pass');
    value.write('tests/browser-contract/generic-tool.mjs', `
export function plan() { return { evidenceKind: 'plan' }; }
function observe() { runtime.requestLocale(); }
export const actions = { observe };
`);
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /internal locale call/u);
});

test('active reachability admits single visible candidate selection, not repeated browser actions', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tests/browser-contract/renamed-observer.mjs', `
export async function navigate(links) {
    for (let index=0; index<await links.count(); index++) {
        if (await links.nth(index).isVisible()) {
            await links.nth(index).click(); return;
        }
    }
    throw new Error('no visible navigation');
}
`);
    assert.equal((await checkPublicShellLocaleLegacyGovernance({ root: value.directory })).status, 'pass');
    value.write('tests/browser-contract/renamed-observer.mjs', `
export async function navigate(links) {
    for (let index=0; index<await links.count(); index++) {
        if (await links.nth(index).isVisible()) { await links.nth(index).click(); }
    }
}
`);
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /browser retry/u);
});

test('active reachability admits independently validated non-locale identity, not renamed locale authority', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tests/browser-contract/renamed-observer.mjs', `
import { identity, validate } from './identity-tool.mjs';
validate(identity());
`);
    value.write('tests/browser-contract/identity-tool.mjs', `
export function identity() {
    return { schema: 'example.browser-identity.v1', qualificationEligible: true, managedExecutable: true };
}
export function validate(plan) {
    if (plan.schema !== 'example.browser-identity.v1' || plan.managedExecutable !== true) {
        throw new Error('invalid identity');
    }
}
`);
    assert.equal((await checkPublicShellLocaleLegacyGovernance({ root: value.directory })).status, 'pass');
    value.write('tests/browser-contract/identity-tool.mjs', `
export function identity() { return { schema: 'renamed.locale.v1', qualificationEligible: true }; }
export function validate(plan) { return plan; }
`);
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /compat schema/u);
    for (const validator of [
        "export function validate(plan) { if(plan.schema !== 'renamed.locale.v1') { throw new Error('invalid'); } }",
        "export function validate(plan) { if(plan.schema !== 'renamed.locale.v1' || plan.managedExecutable !== true) { warnings.push('invalid'); } }"
    ])
    {
        value.write('tests/browser-contract/identity-tool.mjs', `
export function identity() { return { schema: 'renamed.locale.v1', qualificationEligible: true, managedExecutable: true }; }
${validator}
`);
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /compat schema/u);
    }
});

test('active reachability rejects selected measurement, dynamic plugin and extra browser execution', async (t) =>
{
    const value = activeClosureFixture(t);
    for (const [source, expected] of [
        ['export async function selected(page) { await page.waitForTimeout(100); }', /browser sleep/u],
        ['export async function selected(entrypoint) { return await import(entrypoint); }', /unresolved active import/u],
        ['export async function selected(browser) { await browser.launch(); }', /second browser launch/u]
    ])
    {
        value.write('tests/browser-contract/renamed-observer.mjs', "import { selected as run } from './generic-tool.mjs'; run();\n");
        value.write('tests/browser-contract/generic-tool.mjs', source);
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), expected);
    }
    value.write('tests/browser-contract/renamed-observer.mjs', "import run from './generic-tool.mjs'; run();\n");
    value.write('tests/browser-contract/generic-tool.mjs', 'export default async function(browser) { await browser.launch(); }');
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /second browser launch/u);
});

test('active current source admits the exact visible-link selection and rejects changed termination or increment', async (t) =>
{
    const value = activeClosureFixture(t);
    const original = fs.readFileSync(path.join(root, 'tests/browser-contract/scenarios.mjs'), 'utf8');
    const start = original.indexOf('async function clickVisiblePublicLink(page, name)');
    const end = original.indexOf('async function publicHydrationHistoryReload(', start);
    assert.ok(start >= 0 && end > start, 'current source function boundaries must exist');
    const actualFunction = original.slice(start, end);
    assert.ok(actualFunction.includes('index += 1'));
    assert.equal(actualFunction.split('return;').length, 2);
    const expose = (source) => `${source}\nclickVisiblePublicLink(page, name);\n`;
    value.write('tests/browser-contract/renamed-observer.mjs', expose(actualFunction));
    assert.equal((await checkPublicShellLocaleLegacyGovernance({ root: value.directory })).status, 'pass');
    for (const changed of [
        actualFunction.replace('return;', 'continue;'),
        actualFunction.replace('index += 1', 'index += 0'),
        actualFunction.replace('index += 1', 'index += step'),
        actualFunction.replace('await links.nth(index).click();', 'await links.nth(index).click(); await links.nth(index).click();')
    ])
    {
        assert.notEqual(changed, actualFunction);
        value.write('tests/browser-contract/renamed-observer.mjs', expose(changed));
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /browser retry/u);
    }
    assert.equal(fs.readFileSync(path.join(root, 'tests/browser-contract/scenarios.mjs'), 'utf8'), original);
});

for (const [label, source, expected] of [
    ['helper data payload', "function moduleURL() { return 'data:text/javascript,globalThis.requestLocale()'; } await import(moduleURL());", /internal locale call/u],
    ['unknown template data payload', 'await import(`data:text/javascript,${unknownPayload}`);', /unresolved active import/u],
    ['constant template data payload', 'const payload = "globalThis.requestLocale()"; await import(`data:text/javascript,${payload}`);', /internal locale call/u],
    ['named browser helper loop', 'async function navigate(page) { await page.goto("/"); } export async function scene(page) { for(let attempt=0;attempt<2;attempt++){ await navigate(page); } }', /browser retry/u],
    ['cyclic browser helper loop', 'async function a(page) { await b(page); } async function b(page) { await page.goto("/"); await a(page); } export async function scene(page) { while(again){ await a(page); } }', /browser retry/u]
])
{
    test(`Feynman closure rejects ${label}`, async (t) =>
    {
        const value = activeClosureFixture(t);
        value.write('tests/browser-contract/renamed-observer.mjs', source);
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), expected);
    });
}

for (const [label, declaration, invocation] of [
    ['parameter process', 'export function selected(process)', 'selected({ argv: [null, "module-path"] });'],
    ['default imported process', 'import process from "./process-shaped.mjs"; export function selected()', 'selected();'],
    ['block process', 'export function selected() { let process; } export function nested(process)', 'nested({ argv: [null, "module-path"] });']
])
{
    test(`Feynman closure rejects shadowed ${label}`, async (t) =>
    {
        const value = activeClosureFixture(t);
        const selected = label === 'block process' ? 'nested' : 'selected';
        value.write('tests/browser-contract/renamed-observer.mjs', `import { ${selected} } from './generic-tool.mjs'; ${invocation}`);
        value.write('tests/browser-contract/process-shaped.mjs', 'export default { argv: [] };');
        value.write('tests/browser-contract/generic-tool.mjs', `
import { fileURLToPath } from 'node:url';
${declaration} {
    if(process.argv[1] === fileURLToPath(import.meta.url)) { globalThis.requestLocale(); }
}
`);
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /internal locale call/u);
    });
}

test('Feynman closure rejects an imported browser helper repeated by a caller loop', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tests/browser-contract/renamed-observer.mjs', `
import { navigate as next } from './navigation-tool.mjs';
export async function scene(page) { for(let attempt=0;attempt<2;attempt++){ await next(page); } }
`);
    value.write('tests/browser-contract/navigation-tool.mjs', 'export async function navigate(page) { await page.goto("/"); }');
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /browser retry/u);
});

for (const [label, validator, caller] of [
    ['same-schema single-field fake locale guard', "if(plan.schema !== 'renamed.locale.v1' || plan.managedExecutable !== true) { throw new Error('invalid'); }", 'validate(identity());'],
    ['unbound fake guard', "if(plan.schema !== 'renamed.locale.v1' || plan.managedExecutable !== true) { throw new Error('invalid'); }", 'identity(); validate(unrelated);'],
    ['non-rejecting conjunction guard', "if(plan.schema !== 'renamed.locale.v1' && plan.managedExecutable !== true) { throw new Error('invalid'); }", 'validate(identity());']
])
{
    test(`Feynman closure rejects ${label}`, async (t) =>
    {
        const value = activeClosureFixture(t);
        value.write('tests/browser-contract/renamed-observer.mjs', `import { identity, validate } from './identity-tool.mjs'; ${caller}`);
        value.write('tests/browser-contract/identity-tool.mjs', `
export function identity() { return { schema: 'renamed.locale.v1', qualificationEligible: true, managedExecutable: true, locale: 'ja-P', status: 'success' }; }
export function validate(plan) { ${validator} }
`);
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /compat schema/u);
    });
}

for (const [label, file, command] of [
    ['CI renamed external runner', '.github/workflows/quality-gate.yml', 'node tools/renamed-browser.mjs'],
    ['lane renamed external runner', 'tools/test/lanes/browser-contract.sh', '"$NODE_BIN" "$ROOT_DIR/tools/renamed-browser.mjs"'],
    ['lane shell external runner', 'tools/test/lanes/browser-contract.sh', 'bash "$ROOT_DIR/tools/renamed-browser.sh"'],
    ['lane unresolved runner', 'tools/test/lanes/browser-contract.sh', '"$NODE_BIN" "$UNKNOWN_WRAPPER"']
])
{
    test(`Feynman closure rejects ${label}`, async (t) =>
    {
        const value = activeClosureFixture(t);
        value.write('tools/renamed-browser.mjs', "import '../tests/browser-contract/run.mjs';");
        value.write('tools/renamed-browser.sh', 'node "$ROOT_DIR/tools/renamed-browser.mjs"\n');
        value.write(file, file.endsWith('.yml')
            ? `jobs:\n    browser-contract:\n        steps:\n            - run: ./tools/test.sh ci-tier browser-contract --no-deps\n            - run: ${command}\n`
            : `node "$ROOT_DIR/tests/browser-contract/run.mjs"\n${command}\n`);
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /runner wrapper|unresolved.*command|command.*exactly once/u);
    });
}

test('Feynman source-backed data loader inspects actual source and fails unknown rewrites closed', async (t) =>
{
    const value = activeClosureFixture(t);
    const model = `
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
const moduleUrls = new Map();
async function load(root) {
    const refs = new Map();
    async function source(relativePath) {
        const bytes = await readFile(path.join(root, relativePath));
        refs.set(relativePath, { path: relativePath });
        return bytes.toString('utf8');
    }
    async function moduleUrl(relativePath, imports = {}) {
        const original = await source(relativePath);
        const identity = original;
        if(moduleUrls.has(identity)) { return moduleUrls.get(identity); }
        let code = stripTypeScriptTypes(original);
        for(const [specifier, replacement] of Object.entries(imports)) {
            code = code.replaceAll(\`'\${specifier}'\`, \`'\${replacement}'\`);
        }
        const url = \`data:text/javascript;base64,\${Buffer.from(code).toString('base64')}\`;
        moduleUrls.set(identity, url);
        return url;
    }
    await import(await moduleUrl('typed-source.ts'));
}
load(root);
`;
    value.write('tests/browser-contract/renamed-observer.mjs', model);
    value.write('typed-source.ts', 'export const observed: boolean = true;');
    const result = await checkPublicShellLocaleLegacyGovernance({ root: value.directory });
    assert.ok(result.activeFiles.includes('typed-source.ts'));
    value.write('typed-source.ts', 'export function changed() { globalThis.requestLocale(); }');
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /internal locale call/u);
    value.write('typed-source.ts', 'export const observed: boolean = true;');
    value.write('tests/browser-contract/renamed-observer.mjs', model.replace(
        'const url =', 'code += "globalThis.requestLocale()"; const url ='));
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /unresolved active import/u);
});

test('Feynman independent non-locale guard must consume the actual claim', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tests/browser-contract/identity-tool.mjs', `
export function identity() { return { schema: 'example.browser-identity.v1', qualificationEligible: true, managedExecutable: true }; }
export function validate(plan) {
    if(plan.schema !== 'example.browser-identity.v1' || plan.managedExecutable !== true) { throw new Error('invalid'); }
}
`);
    value.write('tests/browser-contract/renamed-observer.mjs', "import { identity, validate } from './identity-tool.mjs'; validate(identity());");
    assert.equal((await checkPublicShellLocaleLegacyGovernance({ root: value.directory })).status, 'pass');
    value.write('tests/browser-contract/renamed-observer.mjs', "import { identity, validate } from './identity-tool.mjs'; identity(); validate(unrelated);");
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /compat schema/u);
});

test('Feynman closure rejects mutated global CLI argv including a local argv alias', async (t) =>
{
    const value = activeClosureFixture(t);
    for (const write of [
        'process.argv[1] = fileURLToPath(import.meta.url);',
        'const argv = process.argv; argv[1] = fileURLToPath(import.meta.url);'
    ])
    {
        value.write('tests/browser-contract/renamed-observer.mjs', `
import { fileURLToPath } from 'node:url';
${write}
if(process.argv[1] === fileURLToPath(import.meta.url)) { globalThis.requestLocale(); }
`);
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /internal locale call/u);
    }
});

test('Feynman closure propagates browser actions through helper aliases and namespace imports', async (t) =>
{
    const value = activeClosureFixture(t);
    for (const source of [
        'async function navigate(page) { await page.goto("/"); } const next = navigate; export async function scene(page) { while(again){ await next(page); } }',
        'import * as navigation from "./navigation-tool.mjs"; export async function scene(page) { while(again){ await navigation.navigate(page); } }'
    ])
    {
        value.write('tests/browser-contract/renamed-observer.mjs', source);
        value.write('tests/browser-contract/navigation-tool.mjs', 'export async function navigate(page) { await page.goto("/"); }');
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /browser retry/u);
    }
});

test('Feynman closure inspects every possible helper data payload, not only its first return', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tests/browser-contract/renamed-observer.mjs', `
function moduleURL() {
    if (condition) { return 'data:text/javascript,export const observed = true'; }
    return 'data:text/javascript,globalThis.requestLocale()';
}
await import(moduleURL());
`);
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /internal locale call/u);
});

test('Feynman closure rejects contradictory or observation-only qualification guards', async (t) =>
{
    const value = activeClosureFixture(t);
    for (const validator of [
        "if(plan.schema !== 'example.browser-identity.v1' || plan.managedExecutable !== false) { throw new Error('invalid'); }",
        "if(plan.schema !== 'example.browser-identity.v1') { throw new Error('invalid'); } console.log(plan.managedExecutable);"
    ])
    {
        value.write('tests/browser-contract/identity-tool.mjs', `
export function identity() { return { schema: 'example.browser-identity.v1', qualificationEligible: true, managedExecutable: true }; }
export function validate(plan) { ${validator} }
`);
        value.write('tests/browser-contract/renamed-observer.mjs', "import { identity, validate } from './identity-tool.mjs'; validate(identity());");
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /compat schema/u);
    }
});

test('Feynman closure follows a CI inline dispatch into an external renamed runner', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tools/renamed-browser.mjs', "import '../tests/browser-contract/run.mjs';");
    value.write('.github/workflows/quality-gate.yml', `jobs:
    browser-contract:
        steps:
            - run: ./tools/test.sh ci-tier browser-contract --no-deps
            - run: node -e "import('/tools/renamed-browser.mjs')"
`);
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /runner wrapper/u);
});

test('Feynman source-backed loader rejects replaced bytes and unproven cache payloads', async (t) =>
{
    const value = activeClosureFixture(t);
    const model = `
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
const urls = new Map();
async function load(root) {
    async function source(relativePath) {
        let bytes = await readFile(path.join(root, relativePath));
        return bytes.toString('utf8');
    }
    async function moduleUrl(relativePath) {
        const original = await source(relativePath);
        if(urls.has(relativePath)) { return urls.get(relativePath); }
        let code = stripTypeScriptTypes(original);
        const url = \`data:text/javascript;base64,\${Buffer.from(code).toString('base64')}\`;
        urls.set(relativePath, url);
        return url;
    }
    await import(await moduleUrl('typed-source.ts'));
}
load(root);
`;
    value.write('typed-source.ts', 'export const observed: boolean = true;');
    for (const changed of [
        model.replace('return bytes.toString', 'bytes = Buffer.from("globalThis.requestLocale()"); return bytes.toString'),
        model.replace('const urls = new Map();', 'const urls = injectedCache;').replace('urls.set(relativePath, url);', '')
    ])
    {
        value.write('tests/browser-contract/renamed-observer.mjs', changed);
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /unresolved active import/u);
    }
});

test('Feynman source loader closes extensionless typed imports and helper effects without skipping unresolved sources', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tests/browser-contract/renamed-observer.mjs', "import { selected } from './typed-source'; selected();");
    value.write('tests/browser-contract/typed-source.ts', "import type { Model } from './model'; export function selected() { return true; }");
    value.write('tests/browser-contract/model.ts', 'export interface Model { observed: boolean; }');
    const result = await checkPublicShellLocaleLegacyGovernance({ root: value.directory });
    assert.ok(result.activeFiles.includes('tests/browser-contract/typed-source.ts'));
    assert.ok(result.activeFiles.includes('tests/browser-contract/model.ts'));
    value.write('tests/browser-contract/typed-source.ts', 'export function selected() { globalThis.requestLocale(); }');
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /internal locale call/u);
    value.write('tests/browser-contract/renamed-observer.mjs', `
import { navigate } from './navigation';
export async function scene(page) { while(again) { await navigate(page); } }
`);
    value.write('tests/browser-contract/navigation/index.ts', 'export async function navigate(page: unknown) { await page.goto("/"); }');
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /browser retry/u);
    value.write('tests/browser-contract/renamed-observer.mjs', "import './unknown-typed-source';");
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /missing active regular module/u);
});

test('Feynman followup rejects reassigned and unknown data payload writes', async (t) =>
{
    const value = activeClosureFixture(t);
    for (const write of [
        "payload = 'data:text/javascript,globalThis.requestLocale()';",
        'payload = unknownPayload;',
        "alias = 'data:text/javascript,globalThis.requestLocale()';"
    ])
    {
        value.write('tests/browser-contract/renamed-observer.mjs', `
let payload = 'data:text/javascript,export const harmless = true';
let alias = payload;
${write}
await import(${write.startsWith('alias') ? 'alias' : 'payload'});
`);
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /unresolved active import|internal locale call/u);
    }
});

test('Feynman followup rejects argv escaping to Object.assign or an unknown mutator', async (t) =>
{
    const value = activeClosureFixture(t);
    for (const mutation of [
        'Object.assign(process.argv, { 1: fileURLToPath(import.meta.url) });',
        'const argv = process.argv; mutate(argv);'
    ])
    {
        value.write('tests/browser-contract/renamed-observer.mjs', "import { selected } from './generic-tool.mjs'; selected();");
        value.write('tests/browser-contract/generic-tool.mjs', `
import { fileURLToPath } from 'node:url';
${mutation}
export function selected() { return true; }
if(process.argv[1] === fileURLToPath(import.meta.url)) { globalThis.requestLocale(); }
`);
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /internal locale call/u);
    }
});

test('Feynman followup rejects false or input-dependent conjunction field guards', async (t) =>
{
    const value = activeClosureFixture(t);
    for (const predicate of ['false', 'unrelated'])
    {
        value.write('tests/browser-contract/renamed-observer.mjs', "import { identity, validate } from './identity-tool.mjs'; validate(identity());");
        value.write('tests/browser-contract/identity-tool.mjs', `
export function identity() { return { schema: 'example.browser-identity.v1', qualificationEligible: true, managedExecutable: false }; }
export function validate(plan) {
    if(plan.schema !== 'example.browser-identity.v1') { throw new Error('schema'); }
    if(${predicate} && plan.managedExecutable !== true) { throw new Error('not managed'); }
}
`);
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /compat schema/u);
    }
});

test('Feynman followup closes directly executed shell wrappers and rejects unknown command dispatch', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tools/renamed-browser.sh', 'node "$ROOT_DIR/tools/renamed-browser.mjs"\n');
    value.write('tools/renamed-browser.mjs', "import '../tests/browser-contract/run.mjs';");
    for (const command of ['./tools/renamed-browser.sh', '$EXECUTOR "$WRAPPER"'])
    {
        value.write('.github/workflows/quality-gate.yml', `jobs:
    browser-contract:
        steps:
            - run: ./tools/test.sh ci-tier browser-contract --no-deps
            - run: ${command}
`);
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /runner wrapper|unresolved.*command/u);
    }
});

test('Feynman source-backed loader admits an immutable module URL alias and rejects a rewritten alias', async (t) =>
{
    const value = activeClosureFixture(t);
    const model = `
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
async function load(root) {
    async function source(relativePath) {
        const bytes = await readFile(path.join(root, relativePath));
        return bytes.toString('utf8');
    }
    async function moduleUrl(relativePath) {
        const original = await source(relativePath);
        const code = stripTypeScriptTypes(original);
        const url = \`data:text/javascript;base64,\${Buffer.from(code).toString('base64')}\`;
        return url;
    }
    let url = await moduleUrl('typed-source.ts');
    await import(url);
}
load(root);
`;
    value.write('tests/browser-contract/renamed-observer.mjs', model);
    value.write('typed-source.ts', 'export const observed: boolean = true;');
    const result = await checkPublicShellLocaleLegacyGovernance({ root: value.directory });
    assert.ok(result.activeFiles.includes('typed-source.ts'));
    value.write('tests/browser-contract/renamed-observer.mjs', model.replace('await import(url);', 'url = unknownPayload; await import(url);'));
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /unresolved active import/u);
});

test('Feynman command closure preserves shell identity setup and follows substitution dispatch', async (t) =>
{
    const value = activeClosureFixture(t);
    const setup = `#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "$SOURCE_COMMIT" ||
    -z "$SOURCE_FINGERPRINT" ]]; then
    printf 'identity missing\\n' >&2
    exit 2
fi
node "$ROOT_DIR/tests/browser-contract/run.mjs"
`;
    value.write('tools/test/lanes/browser-contract.sh', setup);
    assert.equal((await checkPublicShellLocaleLegacyGovernance({ root: value.directory })).status, 'pass');
    value.write('tools/renamed-browser.mjs', "import '../tests/browser-contract/run.mjs';");
    value.write('tools/test/lanes/browser-contract.sh', setup.replace('set -euo pipefail', 'set -euo pipefail\nVALUE="$(node tools/renamed-browser.mjs)"'));
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /runner wrapper/u);
});

test('BindingElement URL import declarations do not activate unused helper bodies', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tests/browser-contract/renamed-observer.mjs', `
const { validate, dispatch: unusedDispatch } = await import(new URL('./generic-tool.mjs', import.meta.url));
validate();
`);
    value.write('tests/browser-contract/generic-tool.mjs', `
export function validate() { return true; }
export async function dispatch(entrypoint) { await import(entrypoint); }
`);
    const result = await checkPublicShellLocaleLegacyGovernance({ root: value.directory });
    assert.equal(result.status, 'pass');
    assert.ok(result.activeFiles.includes('tests/browser-contract/generic-tool.mjs'));
    assert.equal(result.browserSpawnCount, 0);
});

test('BindingElement URL import used aliases still activate forbidden helper bodies', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tests/browser-contract/renamed-observer.mjs', `
const { dispatch: selected } = await import(new URL('./generic-tool.mjs', import.meta.url));
const alias = selected;
alias();
`);
    value.write('tests/browser-contract/generic-tool.mjs', 'export function dispatch() { globalThis.requestLocale(); }');
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /internal locale call/u);
});

test('BindingElement URL import used aliases keep unknown dispatch fail closed', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tests/browser-contract/renamed-observer.mjs', `
const { dispatch: selected } = await import(new URL('./generic-tool.mjs', import.meta.url));
const alias = selected;
alias(unknownEntrypoint);
`);
    value.write('tests/browser-contract/generic-tool.mjs', 'export async function dispatch(entrypoint) { await import(entrypoint); }');
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /unresolved active import/u);
});

test('BindingElement URL import still inspects module initialization and computed binding keys', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tests/browser-contract/renamed-observer.mjs', `
const { dispatch: unusedDispatch } = await import(new URL('./generic-tool.mjs', import.meta.url));
`);
    value.write('tests/browser-contract/generic-tool.mjs', 'globalThis.requestLocale(); export function dispatch() { return true; }');
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /internal locale call/u);
    value.write('tests/browser-contract/generic-tool.mjs', 'export function dispatch() { return true; }');
    value.write('tests/browser-contract/renamed-observer.mjs', `
const { [globalThis.requestLocale()]: unusedDispatch } = await import(new URL('./generic-tool.mjs', import.meta.url));
`);
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /internal locale call/u);
});

test('current provider CLI URL identity does not activate an imported dispatcher', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tests/browser-contract/renamed-observer.mjs', "import { selected } from './generic-tool.mjs'; selected();");
    value.write('tests/browser-contract/generic-tool.mjs', `
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
export function selected() { return true; }
async function main() { await import(unknownEntrypoint); }
const isMain = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) { await main(); }
`);
    const result = await checkPublicShellLocaleLegacyGovernance({ root: value.directory });
    assert.equal(result.status, 'pass');
    assert.ok(result.activeFiles.includes('tests/browser-contract/generic-tool.mjs'));
});

test('current BehaviorDoc CLI path identity does not activate an imported dispatcher', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tests/browser-contract/renamed-observer.mjs', "import { selected } from './generic-tool.mjs'; selected();");
    value.write('tests/browser-contract/generic-tool.mjs', `
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
const directFile = fileURLToPath(import.meta.url);
export function selected() { return true; }
async function main() { await import(unknownEntrypoint); }
if (process.argv[1] && path.resolve(process.argv[1]) === directFile) { await main(); }
`);
    assert.equal((await checkPublicShellLocaleLegacyGovernance({ root: value.directory })).status, 'pass');
});

test('current CLI identity pruning refuses shadowed tools mutated aliases and ineffective guards', async (t) =>
{
    const value = activeClosureFixture(t);
    value.write('tests/browser-contract/renamed-observer.mjs', "import { selected } from './generic-tool.mjs'; selected();");
    const model = `
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
export function selected() { return true; }
async function main() { await import(unknownEntrypoint); }
let isMain = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) { await main(); }
`;
    for (const changed of [
        model.replace('if (isMain)', 'isMain = unknownIdentity; if (isMain)'),
        model.replace("import path from 'node:path';", 'const path = { resolve(value) { return value; } };'),
        model.replace("import { pathToFileURL } from 'node:url';", 'function pathToFileURL(value) { return { href: value }; }'),
        model.replace('&& pathToFileURL', '|| pathToFileURL'),
        model.replace('let isMain', 'path.resolve = unknownResolver; let isMain'),
        model.replace('let isMain', 'Object.assign(path, replacement); let isMain'),
        model.replace('if (isMain)', 'Object.assign(process.argv, replacement); if (isMain)'),
        model.replace('if (isMain)', 'mutate(process.argv); if (isMain)')
    ])
    {
        value.write('tests/browser-contract/generic-tool.mjs', changed);
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /unresolved active import/u);
    }
});

test('current CLI identity leaves a genuinely selected dispatcher and else branch fail closed', async (t) =>
{
    const value = activeClosureFixture(t);
    const model = `
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
export function selected() { return true; }
export async function dispatch() { await import(unknownEntrypoint); }
const isMain = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) { await dispatch(); }
`;
    value.write('tests/browser-contract/generic-tool.mjs', model);
    value.write('tests/browser-contract/renamed-observer.mjs', `
const { dispatch: selected } = await import(new URL('./generic-tool.mjs', import.meta.url));
selected();
`);
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /unresolved active import/u);
    value.write('tests/browser-contract/renamed-observer.mjs', "import { selected } from './generic-tool.mjs'; selected();");
    value.write('tests/browser-contract/generic-tool.mjs', `${model}\nelse { await dispatch(); }`);
    await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /unresolved active import/u);
});

const destructuredCliModel = `
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
export function selected() { return true; }
async function main() { await import(unknownEntrypoint); }
let isMain = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
WRITE_TARGET
if (isMain) { await main(); }
`;

for (const [label, write] of [
    ['array', '[isMain] = [true];'],
    ['object', '({ value: isMain } = { value: true });'],
    ['shorthand', '({ isMain } = { isMain: true });'],
    ['nested array', '[[isMain]] = [[true]];'],
    ['nested object', '({ outer: { value: isMain } } = { outer: { value: true } });'],
    ['array rest', '[...[isMain]] = [true];'],
    ['object rest', '({...isMain} = { value: true });'],
    ['array default', '[isMain = true] = [];'],
    ['object default', '({ value: isMain = true } = {});'],
    ['nested default', '({ value: [isMain = true] } = { value: [] });']
])
{
    test(`destructured CLI write rejects ${label} alias reassignment`, async (t) =>
    {
        const value = activeClosureFixture(t);
        value.write('tests/browser-contract/renamed-observer.mjs', "import { selected } from './generic-tool.mjs'; selected();");
        value.write('tests/browser-contract/generic-tool.mjs', destructuredCliModel.replace('WRITE_TARGET', write));
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /unresolved active import/u);
    });
}

for (const [label, write] of [
    ['array builtin property', '[path.resolve] = [unknownResolver];'],
    ['object builtin property', '({ resolve: path.resolve } = replacement);'],
    ['nested builtin property', '({ outer: [path.resolve] } = replacement);'],
    ['argv element', '[process.argv[1]] = [unknownIdentity];']
])
{
    test(`destructured CLI write rejects ${label} mutation`, async (t) =>
    {
        const value = activeClosureFixture(t);
        value.write('tests/browser-contract/renamed-observer.mjs', "import { selected } from './generic-tool.mjs'; selected();");
        value.write('tests/browser-contract/generic-tool.mjs', destructuredCliModel.replace('WRITE_TARGET', write));
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /unresolved active import/u);
    });
}

for (const [label, write] of [
    ['unchanged let', ''],
    ['property keys and default reads', 'let scratch; ({ isMain: scratch } = { isMain: true }); [scratch = isMain] = [];'],
    ['shadowed binding', 'function assign(isMain) { [isMain] = [true]; return isMain; } assign(false);'],
    ['element index read', 'const values = []; [values[isMain ? 1 : 0]] = [true];']
])
{
    test(`destructured CLI write preserves ${label} identity`, async (t) =>
    {
        const value = activeClosureFixture(t);
        value.write('tests/browser-contract/renamed-observer.mjs', "import { selected } from './generic-tool.mjs'; selected();");
        value.write('tests/browser-contract/generic-tool.mjs', destructuredCliModel.replace('WRITE_TARGET', write));
        assert.equal((await checkPublicShellLocaleLegacyGovernance({ root: value.directory })).status, 'pass');
    });
}

for (const [label, write] of [
    ['scalar of', 'for (isMain of [true]) {}'],
    ['scalar in', 'for (isMain in { selected: true }) {}'],
    ['array of', 'for ([isMain] of [[true]]) {}'],
    ['object of', 'for ({ value: isMain } of [{ value: true }]) {}'],
    ['builtin of', 'for (path.resolve of [unknownResolver]) {}'],
    ['nested builtin of', 'for ({ value: [path.resolve] } of replacement) {}'],
    ['argv of', 'for (process.argv[1] of [unknownIdentity]) {}'],
    ['argv in', 'for (process.argv[1] in { selected: true }) {}']
])
{
    test(`loop CLI write rejects ${label} target`, async (t) =>
    {
        const value = activeClosureFixture(t);
        value.write('tests/browser-contract/renamed-observer.mjs', "import { selected } from './generic-tool.mjs'; selected();");
        value.write('tests/browser-contract/generic-tool.mjs', destructuredCliModel.replace('WRITE_TARGET', write));
        await assert.rejects(checkPublicShellLocaleLegacyGovernance({ root: value.directory }), /unresolved active import/u);
    });
}

for (const [label, write] of [
    ['declared let loop local', 'for (let isMain of [true]) { [isMain] = [false]; }'],
    ['declared const loop local', 'for (const isMain in { selected: true }) { void isMain; }'],
    ['shadowed parameter', 'function assign(isMain) { for (isMain of [true]) {} } assign(false);'],
    ['readonly iterable and key', 'let scratch; for (scratch of [isMain]) {} for (scratch in { [isMain]: true }) {}'],
    ['readonly target key and index', 'let scratch; const values = []; for ({ [isMain]: scratch } of [{}]) {} for (values[isMain ? 1 : 0] of [true]) {}']
])
{
    test(`loop CLI write preserves ${label} identity`, async (t) =>
    {
        const value = activeClosureFixture(t);
        value.write('tests/browser-contract/renamed-observer.mjs', "import { selected } from './generic-tool.mjs'; selected();");
        value.write('tests/browser-contract/generic-tool.mjs', destructuredCliModel.replace('WRITE_TARGET', write));
        assert.equal((await checkPublicShellLocaleLegacyGovernance({ root: value.directory })).status, 'pass');
    });
}
