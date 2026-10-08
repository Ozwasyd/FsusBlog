import assert from 'node:assert/strict';
import test from 'node:test';

const { inventoryArticleEmbedLegacySources } = await import(new URL('../../tools/governance/check-article-embed-legacy.mjs', import.meta.url));
const file = 'blog:src/frontend/ArticleEmbedRuntime.ts';
const inventory = (source) => inventoryArticleEmbedLegacySources(new Map([[file, source]]));

test('executable legacy routes fail closed as source diagnostics', () =>
{
    for (const source of [
        'const embedProvider = () => ResolveRemoteInclude(target);',
        'const embedProvider = () => GetLatestRevision(target);',
        'const privateCopy = copyPrivateTarget(target);',
        'const autoRefreshEmbed = () => refreshEmbedDependenciesAutomatically();',
        'const embedProvider = () => flushAllCaches();',
        'const scanRenderedEmbed = () => document.querySelectorAll("[data-embed]");',
        'class SecondArticleEmbedResolver {}',
        'const embedProvider = () => ({ html: "<iframe></iframe>" });',
        'const embedProvider = () => parse("::include[target=remote]");',
        'const embedProvider = () => consumerRegexScan(source);'
    ])
    {
        assert.ok(inventory(source).diagnostics.length > 0, source);
    }
});

test('comments, denial strings and unrelated legitimate APIs are retained and classified', () =>
{
    const source = '// GetLatestRevision and privateCopy are forbidden examples\n'
        + 'if (ContainsAnyOrdinalIgnoreCase(text, "remote-include")) { throw new ValidationException("forbidden"); }\n'
        + 'const LatestObservedRevision = facts.LatestObservedRevision;\n'
        + 'cache.autoRefresh(decision); refreshEmbedPresentations();';
    const report = inventory(source);
    assert.deepEqual(report.diagnostics, []);
    assert.ok(report.findings.some((finding) => finding.disposition === 'comment'));
    assert.ok(report.findings.some((finding) => finding.disposition === 'denial'));
    assert.equal(report.files[0].sha256.length, 64);
});

test('a URL inside a string cannot hide the following executable legacy call', () =>
{
    assert.ok(inventory('const embedProvider = () => { const url = "https://example.test"; return ResolveRemoteInclude(url); };').diagnostics.length);
});

test('negative mutation probes stay inspectable but escape to a provider fails', () =>
{
    const relative = 'fsusui:vue/packages/wasm/markdown-embed-directive.ts';
    const control = 'const consumerRegexScan = () => [];\nexport const evaluateMarkdownEmbedMutations = () => consumerRegexScan(source);\n';
    const controls = inventoryArticleEmbedLegacySources(new Map([[relative, control]]));
    assert.deepEqual(controls.diagnostics, []);
    assert.ok(controls.findings.some((finding) => finding.disposition === 'mutation-control'));
    const escaped = inventoryArticleEmbedLegacySources(new Map([[relative, control + 'export const embedProvider = () => consumerRegexScan(source);']]));
    assert.ok(escaped.diagnostics.some((finding) => finding.disposition === 'active'));
});

test('unknown include occurrences require review and are never silently accepted', () =>
{
    const report = inventory('const text = "::include[unsafe]";');
    assert.equal(report.diagnostics[0].disposition, 'review');
});

test('source inventory and line diagnostics are deterministic', () =>
{
    const a = new Map([[file, '\nconst privateCopy = 1;'], ['blog:src/Other.ts', 'const unrelated = 1;']]);
    const b = new Map([...a].reverse());
    assert.deepEqual(inventoryArticleEmbedLegacySources(a), inventoryArticleEmbedLegacySources(b));
    assert.equal(inventoryArticleEmbedLegacySources(a).diagnostics[0].line, 2);
});


test('negative probe classification ends at the next private declaration', () =>
{
    const source = 'export const evaluateMarkdownEmbedMutations = () => consumerRegexScan(source);\n'
        + 'const embedProvider = () => consumerRegexScan(source);';
    const report = inventoryArticleEmbedLegacySources(new Map([['fsusui:vue/packages/wasm/markdown-embed-directive.ts', source]]));
    assert.ok(report.diagnostics.some((finding) => finding.line === 2));
});

test('Unicode offsets and unrelated denial text cannot hide active includes', () =>
{
    const report = inventory('// 😀 privateCopy\nconst forbidden = true;\nconst embedProvider = () => parse("::include[unsafe]");');
    assert.ok(report.findings.some((finding) => finding.disposition === 'comment' && finding.line === 1));
    assert.ok(report.diagnostics.some((finding) => finding.disposition === 'review' && finding.line === 3));
});

test('null HTML fields remain inert while non-null provider payloads fail', () =>
{
    assert.deepEqual(inventory('const embedProvider = () => ({ html: null });').diagnostics, []);
    assert.ok(inventory('const embedProvider = () => ({ html: unsafe });').diagnostics.length);
});

test('tests and documents are included as references without runtime qualification', () =>
{
    const report = inventoryArticleEmbedLegacySources(new Map([
        ['blog:docs/legacy.md', '::include[unknown]'],
        ['blog:tests/frontend/embed.test.ts', 'const embedProvider = () => ({ html: unsafe });']
    ]));
    assert.equal(report.scannedFiles, 2);
    assert.equal(report.findings.length, 2);
    assert.deepEqual(report.findings.map((finding) => finding.disposition), ['document-reference', 'test-reference']);
    assert.deepEqual(report.diagnostics, []);
});


test('a governance rule corpus cannot exempt a following provider call', () =>
{
    const source = 'const forbiddenRuntime = [\n        ["legacy", /::include/],\n    ];\n'
        + 'const embedProvider = () => ResolveRemoteInclude(target);';
    const report = inventoryArticleEmbedLegacySources(new Map([['blog:tools/governance/check-article-embed-contract.mjs', source]]));
    assert.ok(report.findings.some((finding) => finding.disposition === 'governance-reference'));
    assert.ok(report.diagnostics.some((finding) => finding.line === 4));
});
