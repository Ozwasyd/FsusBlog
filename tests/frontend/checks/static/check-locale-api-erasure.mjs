import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const self = relative(root, import.meta.filename);
const trackedFiles = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file && file !== self && existsSync(resolve(root, file)))
    .filter((file) => /^(?:src|tests|docs|tools)\//u.test(file))
    .filter((file) => /\.(?:[cm]?[jt]sx?|vue|css|json|md|ya?ml)$/u.test(file));

const zh = 'zh' + '-CN';
const en = 'en' + '-US';
const retiredSymbols = [
    'is' + 'English',
    'toggle' + 'Locale',
    'Locale' + 'Toggle',
    'fsusblog-locale-' + 'toggle',
    'previous' + 'Locale',
    'toggle' + 'Label',
    'compact' + 'Label',
    'initializeLocaleRuntime',
    'applyLocale',
    'performSwitch',
    'activeSwitch',
    'fsus:locale-change'
];
const retiredPatterns = [
    /\bsetLocale\b/u
];

const violations = [];
for (const file of trackedFiles)
{
    const source = readFileSync(resolve(root, file), 'utf8');
    for (const symbol of retiredSymbols)
    {
        if (source.includes(symbol))
        {
            violations.push(`${file}: retired locale artifact ${symbol}`);
        }
    }
    for (const pattern of retiredPatterns)
    {
        if (pattern.test(source))
        {
            violations.push(`${file}: retired locale artifact ${pattern}`);
        }
    }

    const explicitBinaryComparison = new RegExp(`(?:activeLocale|locale)\\.value\\s*(?:===|!==)\\s*['"](?:${zh}|${en})['"]`, 'u');
    const binaryCycle = new RegExp(`\\[\\s*['"]${zh}['"]\\s*,\\s*['"]${en}['"]\\s*\\].{0,120}%\\s*2`, 'su');
    const renamedBinaryBoolean = new RegExp(`(?:const|let)\\s+\\w+\\s*=\\s*computed\\s*\\(\\s*\\(\\s*\\)\\s*=>\\s*(?:activeLocale|locale)\\.value\\s*===`, 'u');
    const twoItemLocaleMenu = new RegExp(`(?:options|items|locales)\\s*[:=]\\s*\\[.{0,120}['"]${zh}['"].{0,120}['"]${en}['"]`, 'su');
    if (explicitBinaryComparison.test(source))
    {
        violations.push(`${file}: binary locale comparison`);
    }
    if (binaryCycle.test(source))
    {
        violations.push(`${file}: binary locale cycle`);
    }
    if (renamedBinaryBoolean.test(source))
    {
        violations.push(`${file}: derived binary locale boolean`);
    }
    if (twoItemLocaleMenu.test(source))
    {
        violations.push(`${file}: temporary two-item locale menu`);
    }
}

const runtimePath = 'src/frontend/src/locales/index.ts';
const runtime = readFileSync(resolve(root, runtimePath), 'utf8');
if (/from\s+['"]\.\/zh-CN\//u.test(runtime))
{
    violations.push(`${runtimePath}: runtime must not statically carry zh-CN critical domains`);
}
if (!/requestLocale/u.test(runtime))
{
    violations.push(`${runtimePath}: explicit locale request must remain exported`);
}
if (!/activeLocale/u.test(runtime))
{
    violations.push(`${runtimePath}: current locale must be exposed as activeLocale`);
}
if (!runtime.includes('getLocaleDescriptor'))
{
    violations.push(`${runtimePath}: locale display metadata must remain catalog-descriptor backed`);
}
if (!/prepareLocaleDomains/u.test(runtime)
    || !/beginLocaleRouteTransaction/u.test(runtime)
    || !/activateLocaleRuntime/u.test(runtime))
{
    violations.push(`${runtimePath}: locale domains must use pure snapshots, activation, and explicit route transactions`);
}
if (/CustomEvent|fsus:locale-change|localStorage|sessionStorage/u.test(runtime))
{
    violations.push(`${runtimePath}: locale surface must not host CustomEvent or storage authorities`);
}

const coordinatorPath = 'src/frontend/src/locales/runtime/localeRuntimeCoordinator.ts';
const coordinator = readFileSync(resolve(root, coordinatorPath), 'utf8');
for (const banned of [
    "from 'vue'",
    'from "vue"',
    '@/router',
    'pinia',
    'document.cookie',
    '@/api/',
    '@/bootstrap/fontPreparationPort',
    '@/services/localePreferenceCommandPort'
])
{
    if (coordinator.includes(banned))
    {
        violations.push(`${coordinatorPath}: coordinator must not depend on ${banned}`);
    }
}
if (/\blocalStorage\b|\bsessionStorage\b/u.test(coordinator))
{
    violations.push(`${coordinatorPath}: coordinator must not depend on browser storage APIs`);
}
if (!/domainBundlePort/u.test(coordinator)
    || !/fontPreparationPort/u.test(coordinator)
    || !/preferenceCommitPort/u.test(coordinator)
    || !/metadataPort/u.test(coordinator)
    || !/telemetryPort/u.test(coordinator))
{
    violations.push(`${coordinatorPath}: coordinator must inject domain, font, preference, metadata, and telemetry ports`);
}

const compositionPath = 'src/frontend/src/locales/runtime/localeRuntimeComposition.ts';
const composition = readFileSync(resolve(root, compositionPath), 'utf8');
if (!/LocaleRuntimeCoordinator/u.test(composition)
    || !/prepareLocaleFonts/u.test(composition)
    || !/preferenceCommitPort/u.test(composition))
{
    violations.push(`${compositionPath}: composition must wire coordinator with domain and font ports`);
}

const fontPreparationPath = 'src/frontend/src/bootstrap/fontPreparationPort.ts';
const fontPreparation = readFileSync(resolve(root, fontPreparationPath), 'utf8');
if (/from\s+['"]@\/locales(?:\/index)?['"]/u.test(fontPreparation))
{
    violations.push(`${fontPreparationPath}: font preparation must not depend on the locale runtime index`);
}
const retiredLocaleSetter = ['set', 'Locale'].join('');
if (new RegExp(
    `prepareLocaleDomains|syncLocaleDocumentMetadata|${retiredLocaleSetter}|router|vue|localStorage|sessionStorage|fetch\\(`,
    'u'
).test(fontPreparation))
{
    violations.push(`${fontPreparationPath}: font preparation must remain catalog-only without runtime, router, framework, storage, or fetch dependencies`);
}
for (const catalogImport of [
    "from '@/locales/localeFontCatalog'",
    "from '@/locales/localeCatalog'"
])
{
    if (!fontPreparation.includes(catalogImport))
    {
        violations.push(`${fontPreparationPath}: font preparation must import ${catalogImport}`);
    }
}

const fontCutoverPaths = [
    fontPreparationPath,
    'src/frontend/src/bootstrap/codeFontPreparation.ts',
    'src/frontend/src/bootstrap/nonCriticalResources.ts',
    'src/frontend/src/bootstrap/entry.ts',
    'src/frontend/src/locales/localeFontCatalog.ts',
    'tools/contracts/generate-locale-catalog.mjs'
];
const fontCutoverSources = fontCutoverPaths.map((path) => readFileSync(resolve(root, path), 'utf8')).join('\n');
for (const forbidden of [
    'zh-TW',
    'BUNDLED_FONT_LOADING_PLAN',
    'selectBundledDeferredFonts',
    'loadBundledFonts',
    'recordCriticalFontPlan',
    'fsus:font-loading-evidence',
    'LOCALE_FACES',
    'DEFERRED_FACES'
])
{
    if (fontCutoverSources.includes(forbidden))
    {
        violations.push(`locale font cutover sources must not retain ${forbidden}`);
    }
}
if (/trigger\s*[:=]\s*['"]idle['"]/u.test(fontCutoverSources))
{
    violations.push('locale font cutover sources must not retain the retired idle trigger');
}
for (const retiredPath of [
    'src/frontend/src/bootstrap/fontLoadingPlanner.ts',
    'src/frontend/src/bootstrap/criticalFonts.ts'
])
{
    if (existsSync(resolve(root, retiredPath)))
    {
        violations.push(`${retiredPath}: retired locale font compatibility loader must be deleted`);
    }
}
const nonCriticalResourcesPath = 'src/frontend/src/bootstrap/nonCriticalResources.ts';
const nonCriticalResources = readFileSync(resolve(root, nonCriticalResourcesPath), 'utf8');
if (!/prepareCodeFonts/u.test(nonCriticalResources))
{
    violations.push(`${nonCriticalResourcesPath}: non-critical resources must prepare visible code fonts`);
}
if (/prepareLocaleFonts|hans\.css|hant\.css|jpan\.css|kore\.css/u.test(nonCriticalResources))
{
    violations.push(`${nonCriticalResourcesPath}: non-critical resources must not preload locale fonts`);
}

const localeSelectorPaths = [
    'src/frontend/src/components/i18n/LocaleSelectorRuntimeAdapter.vue',
    'src/frontend/src/components/i18n/useLocaleSelectorRuntime.ts'
];
const selectorRetiredSymbols = [
    'Locale' + 'Toggle',
    'locale' + 'Override',
    'locale' + 'RuntimeReady',
    'get' + 'LocaleMessages',
    'initialize' + 'LocaleRuntime'
];
for (const path of localeSelectorPaths)
{
    const source = readFileSync(resolve(root, path), 'utf8');
    if (/PublicBlogLayoutShell|PublicAuthLayout|AccountLayout|vue-router|@\/router/u.test(source))
    {
        violations.push(`${path}: locale selector must not know host layouts or routing`);
    }
    for (const symbol of selectorRetiredSymbols)
    {
        if (source.includes(symbol))
        {
            violations.push(`${path}: locale selector must not retain ${symbol}`);
        }
    }
    if (/localStorage|sessionStorage|document\.cookie/u.test(source))
    {
        violations.push(`${path}: locale selector must not own browser preference storage`);
    }
}
const localeSelectorComposablePath = localeSelectorPaths[1];
const localeSelectorComposable = readFileSync(resolve(root, localeSelectorComposablePath), 'utf8');
for (const requiredProjection of ['requestLocalePreference', 'projectLocaleSelectorItems'])
{
    if (!localeSelectorComposable.includes(requiredProjection))
    {
        violations.push(`${localeSelectorComposablePath}: locale selector must retain ${requiredProjection}`);
    }
}

const publicBlogLayoutShellPath = 'src/frontend/src/components/public/PublicBlogLayoutShell.vue';
const publicBlogLayoutShell = readFileSync(resolve(root, publicBlogLayoutShellPath), 'utf8');
if ((publicBlogLayoutShell.match(/LocaleSelectorRuntimeAdapter/gu) ?? []).length < 2)
{
    violations.push(`${publicBlogLayoutShellPath}: public chrome must mount the locale selector adapter in both responsive entries`);
}
for (const symbol of selectorRetiredSymbols)
{
    if (publicBlogLayoutShell.includes(symbol))
    {
        violations.push(`${publicBlogLayoutShellPath}: public chrome must not retain ${symbol}`);
    }
}
if (/\brequestLocale\b|requestLocalePreference|localeRuntimeState|ENABLED_LOCALES/u.test(publicBlogLayoutShell))
{
    violations.push(`${publicBlogLayoutShellPath}: public chrome must not own locale runtime switching`);
}
for (const retiredImport of [
    /from\s+['"]@\/locales\/runtime/u,
    /from\s+['"]@\/services\/localePreference/u,
    /from\s+['"]@\/locales\/localeDomainBundleStore/u
])
{
    if (retiredImport.test(publicBlogLayoutShell))
    {
        violations.push(`${publicBlogLayoutShellPath}: public chrome must not import a retired locale owner`);
    }
}

for (const relativePath of [
    'src/frontend/src/App.vue',
    'src/frontend/src/layouts/AccountLayout.vue',
    'src/frontend/src/layouts/PublicAuthLayout.vue',
    'src/frontend/src/components/public/PublicBlogLayoutShell.vue'
])
{
    const source = readFileSync(resolve(root, relativePath), 'utf8');
    if (/activateLocaleRuntime/u.test(source))
    {
        violations.push(`${relativePath}: locale initialization must complete before render, not in a component lifecycle`);
    }
}

const accountLayoutPath = 'src/frontend/src/layouts/AccountLayout.vue';
const accountLayout = readFileSync(resolve(root, accountLayoutPath), 'utf8');
if (!/LocaleSelectorRuntimeAdapter/u.test(accountLayout))
{
    violations.push(`${accountLayoutPath}: account/admin chrome must mount LocaleSelectorRuntimeAdapter`);
}
if ((accountLayout.match(/LocaleSelectorRuntimeAdapter/gu) ?? []).length < 2)
{
    violations.push(`${accountLayoutPath}: account/admin chrome must mount the locale selector adapter in both responsive entries`);
}
if (!/<LocaleSelectorRuntimeAdapter\s+compact\s*\/>/u.test(accountLayout))
{
    violations.push(`${accountLayoutPath}: account/admin mobile chrome must retain the compact locale selector adapter`);
}
const accountRetiredOwners = [
    'Locale' + 'PreferenceHeaderSelector',
    'Locale' + 'Toggle',
    'initialize' + 'LocaleRuntime',
    'localePreferenceCommandPort'
];
for (const symbol of accountRetiredOwners)
{
    if (accountLayout.includes(symbol))
    {
        violations.push(`${accountLayoutPath}: account/admin chrome must not own ${symbol}`);
    }
}
if (/\brequestLocale\b|requestLocalePreference|localeRuntimeState|ENABLED_LOCALES/u.test(accountLayout))
{
    violations.push(`${accountLayoutPath}: account/admin chrome must not own locale switching state or commands`);
}
for (const retiredImport of [
    /from\s+['"]@\/locales(?:\/runtime)?['"]/u,
    /from\s+['"]@\/services\/localePreference/u,
    /from\s+['"]@\/locales\/localeDomainBundleStore/u,
    /from\s+['"]@\/locales\/localeCatalog/u
])
{
    if (retiredImport.test(accountLayout))
    {
        violations.push(`${accountLayoutPath}: account/admin chrome must not import a retired locale owner`);
    }
}
const accountShellPath = 'src/frontend/src/assets/account-shell-base.css';
const accountShell = readFileSync(resolve(root, accountShellPath), 'utf8');
if (!/\.account-site-header__actions\s+\.locale-selector__trigger/u.test(accountShell))
{
    violations.push(`${accountShellPath}: account chrome must retain the locale selector trigger styling hook`);
}
const accountNavPath = 'src/frontend/src/layouts/accountNav.ts';
const accountNav = readFileSync(resolve(root, accountNavPath), 'utf8');
if (!/\/user\/preferences\/language/u.test(accountNav) || !/languageAndRegion/u.test(accountNav))
{
    violations.push(`${accountNavPath}: account navigation must retain the language and region route`);
}
const retiredPreferenceHeader = resolve(
    root,
    'src/frontend/src/components/account/' + ('Locale' + 'PreferenceHeaderSelector') + '.vue'
);
if (existsSync(retiredPreferenceHeader))
{
    violations.push(`${relative(root, retiredPreferenceHeader)}: temporary account preference header selector must be deleted`);
}

const hydrationPath = 'src/frontend/src/public-renderers/clientHydrate.ts';
const hydration = readFileSync(resolve(root, hydrationPath), 'utf8');
const hydrationInitialization = hydration.indexOf('await activateLocaleRuntime(');
const hydrationMount = hydration.indexOf('app.mount(container, true)');
if (hydrationInitialization < 0 || hydrationMount < 0 || hydrationInitialization > hydrationMount)
{
    violations.push(`${hydrationPath}: resolved locale domains must be ready before hydration mount`);
}

const evidencePath = 'tools/frontend/check-locale-domain-bundles.mjs';
const evidence = readFileSync(resolve(root, evidencePath), 'utf8');
if (/initialCritical|new Set\(\['zh-CN\/common'/u.test(evidence))
{
    violations.push(`${evidencePath}: evidence must not hard-code zh-CN as the resolved initial graph`);
}

if (violations.length > 0)
{
    throw new Error(`locale API erasure failed:\n${violations.join('\n')}`);
}

execFileSync(process.execPath, [
    resolve(root, 'tests/frontend/checks/static/check-route-title-contract.mjs')
], { cwd: root, stdio: 'inherit' });

console.log(`[locale-api-erasure] checked ${trackedFiles.length} tracked files`);
