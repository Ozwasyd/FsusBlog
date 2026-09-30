import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
    admitCanonicalEdge,
    authorityRoot,
    edgeRegistryPath,
    validateCandidatePolicy,
    validateSelectedCanonicalSource,
    wrapParentImportRule
} = await import(pathToFileURL(path.join(repositoryRoot, 'tools/frontend/style-toolchain/closed-canonical-edge.mjs')).href);

const caller = 'tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs';
const owner = 'tools/fact-extractors/lib/canonicalize.mjs';
const specifier = '../fact-extractors/lib/canonicalize.mjs';
const originalCaller = fs.readFileSync(path.join(authorityRoot, caller), 'utf8');
const originalOwner = fs.readFileSync(path.join(authorityRoot, owner), 'utf8');
const importNode = {
    type: 'ImportDeclaration', source: { value: specifier },
    specifiers: [{ type: 'ImportSpecifier', imported: { name: 'digestValue' }, local: { name: 'digestValue' } }]
};

function write(root, relative, content)
{
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
}

function fixture(callback)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-canonical-edge-'));
    try
    {
        const registry = JSON.parse(fs.readFileSync(path.join(authorityRoot, edgeRegistryPath), 'utf8'));
        for (const relative of Object.keys(registry.previousPolicySha256))
        {
            write(root, relative, fs.readFileSync(path.join(authorityRoot, relative)));
        }
        write(root, caller, originalCaller);
        write(root, owner, originalOwner);
        write(root, 'src/frontend/package.json', fs.readFileSync(path.join(authorityRoot, 'src/frontend/package.json')));
        callback(root);
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function admits(root, source = fs.readFileSync(path.join(root, caller), 'utf8'), node = importNode)
{
    return admitCanonicalEdge(root, path.join(root, caller), node, source);
}

test('canonical edge accepts only the two bound source value versions', () =>
{
    fixture((root) =>
    {
        assert.equal(admits(root), true);
        // Frozen fc308 caller source is read as text, never executed as a parallel value owner.
        const source = fs.readFileSync(path.join(repositoryRoot, 'tests/tools/fixtures/canonical-digest-edge/v3-contract.mjs'), 'utf8');
        write(root, caller, source);
        assert.equal(admits(root), true);
    });
});

const callerMutations = {
    missing: (source) => source.replace(/import \{ digestValue \} from [^\n]+/u, ''),
    duplicate: (source) => `${source}\nimport { digestValue as duplicate } from '${specifier}';\n`,
    extra: (source) => `${source}\nimport fs from 'node:fs';\n`,
    symbol: (source) => source.replace('{ digestValue }', '{ digestText }'),
    alias: (source) => source.replace('{ digestValue }', '{ digestValue as valueDigest }'),
    namespace: (source) => source.replace('{ digestValue }', '* as digestValue'),
    default: (source) => source.replace('{ digestValue }', 'digestValue'),
    reexport: (source) => source.replace('import { digestValue }', 'export { digestValue }'),
    dynamic: (source) => `${source}\nawait import('${specifier}');\n`,
    require: (source) => `${source}\nrequire('${specifier}');\n`,
    serializer: (source) => `${source}\nexport const duplicateDigest = (value) => JSON.stringify(value);\n`,
    ambient: (source) => `${source}\nglobalThis['process'].exit();\n`,
    traversal: (source) => source.replace(specifier, '../fact-extractors/lib/../lib/canonicalize.mjs'),
    bare: (source) => source.replace(specifier, '@fsusblog/canonicalize'),
    query: (source) => source.replace(specifier, `${specifier}?owner=canonical`),
    inline: (source) => `/* eslint-disable import-x/no-relative-parent-imports */\n${source}`
};

for (const [name, mutate] of Object.entries(callerMutations))
{
    test(`canonical caller refuses ${name}`, () =>
    {
        fixture((root) =>
        {
            write(root, caller, mutate(originalCaller));
            assert.throws(() => admits(root));
        });
    });
}

for (const source of [
    "import fs from 'node:fs';\n", "import process from 'node:process';\n",
    "import net from 'node:net';\n", "import { value } from './hidden.mjs';\n",
    "globalThis['process'].exit();\n", "eval('1');\n", "new Function('return 1')();\n",
    "await import('node:fs');\n", "require('node:fs');\n", "process.cwd();\n"
])
{
    test(`canonical owner refuses transitive or ambient capability ${source.trim()}`, () =>
    {
        fixture((root) =>
        {
            write(root, owner, `${originalOwner}\n${source}`);
            assert.throws(() => admits(root));
        });
    });
}

test('canonical owner refuses semantic drift even within the finite value language', () =>
{
    fixture((root) =>
    {
        write(root, owner, originalOwner.replace("'sha256'", "'sha512'"));
        assert.throws(() => admits(root), /semantics drift/u);
    });
});

test('canonical binding rechecks source after a previous successful decision', () =>
{
    fixture((root) =>
    {
        assert.equal(admits(root), true);
        write(root, owner, `${originalOwner}\nprocess.exit();\n`);
        assert.throws(() => admits(root));
    });
});

for (const relative of [caller, owner])
{
    test(`canonical path refuses symlink and mode drift: ${relative}`, () =>
    {
        fixture((root) =>
        {
            const absolute = path.join(root, relative);
            fs.chmodSync(absolute, 0o755);
            assert.throws(() => admits(root), /executable mode/u);
            fs.chmodSync(absolute, 0o644);
            const copy = `${absolute}.copy`;
            fs.renameSync(absolute, copy);
            fs.symlinkSync(copy, absolute);
            assert.throws(() => admits(root), /redirected/u);
        });
    });
}

test('candidate policy and candidate registry cannot make their own decision', () =>
{
    fixture((root) =>
    {
        validateCandidatePolicy(root);
        write(root, edgeRegistryPath, '{}');
        assert.throws(() => admits(root), /cannot author/u);
        fs.unlinkSync(path.join(root, edgeRegistryPath));
        write(root, 'eslint.config.mjs', 'export default [];\n');
        assert.throws(() => admits(root), /candidate policy drift/u);
    });
});

test('ordinary caller is not an admitted edge and all original visitors survive', () =>
{
    fixture((root) =>
    {
        assert.equal(admitCanonicalEdge(root, path.join(root, 'tools/docs/other.mjs'), importNode, originalCaller), false);
        const events = [];
        const original = {
            meta: { messages: { noAllowed: 'original diagnostic' } },
            create: () => ({
                ImportDeclaration: () => events.push('import'),
                ExportNamedDeclaration: () => events.push('export'),
                ExportAllDeclaration: () => events.push('export-all'),
                ImportExpression: () => events.push('dynamic'),
                CallExpression: () => events.push('call')
            })
        };
        const rule = wrapParentImportRule(original);
        const listeners = rule.create({ physicalFilename: path.join(root, 'tools/docs/other.mjs'), sourceCode: { text: '' } });
        for (const name of ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression', 'CallExpression'])
        {
            listeners[name](importNode);
        }
        assert.deepEqual(events, ['import', 'export', 'export-all', 'dynamic', 'call']);
        assert.equal(rule.meta.messages.noAllowed, original.meta.messages.noAllowed);
    });
});

test('closed authority rejects malformed registration and cached authority changes', () =>
{
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-edge-authority-'));
    try
    {
        const relatives = [
            edgeRegistryPath, '.editorconfig', 'eslint.config.mjs', 'stylelint.config.mjs',
            'config/development/frontend-style-policy.json',
            'config/development/frontend-style-rule-registry.json',
            'src/frontend/eslint.config.mjs', 'src/frontend/stylelint.config.mjs',
            'tools/frontend/check-frontend-style.mjs',
            'tools/frontend/reviewed-residual-classification.mjs'
        ];
        for (const relative of relatives)
        {
            write(clone, relative, fs.readFileSync(path.join(authorityRoot, relative)));
        }
        fs.mkdirSync(path.join(clone, 'tools/frontend'), { recursive: true });
        fs.cpSync(path.join(authorityRoot, 'tools/frontend/style-toolchain'),
            path.join(clone, 'tools/frontend/style-toolchain'), { recursive: true, verbatimSymlinks: true });
        const script = `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import path from 'node:path';
            import { pathToFileURL } from 'node:url';
            const root = process.argv[1];
            const target = path.join(root, process.argv[2]);
            const original = fs.readFileSync(target, 'utf8');
            const module = await import(pathToFileURL(path.join(root, 'tools/frontend/style-toolchain/closed-canonical-edge.mjs')));
            module.validateCandidatePolicy(root);
            fs.appendFileSync(target, '\\n ');
            assert.throws(() => module.validateCandidatePolicy(root), /authority drift/);
            fs.writeFileSync(target, original);
        `;
        for (const relative of [
            edgeRegistryPath,
            'tools/frontend/style-toolchain/eslint.config.mjs',
            'tools/frontend/style-toolchain/node_modules/espree/espree.js',
            'tools/frontend/style-toolchain/closed-canonical-edge.mjs'
        ])
        {
            execFileSync(process.execPath, ['--input-type=module', '-e', script, clone, relative]);
        }
        const registry = JSON.parse(fs.readFileSync(path.join(clone, edgeRegistryPath), 'utf8'));
        for (const mutated of [
            { ...registry, edges: [registry.edge, registry.edge] },
            { ...registry, edge: { ...registry.edge, caller: 'tools/docs/*.mjs' } },
            { ...registry, edge: { ...registry.edge, owner: '../canonicalize.mjs' } },
            { ...registry, callerSemanticSha256: [...registry.callerSemanticSha256, registry.callerSemanticSha256[0]] }
        ])
        {
            write(clone, edgeRegistryPath, JSON.stringify(mutated));
            execFileSync(process.execPath, ['--input-type=module', '-e', `
                import assert from 'node:assert/strict';
                import { pathToFileURL } from 'node:url';
                const module = await import(pathToFileURL(process.argv[1] + '/tools/frontend/style-toolchain/closed-canonical-edge.mjs'));
                assert.throws(() => module.validateCandidatePolicy(process.argv[1]), /exact finite decision/);
            `, clone]);
        }
    }
    finally
    {
        fs.rmSync(clone, { recursive: true, force: true });
    }
});

test('executor refuses a forged authority root and candidate policy or write option', () =>
{
    fixture((root) =>
    {
        const checker = path.join(authorityRoot, 'tools/frontend/check-frontend-style.mjs');
        for (const [options, reason] of [
            [['--authority-root', root], /unknown argument --authority-root/u],
            [['--policy', path.join(root, 'config/development/frontend-style-policy.json')], /executing authority checkout/u],
            [['--fix'], /candidate source is read-only/u],
            [['--update-baseline'], /candidate source is read-only/u]
        ])
        {
            try
            {
                execFileSync(process.execPath, [checker, '--root', root, '--mode', 'changed', '--file', caller, ...options], {
                    cwd: root, encoding: 'utf8', stdio: 'pipe'
                });
                assert.fail('forged or writing candidate option was accepted');
            }
            catch (error)
            {
                assert.equal(error.status, 1);
                assert.match(error.stderr, reason);
            }
        }
        assert.equal(fs.readFileSync(path.join(root, caller), 'utf8'), originalCaller);
        assert.equal(fs.existsSync(path.join(root, '.tmp')), false);
    });
});

test('preflight refuses inline disabling before suppressible ESLint diagnostics', () =>
{
    fixture((root) =>
    {
        write(root, caller, `/* eslint-disable */\n${originalCaller}\nprocess.exit();\n`);
        assert.throws(() => validateSelectedCanonicalSource(root, [caller]), /inline rule directives/u);
        try
        {
            execFileSync(process.execPath, [path.join(authorityRoot, 'tools/frontend/check-frontend-style.mjs'),
                '--root', root, '--mode', 'strict-full', '--file', caller], { encoding: 'utf8', stdio: 'pipe' });
            assert.fail('inline-disable bypass reached a successful style executor');
        }
        catch (error)
        {
            assert.equal(error.status, 1);
            assert.match(error.stderr, /inline rule directives/u);
        }
    });
});
