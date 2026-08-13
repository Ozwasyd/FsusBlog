#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const frontendRoot = resolve(root, 'src/frontend/src');
const errors = [];
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const parse = (path) => JSON.parse(read(path));

function fail(message)
{
    errors.push(message);
}

function walk(directory)
{
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    {
        const absolute = resolve(directory, entry.name);
        return entry.isDirectory() ? walk(absolute) : [absolute];
    });
}

const matrixPath = 'tests/frontend/fixtures/layout-archetype-matrix.json';
const ledgerPath = 'tests/frontend/fixtures/layout-visual-change-ledger.json';
const visualSnapshotRoot = resolve(root, 'tests/frontend/e2e/visual');
const matrix = parse(matrixPath);
const ledger = parse(ledgerPath);

for (const absolute of walk(visualSnapshotRoot))
{
    const path = relative(root, absolute).replaceAll('\\', '/');
    if (path.endsWith('-chrome-linux.png'))
    {
        fail(`${path}: branded Chrome snapshots are forbidden; use the canonical chromium project identity`);
    }
}

const expectedArchetypes = new Set([
    'public/feed',
    'public/reading',
    'public/index',
    'public/document',
    'public/filter-search',
    'identity/identity-settings',
    'identity/inbox-takeover',
    'admin/dashboard',
    'admin/collection',
    'admin/form',
    'admin/settings',
    'admin/console'
]);
const actualArchetypes = new Set();
const labels = new Set();
const paths = new Set();

if (matrix.version !== 'fsusblog-layout-archetype-matrix-v1' || matrix.sourceIssue !== 1313)
{
    fail(`${matrixPath}: invalid version or source issue`);
}
for (const entry of matrix.archetypes ?? [])
{
    const id = `${entry.surface}/${entry.kind}`;
    if (actualArchetypes.has(id))
    {
        fail(`${matrixPath}: duplicate archetype ${id}`);
    }
    if (labels.has(entry.label))
    {
        fail(`${matrixPath}: duplicate label ${entry.label}`);
    }
    if (paths.has(entry.path))
    {
        fail(`${matrixPath}: duplicate path ${entry.path}`);
    }
    actualArchetypes.add(id);
    labels.add(entry.label);
    paths.add(entry.path);
    for (const field of ['path', 'label', 'primary', 'screenshotTarget'])
    {
        if (typeof entry[field] !== 'string' || entry[field].length === 0)
        {
            fail(`${matrixPath}: ${id} is missing ${field}`);
        }
    }
    if (typeof entry.snapshot !== 'boolean' || typeof entry.critical !== 'boolean')
    {
        fail(`${matrixPath}: ${id} must declare snapshot and critical booleans`);
    }
    if (entry.critical && !entry.snapshot)
    {
        fail(`${matrixPath}: critical archetype ${id} must own a stable screenshot`);
    }
}
for (const id of expectedArchetypes)
{
    if (!actualArchetypes.has(id))
    {
        fail(`${matrixPath}: missing ${id}`);
    }
}
for (const value of ['desktop', 'mobile'])
{
    if (!matrix.coverage?.viewports?.includes(value))
    {
        fail(`${matrixPath}: missing ${value} viewport coverage`);
    }
}
for (const value of ['light', 'dark'])
{
    if (!matrix.coverage?.themes?.includes(value))
    {
        fail(`${matrixPath}: missing ${value} theme coverage`);
    }
}
for (const value of ['reduced-motion', 'high-contrast'])
{
    if (!matrix.coverage?.media?.includes(value))
    {
        fail(`${matrixPath}: missing ${value} media coverage`);
    }
}
for (const value of ['keyboard', 'focus-visible', 'hit-targets', 'horizontal-overflow', 'aot-hydration-parity'])
{
    if (!matrix.coverage?.contracts?.includes(value))
    {
        fail(`${matrixPath}: missing ${value} contract`);
    }
}

const classifications = new Set([
    'visual-equivalent-refactor',
    'expected-harmonization',
    'required-accessibility-ergonomic-correction',
    'unintended-regression'
]);
if (ledger.version !== 'fsusblog-layout-visual-change-ledger-v1' || ledger.sourceIssue !== 1313)
{
    fail(`${ledgerPath}: invalid version or source issue`);
}
if (new Set(ledger.classifications ?? []).size !== classifications.size
  || [...classifications].some((classification) => !ledger.classifications?.includes(classification)))
{
    fail(`${ledgerPath}: classification policy must expose exactly the four approved states`);
}
const ledgerIssues = new Set();
for (const entry of ledger.entries ?? [])
{
    ledgerIssues.add(entry.issue);
    if (!classifications.has(entry.classification))
    {
        fail(`${ledgerPath}: issue #${entry.issue} has invalid classification ${entry.classification}`);
    }
    if (!Array.isArray(entry.archetypes) || entry.archetypes.length === 0)
    {
        fail(`${ledgerPath}: issue #${entry.issue} has no affected archetype`);
    }
    for (const id of entry.archetypes ?? [])
    {
        if (!actualArchetypes.has(id))
        {
            fail(`${ledgerPath}: issue #${entry.issue} references unknown ${id}`);
        }
    }
    if (typeof entry.rationale !== 'string' || entry.rationale.trim().length < 20)
    {
        fail(`${ledgerPath}: issue #${entry.issue} needs an evidence rationale`);
    }
}
for (let issue = 1303; issue <= 1312; issue += 1)
{
    if (!ledgerIssues.has(issue))
    {
        fail(`${ledgerPath}: dependency #${issue} is not classified`);
    }
}

const sourceFiles = walk(frontendRoot)
    .filter((path) => ['.css', '.scss', '.ts', '.vue'].includes(extname(path)));
const publicShellOwner = 'src/frontend/src/components/public/PublicBlogLayoutShell.vue';
for (const absolute of sourceFiles)
{
    const path = relative(root, absolute).replaceAll('\\', '/');
    const source = readFileSync(absolute, 'utf8');
    if (path !== publicShellOwner && /\.el-public-shell__[a-z0-9_-]+/u.test(source))
    {
        fail(`${path}: depends on an internal PublicShell BEM selector outside ${publicShellOwner}`);
    }
    if (/(?:class|token|data-[\w-]+)\s*=\s*["'][^"']*(?:apple|linear)[-_](?:style|design|layout|shell|page)/iu.test(source))
    {
        fail(`${path}: contains prohibited Apple/Linear visual naming`);
    }
    if (/defineOptions\s*\(\s*\{[^}]*name:\s*["']FsusUi/isu.test(source)
    || /defineComponent\s*\(\s*\{[^}]*name:\s*["']FsusUi/isu.test(source))
    {
        fail(`${path}: declares a misleading local FsusUi implementation`);
    }
}

for (const path of [
    'src/frontend/src/components/user/ProfileSettingsPrimitives.ts',
    'src/frontend/src/components/account/AccountPageHeader.vue',
    'src/frontend/src/components/account/FsusUiPageHeader.vue'
])
{
    if (existsSync(resolve(root, path)))
    {
        fail(`${path}: retired local generic primitive must stay deleted`);
    }
}

for (const path of [
    'src/frontend/src/layouts/AccountLayout.vue',
    'src/frontend/src/layouts/AccountIdentityFrame.vue',
    'src/frontend/src/layouts/AccountRouteFrame.vue',
    'src/frontend/src/layouts/AdminWorkspaceFrame.vue',
    'src/frontend/src/layouts/accountPageKind.ts',
    'src/frontend/src/layouts/accountRouteMotion.ts'
])
{
    const source = read(path);
    if (/route\.name\s*(?:===|!==|==|!=)|switch\s*\(\s*route\.name|(?:pageKind|contentMode|motionPolicy|contentClasses)\s*=.*route\.name/isu.test(source)
    || /Manage(?:Dashboard|WriteArticle|EditArticle|Settings)|User(?:Profile|Message)/u.test(source))
    {
        fail(`${path}: account frame visual policy must not branch on route names`);
    }
}

const publicVisual = read('tests/frontend/e2e/visual/public-visual.spec.ts');
const consoleVisual = read('tests/frontend/e2e/visual/console-visual.spec.ts');
for (const [path, source, token] of [
    ['tests/frontend/e2e/visual/public-visual.spec.ts', publicVisual, 'PUBLIC_LAYOUT_ARCHETYPES'],
    ['tests/frontend/e2e/visual/console-visual.spec.ts', consoleVisual, 'IDENTITY_LAYOUT_ARCHETYPES'],
    ['tests/frontend/e2e/visual/console-visual.spec.ts', consoleVisual, 'ADMIN_LAYOUT_ARCHETYPES']
])
{
    if (!source.includes(token))
    {
        fail(`${path}: must consume ${token}`);
    }
}
for (const token of ['assertFocusOutlineVisible', 'assertTouchTargetSize', "'reduced-motion'", "'high-contrast'"])
{
    if (!`${publicVisual}\n${consoleVisual}`.includes(token))
    {
        fail(`visual matrix is missing ${token}`);
    }
}

const packageJson = JSON.parse(read('src/frontend/package.json'));
const expectedScript = 'node ../../tests/frontend/checks/static/check-layout-archetype-governance.mjs';
if (packageJson.scripts?.['check:layout-archetype-governance'] !== expectedScript)
{
    fail('src/frontend/package.json: missing check:layout-archetype-governance script');
}
if (!String(packageJson.scripts?.['check:views-constraints'] ?? '').includes('check:layout-archetype-governance'))
{
    fail('src/frontend/package.json: check:views-constraints must run layout archetype governance');
}
if (!read('tests/matrix.yml').includes('id: "layout-archetype-governance"'))
{
    fail('tests/matrix.yml: frontend static lane must run layout archetype governance');
}

if (errors.length > 0)
{
    console.error(errors.map((error) => `[layout-archetype-governance] ${error}`).join('\n'));
    process.exit(1);
}

console.log(`[layout-archetype-governance] ok archetypes=${actualArchetypes.size} ledger=${ledgerIssues.size}`);
