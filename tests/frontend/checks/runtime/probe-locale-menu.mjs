import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runnerFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(runnerFile), '../../../..');
const probeRoot = path.join(repositoryRoot, 'tests/frontend/fixtures/localeMenuProbe');
const { createFsusUiAliases, resolveLocalFsusUiRoot } = await import(
    pathToFileURL(path.join(repositoryRoot, 'src/frontend/scripts/fsusui-local.ts'))
);
const [mode, dependencyRootArgument, evidenceRootArgument] = process.argv.slice(2);
if (!['local', 'published'].includes(mode) || !dependencyRootArgument || !evidenceRootArgument)
{
    throw new Error('usage: node probe-locale-menu.mjs local|published DEPENDENCY_ROOT EVIDENCE_ROOT');
}
const dependencyRoot = path.resolve(dependencyRootArgument);
const evidenceRoot = path.resolve(evidenceRootArgument);
const requireDependency = createRequire(path.join(dependencyRoot, 'package.json'));
const localRoot = mode === 'local' ? resolveLocalFsusUiRoot() : null;
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const report = {
    schema: 'fsusblog.locale-menu-api-probe.v1',
    runId: `locale-menu-${mode}-${new Date().toISOString()}`,
    mode,
    blogCommit: git(repositoryRoot, 'rev-parse', 'HEAD'),
    blogStatus: git(repositoryRoot, 'status', '--short'),
    localRoot,
    localCommit: localRoot ? git(localRoot, 'rev-parse', 'HEAD') : null,
    localTree: localRoot ? git(localRoot, 'rev-parse', 'HEAD^{tree}') : null,
    localStatus: localRoot ? git(localRoot, 'status', '--short') : null,
    nodeVersion: process.version,
    harnessDigests: {},
    authorityDigests: {},
    observations: {},
    errors: [],
    qualification: false
};
await fs.mkdir(evidenceRoot, { recursive: true });
for (const file of [...['App.vue', 'main.ts', 'index.html'].map((name) => path.join(probeRoot, name)), runnerFile])
{
    report.harnessDigests[path.relative(repositoryRoot, file)] = sha256(await fs.readFile(file));
}
if (localRoot)
{
    for (const name of [
        '.agents/skills/fsusui-design-conformance/SKILL.md',
        'docs/design.md',
        'docs/design/governance.md',
        'docs/design/change-classification.md',
        'docs/workflows/visual-change.md',
        'docs/consumers/design-integration.md',
        'docs/components/dropdown.md',
        'docs/components/menu.md',
        'docs/components/select.md',
        'docs/api-stability.md'
    ])
    {
        report.authorityDigests[name] = sha256(await fs.readFile(path.join(localRoot, name)));
    }
}
let server;
let browser;
try
{
    if (mode === 'published')
    {
        const packagePath = path.join(dependencyRoot, 'node_modules/@ozwasyd/element-plus/package.json');
        const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
        report.packageVersion = packageJson.version;
        if (packageJson.version !== '1.5.1')
        {
            throw new Error(`locked published version is 1.5.1, installed ${packageJson.version}`);
        }
    }
    const { createServer } = await import(pathToFileURL(requireDependency.resolve('vite')));
    const { default: vue } = await import(pathToFileURL(requireDependency.resolve('@vitejs/plugin-vue')));
    const { chromium, expect } = requireDependency('@playwright/test');
    server = await createServer({
        configFile: false,
        root: probeRoot,
        plugins: [vue()],
        resolve: {
            dedupe: ['vue'],
            alias: [
                ...createFsusUiAliases(localRoot),
                { find: /^vue$/, replacement: path.join(dependencyRoot, 'node_modules/vue/dist/vue.runtime.esm-bundler.js') },
                ...(mode === 'published' ? [{
                    find: /^@ozwasyd\/element-plus$/,
                    replacement: path.join(dependencyRoot, 'node_modules/@ozwasyd/element-plus')
                }, {
                    find: /^@ozwasyd\/element-plus\/(.+)$/,
                    replacement: `${path.join(dependencyRoot, 'node_modules/@ozwasyd/element-plus')}/$1`
                }] : [])
            ]
        },
        server: { host: '127.0.0.1', port: 0, fs: { allow: [repositoryRoot, dependencyRoot, ...(localRoot ? [localRoot] : [])] } }
    });
    await server.listen();
    browser = await chromium.launch({ headless: true });
    report.browserVersion = browser.version();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(5000);
    page.on('pageerror', (error) => report.errors.push(error.message));
    await page.goto(server.resolvedUrls.local[0]);
    const probe = (name) => page.locator(`[data-probe="${name}"]`);
    const state = async () => JSON.parse(await probe('state').textContent());
    const focused = async (name) => probe(name).evaluate((element) => globalThis.document.activeElement === element);
    const settleMenu = async () => probe('menu').evaluate(async (menu) =>
    {
        const animations = globalThis.document.getAnimations().filter((animation) =>
        {
            const target = animation.effect?.target;
            return target instanceof globalThis.Element && (target.contains(menu) || menu.contains(target));
        });
        await Promise.allSettled(animations.map((animation) => animation.finished));
    });
    await expect(probe('trigger')).toBeVisible();
    await probe('manual-open').click();
    await expect(probe('menu')).toBeVisible();
    report.observations.publicOpen = (await state()).visible;
    report.observations.triggerAssociation = await probe('trigger').evaluate((element) => ({
        expanded: element.getAttribute('aria-expanded'),
        controls: element.getAttribute('aria-controls'),
        haspopup: element.getAttribute('aria-haspopup')
    }));
    report.observations.radioItem = await probe('english').evaluate((element) => ({
        role: element.getAttribute('role'), checked: element.getAttribute('aria-checked')
    }));
    await probe('manual-close').click();
    await expect(probe('menu')).not.toBeAttached();
    report.observations.publicClose = !(await state()).visible;
    await probe('trigger').focus();
    await page.keyboard.press('Enter');
    await expect(probe('menu')).toBeVisible();
    try
    {
        await expect(probe('menu')).toBeFocused({ timeout: 1500 });
        await page.keyboard.press('ArrowDown');
        await expect(probe('english')).toBeFocused({ timeout: 1500 });
        report.observations.keyboardEntry = true;
    }
    catch
    {
        report.observations.keyboardEntry = false;
        await probe('trigger').click();
        await expect(probe('menu')).toBeVisible();
        await probe('english').focus();
    }
    const keys = {};
    for (const [key, target] of [['ArrowDown', 'japanese'], ['End', 'link-item'], ['Home', 'english'], ['ArrowUp', 'link-item']])
    {
        await page.keyboard.press(key);
        try
        {
            await expect(probe(target)).toBeFocused({ timeout: 1500 });
            keys[key] = true;
        }
        catch
        {
            keys[key] = false;
        }
    }
    report.observations.keyboard = keys;
    await probe('japanese').focus();
    await page.keyboard.press('Enter');
    await expect(probe('item-pending')).toBeVisible();
    report.observations.pendingOpen = (await state()).visible;
    report.observations.commandKeepsUrl = new URL(page.url()).hash === '';
    report.observations.commandsAfterEnter = (await state()).commands;
    await page.keyboard.press('Space');
    report.observations.commandsAfterSpace = (await state()).commands;
    await page.screenshot({ path: path.join(evidenceRoot, 'pending.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(probe('menu')).not.toBeAttached();
    report.observations.escapeFocusReturn = await focused('trigger');
    await probe('trigger').click();
    await expect(probe('menu')).toBeVisible();
    await settleMenu();
    await probe('outside').click();
    try
    {
        await expect(probe('menu')).not.toBeVisible({ timeout: 1500 });
        report.observations.outsideClose = !(await state()).visible;
    }
    catch
    {
        report.observations.outsideClose = false;
    }
    report.observations.outsideFocus = await page.evaluate(() => globalThis.document.activeElement?.getAttribute('data-probe'));
    await probe('manual-close').click();
    await expect(probe('menu')).not.toBeAttached();
    await probe('fail').click();
    await probe('trigger').click();
    await expect(probe('retry')).toBeVisible();
    await probe('retry').focus();
    await page.keyboard.press('Enter');
    report.observations.retryCommand = (await state()).commands.at(-1);
    report.observations.retryOpen = (await state()).visible;
    await probe('disabled-item').click({ force: true });
    report.observations.disabledItemIgnored = !(await state()).commands.includes('disabled');
    await probe('link-item').focus();
    await page.keyboard.press('Enter');
    report.observations.linkKeyboardHash = new URL(page.url()).hash;
    await probe('link').click();
    report.observations.linkPointerHash = new URL(page.url()).hash;
    report.observations.linkPointerCommand = (await state()).commands.at(-1);
    await page.screenshot({ path: path.join(evidenceRoot, 'error-retry.png'), fullPage: true });
    await probe('outside').click();
    await probe('manual-close').click();
    await expect(probe('menu')).not.toBeAttached();
    await probe('disable').click();
    report.observations.triggerDisabled = await probe('trigger').isDisabled();
    await probe('trigger').click({ force: true });
    report.observations.disabledOpen = (await state()).visible;
    await page.getByRole('combobox').click();
    await page.getByRole('option', { name: '日本語' }).click();
    await expect(page.getByRole('option', { name: '日本語' })).not.toBeVisible();
    report.observations.selectAfterActivation = JSON.parse(await probe('select-state').textContent());
    try
    {
        await expect(probe('select-retry')).not.toBeVisible({ timeout: 1500 });
        report.observations.selectRetryReachable = false;
    }
    catch
    {
        report.observations.selectRetryReachable = true;
    }
    await probe('alternative-trigger').focus();
    await page.keyboard.press('Enter');
    await expect(probe('alternative-menu')).toBeVisible();
    report.observations.menuAlternativeRole = await probe('menu-alternative').getAttribute('role');
    await page.keyboard.press('ArrowDown');
    try
    {
        await expect(probe('menu-alternative')).toBeFocused({ timeout: 1500 });
        report.observations.menuAlternativeKeyboardEntry = true;
    }
    catch
    {
        report.observations.menuAlternativeKeyboardEntry = false;
    }
    report.observations.menuAlternativeOpenAfterArrow = await probe('alternative-menu').isVisible();
    if (!report.observations.menuAlternativeOpenAfterArrow)
    {
        await probe('alternative-trigger').click();
        await expect(probe('alternative-menu')).toBeVisible();
    }
    await probe('menu-alternative').focus();
    await page.keyboard.press('ArrowDown');
    try
    {
        await expect(probe('menu-alternative-next')).toBeFocused({ timeout: 1500 });
        report.observations.menuAlternativeArrowDown = true;
    }
    catch
    {
        report.observations.menuAlternativeArrowDown = false;
    }
    await page.screenshot({ path: path.join(evidenceRoot, 'menu-alternative.png'), fullPage: true });
    await browser.close();
    browser = null;
    const observations = report.observations;
    report.failures = [
        ...(observations.radioItem.role !== 'menuitemradio' ? ['dropdown-single-selection-role'] : []),
        ...(!observations.escapeFocusReturn ? ['escape-focus-return'] : []),
        ...(!observations.keyboardEntry ? ['keyboard-entry'] : []),
        ...(!observations.pendingOpen ? ['pending-popup-retention'] : []),
        ...(!observations.outsideClose ? ['outside-close'] : []),
        ...(observations.linkKeyboardHash !== '#linked-locale' ? ['public-url-command-adapter'] : []),
        ...Object.entries(observations.keyboard).filter(([, passed]) => !passed).map(([key]) => `keyboard-${key}`),
        ...(!observations.disabledItemIgnored ? ['disabled-item-activation'] : [])
    ];
    report.status = report.failures.length ? 'capability-gap' : 'probe-passed';
    process.exitCode = report.failures.length ? 2 : 0;
    report.observedCoverage = 'minimal public API/DOM probe; no product UX acceptance';
}
catch (error)
{
    report.status = 'blocked';
    report.errors.push(error.stack ?? error.message);
    process.exitCode = 3;
}
finally
{
    await browser?.close();
    await server?.close();
    await fs.writeFile(path.join(evidenceRoot, 'probe.json'), `${JSON.stringify(report, null, 4)}\n`);
    console.log(JSON.stringify({ status: report.status, report: path.join(evidenceRoot, 'probe.json'), observations: report.observations, errors: report.errors }, null, 4));
}
