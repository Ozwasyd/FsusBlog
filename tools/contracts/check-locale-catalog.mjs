import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const catalog = JSON.parse(await readFile(path.join(root, 'src/shared/Contracts/Localization/locale-catalog.json'), 'utf8'))
const expectedKeys = new Set(catalog.locales.filter((locale) => locale.status === 'enabled').map((locale) => locale.code))

export function assertExactKeys(name, actualKeys) {
  const actual = new Set(actualKeys)
  const missing = [...expectedKeys].filter((key) => !actual.has(key))
  const extra = [...actual].filter((key) => !expectedKeys.has(key))
  if (missing.length || extra.length) throw new Error(`${name} drift: missing=[${missing.join(',')}] extra=[${extra.join(',')}]`)
}

const extractObjectKeys = (source, symbol) => {
  const match = source.match(new RegExp(`(?:const|export const)\\s+${symbol}[\\s\\S]*?\\s=\\s*\\{([\\s\\S]*?)\\}\\s+as const`, 'u'))
  if (!match) throw new Error(`cannot locate ${symbol}`)
  return [...match[1].matchAll(/^\s*'([^']+)'\s*:/gmu)].map((item) => item[1])
}

const assertIncludes = (source, token, message) => { if (!source.includes(token)) throw new Error(message) }

const productionLocaleAssertionFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const children = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return productionLocaleAssertionFiles(target)
    return /\.(?:ts|tsx|vue)$/u.test(entry.name) ? [target] : []
  }))
  return children.flat()
}

const assertNoForcedSupportedLocale = async () => {
  for (const file of await productionLocaleAssertionFiles(path.join(root, 'src/frontend/src'))) {
    if (/\bas\s+(?:Readonly<)?SupportedLocale\b/u.test(await readFile(file, 'utf8'))) {
      throw new Error(`production locale assertion bypass: ${path.relative(root, file)}`)
    }
  }
}

export async function checkLocaleCatalog() {
  execFileSync('node', ['tools/contracts/generate-locale-catalog.mjs', '--check'], { cwd: root, stdio: 'inherit' })
  const [loaders, fonts, runtime, metadata, serverFonts, serverAot, keys] = await Promise.all([
    readFile(path.join(root, 'src/frontend/src/locales/bundleLoader.ts'), 'utf8'),
    readFile(path.join(root, 'src/frontend/src/bootstrap/fontLoadingPlanner.ts'), 'utf8'),
    readFile(path.join(root, 'src/frontend/src/locales/index.ts'), 'utf8'),
    readFile(path.join(root, 'src/frontend/src/locales/documentMetadata.ts'), 'utf8'),
    readFile(path.join(root, 'src/backend/Infrastructure/Fonts/FontLoadingPlanner.cs'), 'utf8'),
    readFile(path.join(root, 'src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs'), 'utf8'),
    readFile(path.join(root, 'src/frontend/src/locales/keys.ts'), 'utf8')
  ])
  assertExactKeys('locale bundle loader', extractObjectKeys(loaders, 'LOCALE_BUNDLE_LOADERS'))
  assertExactKeys('locale font mapping', extractObjectKeys(fonts, 'LOCALE_FACES'))
  assertIncludes(runtime, "export { ENABLED_LOCALES } from './localeCatalog'", 'locale selector inventory must project catalog enabled locales')
  assertIncludes(serverAot, 'LocaleCatalog.Default.DocumentLanguage', 'server document language must consume generated catalog metadata')
  assertIncludes(serverAot, 'LocaleCatalog.Default.OpenGraphLocale', 'server OpenGraph locale must consume generated catalog metadata')
  assertIncludes(metadata, 'descriptor.openGraphLocale', 'document metadata must consume descriptor OpenGraph locale')
  if (/\.replace\s*\(/u.test(metadata)) throw new Error('documentMetadata must not derive OpenGraph locale by string replacement')
  assertIncludes(serverFonts, 'LocaleCatalog.Enabled.ToDictionary(', 'server font mapping must project the generated enabled inventory')
  if (/\["(?:zh-CN|en-US|zh-Hant|ja-JP|ko-KR|es-419|fr-FR|de-DE|pt-BR|ru-RU)"\]/u.test(serverFonts)) throw new Error('server font mapping must not maintain a second locale inventory')
  const traditional = catalog.locales.find((locale) => locale.code === 'zh-Hant')
  if (!traditional || traditional.openGraphLocale !== 'zh_TW' || traditional.code === 'zh-TW') throw new Error('zh-Hant must remain distinct from OpenGraph zh_TW metadata')
  const forbidden = [
    ['LOCALE', 'REGISTRY'].join('_'), ['REGISTRY', 'BY', 'CODE'].join('_'), ['ACTIVE', 'LOCALES'].join('_'),
    ['AVAILABLE', 'LOCALES'].join('_'), ['cast', 'Supported'].join(''), ['Deep', 'LocaleShape'].join(''),
    ['TranslationKey', 'string'].join(' = '), ['LocaleMessages', 'Record<string, unknown>'].join(' = ')
  ]
  const haystack = `${loaders}\n${runtime}\n${metadata}\n${keys}`
  for (const token of forbidden) if (haystack.includes(token)) throw new Error(`forbidden legacy locale surface: ${token}`)
  await assertNoForcedSupportedLocale()
}

await checkLocaleCatalog()
console.log('[locale-catalog] consumer projections are in sync')
