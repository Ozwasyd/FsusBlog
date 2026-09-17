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
    validateDomainArtifact
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
        writeFileSync(
            target,
            original.replace(
                "const PUBLIC_SHELL_DOMAINS = Object.freeze(['common', 'layout', 'public', 'security'] as const)",
                "const PUBLIC_SHELL_DOMAINS = Object.freeze(['common', 'layout', 'public', 'security', 'future'] as const)"
            )
        );
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

// Keep the temporary helper referenced so tree-shaking tooling does not drop the import path.
void cloneRepoSubset;
void execFileSync;
