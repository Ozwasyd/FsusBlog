import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const generator = path.join(root, 'tools/contracts/generate-locale-catalog.mjs')
const checker = path.join(root, 'tools/contracts/check-locale-catalog.mjs')
const sourceCatalog = path.join(root, 'src/shared/Contracts/Localization/locale-catalog.json')
const frontendRoot = path.join(root, 'src/frontend')
const tsc = path.join(frontendRoot, 'node_modules/.bin/tsc')

const generatorFails = async (mutate) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-locale-catalog-'))
  try {
    const catalogPath = path.join(directory, 'locale-catalog.json')
    const catalog = JSON.parse(await readFile(sourceCatalog, 'utf8'))
    mutate(catalog)
    await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`)
    return spawnSync('node', [generator, '--check', '--catalog', catalogPath], { cwd: root, encoding: 'utf8' })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

const checkerRejectsMutation = async (relative, mutate) => {
  const target = path.join(root, relative)
  const original = await readFile(target, 'utf8')
  try {
    await writeFile(target, mutate(original))
    const result = spawnSync('node', [checker], { cwd: root, encoding: 'utf8' })
    assert.notEqual(result.status, 0, `${relative} mutation unexpectedly passed`)
  } finally { await writeFile(target, original) }
}

test('catalog generator rejects duplicate and incomplete metadata', async () => {
  const duplicate = await generatorFails((catalog) => { catalog.locales[1].code = catalog.locales[0].code })
  assert.notEqual(duplicate.status, 0)
  const missing = await generatorFails((catalog) => { delete catalog.locales[0].openGraphLocale })
  assert.notEqual(missing.status, 0)
  const dependencyLeak = await generatorFails((catalog) => { catalog.locales[0].bundleLoader = './zh-CN' })
  assert.notEqual(dependencyLeak.status, 0)
})

test('real consumer mutations fail closed', async () => {
  execFileSync('node', [checker], { cwd: root, stdio: 'inherit' })
  await checkerRejectsMutation('src/frontend/src/locales/bundleLoader.ts', (source) => source.replace("    'ru-RU': () => import('./ru-RU').then(m => m.ruRU)\n", ''))
  await checkerRejectsMutation('src/frontend/src/locales/bundleLoader.ts', (source) => source.replace("    'ru-RU': () => import('./ru-RU').then(m => m.ruRU)\n", "    'ru-RU': () => import('./ru-RU').then(m => m.ruRU),\n    'x-test': () => import('./ru-RU').then(m => m.ruRU)\n"))
  await checkerRejectsMutation('src/frontend/src/locales/documentMetadata.ts', (source) => source.replace('descriptor.openGraphLocale', "locale.replace('-', '_')"))
  await checkerRejectsMutation('src/frontend/src/locales/localeCatalog.ts', (source) => source.replace('LOCALE_CATALOG_DIGEST =', 'LOCALE_CATALOG_DIGEST_MUTATED ='))
  await checkerRejectsMutation('src/shared/Contracts/Localization/LocaleCatalog.g.cs', (source) => source.replace('public const string Digest', 'public const string CatalogDigest'))
  await checkerRejectsMutation('src/frontend/src/locales/index.ts', (source) => `${source}\nconst untrustedLocale = 'x-test' as SupportedLocale\nvoid untrustedLocale\n`)
  await checkerRejectsMutation('src/backend/Infrastructure/Fonts/FontLoadingPlanner.cs', (source) => source.replace('LocaleCatalog.Enabled.ToDictionary(', 'new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal).ToDictionary('))
})

const compileFixture = async (source) => {
  const directory = await mkdtemp(path.join(frontendRoot, '.locale-catalog-typecheck-'))
  try {
    const fixture = path.join(directory, 'consumer.ts')
    await writeFile(fixture, source)
    return spawnSync(tsc, [fixture, '--ignoreConfig', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck'], { cwd: frontendRoot, encoding: 'utf8' })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test('real TypeScript consumers accept the catalog union and reject an eleventh locale', async () => {
  const positive = await compileFixture(`import type { SupportedLocale } from '../src/locales/localeCatalog.js'\nconst values: readonly SupportedLocale[] = ['zh-CN', 'en-US', 'zh-Hant', 'ja-JP', 'ko-KR', 'es-419', 'fr-FR', 'de-DE', 'pt-BR', 'ru-RU']\nvoid values\n`)
  assert.equal(positive.status, 0, `${positive.stdout}\n${positive.stderr}`)
  const eleventh = await compileFixture(`import type { SupportedLocale } from '../src/locales/localeCatalog.js'\nconst invalid: SupportedLocale = 'x-test'\nvoid invalid\n`)
  assert.notEqual(eleventh.status, 0, 'the TypeScript compiler accepted an eleventh locale')
})

test('TranslationKey is exact for the current zh-CN tree and rejects arbitrary strings', async () => {
  const positive = await compileFixture(`import type { TranslationKey } from '../src/locales/keys.js'\nconst known: TranslationKey = 'common.actions.save'\nvoid known\n`)
  assert.equal(positive.status, 0, `${positive.stdout}\n${positive.stderr}`)
  const arbitrary = await compileFixture(`import type { TranslationKey } from '../src/locales/keys.js'\nconst invalid: TranslationKey = 'untrusted.translation.key'\nvoid invalid\n`)
  assert.notEqual(arbitrary.status, 0, 'the TypeScript compiler accepted an arbitrary translation key')
})

test('PluralTranslationKey is exactly never for the current zh-CN tree and DeepStringShape preserves plural leaves', async () => {
  const exactCurrentCatalog = await compileFixture(`import type { PluralTranslationKey } from '../src/locales/keys.js'\ntype Assert<T extends true> = T\ntype IsExactly<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends (<T>() => T extends Right ? 1 : 2) ? ((<T>() => T extends Right ? 1 : 2) extends (<T>() => T extends Left ? 1 : 2) ? true : false) : false\ntype CurrentCatalogHasNoPluralLeaves = Assert<IsExactly<PluralTranslationKey, never>>\nvoid (null as unknown as CurrentCatalogHasNoPluralLeaves)\n`)
  assert.equal(exactCurrentCatalog.status, 0, `${exactCurrentCatalog.stdout}\n${exactCurrentCatalog.stderr}`)
  const arbitrary = await compileFixture(`import type { PluralTranslationKey } from '../src/locales/keys.js'\nconst impossible: PluralTranslationKey = 'untrusted.plural.key'\nvoid impossible\n`)
  assert.notEqual(arbitrary.status, 0, 'the TypeScript compiler accepted an arbitrary plural translation key')
  const positive = await compileFixture(`import type { DeepStringShape, PluralMessage } from '../src/locales/keys.js'\ntype Fixture = { ordinary: 'ordinary'; plural: PluralMessage }\nconst translated: DeepStringShape<Fixture> = { ordinary: 'translated', plural: { zero: '0', one: '1', two: '2', few: 'few', many: 'many', other: 'other' } }\nvoid translated\n`)
  assert.equal(positive.status, 0, `${positive.stdout}\n${positive.stderr}`)
  const ordinaryPlural = await compileFixture(`import type { DeepStringShape } from '../src/locales/keys.js'\ntype Fixture = { ordinary: 'ordinary' }\nconst invalid: DeepStringShape<Fixture> = { ordinary: { zero: '0', one: '1', two: '2', few: 'few', many: 'many', other: 'other' } }\nvoid invalid\n`)
  assert.notEqual(ordinaryPlural.status, 0, 'the TypeScript compiler accepted a plural message for an ordinary leaf')
})
