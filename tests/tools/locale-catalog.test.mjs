import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const generator = path.join(root, 'tools/contracts/generate-locale-catalog.mjs');
const checker = path.join(root, 'tools/contracts/check-locale-catalog.mjs');
const sourceCatalog = path.join(root, 'src/shared/Contracts/Localization/locale-catalog.json');
const frontendRoot = path.join(root, 'src/frontend');
const tsc = path.join(frontendRoot, 'node_modules/.bin/tsc');

const generatorFails = async (mutate) =>
{
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-locale-catalog-'));
    try
    {
        const catalogPath = path.join(directory, 'locale-catalog.json');
        const catalog = JSON.parse(await readFile(sourceCatalog, 'utf8'));
        mutate(catalog);
        await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`);
        return spawnSync('node', [generator, '--check', '--catalog', catalogPath], { cwd: root, encoding: 'utf8' });
    }
    finally
    {
        await rm(directory, { recursive: true, force: true });
    }
};

const checkerRejectsMutation = async (relative, mutate) =>
{
    const target = path.join(root, relative);
    const original = await readFile(target, 'utf8');
    try
    {
        const mutated = mutate(original);
        assert.notEqual(mutated, original, `${relative} negative fixture did not change the source`);
        await writeFile(target, mutated);
        const result = spawnSync('node', [checker], { cwd: root, encoding: 'utf8' });
        assert.notEqual(result.status, 0, `${relative} mutation unexpectedly passed`);
    }
    finally
    {
        await writeFile(target, original);
    }
};

test('catalog generator rejects duplicate and incomplete metadata', async () =>
{
    const duplicate = await generatorFails((catalog) =>
    {
        catalog.locales[1].code = catalog.locales[0].code;
    });
    assert.notEqual(duplicate.status, 0);
    const missing = await generatorFails((catalog) =>
    {
        delete catalog.locales[0].openGraphLocale;
    });
    assert.notEqual(missing.status, 0);
    const dependencyLeak = await generatorFails((catalog) =>
    {
        catalog.locales[0].bundleLoader = './zh-CN';
    });
    assert.notEqual(dependencyLeak.status, 0);
});

test('canonical generator preserves byte parity and repeated generation for existing projections', async () =>
{
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-locale-generator-replay-'));
    const outputs = [
        'src/frontend/src/locales/localeCatalog.ts',
        'src/frontend/src/locales/localeFontCatalog.ts',
        'src/shared/Contracts/Localization/LocaleCatalog.g.cs'
    ];
    try
    {
        for (const relative of ['tools/contracts/generate-locale-catalog.mjs',
            'src/shared/Contracts/Localization/locale-catalog.json', ...outputs])
        {
            const destination = path.join(directory, relative);
            await mkdir(path.dirname(destination), { recursive: true });
            await writeFile(destination, await readFile(path.join(root, relative)));
        }
        const replayGenerator = path.join(directory, 'tools/contracts/generate-locale-catalog.mjs');
        for (let generation = 0; generation < 2; generation += 1)
        {
            execFileSync('node', [replayGenerator], { cwd: directory });
            for (const relative of outputs)
            {
                const emitted = await readFile(path.join(directory, relative));
                assert.ok(emitted.equals(await readFile(path.join(root, relative))), `canonical output drift: ${relative}`);
            }
        }
        execFileSync('node', [replayGenerator, '--check'], { cwd: directory });
    }
    finally
    {
        await rm(directory, { recursive: true, force: true });
    }
});

test('real consumer mutations fail closed', async () =>
{
    execFileSync('node', [checker], { cwd: root, stdio: 'inherit' });
    await checkerRejectsMutation('src/frontend/src/locales/localeDomainBundleStore.ts', (source) => source.replace("  'ru-RU': loadersFor('ru-RU', {", "  'ru-RU-removed': loadersFor('ru-RU', {"));
    await checkerRejectsMutation('src/frontend/src/locales/localeDomainBundleStore.ts', (source) => source.replace("    errors: () => import('./ru-RU/errors')", "    errors: () => import('./en-US/errors')"));
    await checkerRejectsMutation('src/frontend/src/locales/localeDomainBundleStore.ts', (source) => source.replace(
        "import { ENABLED_LOCALES, isSupportedLocale, type SupportedLocale } from './localeCatalog'",
        "import { ENABLED_LOCALES, isSupportedLocale, type SupportedLocale } from './localeCatalog'\nvoid import('./ru-RU')"
    ));
    await checkerRejectsMutation('src/frontend/src/locales/localeDomains.ts', (source) => source.replace("  'errors'\n", "  'errors',\n  'future'\n"));
    await checkerRejectsMutation('src/frontend/src/locales/documentMetadata.ts', (source) => source.replace('descriptor.openGraphLocale', "locale.replace('-', '_')"));
    await checkerRejectsMutation('src/frontend/src/locales/localeCatalog.ts', (source) => source.replace('LOCALE_CATALOG_DIGEST =', 'LOCALE_CATALOG_DIGEST_MUTATED ='));
    await checkerRejectsMutation('src/shared/Contracts/Localization/LocaleCatalog.g.cs', (source) => source.replace('public const string Digest', 'public const string CatalogDigest'));
    await checkerRejectsMutation('src/frontend/src/locales/index.ts', (source) => `${source}\nconst untrustedLocale = 'x-test' as SupportedLocale\nvoid untrustedLocale\n`);
    await checkerRejectsMutation('src/backend/Infrastructure/Fonts/FontLoadingPlanner.cs', (source) => source.replace('LocaleCatalog.Enabled.ToDictionary(', 'new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal).ToDictionary('));
    await checkerRejectsMutation('src/frontend/src/locales/localeFontCatalog.ts', (source) => source.replace('"zh-Hant"', '"zh-TW"').replace('"Hant"', '"Hans"'));
    await checkerRejectsMutation('src/frontend/src/bootstrap/fontPreparationPort.ts', (source) => source.replace("from '@/locales/localeFontCatalog'", "from '@/locales'\nimport { getLocaleFontDescriptor, LOCALE_FONT_CATALOG_DIGEST, LOCALE_FONT_WEIGHTS, type LocaleFontScript, type LocaleFontWeight } from '@/locales/localeFontCatalog'"));
    await checkerRejectsMutation('src/frontend/src/bootstrap/nonCriticalResources.ts', (source) => `${source}\nvoid import('@/assets/fonts/hant.css')\n`);
});

const compileFixture = async (source) =>
{
    const directory = await mkdtemp(path.join(frontendRoot, '.locale-catalog-typecheck-'));
    try
    {
        const fixture = path.join(directory, 'consumer.ts');
        await writeFile(fixture, source);
        return spawnSync(tsc, [fixture, '--ignoreConfig', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck'], { cwd: frontendRoot, encoding: 'utf8' });
    }
    finally
    {
        await rm(directory, { recursive: true, force: true });
    }
};

test('real TypeScript consumers accept the catalog union and reject an eleventh locale', async () =>
{
    const positive = await compileFixture(`import type { SupportedLocale } from '../src/locales/localeCatalog.js'\nconst values: readonly SupportedLocale[] = ['zh-CN', 'en-US', 'zh-Hant', 'ja-JP', 'ko-KR', 'es-419', 'fr-FR', 'de-DE', 'pt-BR', 'ru-RU']\nvoid values\n`);
    assert.equal(positive.status, 0, `${positive.stdout}\n${positive.stderr}`);
    const eleventh = await compileFixture(`import type { SupportedLocale } from '../src/locales/localeCatalog.js'\nconst invalid: SupportedLocale = 'x-test'\nvoid invalid\n`);
    assert.notEqual(eleventh.status, 0, 'the TypeScript compiler accepted an eleventh locale');
});

test('LocaleDomain is the exact catalog union and rejects an eleventh domain', async () =>
{
    const positive = await compileFixture(`import { LOCALE_DOMAINS, type LocaleDomain } from '../src/locales/localeDomains.js'\nconst values: readonly LocaleDomain[] = LOCALE_DOMAINS\nvoid values\n`);
    assert.equal(positive.status, 0, `${positive.stdout}\n${positive.stderr}`);
    const eleventh = await compileFixture(`import type { LocaleDomain } from '../src/locales/localeDomains.js'\nconst invalid: LocaleDomain = 'future'\nvoid invalid\n`);
    assert.notEqual(eleventh.status, 0, 'the TypeScript compiler accepted an eleventh locale domain');
});

test('TranslationKey is exact for the current zh-CN tree and rejects arbitrary strings', async () =>
{
    const positive = await compileFixture(`import type { TranslationKey } from '../src/locales/keys.js'\nconst known: TranslationKey = 'common.actions.save'\nvoid known\n`);
    assert.equal(positive.status, 0, `${positive.stdout}\n${positive.stderr}`);
    const arbitrary = await compileFixture(`import type { TranslationKey } from '../src/locales/keys.js'\nconst invalid: TranslationKey = 'untrusted.translation.key'\nvoid invalid\n`);
    assert.notEqual(arbitrary.status, 0, 'the TypeScript compiler accepted an arbitrary translation key');
});

test('ordinary and plural keys plus parameter maps are exact and mutually exclusive', async () =>
{
    const exactCurrentCatalog = await compileFixture(`import type { PluralParamsByKey, PluralTranslationKey, TranslationKey, TranslationParamsByKey } from '../src/locales/keys.js'\ntype Assert<T extends true> = T\ntype IsExactly<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends (<T>() => T extends Right ? 1 : 2) ? ((<T>() => T extends Right ? 1 : 2) extends (<T>() => T extends Left ? 1 : 2) ? true : false) : false\ntype ExpectedPluralKeys = 'article.metadata.readingMinuteCount' | 'article.metadata.wordCount' | 'identity.overview.passkeyDeviceCount' | 'identity.sessions.activeCount' | 'layout.recommendations.viewCount' | 'messages.conversationList.showMoreLabel' | 'public.archive.publishedCount'\ntype PluralKey = Assert<IsExactly<PluralTranslationKey, ExpectedPluralKeys>>\ntype OrdinaryDoesNotContainPlural = Assert<'public.archive.publishedCount' extends TranslationKey ? false : true>\ntype PluralDoesNotContainOrdinary = Assert<'common.actions.save' extends PluralTranslationKey ? false : true>\ntype OrdinaryNoParams = Assert<IsExactly<TranslationParamsByKey['common.actions.save'], undefined>>\ntype OrdinaryNamedParams = Assert<IsExactly<TranslationParamsByKey['article.actions.viewImageNamed'], Readonly<{ title: string | number }>>>\ntype PluralCountParams = Assert<IsExactly<PluralParamsByKey['public.archive.publishedCount'], Readonly<{ count: string | number }>>>\nvoid (null as unknown as PluralKey | OrdinaryDoesNotContainPlural | PluralDoesNotContainOrdinary | OrdinaryNoParams | OrdinaryNamedParams | PluralCountParams)\n`);
    assert.equal(exactCurrentCatalog.status, 0, `${exactCurrentCatalog.stdout}\n${exactCurrentCatalog.stderr}`);
    const arbitrary = await compileFixture(`import type { PluralTranslationKey } from '../src/locales/keys.js'\nconst impossible: PluralTranslationKey = 'untrusted.plural.key'\nvoid impossible\n`);
    assert.notEqual(arbitrary.status, 0, 'the TypeScript compiler accepted an arbitrary plural translation key');
    // Value imports of locales/index pull runtime composition ports that require
    // the frontend tsconfig path map; these fixtures use --ignoreConfig and only
    // assert the typed resolver call signatures exported from keys.
    const validCalls = await compileFixture(`import type { PluralTranslationArguments, PluralTranslationKey, TranslationArguments, TranslationKey } from '../src/locales/keys.js'\ndeclare function translate<Key extends TranslationKey>(key: Key, ...args: TranslationArguments<Key>): string\ndeclare function translatePlural<Key extends PluralTranslationKey>(key: Key, ...args: PluralTranslationArguments<Key>): string\ntranslate('common.actions.save')\ntranslate('article.actions.viewImageNamed', { title: 'cover' })\ntranslatePlural('public.archive.publishedCount', 2)\n`);
    assert.equal(validCalls.status, 0, `${validCalls.stdout}\n${validCalls.stderr}`);
    const missingParams = await compileFixture(`import type { TranslationArguments, TranslationKey } from '../src/locales/keys.js'\ndeclare function translate<Key extends TranslationKey>(key: Key, ...args: TranslationArguments<Key>): string\ntranslate('article.actions.viewImageNamed')\n`);
    assert.notEqual(missingParams.status, 0, 'translate accepted a parameterized key without its exact parameters');
    const extraParams = await compileFixture(`import type { TranslationArguments, TranslationKey } from '../src/locales/keys.js'\ndeclare function translate<Key extends TranslationKey>(key: Key, ...args: TranslationArguments<Key>): string\ntranslate('common.actions.save', { count: 1 })\n`);
    assert.notEqual(extraParams.status, 0, 'translate accepted parameters for a parameterless key');
    const pluralThroughOrdinary = await compileFixture(`import type { TranslationArguments, TranslationKey } from '../src/locales/keys.js'\ndeclare function translate<Key extends TranslationKey>(key: Key, ...args: TranslationArguments<Key>): string\ntranslate('public.archive.publishedCount', { count: 1 })\n`);
    assert.notEqual(pluralThroughOrdinary.status, 0, 'ordinary translate accepted a plural key');
    const ordinaryThroughPlural = await compileFixture(`import type { PluralTranslationArguments, PluralTranslationKey } from '../src/locales/keys.js'\ndeclare function translatePlural<Key extends PluralTranslationKey>(key: Key, ...args: PluralTranslationArguments<Key>): string\ntranslatePlural('common.actions.save', 1)\n`);
    assert.notEqual(ordinaryThroughPlural.status, 0, 'translatePlural accepted an ordinary key');
    const pluralCountInParams = await compileFixture(`import type { PluralTranslationArguments, PluralTranslationKey } from '../src/locales/keys.js'\ndeclare function translatePlural<Key extends PluralTranslationKey>(key: Key, ...args: PluralTranslationArguments<Key>): string\ntranslatePlural('public.archive.publishedCount', 2, { count: 9 })\n`);
    assert.notEqual(pluralCountInParams.status, 0, 'translatePlural accepted caller-supplied count params');
});

test('LocaleSchema preserves the discriminated plural kind and required other form', async () =>
{
    const positive = await compileFixture(`import type { LocaleSchema, PluralNode } from '../src/locales/keys.js'\ntype Fixture = { ordinary: 'ordinary'; plural: PluralNode }\nconst translated: LocaleSchema<Fixture> = { ordinary: 'translated', plural: { kind: 'plural', forms: { other: '{count}' } } }\nvoid translated\n`);
    assert.equal(positive.status, 0, `${positive.stdout}\n${positive.stderr}`);
    const ordinaryPlural = await compileFixture(`import type { LocaleSchema } from '../src/locales/keys.js'\ntype Fixture = { ordinary: 'ordinary' }\nconst invalid: LocaleSchema<Fixture> = { ordinary: { kind: 'plural', forms: { other: '{count}' } } }\nvoid invalid\n`);
    assert.notEqual(ordinaryPlural.status, 0, 'the TypeScript compiler accepted a plural node for an ordinary leaf');
    const missingOther = await compileFixture(`import type { LocaleSchema, PluralNode } from '../src/locales/keys.js'\ntype Fixture = { plural: PluralNode }\nconst invalid: LocaleSchema<Fixture> = { plural: { kind: 'plural', forms: { one: '{count}' } } }\nvoid invalid\n`);
    assert.notEqual(missingOther.status, 0, 'the TypeScript compiler accepted a plural node without other');
});
