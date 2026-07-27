import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../../..')
const self = relative(root, import.meta.filename)
const trackedFiles = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file && file !== self && existsSync(resolve(root, file)))
    .filter((file) => /^(?:src|tests|docs|tools)\//u.test(file))
    .filter((file) => /\.(?:[cm]?[jt]sx?|vue|css|json|md|ya?ml)$/u.test(file))

const zh = 'zh' + '-CN'
const en = 'en' + '-US'
const retiredSymbols = [
    'is' + 'English',
    'toggle' + 'Locale',
    'Locale' + 'Toggle',
    'fsusblog-locale-' + 'toggle',
    'previous' + 'Locale',
    'toggle' + 'Label',
    'compact' + 'Label',
]

const violations = []
for (const file of trackedFiles) {
    const source = readFileSync(resolve(root, file), 'utf8')
    for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) violations.push(`${file}: retired locale artifact ${symbol}`)
    }

    const explicitBinaryComparison = new RegExp(`(?:activeLocale|locale)\\.value\\s*(?:===|!==)\\s*['\"](?:${zh}|${en})['\"]`, 'u')
    const binaryCycle = new RegExp(`\\[\\s*['\"]${zh}['\"]\\s*,\\s*['\"]${en}['\"]\\s*\\].{0,120}%\\s*2`, 'su')
    const renamedBinaryBoolean = new RegExp(`(?:const|let)\\s+\\w+\\s*=\\s*computed\\s*\\(\\s*\\(\\s*\\)\\s*=>\\s*(?:activeLocale|locale)\\.value\\s*===`, 'u')
    const twoItemLocaleMenu = new RegExp(`(?:options|items|locales)\\s*[:=]\\s*\\[.{0,120}['\"]${zh}['\"].{0,120}['\"]${en}['\"]`, 'su')
    if (explicitBinaryComparison.test(source)) violations.push(`${file}: binary locale comparison`)
    if (binaryCycle.test(source)) violations.push(`${file}: binary locale cycle`)
    if (renamedBinaryBoolean.test(source)) violations.push(`${file}: derived binary locale boolean`)
    if (twoItemLocaleMenu.test(source)) violations.push(`${file}: temporary two-item locale menu`)
}

const runtimePath = 'src/frontend/src/locales/index.ts'
const runtime = readFileSync(resolve(root, runtimePath), 'utf8')
if (/from\s+['"]\.\/zh-CN\//u.test(runtime)) {
    violations.push(`${runtimePath}: runtime must not statically carry zh-CN critical domains`)
}
if (!/export async function requestLocale\(value: SupportedLocale\)/u.test(runtime)) {
    violations.push(`${runtimePath}: explicit locale request must accept SupportedLocale`)
}
if (!/export \{ localeState as activeLocale \}/u.test(runtime)) {
    violations.push(`${runtimePath}: current locale must be exposed as activeLocale`)
}
if (!runtime.includes('getLocaleDescriptor')) {
    violations.push(`${runtimePath}: locale display metadata must remain catalog-descriptor backed`)
}
if (!/export async function prepareLocaleDomains[\s\S]*?Promise<PreparedLocaleDomains>/u.test(runtime)
    || !/export async function beginLocaleRouteTransaction/u.test(runtime)) {
    violations.push(`${runtimePath}: locale domains must use pure snapshots and explicit route transactions`)
}

for (const relativePath of [
    'src/frontend/src/App.vue',
    'src/frontend/src/layouts/AccountLayout.vue',
    'src/frontend/src/layouts/PublicAuthLayout.vue',
    'src/frontend/src/components/public/PublicBlogLayoutShell.vue'
]) {
    const source = readFileSync(resolve(root, relativePath), 'utf8')
    if (/initializeLocaleRuntime/u.test(source)) {
        violations.push(`${relativePath}: locale initialization must complete before render, not in a component lifecycle`)
    }
}

const hydrationPath = 'src/frontend/src/public-renderers/clientHydrate.ts'
const hydration = readFileSync(resolve(root, hydrationPath), 'utf8')
const hydrationInitialization = hydration.indexOf('await initializeLocaleRuntime(')
const hydrationMount = hydration.indexOf('app.mount(container, true)')
if (hydrationInitialization < 0 || hydrationMount < 0 || hydrationInitialization > hydrationMount) {
    violations.push(`${hydrationPath}: resolved locale domains must be ready before hydration mount`)
}

const evidencePath = 'tools/frontend/check-locale-domain-bundles.mjs'
const evidence = readFileSync(resolve(root, evidencePath), 'utf8')
if (/initialCritical|new Set\(\['zh-CN\/common'/u.test(evidence)) {
    violations.push(`${evidencePath}: evidence must not hard-code zh-CN as the resolved initial graph`)
}

if (violations.length > 0) {
    throw new Error(`locale API erasure failed:\n${violations.join('\n')}`)
}

execFileSync(process.execPath, [
    resolve(root, 'tests/frontend/checks/static/check-route-title-contract.mjs')
], { cwd: root, stdio: 'inherit' })

console.log(`[locale-api-erasure] checked ${trackedFiles.length} tracked files`)
