import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checker = path.join(root, 'tools/frontend/check-locale-domain-static.mjs');

const {
    buildLocaleDomainArtifacts,
    checkLocaleDomainStatic,
    evaluateInitialGraphEntry,
    formatDiagnostic,
    loadEnabledLocales,
    loadLocaleDomains,
    parseDomainTree,
    validateDomainArtifact,
    validateLocaleDomainLoaderMap
} = await import(checker);

function cloneRepoSubset()
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-locale-domain-static-'));
    const copy = (relative) =>
    {
        const source = path.join(root, relative);
        const target = path.join(directory, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(source, target, { recursive: true });
    };
    copy('src/shared/Contracts/Localization/locale-catalog.json');
    copy('src/frontend/src/locales');
    copy('src/frontend/src/bootstrap/globalLoaderCopy.ts');
    // Minimal git ls-files surface for dependency scan.
    mkdirSync(path.join(directory, '.git'), { recursive: true });
    writeFileSync(path.join(directory, '.git/HEAD'), 'ref: refs/heads/master\n');
    // Provide a fake git that lists frontend sources we copied.
    const bin = path.join(directory, '.bin');
    mkdirSync(bin, { recursive: true });
    const gitShim = path.join(bin, 'git');
    writeFileSync(gitShim, `#!/usr/bin/env bash
if [[ "$1" == "ls-files" ]]; then
  printf '%s\\n' \\
    'src/frontend/src/bootstrap/globalLoaderCopy.ts' \\
    'src/frontend/src/locales/localeDomainBundleStore.ts'
  exit 0
fi
exec "$(command -v git)" "$@"
`);
    // Use real git via PATH for simplicity — checker only uses ls-files on production paths.
    return directory;
}

function runChecker(cwd, env = {})
{
    return spawnSync(process.execPath, [checker], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...env }
    });
}

test('check set is exactly catalog enabled locales × LocaleDomain (100)', () =>
{
    const { locales } = loadEnabledLocales(root);
    const domains = loadLocaleDomains(root);
    const artifacts = buildLocaleDomainArtifacts({ rootDir: root });
    assert.equal(locales.length, 10);
    assert.equal(domains.length, 10);
    assert.equal(artifacts.length, 100);
    assert.equal(new Set(artifacts.map((item) => `${item.locale}/${item.domain}`)).size, 100);
});

test('production tree passes the fail-closed static gate', () =>
{
    const result = checkLocaleDomainStatic({ rootDir: root });
    assert.equal(result.ok, true, result.errors.map(formatDiagnostic).join('\n'));
    assert.equal(result.artifactCount, 100);
});

test('skip/bypass environment variables are rejected', () =>
{
    const denied = runChecker(root, { SKIP_I18N_GATE: '1' });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /skip\/bypass/u);
});

test('1. ja-JP/admin missing file fails with structured diagnostics', () =>
{
    const target = path.join(root, 'src/frontend/src/locales/ja-JP/admin.ts');
    const original = readFileSync(target, 'utf8');
    try
    {
        rmSync(target);
        const result = checkLocaleDomainStatic({ rootDir: root });
        assert.equal(result.ok, false);
        const hit = result.errors.find((item) =>
            item.locale === 'ja-JP' && item.domain === 'admin' && item.rule === 'artifact-file-exists');
        assert.ok(hit, result.errors.map(formatDiagnostic).join('\n'));
        assert.equal(hit.file, 'src/frontend/src/locales/ja-JP/admin.ts');
        assert.match(formatDiagnostic(hit), /rule=artifact-file-exists/u);
    }
    finally
    {
        writeFileSync(target, original);
    }
});

test('2. de-DE/public extra key fails', () =>
{
    const target = path.join(root, 'src/frontend/src/locales/de-DE/public.ts');
    const original = readFileSync(target, 'utf8');
    try
    {
        writeFileSync(
            target,
            original.replace(
                '} as const satisfies LocaleSchema',
                '    unexpectedExtraKey: \'extra\',\n} as const satisfies LocaleSchema'
            )
        );
        const result = checkLocaleDomainStatic({ rootDir: root });
        assert.equal(result.ok, false);
        const hit = result.errors.find((item) =>
            item.locale === 'de-DE' && item.domain === 'public' && item.rule === 'extra-key');
        assert.ok(hit, result.errors.map(formatDiagnostic).join('\n'));
        assert.match(hit.key, /unexpectedExtraKey/u);
    }
    finally
    {
        writeFileSync(target, original);
    }
});

test('3. ru-RU/messages missing few plural category fails', () =>
{
    const schema = {
        kind: 'object',
        value: {
            quantity: {
                kind: 'plural',
                forms: { other: '{count} items' }
            }
        }
    };
    const candidate = {
        kind: 'object',
        value: {
            quantity: {
                kind: 'plural',
                forms: {
                    one: '{count} item',
                    other: '{count} items'
                }
            }
        }
    };
    const errors = validateDomainArtifact(schema, candidate, {
        locale: 'ru-RU',
        domain: 'messages',
        file: 'src/frontend/src/locales/ru-RU/messages.ts'
    });
    assert.ok(errors.some((item) =>
        item.rule === 'plural-category' && item.expected.includes('few')));
    assert.ok(errors.some((item) => item.expected.includes('many')));
});

test('4. ko-KR/auth export identity as ja-JP fails', () =>
{
    const target = path.join(root, 'src/frontend/src/locales/ko-KR/auth.ts');
    const original = readFileSync(target, 'utf8');
    try
    {
        writeFileSync(
            target,
            original.replace(
                "export const localeDomainIdentity = Object.freeze({ locale: 'ko-KR', domain: 'auth' } as const)",
                "export const localeDomainIdentity = Object.freeze({ locale: 'ja-JP', domain: 'auth' } as const)"
            )
        );
        const result = checkLocaleDomainStatic({ rootDir: root });
        assert.equal(result.ok, false);
        const hit = result.errors.find((item) =>
            item.locale === 'ko-KR'
      && item.domain === 'auth'
      && item.rule === 'module-identity'
      && item.actual === 'ja-JP/auth');
        assert.ok(hit, result.errors.map(formatDiagnostic).join('\n'));
    }
    finally
    {
        writeFileSync(target, original);
    }
});

test('5. pt-BR/admin static into PublicHome initial graph fails build gate rule', () =>
{
    const errors = evaluateInitialGraphEntry({
        locale: 'pt-BR',
        domain: 'admin',
        isInitial: true,
        entryName: 'assets/locale-pt-BR-admin.js'
    });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].rule, 'initial-entry-locale-static');
    assert.equal(errors[0].locale, 'pt-BR');
    assert.equal(errors[0].domain, 'admin');
    assert.match(formatDiagnostic(errors[0]), /rule=initial-entry-locale-static/u);
});

test('6. route requiring unknown domain fails', () =>
{
    const target = path.join(root, 'src/frontend/src/locales/routeLocaleDomains.ts');
    const original = readFileSync(target, 'utf8');
    try
    {
        const mutated = original.replace(
            "const PUBLIC_SHELL_DOMAINS = Object.freeze(['common', 'layout', 'public'] as const)",
            "const PUBLIC_SHELL_DOMAINS = Object.freeze(['common', 'layout', 'public', 'future'] as const)"
        );
        assert.notEqual(mutated, original, 'unknown-domain control must mutate the actual route manifest');
        writeFileSync(target, mutated);
        const result = checkLocaleDomainStatic({ rootDir: root });
        assert.equal(result.ok, false);
        const hit = result.errors.find((item) =>
            item.rule === 'route-domain-exists' && item.domain === 'future');
        assert.ok(hit, result.errors.map(formatDiagnostic).join('\n'));
    }
    finally
    {
        writeFileSync(target, original);
    }
});

test('7. type-only schema import becoming runtime import fails', () =>
{
    const target = path.join(root, 'src/frontend/src/locales/en-US/common.ts');
    const original = readFileSync(target, 'utf8');
    try
    {
        writeFileSync(
            target,
            original.replace(
                "import type { common as zhCNCommon } from '../zh-CN/common';",
                "import { common as zhCNCommon } from '../zh-CN/common';"
            )
        );
        const result = checkLocaleDomainStatic({ rootDir: root });
        assert.equal(result.ok, false);
        const hit = result.errors.find((item) =>
            item.locale === 'en-US'
      && item.domain === 'common'
      && item.rule === 'type-only-schema-import');
        assert.ok(hit, result.errors.map(formatDiagnostic).join('\n'));
    }
    finally
    {
        writeFileSync(target, original);
    }
});

test('8. eleventh locale directory not in catalog fails', () =>
{
    const eleventh = path.join(root, 'src/frontend/src/locales/x-test');
    mkdirSync(eleventh, { recursive: true });
    writeFileSync(path.join(eleventh, 'common.ts'), "export const common = {}\n");
    try
    {
        const result = checkLocaleDomainStatic({ rootDir: root });
        assert.equal(result.ok, false);
        const hit = result.errors.find((item) =>
            item.locale === 'x-test' && item.rule === 'directory-inventory');
        assert.ok(hit, result.errors.map(formatDiagnostic).join('\n'));
        assert.match(hit.actual, /untracked locale directory/u);
    }
    finally
    {
        rmSync(eleventh, { recursive: true, force: true });
    }
});

test('missing key, node-kind drift, and param drift emit precise diagnostics', () =>
{
    const schema = parseDomainTree(
        `export const common = {
      ordinary: 'Hello {name}',
      nested: { leaf: 'x' },
      plural: { kind: 'plural', forms: { other: '{count} items for {name}' } }
    } as const`,
        'common'
    );
    const missing = validateDomainArtifact(schema, {
        kind: 'object',
        value: {
            ordinary: { kind: 'string', value: 'Hello {name}' },
            plural: { kind: 'plural', forms: { one: '{count} item for {name}', other: '{count} items for {name}' } }
        }
    }, { locale: 'en-US', domain: 'common', file: 'fixture.ts' });
    assert.ok(missing.some((item) => item.rule === 'missing-key' && item.key === 'nested'));

    const kindDrift = validateDomainArtifact(schema, {
        kind: 'object',
        value: {
            ordinary: { kind: 'plural', forms: { one: '{count}', other: '{count}' } },
            nested: { kind: 'object', value: { leaf: { kind: 'string', value: 'x' } } },
            plural: { kind: 'string', value: '{count} items for {name}' }
        }
    }, { locale: 'de-DE', domain: 'common', file: 'fixture.ts' });
    assert.ok(kindDrift.some((item) => item.rule === 'node-kind' && item.key === 'ordinary'));
    assert.ok(kindDrift.some((item) => item.rule === 'node-kind' && item.key === 'plural'));

    const paramDrift = validateDomainArtifact(schema, {
        kind: 'object',
        value: {
            ordinary: { kind: 'string', value: 'Hello' },
            nested: { kind: 'object', value: { leaf: { kind: 'string', value: 'x' } } },
            plural: {
                kind: 'plural',
                forms: {
                    one: '{count} item for {name}',
                    other: '{count} items'
                }
            }
        }
    }, { locale: 'en-US', domain: 'common', file: 'fixture.ts' });
    assert.ok(paramDrift.some((item) => item.rule === 'interpolation-params' && item.key === 'ordinary'));
    assert.ok(paramDrift.some((item) => item.rule === 'plural-params'));
});

test('CLI entrypoint exits nonzero on production mutations and restores cleanly', () =>
{
    const target = path.join(root, 'src/frontend/src/locales/fr-FR/errors.ts');
    const original = readFileSync(target, 'utf8');
    try
    {
        writeFileSync(target, original.replace(
            "export const localeDomainIdentity = Object.freeze({ locale: 'fr-FR', domain: 'errors' } as const)",
            "export const localeDomainIdentity = Object.freeze({ locale: 'de-DE', domain: 'errors' } as const)"
        ));
        const failed = runChecker(root);
        assert.notEqual(failed.status, 0);
        assert.match(failed.stderr, /locale=fr-FR/u);
        assert.match(failed.stderr, /rule=module-identity/u);
    }
    finally
    {
        writeFileSync(target, original);
    }
    const clean = runChecker(root);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /artifacts=100/u);
});

test('artifact set grows and shrinks with catalog × domain union', () =>
{
    const baseLocales = loadEnabledLocales(root).locales;
    const baseDomains = loadLocaleDomains(root);
    const plusLocale = buildLocaleDomainArtifacts({
        rootDir: root,
        locales: [...baseLocales, 'x-extra'],
        domains: baseDomains
    });
    assert.equal(plusLocale.length, 110);
    const minusDomain = buildLocaleDomainArtifacts({
        rootDir: root,
        locales: baseLocales,
        domains: baseDomains.filter((domain) => domain !== 'admin')
    });
    assert.equal(minusDomain.length, 90);
});

// Pure source mutations exercise the admission parser without changing product
// files. Authorities remain the existing catalog and domain union.
const loaderLocales = loadEnabledLocales(root).locales;
const loaderDomains = loadLocaleDomains(root);
const loaderSource = readFileSync(path.join(root, 'src/frontend/src/locales/localeDomainBundleStore.ts'), 'utf8');

function loaderFixture({ indent = '    ', quote = "'", newline = '\n', gap = ' ', trailing = true } = {})
{
    const literal = (value) => `${quote}${value}${quote}`;
    const blocks = loaderLocales.map((locale) =>
    {
        const imports = loaderDomains.map((domain) =>
            `${indent}${indent}${literal(domain)}:${gap}()${gap}=>${gap}import(${gap}${literal(`./${locale}/${domain}`)}${gap})`);
        return `${indent}${literal(locale)}:${gap}loadersFor(${gap}${literal(locale)},${gap}{${newline}`
            + imports.join(`,${newline}`) + (trailing ? ',' : '') + `${newline}${indent}}${gap})`;
    });
    return 'export const LOCALE_DOMAIN_LOADERS: LocaleDomainLoaderRegistry = Object.freeze({' + newline
        + blocks.join(`,${newline}`) + (trailing ? ',' : '') + newline + '});';
}

const fixture = loaderFixture().replaceAll('( ', '(').replaceAll(' )', ')');

for (const [name, source] of [
    ['current production 4/8-space TypeScript', loaderSource],
    ['2/4 spaces', loaderFixture({ indent: '  ' })],
    ['4/8 spaces', loaderFixture()],
    ['8/16 spaces', loaderFixture({ indent: '        ' })],
    ['without a type annotation', fixture.replace(': LocaleDomainLoaderRegistry', '')],
    ['line comments between entries', fixture.replaceAll(',\n', ', // misleading }), import("./fake")\n')],
    ['escaped literal identity', fixture.replaceAll('zh-CN', 'zh\\u002dCN')],
    ['tabs and double quoted keys/imports', loaderFixture({ indent: '\t', quote: '"' })],
    ['single line without whitespace or trailing commas', loaderFixture({ indent: '', newline: '', gap: '', trailing: false })],
    ['CRLF and multiline expressions', loaderFixture({ newline: '\r\n', gap: '\r\n' })],
    ['comments between expression tokens', loaderFixture({ gap: '/* misleading }), import(\'./fake\') */' })],
    ['parenthesized initializer and importer bodies', fixture
        .replace('= Object.freeze({', '= (Object.freeze({').replace('});', '}));')
        .replaceAll("=> import('", "=> (import('").replaceAll("'),", "')),")],
    ['comment/string/template-text decoys are not declarations/imports', loaderFixture()
        + '\n// export const LOCALE_DOMAIN_LOADERS = {}; import("./fake")\n'
        + 'const decoy = ' + JSON.stringify('export const LOCALE_DOMAIN_LOADERS = {}; import("./fake")') + ';\n'
        + 'const text = `import("./fake") { [ ] }`;'],
    ['nested type annotation', loaderFixture().replace(': LocaleDomainLoaderRegistry =', ': Readonly<{ type: (x: string) => Record<string, unknown> }> =')]
])
{
    test(`loader structure accepts ${name} with the exact ten × ten registry`, () =>
    {
        const errors = validateLocaleDomainLoaderMap(source, loaderLocales, loaderDomains);
        assert.deepEqual(errors, [], errors.map(formatDiagnostic).join('\n'));
    });
}

const firstDomain = "'common': () => import('./zh-CN/common')";
const firstLocaleStart = "    'zh-CN': loadersFor('zh-CN', {";
const firstLocaleEnd = fixture.indexOf("    'en-US':");
const firstLocaleBlock = fixture.slice(fixture.indexOf(firstLocaleStart), firstLocaleEnd);
for (const [name, mutate, rule, actual] of [
    ['missing locale', (source) => source.replace(firstLocaleBlock, ''), 'loader-map-keyset', /missing/u],
    ['duplicate locale', (source) => source.replace(firstLocaleBlock, firstLocaleBlock.repeat(2)), 'loader-map-keyset', /duplicate zh-CN/u],
    ['extra locale', (source) => source.replace(firstLocaleStart, "    'x-extra': loadersFor('x-extra', {"), 'loader-map-keyset', /extra x-extra/u],
    ['missing domain', (source) => source.replace(`        ${firstDomain},\n`, ''), 'loader-map-keyset', /missing/u],
    ['duplicate domain', (source) => source.replace(firstDomain, `${firstDomain}, ${firstDomain}`), 'loader-map-keyset', /duplicate common/u],
    ['escaped duplicate domain', (source) => source.replace(firstDomain, `${firstDomain}, 'c\\u006fmmon': () => import('./zh-CN/common')`), 'loader-map-keyset', /duplicate common/u],
    ['extra domain', (source) => source.replace(firstDomain, `${firstDomain}, 'future': () => import('./zh-CN/future')`), 'loader-map-keyset', /extra future/u],
    ['wrong loadersFor locale', (source) => source.replace("loadersFor('zh-CN'", "loadersFor('en-US'"), 'loader-import-identity', /en-US/u],
    ['wrong import locale', (source) => source.replace('./zh-CN/common', './en-US/common'), 'loader-import-identity', /en-US\/common/u],
    ['wrong import domain', (source) => source.replace('./zh-CN/common', './zh-CN/admin'), 'loader-import-identity', /zh-CN\/admin/u],
    ['wrong import extension', (source) => source.replace('./zh-CN/common', './zh-CN/common.ts'), 'loader-import-identity', /common\.ts/u],
    ['whole-locale import', (source) => source.replace('./zh-CN/common', './zh-CN'), 'whole-bundle-forbidden', /whole-locale/u],
    ['extra import outside registry', (source) => source + "\nconst leak = () => import('./zh-CN/admin');", 'loader-import-identity', /extra import/u],
    ['extra static value import', (source) => "import { admin } from './zh-CN/admin';\n" + source, 'loader-import-identity', /extra static import/u],
    ['extra static side-effect import', (source) => "import './zh-CN/admin';\n" + source, 'loader-import-identity', /extra static import/u],
    ['extra static type import', (source) => "import type { admin } from './zh-CN/admin';\n" + source, 'loader-import-identity', /extra static import/u],
    ['extra import in template interpolation', (source) => source + "\nconst leak = `text ${import('./zh-CN/admin')}`;", 'loader-import-identity', /extra import/u],
    ['extra import inside importer', (source) => source.replace(firstDomain, "'common': () => (import('./zh-CN/common'), import('./zh-CN/admin'))"), 'loader-map-keyset', /expected \)/u],
    ['block importer hiding an extra import', (source) => source.replace(firstDomain, "'common': () => { import('./zh-CN/admin'); return import('./zh-CN/common'); }"), 'loader-map-keyset', /expected/u],
    ['computed key', (source) => source.replace("'common':", "['common']:"), 'loader-map-keyset', /literal property key/u],
    ['spread keys', (source) => source.replace(firstDomain, `...hidden, ${firstDomain}`), 'loader-map-keyset', /literal property key/u],
    ['nonliteral importer path', (source) => source.replace("import('./zh-CN/common')", 'import(path)'), 'loader-map-keyset', /expected \(/u],
    ['interpolated importer path', (source) => source.replace("import('./zh-CN/common')", 'import(`./${locale}/common`)'), 'loader-map-keyset', /unsupported/u],
    ['eager import instead of arrow', (source) => source.replace(firstDomain, "'common': import('./zh-CN/common')"), 'loader-map-keyset', /expected \(\) => import/u],
    ['import options/extra argument', (source) => source.replace("import('./zh-CN/common')", "import('./zh-CN/common', {})"), 'loader-map-keyset', /expected \(\) => import/u],
    ['extra loadersFor argument', (source) => source.replace("'zh-CN', {", "'zh-CN', 'extra', {"), 'loader-map-keyset', /expected loadersFor/u],
    ['duplicate exported registry', (source) => source + '\n' + source, 'loader-map-keyset', /found 2/u],
    ['missing exported registry with a comment decoy', (source) => '// ' + source.replaceAll('\n', '\n// '), 'loader-map-keyset', /found 0/u],
    ['malformed close delimiter', (source) => source.replace('});', ']);'), 'loader-map-keyset', /unmatched/u],
    ['unterminated comment', (source) => source + '\n/*', 'loader-map-keyset', /unterminated comment/u],
    ['unterminated string', (source) => source + "\nconst text = '", 'loader-map-keyset', /unterminated string/u],
    ['non-frozen object', (source) => source.replace('Object.freeze({', 'other({'), 'loader-map-keyset', /Object.freeze/u]
])
{
    test(`loader structure fails closed on ${name}`, () =>
    {
        const changed = mutate(fixture);
        assert.ok(changed !== fixture, 'counterexample must change actual source syntax');
        const errors = validateLocaleDomainLoaderMap(changed, loaderLocales, loaderDomains);
        const hit = errors.find((item) => item.rule === rule && actual.test(item.actual));
        assert.ok(hit, errors.map(formatDiagnostic).join('\n'));
        assert.equal(hit.file, 'src/frontend/src/locales/localeDomainBundleStore.ts');
    });
}

// Keep the temporary helper referenced so tree-shaking tooling does not drop the import path.
void cloneRepoSubset;
void execFileSync;
