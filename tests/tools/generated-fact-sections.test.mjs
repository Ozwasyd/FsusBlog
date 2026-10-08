import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
    cpSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { loadCatalog, loadCatalogSchema, validateCatalog, validateCatalogSchemaContract, resolveFactPath, catalogSchemaId, root } = await import(new URL("../../tools/docs/generated-fact-sections/catalog.mjs", import.meta.url));
const { assertDeterministicRender, assertObservationIdentity, processGeneratedFactSections, renderSectionFromReceipt, indexReceiptsByExtractor } = await import(new URL("../../tools/docs/generated-fact-sections/generator.mjs", import.meta.url));
const { scanGeneratedFactSectionGovernance, formatGovernanceViolations } = await import(new URL("../../tools/docs/generated-fact-sections/governance.mjs", import.meta.url));
const { formatBeginMarker, formatEndMarker, parseGeneratedMarkers, replaceGeneratedSections, wrapGeneratedSection, GeneratedSectionErrorCode } = await import(new URL("../../tools/docs/generated-fact-sections/markers.mjs", import.meta.url));
const { RendererRegistry, allowedRenderers, compareOrdinal } = await import(new URL("../../tools/docs/generated-fact-sections/renderers.mjs", import.meta.url));
const { sealSourceIdentity } = await import(new URL("../../tools/fact-extractors/identity.mjs", import.meta.url));
const { digestValue } = await import(new URL("../../tools/fact-extractors/lib/canonicalize.mjs", import.meta.url));
const { buildReceipt, sealReceipt } = await import(new URL("../../tools/fact-extractors/receipt.mjs", import.meta.url));

const cli = path.join(root, 'tools/docs/generate-fact-sections.mjs');

function fixtureRoot()
{
    return mkdtempSync(path.join(os.tmpdir(), 'fsusblog-generated-fact-sections-'));
}

function write(directory, relative, content)
{
    const target = path.join(directory, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    return target;
}

function copyFramework(directory)
{
    for (const relative of [
        'config/schemas/fact-observation-receipt.schema.json',
        'config/schemas/generated-fact-section-catalog.schema.json',
        'config/contracts/generated-fact-sections.json',
        'tools/fact-extractors/lib/canonicalize.mjs',
        'tools/fact-extractors/identity.mjs',
        'tools/fact-extractors/receipt.mjs',
        'tools/fact-extractors/reader.mjs',
        'tools/fact-extractors/registry.mjs',
        'tools/docs/generated-fact-sections/markers.mjs',
        'tools/docs/generated-fact-sections/renderers.mjs',
        'tools/docs/generated-fact-sections/catalog.mjs',
        'tools/docs/generated-fact-sections/generator.mjs',
        'tools/docs/generated-fact-sections/governance.mjs',
        'tools/docs/generate-fact-sections.mjs'
    ])
    {
        const target = path.join(directory, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(path.join(root, relative), target);
    }
}

function initGit(directory)
{
    spawnSync('git', ['init'], { cwd: directory, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: directory, encoding: 'utf8' });
    spawnSync('git', ['add', '-A'], { cwd: directory, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'fixture'], { cwd: directory, encoding: 'utf8' });
    return sealSourceIdentity(directory);
}

function sampleCatalog(sections)
{
    return {
        schema: catalogSchemaId,
        digestAlgorithm: 'sha256',
        canonicalSerialization: 'json-utf8-v1',
        sections
    };
}

function sectionDef(overrides = {})
{
    return {
        sectionId: 'auth.permissions.all',
        documentPath: 'docs/security.md',
        renderer: 'enum-set',
        extractorId: 'auth-session-permission-fact-extractor',
        behaviorId: 'authentication-session-permission',
        factPath: 'permissions',
        orderPolicy: 'ordinal',
        emptyPolicy: 'fail',
        ...overrides
    };
}

function makeReceipt({
    extractorId = 'auth-session-permission-fact-extractor',
    behaviorIds = ['authentication-session-permission'],
    observations = { permissions: ['admin.read', 'admin.write'] },
    sourceCommit,
    worktreeFingerprint,
    buildIdentity = null,
    status = 'ok',
    failureReasons = []
})
{
    return sealReceipt(buildReceipt({
        extractorId,
        behaviorIds,
        sourceCommit,
        worktreeFingerprint,
        buildIdentity,
        extractorDigest: 'a'.repeat(64),
        registryDigest: 'b'.repeat(64),
        consumedInputDigests: [{ path: 'src/backend/Infrastructure/Auth/AdminPermissions.cs', digest: 'c'.repeat(64) }],
        observations,
        status,
        failureReasons
    }));
}

function documentWithSection(sectionId, body)
{
    return [
        '# Security',
        '',
        'Prose outside the marker must survive generation.',
        '',
        wrapGeneratedSection(sectionId, body),
        '',
        'Trailing explanation stays put.',
        ''
    ].join('\n');
}

test('catalog schema contract is fail-closed and forbids baseline allowlists', () =>
{
    validateCatalogSchemaContract(loadCatalogSchema());
    const catalog = loadCatalog();
    assert.equal(catalog.schema, catalogSchemaId);
    assert.ok(catalog.sections.length > 0);
    validateCatalog(catalog);
});

test('RendererRegistry exposes exactly the admitted typed renderers', () =>
{
    assert.deepEqual([...RendererRegistry.kinds], [...allowedRenderers]);
    for (const kind of allowedRenderers)
    {
        assert.equal(typeof RendererRegistry.get(kind), 'function');
    }
    assert.throws(
        () => RendererRegistry.get('json-blob'),
        (error) => error.code === GeneratedSectionErrorCode.RENDERER_UNKNOWN
    );
});

test('typed renderers are deterministic across two runs', () =>
{
    const cases = [
        { renderer: 'scalar', value: { value: 5, unit: 'minutes' } },
        { renderer: 'boolean', value: true },
        { renderer: 'enum-set', value: ['z', 'a', 'm'] },
        { renderer: 'ordered-set', value: ['first', 'second', 'third'] },
        { renderer: 'key-value-table', value: { beta: 2, alpha: 1 } },
        { renderer: 'transition-table', value: ['Update:Draft->Published', 'Create:Draft->Draft'] },
        { renderer: 'failure-mode-table', value: ['rate_limited', 'auth_required'] },
        {
            renderer: 'route-table',
            value: [
                { method: 'GET', path: '/api/b', auth: 'user', protocol: 'aeds' },
                { method: 'GET', path: '/api/a', auth: 'anon', protocol: 'aeds' }
            ]
        },
        {
            renderer: 'dependency-graph-table',
            value: [
                { from: 'tier-b', to: 'tier-c' },
                { from: 'tier-a', to: 'tier-b' }
            ]
        }
    ];
    for (const entry of cases)
    {
        const section = sectionDef({
            sectionId: `demo.${entry.renderer}`,
            renderer: entry.renderer,
            factPath: 'value',
            orderPolicy: entry.renderer === 'ordered-set' ? 'preserve' : 'ordinal'
        });
        const first = assertDeterministicRender(section, entry.value, 2);
        const second = assertDeterministicRender(section, entry.value, 2);
        assert.equal(first, second);
        assert.ok(first.length > 0);
    }
});

test('enum-set sorts by ordinal and ignores observation order / filesystem order', () =>
{
    const left = RendererRegistry.render('enum-set', ['zeta', 'alpha', 'mu'], { orderPolicy: 'ordinal', emptyPolicy: 'fail' });
    const right = RendererRegistry.render('enum-set', ['mu', 'zeta', 'alpha'], { orderPolicy: 'ordinal', emptyPolicy: 'fail' });
    assert.equal(left, right);
    assert.equal(left, ['alpha', 'mu', 'zeta'].map((item) => `- \`${item}\``).join('\n'));
    // Explicit ordinal comparator is stable for identical inputs shuffled.
    const shuffled = ['file-c', 'file-a', 'file-b'].sort(() => 0.5 - Math.random());
    const sorted = [...shuffled].sort(compareOrdinal);
    assert.deepEqual(sorted, ['file-a', 'file-b', 'file-c']);
});

test('ordered-set preserves observation order', () =>
{
    const rendered = RendererRegistry.render(
        'ordered-set',
        ['create', 'review', 'publish'],
        { orderPolicy: 'preserve', emptyPolicy: 'fail' }
    );
    assert.equal(
        rendered,
        ['create', 'review', 'publish'].map((item) => `- \`${item}\``).join('\n')
    );
});

test('table observation text cannot become inline HTML or an HTML entity', () =>
{
    const rendered = RendererRegistry.render(
        'key-value-table',
        { '<method>': '<MapAuthoringModerationRoutes> &lt;raw&gt; | next\nline' },
        { orderPolicy: 'ordinal', emptyPolicy: 'fail' }
    );
    assert.doesNotMatch(rendered, /<[^>]*>/u);
    assert.match(rendered, /&lt;method&gt;/u);
    assert.match(rendered, /&lt;MapAuthoringModerationRoutes&gt;/u);
    assert.match(rendered, /&amp;lt;raw&amp;gt;/u);
    assert.ok(rendered.includes('\\| next line'));
});

test('transition-table and route-table emit fixed columns', () =>
{
    const transitions = RendererRegistry.render(
        'transition-table',
        [{ from: 'Draft', to: 'Published', guard: 'publish.allowed' }],
        { orderPolicy: 'ordinal', emptyPolicy: 'fail' }
    );
    assert.match(transitions, /\| From \| To \| Guard \|/);
    assert.match(transitions, /Draft/);
    assert.match(transitions, /publish\.allowed/);

    const routes = RendererRegistry.render(
        'route-table',
        [{ method: 'POST', path: '/api/login', auth: 'anon', protocol: 'aeds' }],
        { orderPolicy: 'ordinal', emptyPolicy: 'fail' }
    );
    assert.match(routes, /\| Method \| Path \| Auth \| Protocol \|/);
});

test('emptyPolicy fail rejects empty sets; render-empty emits placeholder', () =>
{
    assert.throws(
        () => RendererRegistry.render('enum-set', [], { emptyPolicy: 'fail' }),
        (error) => error.code === GeneratedSectionErrorCode.EMPTY_POLICY
    );
    assert.equal(
        RendererRegistry.render('enum-set', [], { emptyPolicy: 'render-empty' }),
        '_empty set_'
    );
});

test('marker parser requires unique paired non-nested begin/end', () =>
{
    const ok = parseGeneratedMarkers(documentWithSection('auth.permissions.all', '- `a`\n'));
    assert.equal(ok.length, 1);
    assert.equal(ok[0].sectionId, 'auth.permissions.all');

    assert.throws(
        () => parseGeneratedMarkers(`${formatBeginMarker('a')}\nbody\n`),
        (error) => error.code === GeneratedSectionErrorCode.MARKER_UNPAIRED
    );

    assert.throws(
        () => parseGeneratedMarkers(
            `${formatBeginMarker('a')}\n${formatBeginMarker('b')}\nx\n${formatEndMarker('b')}\n${formatEndMarker('a')}\n`
        ),
        (error) => error.code === GeneratedSectionErrorCode.MARKER_NESTED
    );

    assert.throws(
        () => parseGeneratedMarkers(
            `${wrapGeneratedSection('same.id', 'one')}\n${wrapGeneratedSection('same.id', 'two')}\n`
        ),
        (error) => error.code === GeneratedSectionErrorCode.MARKER_DUPLICATE_ID
    );
});

test('replaceGeneratedSections rewrites only owned ranges and drops manual extra rows', () =>
{
    const source = documentWithSection(
        'auth.permissions.all',
        '- `admin.read`\n- `manual.extra.row`\n- `stale`\n'
    );
    const next = replaceGeneratedSections(
        source,
        new Map([['auth.permissions.all', '- `admin.read`\n- `admin.write`']])
    );
    assert.match(next, /Prose outside the marker must survive generation/);
    assert.match(next, /Trailing explanation stays put/);
    assert.match(next, /admin\.write/);
    assert.doesNotMatch(next, /manual\.extra\.row/);
    assert.doesNotMatch(next, /stale/);
    // Existing body was not merged; full replacement from observation only.
    const markers = parseGeneratedMarkers(next);
    assert.equal(markers[0].existingBody.trim(), '- `admin.read`\n- `admin.write`');
});

test('counter-example: observation adds permission but generated table stays stale → check fails', () =>
{
    const directory = fixtureRoot();
    try
    {
        copyFramework(directory);
        write(
            directory,
            'docs/security.md',
            documentWithSection('auth.permissions.all', '- `admin.read`\n')
        );
        write(
            directory,
            'config/contracts/generated-fact-sections.json',
            `${JSON.stringify(sampleCatalog([sectionDef()]), null, 2)}\n`
        );
        const identity = initGit(directory);
        const receipt = makeReceipt({
            ...identity,
            observations: { permissions: ['admin.read', 'admin.write'] }
        });
        write(directory, '.tmp/receipt.json', `${JSON.stringify(receipt)}\n`);

        assert.throws(
            () => processGeneratedFactSections({
                repositoryRoot: directory,
                mode: 'check',
                catalog: sampleCatalog([sectionDef()]),
                receipts: [path.join(directory, '.tmp/receipt.json')],
                expectedIdentity: identity
            }),
            (error) => error.code === GeneratedSectionErrorCode.CHECK_DRIFT
        );
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('counter-example: manual deletion of a generated row fails check', () =>
{
    const directory = fixtureRoot();
    try
    {
        copyFramework(directory);
        const identity = (() =>
        {
            write(
                directory,
                'docs/security.md',
                documentWithSection(
                    'errors.codes',
                    '| Failure mode | Semantic |\n| --- | --- |\n| auth_required | - |\n'
                )
            );
            write(
                directory,
                'config/contracts/generated-fact-sections.json',
                `${JSON.stringify(sampleCatalog([
                    sectionDef({
                        sectionId: 'errors.codes',
                        renderer: 'failure-mode-table',
                        extractorId: 'config-error-security-policy-fact-extractor',
                        behaviorId: 'config-error-security-policy',
                        factPath: 'errorCodes'
                    })
                ]), null, 2)}\n`
            );
            return initGit(directory);
        })();

        const receipt = makeReceipt({
            extractorId: 'config-error-security-policy-fact-extractor',
            behaviorIds: ['config-error-security-policy'],
            observations: { errorCodes: ['auth_required', 'rate_limited'] },
            ...identity
        });

        assert.throws(
            () => processGeneratedFactSections({
                repositoryRoot: directory,
                mode: 'check',
                catalog: sampleCatalog([
                    sectionDef({
                        sectionId: 'errors.codes',
                        renderer: 'failure-mode-table',
                        extractorId: 'config-error-security-policy-fact-extractor',
                        behaviorId: 'config-error-security-policy',
                        factPath: 'errorCodes'
                    })
                ]),
                receiptsByExtractor: indexReceiptsByExtractor([receipt]),
                expectedIdentity: identity
            }),
            (error) => error.code === GeneratedSectionErrorCode.CHECK_DRIFT
        );
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('receipt-canonical empty set {count:0} obeys render-empty without becoming a map row', () =>
{
    assert.equal(RendererRegistry.render('enum-set', { count: 0 }, { emptyPolicy: 'render-empty' }), '_empty set_');
    assert.throws(
        () => RendererRegistry.render('enum-set', { count: 0 }, { emptyPolicy: 'fail' }),
        /empty observation rejected/u
    );
});

test('counter-example: tampered generated value with only lastVerifiedCommit change still fails', () =>
{
    const directory = fixtureRoot();
    try
    {
        copyFramework(directory);
        write(
            directory,
            'docs/security.md',
            documentWithSection('auth.stepup.freshness', '50 minutes\n')
        );
        write(
            directory,
            'config/development/document-lifecycle.json',
            `${JSON.stringify({ lastVerifiedCommit: 'f'.repeat(40) }, null, 2)}\n`
        );
        write(
            directory,
            'config/contracts/generated-fact-sections.json',
            `${JSON.stringify(sampleCatalog([
                sectionDef({
                    sectionId: 'auth.stepup.freshness',
                    renderer: 'scalar',
                    factPath: 'freshness',
                    orderPolicy: 'not-applicable'
                })
            ]), null, 2)}\n`
        );
        const identity = initGit(directory);
        const receipt = makeReceipt({
            ...identity,
            observations: { freshness: { value: 5, unit: 'minutes' } }
        });
        // lastVerifiedCommit is irrelevant and must not create pass evidence.
        assert.throws(
            () => processGeneratedFactSections({
                repositoryRoot: directory,
                mode: 'check',
                catalog: sampleCatalog([
                    sectionDef({
                        sectionId: 'auth.stepup.freshness',
                        renderer: 'scalar',
                        factPath: 'freshness',
                        orderPolicy: 'not-applicable'
                    })
                ]),
                receiptsByExtractor: indexReceiptsByExtractor([receipt]),
                expectedIdentity: identity
            }),
            (error) => error.code === GeneratedSectionErrorCode.CHECK_DRIFT
        );
        // Lifecycle metadata file is never rewritten by generate either.
        const lifecycleBefore = readFileSync(path.join(directory, 'config/development/document-lifecycle.json'), 'utf8');
        processGeneratedFactSections({
            repositoryRoot: directory,
            mode: 'generate',
            catalog: sampleCatalog([
                sectionDef({
                    sectionId: 'auth.stepup.freshness',
                    renderer: 'scalar',
                    factPath: 'freshness',
                    orderPolicy: 'not-applicable'
                })
            ]),
            receiptsByExtractor: indexReceiptsByExtractor([receipt]),
            expectedIdentity: identity
        });
        const lifecycleAfter = readFileSync(path.join(directory, 'config/development/document-lifecycle.json'), 'utf8');
        assert.equal(lifecycleAfter, lifecycleBefore);
        const doc = readFileSync(path.join(directory, 'docs/security.md'), 'utf8');
        assert.match(doc, /5 minutes/);
        assert.doesNotMatch(doc, /50 minutes/);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('counter-example: observation from old build is refused before write', () =>
{
    const directory = fixtureRoot();
    try
    {
        copyFramework(directory);
        write(
            directory,
            'docs/security.md',
            documentWithSection('auth.permissions.all', '- `admin.read`\n')
        );
        write(
            directory,
            'config/contracts/generated-fact-sections.json',
            `${JSON.stringify(sampleCatalog([sectionDef()]), null, 2)}\n`
        );
        const identity = initGit(directory);
        const staleReceipt = makeReceipt({
            sourceCommit: '0'.repeat(40),
            worktreeFingerprint: '1'.repeat(64),
            observations: { permissions: ['admin.read', 'admin.write'] }
        });

        assert.throws(
            () => processGeneratedFactSections({
                repositoryRoot: directory,
                mode: 'generate',
                catalog: sampleCatalog([sectionDef()]),
                receiptsByExtractor: indexReceiptsByExtractor([staleReceipt]),
                expectedIdentity: identity
            }),
            (error) => error.code === GeneratedSectionErrorCode.OBSERVATION_STALE
        );
        const doc = readFileSync(path.join(directory, 'docs/security.md'), 'utf8');
        assert.match(doc, /admin\.read/);
        assert.doesNotMatch(doc, /admin\.write/);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('counter-example: check mode never rewrites the file', () =>
{
    const directory = fixtureRoot();
    try
    {
        copyFramework(directory);
        const docPath = write(
            directory,
            'docs/security.md',
            documentWithSection(
                'auth.permissions.all',
                '- `admin.read`\n- `admin.write`\n'
            )
        );
        write(
            directory,
            'config/contracts/generated-fact-sections.json',
            `${JSON.stringify(sampleCatalog([sectionDef()]), null, 2)}\n`
        );
        const identity = initGit(directory);
        const receipt = makeReceipt({
            ...identity,
            observations: { permissions: ['admin.read', 'admin.write'] }
        });
        chmodSync(docPath, 0o444);
        const before = readFileSync(docPath);
        const beforeStat = statSync(docPath);
        const result = processGeneratedFactSections({
            repositoryRoot: directory,
            mode: 'check',
            catalog: sampleCatalog([sectionDef()]),
            receiptsByExtractor: indexReceiptsByExtractor([receipt]),
            expectedIdentity: identity
        });
        assert.equal(result.status, 'ok');
        const after = readFileSync(docPath);
        const afterStat = statSync(docPath);
        assert.ok(before.equals(after));
        assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
        chmodSync(docPath, 0o644);
    }
    finally
    {
        try
        {
            chmodSync(path.join(directory, 'docs/security.md'), 0o644);
        }
        catch
        { /* ignore */ }
        rmSync(directory, { recursive: true, force: true });
    }
});

test('generate replaces only owned sections; exterior prose and second section untouched if not owned', () =>
{
    const directory = fixtureRoot();
    try
    {
        copyFramework(directory);
        const source = [
            '# Security',
            '',
            'Intro prose.',
            '',
            wrapGeneratedSection('auth.permissions.all', '- `old`\n'),
            '',
            'Middle prose.',
            '',
            wrapGeneratedSection('auth.methods', '- `passkey`\n'),
            ''
        ].join('\n');
        write(directory, 'docs/security.md', source);
        const catalog = sampleCatalog([
            sectionDef({ sectionId: 'auth.permissions.all', factPath: 'permissions' }),
            sectionDef({
                sectionId: 'auth.methods',
                factPath: 'methods',
                orderPolicy: 'ordinal'
            })
        ]);
        write(directory, 'config/contracts/generated-fact-sections.json', `${JSON.stringify(catalog, null, 2)}\n`);
        const identity = initGit(directory);
        const receipt = makeReceipt({
            ...identity,
            observations: {
                permissions: ['admin.write', 'admin.read'],
                methods: ['passkey', 'recovery_key']
            }
        });
        const result = processGeneratedFactSections({
            repositoryRoot: directory,
            mode: 'generate',
            catalog,
            receiptsByExtractor: indexReceiptsByExtractor([receipt]),
            expectedIdentity: identity
        });
        assert.deepEqual(result.written, ['docs/security.md']);
        const next = readFileSync(path.join(directory, 'docs/security.md'), 'utf8');
        assert.match(next, /Intro prose/);
        assert.match(next, /Middle prose/);
        assert.match(next, /admin\.read/);
        assert.match(next, /admin\.write/);
        assert.match(next, /passkey/);
        assert.match(next, /recovery_key/);
        assert.doesNotMatch(next, /- `old`/);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('same input twice produces identical document bytes', () =>
{
    const directory = fixtureRoot();
    try
    {
        copyFramework(directory);
        write(
            directory,
            'docs/security.md',
            documentWithSection('auth.permissions.all', '- `stale`\n')
        );
        write(
            directory,
            'config/contracts/generated-fact-sections.json',
            `${JSON.stringify(sampleCatalog([sectionDef()]), null, 2)}\n`
        );
        const identity = initGit(directory);
        const receipt = makeReceipt({
            ...identity,
            observations: { permissions: ['admin.write', 'admin.read'] }
        });
        const run = () => processGeneratedFactSections({
            repositoryRoot: directory,
            mode: 'generate',
            catalog: sampleCatalog([sectionDef()]),
            receiptsByExtractor: indexReceiptsByExtractor([receipt]),
            expectedIdentity: identity
        });
        run();
        const first = readFileSync(path.join(directory, 'docs/security.md'), 'utf8');
        run();
        const second = readFileSync(path.join(directory, 'docs/security.md'), 'utf8');
        assert.equal(second, first);
        assert.equal(
            createHash('sha256').update(first).digest('hex'),
            createHash('sha256').update(second).digest('hex')
        );
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('catalog rejects duplicate fact ownership and forbidden baseline fields', () =>
{
    assert.throws(
        () => validateCatalog(sampleCatalog([
            sectionDef({ sectionId: 'a.one' }),
            sectionDef({ sectionId: 'a.two' })
        ])),
        (error) => error.code === GeneratedSectionErrorCode.FACT_DUPLICATE_OWNER
    );
    assert.throws(
        () => validateCatalog(sampleCatalog([
            sectionDef({ baselineAllowlist: true })
        ])),
        (error) => error.code === GeneratedSectionErrorCode.BASELINE_ALLOWLIST
            || error.code === GeneratedSectionErrorCode.CATALOG_INVALID
    );
});

test('resolveFactPath prefers exact keys then nested descent', () =>
{
    const observations = {
        permissions: ['a'],
        nested: { child: { value: 3 } },
        facts: { 'auth.authentication-methods': { active: ['passkey'] } }
    };
    assert.deepEqual(resolveFactPath(observations, 'permissions'), ['a']);
    assert.equal(resolveFactPath(observations, 'nested.child.value'), 3);
    assert.deepEqual(resolveFactPath(observations, 'facts.auth.authentication-methods.active'), ['passkey']);
    assert.equal(resolveFactPath(observations, 'missing'), undefined);
});

test('renderSectionFromReceipt refuses failed or mismatched receipts', () =>
{
    const identity = {
        sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: 'b'.repeat(64)
    };
    const failed = makeReceipt({
        ...identity,
        status: 'failed',
        failureReasons: ['boom'],
        observations: {}
    });
    assert.throws(
        () => renderSectionFromReceipt(sectionDef(), failed, identity),
        (error) => error.code === GeneratedSectionErrorCode.OBSERVATION_FAILED
    );
    const ok = makeReceipt({
        ...identity,
        observations: { permissions: ['x'] }
    });
    assert.throws(
        () => assertObservationIdentity(ok, {
            sourceCommit: 'c'.repeat(40),
            worktreeFingerprint: identity.worktreeFingerprint
        }),
        (error) => error.code === GeneratedSectionErrorCode.OBSERVATION_STALE
    );
});

test('repository governance scan is clean and renderer has no extractor imports', () =>
{
    const violations = scanGeneratedFactSectionGovernance(root);
    assert.deepEqual(violations, [], formatGovernanceViolations(violations).join('\n'));
    const rendererSource = readFileSync(path.join(root, 'tools/docs/generated-fact-sections/renderers.mjs'), 'utf8');
    assert.doesNotMatch(rendererSource, /fact-extractors\//);
    assert.doesNotMatch(rendererSource, /from\s+['"].*\/src\//);
    assert.doesNotMatch(rendererSource, /from\s+['"].*tests\//);
    const generatorSource = readFileSync(path.join(root, 'tools/docs/generated-fact-sections/generator.mjs'), 'utf8');
    assert.doesNotMatch(generatorSource, /runExtractor|importExtractorModule|fact-extractors\/seeds/);
    // Dual-authority implementation surfaces must not exist outside ban-list patterns.
    for (const relative of [
        'tools/docs/generated-fact-sections/renderers.mjs',
        'tools/docs/generated-fact-sections/catalog.mjs',
        'tools/docs/generated-fact-sections/generator.mjs',
        'tools/docs/generate-fact-sections.mjs'
    ])
    {
        const source = readFileSync(path.join(root, relative), 'utf8');
        assert.doesNotMatch(source, /\bdomainRendererRegistry\b/);
        assert.doesNotMatch(source, /\bsectionDiffAllowlist\b/);
        assert.doesNotMatch(source, /\bwarningOnlyGeneratedSections\b/);
        assert.doesNotMatch(source, /export\s+const\s+legacyRendererRegistry\b/);
        assert.doesNotMatch(source, /function\s+parseLegacyGeneratedSection\b/);
    }
    // Marker/governance modules may name forbidden tokens only inside reject patterns.
    const markerSource = readFileSync(path.join(root, 'tools/docs/generated-fact-sections/markers.mjs'), 'utf8');
    assert.match(markerSource, /MARKER_COMPAT/);
    assert.doesNotMatch(markerSource, /function\s+parseLegacyGeneratedSection\b/);
});

test('repository governance rejects a lifecycle metadata write target', (t) =>
{
    const directory = fixtureRoot();
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    copyFramework(directory);
    write(directory, 'tools/docs/generated-fact-sections/generator.mjs', [
        "import { writeFileSync } from 'node:fs'",
        "writeFileSync('config/development/document-lifecycle.json', '{}\\n')",
        ''
    ].join('\n'));
    const violations = scanGeneratedFactSectionGovernance(directory);
    assert.ok(violations.some((entry) =>
        entry.code === GeneratedSectionErrorCode.LIFECYCLE_MUTATION
        && entry.documentPath === 'tools/docs/generated-fact-sections/generator.mjs'));
});

test('CLI --check on empty catalog succeeds with zero writes', () =>
{
    const directory = fixtureRoot();
    const catalogPath = write(directory, 'empty-catalog.json', `${JSON.stringify(sampleCatalog([]), null, 2)}\n`);
    const result = spawnSync(process.execPath, [cli, '--check', '--catalog', catalogPath], {
        cwd: root,
        encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /sections=0/);
});

test('CLI rejects unknown flags and missing mode', () =>
{
    const missing = spawnSync(process.execPath, [cli], { cwd: root, encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
    const unknown = spawnSync(process.execPath, [cli, '--check', '--baseline-allow'], {
        cwd: root,
        encoding: 'utf8'
    });
    assert.notEqual(unknown.status, 0);
});

test('digest helper used by receipts stays stable for identical observation payloads', () =>
{
    const left = digestValue({ permissions: ['a', 'b'] });
    const right = digestValue({ permissions: ['a', 'b'] });
    assert.equal(left, right);
    assert.notEqual(digestValue({ permissions: ['b', 'a'] }), left);
});
