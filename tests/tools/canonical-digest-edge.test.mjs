import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import currentTest from 'node:test';
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
const {
    trustedPolicyFiles: historicalPolicyFiles,
    effectiveTrustedPolicyFiles: trustedPolicyFiles,
    styleAuthorityPolicyFiles
} = await import(pathToFileURL(path.join(repositoryRoot, 'tools/governance/change-contract-registry.mjs')).href);
const { validatePrContract } = await import(new URL('../../tools/governance/change-contract.mjs', import.meta.url));

// Original positive/admission oracles stay prepared. No policy is synthesized for them.
const missingAuthority = !fs.existsSync(path.join(authorityRoot, edgeRegistryPath))
    ? 'UNRUN: the protected canonical edge decision is absent; independent promotion is required'
    : false;
const test = (name, callback) => currentTest(name, { skip: missingAuthority }, callback);

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
    test(`canonical path refuses hardlink, symlink and mode drift: ${relative}`, () =>
    {
        fixture((root) =>
        {
            const absolute = path.join(root, relative);
            fs.chmodSync(absolute, 0o755);
            assert.throws(() => admits(root), /executable mode/u);
            fs.chmodSync(absolute, 0o644);
            const copy = `${absolute}.copy`;
            fs.linkSync(absolute, copy);
            assert.throws(() => admits(root), /single-link/u);
            fs.unlinkSync(copy);
            fs.renameSync(absolute, copy);
            fs.symlinkSync(copy, absolute);
            assert.throws(() => admits(root), /redirected/u);
        });
    });
}

test('actual caller and owner reads reject replacement, alias and in-place drift', (context) =>
{
    for (const relative of [caller, owner])
    {
        for (const mutation of ['symlink', 'replacement', 'hardlink', 'mode', 'content', 'parent'])
        {
            fixture((root) =>
            {
                const absolute = path.join(root, relative);
                const expected = fs.lstatSync(absolute, { bigint: true });
                const originalRead = fs.readFileSync;
                let mutated = false;
                context.mock.method(fs, 'readFileSync', (descriptor, ...args) =>
                {
                    // Keep actual read-window controls without retaining every authority Buffer in Node's mock history.
                    fs.readFileSync.mock.resetCalls();
                    const bytes = originalRead.call(fs, descriptor, ...args);
                    if (typeof descriptor === 'number' && !mutated)
                    {
                        const actual = fs.fstatSync(descriptor, { bigint: true });
                        if (actual.dev === expected.dev && actual.ino === expected.ino)
                        {
                            mutated = true;
                            const copy = `${absolute}.copy`;
                            if (mutation === 'symlink')
                            {
                                fs.renameSync(absolute, copy);
                                fs.symlinkSync(copy, absolute);
                            }
                            else if (mutation === 'replacement')
                            {
                                fs.copyFileSync(absolute, copy);
                                fs.renameSync(copy, absolute);
                            }
                            else if (mutation === 'hardlink')
                            {
                                fs.linkSync(absolute, copy);
                            }
                            else if (mutation === 'mode')
                            {
                                fs.chmodSync(absolute, 0o755);
                            }
                            else if (mutation === 'content')
                            {
                                fs.appendFileSync(absolute, '\n ');
                            }
                            else
                            {
                                const parent = path.dirname(absolute);
                                fs.renameSync(parent, `${parent}.copy`);
                                fs.symlinkSync(`${parent}.copy`, parent);
                            }
                        }
                    }
                    return bytes;
                });
                try
                {
                    assert.throws(() => admits(root), undefined, `${relative}: ${mutation}`);
                    assert.equal(mutated, true, `${relative}: ${mutation} must change the actual read window`);
                }
                finally
                {
                    context.mock.restoreAll();
                }
            });
        }
    }
});

for (const relative of [caller, owner])
{
    for (const [stage, openOrdinal, expectedReads, diagnostic] of [
        ['first-open', 1, 0, /changed while opening/u],
        ['verification-open', 2, 1, /changed before read verification/u]
    ])
    {
        test(`canonical source refuses replacement before ${stage} read: ${relative}`, (context) =>
        {
            fixture((root) =>
            {
                const absolute = path.join(root, relative);
                const originalOpen = fs.openSync;
                const originalRead = fs.readFileSync;
                const originalClose = fs.closeSync;
                const descriptors = new Set();
                let targetOpens = 0;
                let targetReads = 0;
                let replaced = false;
                context.mock.method(fs, 'openSync', (filename, ...args) =>
                {
                    if (filename === absolute && ++targetOpens === openOrdinal)
                    {
                        const replacement = `${absolute}.replacement`;
                        fs.copyFileSync(absolute, replacement);
                        fs.renameSync(replacement, absolute);
                        replaced = true;
                    }
                    const descriptor = originalOpen.call(fs, filename, ...args);
                    if (filename === absolute)
                    {
                        descriptors.add(descriptor);
                    }
                    return descriptor;
                });
                context.mock.method(fs, 'readFileSync', (descriptor, ...args) =>
                {
                    // Keep actual read-window controls without retaining every authority Buffer in Node's mock history.
                    fs.readFileSync.mock.resetCalls();
                    if (descriptors.has(descriptor))
                    {
                        targetReads += 1;
                    }
                    return originalRead.call(fs, descriptor, ...args);
                });
                context.mock.method(fs, 'closeSync', (descriptor) =>
                {
                    descriptors.delete(descriptor);
                    return originalClose.call(fs, descriptor);
                });
                try
                {
                    assert.throws(() => admits(root), diagnostic);
                    assert.equal(replaced, true, 'replace the inode at the actual descriptor open');
                    assert.equal(targetReads, expectedReads, 'never read the replacement descriptor');
                }
                finally
                {
                    context.mock.restoreAll();
                }
            });
        });
    }
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

test('every actual style authority input is protected and refuses candidate byte changes', () =>
{
    const registry = JSON.parse(fs.readFileSync(path.join(authorityRoot, edgeRegistryPath), 'utf8'));
    for (const relative of [...Object.keys(registry.previousPolicySha256), edgeRegistryPath,
        'tools/frontend/style-toolchain/closed-canonical-edge.mjs'])
    {
        assert.equal(trustedPolicyFiles.includes(relative), true, `unprotected actual authority: ${relative}`);
    }
    for (const relative of Object.keys(registry.previousPolicySha256))
    {
        fixture((root) =>
        {
            fs.appendFileSync(path.join(root, relative), '\n ');
            assert.throws(() => validateCandidatePolicy(root),
                (error) => error.message.includes(`candidate policy drift: ${relative}`));
        });
    }
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
            const alias = target + '.hardlink';
            fs.linkSync(target, alias);
            assert.throws(() => module.validateCandidatePolicy(root), /single-link/);
            fs.unlinkSync(alias);
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
            execFileSync(process.execPath, ['--input-type=module', '-e', `
                import assert from 'node:assert/strict';
                import fs from 'node:fs';
                import path from 'node:path';
                import { pathToFileURL } from 'node:url';
                const target = path.join(process.argv[1], process.argv[2]);
                const alias = target + '.hardlink';
                fs.linkSync(target, alias);
                try
                {
                    await assert.rejects(import(pathToFileURL(path.join(process.argv[1],
                        'tools/frontend/style-toolchain/closed-canonical-edge.mjs'))), /single-link/);
                }
                finally
                {
                    fs.unlinkSync(alias);
                }
            `, clone, relative]);
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
        const raw = JSON.stringify(registry);
        const schema = JSON.stringify(registry.schema);
        const callerValue = JSON.stringify(registry.edge.caller);
        const editorValue = JSON.stringify(registry.previousPolicySha256['.editorconfig']);
        const duplicateDocuments = [
            raw.replace(`"schema":${schema}`, `"schema":"invalid-duplicate-decision","schema":${schema}`),
            raw.replace(`"schema":${schema}`, `"schema":${schema},"schema":${schema}`),
            raw.replace(`"schema":${schema}`, `"schema":"invalid","\\u0073chema":${schema}`),
            raw.replace(`"caller":${callerValue}`, `"caller":"wrong","caller":${callerValue}`),
            raw.replace(`"caller":${callerValue}`, `"caller":"wrong","\\u0063aller":${callerValue}`),
            raw.replace(`".editorconfig":${editorValue}`, `".editorconfig":"wrong",".editorconfig":${editorValue}`),
            raw.replace(`".editorconfig":${editorValue}`, `".editorconfig":"wrong","\\u002eeditorconfig":${editorValue}`)
        ];
        for (const duplicateDocument of duplicateDocuments)
        {
            assert.notEqual(duplicateDocument, raw);
            write(clone, edgeRegistryPath, duplicateDocument);
            execFileSync(process.execPath, ['--input-type=module', '-e', `
                import assert from 'node:assert/strict';
                import { pathToFileURL } from 'node:url';
                const module = await import(pathToFileURL(process.argv[1] + '/tools/frontend/style-toolchain/closed-canonical-edge.mjs'));
                assert.throws(() => module.validateCandidatePolicy(process.argv[1]), /duplicate raw registry member/);
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


test('current style policies refuse PR replacement while retaining the historical policy roster', () =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-edge-policy-gate-'));
    const trusted = path.join(root, 'trusted');
    const candidate = path.join(root, 'candidate');
    try
    {
        fs.mkdirSync(candidate, { recursive: true });
        const git = (...args) => execFileSync('git', args, { cwd: candidate, encoding: 'utf8' }).trim();
        git('init', '--quiet');
        git('config', 'user.name', 'FsusBlog Candidate Fixture');
        git('config', 'user.email', 'fixture@fsus.invalid');
        write(trusted, 'config/development/native-tooling-style-exceptions.json', '{"exceptions":[]}\n');
        for (const file of styleAuthorityPolicyFiles)
        {
            assert.equal(historicalPolicyFiles.includes(file), false, 'current styles cannot mutate the historical seal roster');
            assert.equal(trustedPolicyFiles.includes(file), true, 'all current styles must remain protected');
            write(candidate, file, 'candidate replacement\n');
            write(trusted, file, 'trusted original\n');
        }
        git('add', '.');
        git('commit', '-qm', 'fixture current style authority replacement');
        for (const file of styleAuthorityPolicyFiles)
        {
            const errors = validatePrContract({
                title: 'feat(governance): bind closed canonical ownership', body: '',
                changedFiles: [file], root: candidate, authorityRoot: trusted
            });
            assert.ok(errors.includes(`pull request cannot replace trusted change-contract policy source: ${file}`), file);
        }
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

const {
    parseUniqueRegistry,
    regularSource
} = await import(pathToFileURL(path.join(repositoryRoot, 'tools/frontend/style-toolchain/closed-canonical-edge.mjs')).href);

function currentFixture(callback)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-current-canonical-edge-'));
    try
    {
        write(root, caller, originalCaller);
        write(root, owner, originalOwner);
        callback(root);
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

currentTest('missing reviewed authority is a decision refusal while CLI help stays read-only',
    { skip: missingAuthority === false ? 'UNRUN: protected authority is present; absent-decision control is not applicable' : false }, () =>
{
    assert.equal(missingAuthority !== false, true, 'this control binds the current absent decision');
    assert.throws(() => validateCandidatePolicy(repositoryRoot), /closed canonical edge authority unavailable/u);
    const output = execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/frontend/check-frontend-style.mjs'), '--help'],
        { encoding: 'utf8' });
    assert.match(output, /Usage:/u);
});

for (const [name, mutate] of Object.entries(callerMutations))
{
    currentTest(`current actual CLI refuses unapproved caller ${name}`, () =>
    {
        currentFixture((root) =>
        {
            write(root, caller, mutate(originalCaller));
            try
            {
                execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/frontend/check-frontend-style.mjs'),
                    '--root', root, '--mode', 'strict-full', '--file', caller], { encoding: 'utf8', stdio: 'pipe' });
                assert.fail('unapproved caller reached successful style execution');
            }
            catch (error)
            {
                assert.equal(error.status, 1);
                assert.match(error.stderr, /missing or duplicate closed canonical source edge|canonical caller or exact static named edge drift|inline rule directives|closed canonical edge authority unavailable/u);
            }
            assert.equal(fs.existsSync(path.join(root, '.tmp')), false);
        });
    });
}

for (const capability of [
    "import fs from 'node:fs';\n", "import process from 'node:process';\n",
    "import net from 'node:net';\n", "import { value } from './hidden.mjs';\n",
    "globalThis['process'].exit();\n", "eval('1');\n", "new Function('return 1')();\n",
    "await import('node:fs');\n", "require('node:fs');\n", "process.cwd();\n"
])
{
    currentTest(`current original owner capability guard refuses ${capability.trim()}`, () =>
    {
        currentFixture((root) =>
        {
            write(root, owner, `${originalOwner}\n${capability}`);
            assert.throws(() => validateSelectedCanonicalSource(root, [caller]),
                /canonical capability|canonical computed ambient access|canonical transitive closure/u);
        });
    });
}

currentTest('raw decoded duplicate members are rejected by the original registry decoder', () =>
{
    assert.deepEqual(parseUniqueRegistry('{"edge":{"caller":"x"},"list":[{"a":1}]}'),
        { edge: { caller: 'x' }, list: [{ a: 1 }] });
    for (const source of [
        '{"schema":"wrong","schema":"x"}', '{"schema":"x","schema":"x"}', '{"schema":"x","\\u0073chema":"x"}',
        '{"edge":{"caller":"x","caller":"x"}}', '{"edge":{"caller":"x","\\u0063aller":"x"}}',
        '{"list":[{"a":1,"\\u0061":2}]}',
        '{"policy":{".editorconfig":"wrong",".editorconfig":"x"}}',
        '{"policy":{".editorconfig":"x","\\u002eeditorconfig":"x"}}'
    ]) assert.throws(() => parseUniqueRegistry(source), /duplicate raw registry member/u);
});

for (const relative of [caller, owner])
{
    currentTest(`current same-descriptor source guard refuses aliases and mode changes: ${relative}`, () =>
    {
        currentFixture((root) =>
        {
            const target = path.join(root, relative);
            assert.equal(regularSource(root, relative), fs.readFileSync(target, 'utf8'));
            fs.chmodSync(target, 0o755);
            assert.throws(() => regularSource(root, relative), /executable mode/u);
            fs.chmodSync(target, 0o644);
            fs.linkSync(target, `${target}.copy`);
            assert.throws(() => regularSource(root, relative), /single-link/u);
            fs.unlinkSync(`${target}.copy`);
            fs.renameSync(target, `${target}.copy`);
            fs.symlinkSync(`${target}.copy`, target);
            assert.throws(() => regularSource(root, relative), /redirected/u);
        });
    });
    for (const [stage, ordinal, reads, diagnostic] of [
        ['first-open', 1, 0, /changed while opening/u],
        ['verification-open', 2, 1, /changed before read verification/u]
    ])
    {
        currentTest(`current actual ${relative} replacement before ${stage} never reads a replacement descriptor`, (context) =>
        {
            currentFixture((root) =>
            {
                const target = path.join(root, relative);
                const open = fs.openSync;
                const read = fs.readFileSync;
                const close = fs.closeSync;
                const descriptors = new Set();
                let opens = 0;
                let actualReads = 0;
                let replaced = false;
                context.mock.method(fs, 'openSync', (file, ...args) =>
                {
                    if (file === target && ++opens === ordinal)
                    {
                        fs.copyFileSync(target, `${target}.replacement`);
                        fs.renameSync(`${target}.replacement`, target);
                        replaced = true;
                    }
                    const descriptor = open.call(fs, file, ...args);
                    if (file === target) descriptors.add(descriptor);
                    return descriptor;
                });
                context.mock.method(fs, 'readFileSync', (descriptor, ...args) =>
                {
                    if (descriptors.has(descriptor)) actualReads += 1;
                    return read.call(fs, descriptor, ...args);
                });
                context.mock.method(fs, 'closeSync', (descriptor) =>
                {
                    descriptors.delete(descriptor);
                    return close.call(fs, descriptor);
                });
                try
                {
                    assert.throws(() => regularSource(root, relative), diagnostic);
                    assert.equal(replaced, true);
                    assert.equal(actualReads, reads);
                }
                finally
                {
                    context.mock.restoreAll();
                }
            });
        });
    }
}

currentTest('cached classifier drift still refuses before missing policy can obscure it', () =>
{
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-current-edge-cache-'));
    try
    {
        const relative = 'tools/frontend/style-toolchain/closed-canonical-edge.mjs';
        write(clone, relative, fs.readFileSync(path.join(repositoryRoot, relative)));
        fs.symlinkSync(path.join(repositoryRoot, 'tools/frontend/style-toolchain/node_modules'),
            path.join(clone, 'tools/frontend/style-toolchain/node_modules'), 'dir');
        // Parser transport here is deliberately unqualified. The clone has no
        // registry and can never grant admission; only its classifier drift is tested.
        execFileSync(process.execPath, ['--input-type=module', '-e', `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import { pathToFileURL } from 'node:url';
            const filename = process.argv[1];
            const module = await import(pathToFileURL(filename));
            assert.throws(() => module.validateCandidatePolicy(process.argv[2]), /authority unavailable/);
            const registry = process.argv[2] + '/config/development/canonical-digest-edge.json';
            fs.mkdirSync(process.argv[2] + '/config/development', { recursive: true });
            fs.writeFileSync(registry, '{}');
            assert.throws(() => module.validateCandidatePolicy(process.argv[2]), /authority unavailable/);
            fs.appendFileSync(filename, '\\n ');
            assert.throws(() => module.validateCandidatePolicy(process.argv[2]), /cached classifier authority drift/);
        `, path.join(clone, relative), clone]);
    }
    finally
    {
        fs.rmSync(clone, { recursive: true, force: true });
    }
});

currentTest('current ordinary listener wrapper retains all parent rule visitors without authority', () =>
{
    const events = [];
    const names = ['Program', 'ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression', 'CallExpression'];
    const original = { meta: { messages: { original: 'original' } },
        create: () => Object.fromEntries(names.map((name) => [name, () => events.push(name)])) };
    const rule = wrapParentImportRule(original);
    const listeners = rule.create({ physicalFilename: path.join(repositoryRoot, 'tools/docs/ordinary.mjs'), sourceCode: { text: '' } });
    for (const name of names) listeners[name]({ body: [], ...importNode });
    assert.deepEqual(events, names);
    assert.equal(rule.meta.messages.original, 'original');
});

currentTest('current caller and owner descriptor reads reject every original read-window mutation', (context) =>
{
    for (const relative of [caller, owner])
    {
        for (const mutation of ['symlink', 'replacement', 'hardlink', 'mode', 'content', 'parent'])
        {
            currentFixture((root) =>
            {
                const target = path.join(root, relative);
                const expected = fs.lstatSync(target, { bigint: true });
                const read = fs.readFileSync;
                let changed = false;
                context.mock.method(fs, 'readFileSync', (descriptor, ...args) =>
                {
                    fs.readFileSync.mock.resetCalls();
                    const bytes = read.call(fs, descriptor, ...args);
                    if (typeof descriptor === 'number' && !changed)
                    {
                        const actual = fs.fstatSync(descriptor, { bigint: true });
                        if (actual.dev === expected.dev && actual.ino === expected.ino)
                        {
                            changed = true;
                            if (mutation === 'symlink')
                            {
                                fs.renameSync(target, `${target}.copy`);
                                fs.symlinkSync(`${target}.copy`, target);
                            }
                            else if (mutation === 'replacement')
                            {
                                fs.copyFileSync(target, `${target}.copy`);
                                fs.renameSync(`${target}.copy`, target);
                            }
                            else if (mutation === 'hardlink') fs.linkSync(target, `${target}.copy`);
                            else if (mutation === 'mode') fs.chmodSync(target, 0o755);
                            else if (mutation === 'content') fs.appendFileSync(target, '\n ');
                            else
                            {
                                const parent = path.dirname(target);
                                fs.renameSync(parent, `${parent}.copy`);
                                fs.symlinkSync(`${parent}.copy`, parent);
                            }
                        }
                    }
                    return bytes;
                });
                try
                {
                    assert.throws(() => regularSource(root, relative));
                    assert.equal(changed, true, `${relative}: ${mutation} must reach the actual descriptor window`);
                }
                finally
                {
                    context.mock.restoreAll();
                }
            });
        }
    }
});

currentTest('current executor rejects authority, policy and write options before missing decision or cache writes', () =>
{
    currentFixture((root) =>
    {
        for (const [options, diagnostic] of [
            [['--authority-root', root], /unknown argument --authority-root/u],
            [['--policy', path.join(root, 'candidate-policy.json')], /executing authority checkout/u],
            [['--fix'], /candidate source is read-only/u],
            [['--update-baseline'], /candidate source is read-only/u]
        ])
        {
            try
            {
                execFileSync(process.execPath, [path.join(repositoryRoot, 'tools/frontend/check-frontend-style.mjs'),
                    '--root', root, '--mode', 'changed', '--file', caller, ...options], { encoding: 'utf8', stdio: 'pipe' });
                assert.fail('unowned authority or candidate write option accepted');
            }
            catch (error)
            {
                assert.equal(error.status, 1);
                assert.match(error.stderr, diagnostic);
            }
        }
        assert.equal(fs.readFileSync(path.join(root, caller), 'utf8'), originalCaller);
        assert.equal(fs.existsSync(path.join(root, '.tmp')), false);
    });
});
