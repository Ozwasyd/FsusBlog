import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { articleProductSurfacePaths, checkArticleProductSurface, scanArticleProductSurfaceSources } from './check-article-product-surface-governance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const modulePath = articleProductSurfacePaths[1];
const fixture = () => new Map(articleProductSurfacePaths.map(file => [file, file.endsWith('.vue')
    ? '<script setup lang="ts">const preference = createArticleEditorSurfacePreference(scope);</script>'
    : readFileSync(path.join(root, file), 'utf8')]));

test('bounded valid controls use the actual domain source closure, without claiming a mounted Writer', () =>
{
    assert.deepEqual(scanArticleProductSurfaceSources(fixture()), []);
});

for (const [name, mutation, expected] of [
    ['four-mode enum', "type Surface = 'live' | 'source' | 'split';", 'legacy-product-surface'],
    ['preview route', "const route = { mode: 'preview' };", 'legacy-product-surface'],
    ['legacy source alias', "if (mode === 'write') mode = 'source';", 'legacy-product-surface'],
    ['generic mode type', 'type ProductMode = MarkdownEditorMode;', 'generic-editor-mode-leaks-to-product'],
    ['private DOM capability', "const capability = element.querySelector('.private-editor');", 'second-owner-or-private-detection'],
    ['error-text capability', "const capability = error.message.includes('unavailable');", 'error-text-capability-detection'],
    ['second renderer', 'renderMarkdownWithRuntime(source);', 'second-owner-or-private-detection'],
    ['second projection parser', 'createMarkdownEditorProjection(source);', 'second-owner-or-private-detection'],
    ['second epoch', 'createArticleDocumentContextAdapter(options);', 'second-owner-or-private-detection'],
    ['tool persistence', "localStorage.setItem('compare', 'open');", 'product-state-bypasses-preference-owner'],
    ['legacy in normal reader', "import { planArticleEditorSurfaceMigration } from './articleEditorSurfaceMigration';", 'migration-in-normal-product-reader']
])
{
    test(`refuses ${name} injected into the real capability owner`, () =>
    {
        const sources = fixture();
        sources.set(modulePath, `${sources.get(modulePath)}\n${mutation}\n`);
        assert.equal(scanArticleProductSurfaceSources(sources).some(item => item.code === expected), true);
    });
}

test('refuses a missing domain source instead of reporting a partial scan green', () =>
{
    const sources = fixture();
    sources.delete(modulePath);
    assert.equal(scanArticleProductSurfaceSources(sources).some(item => item.code === 'required-product-source-missing'), true);
});

test('refuses a third surface and a changed default in the real schema', () =>
{
    const sources = fixture();
    const file = articleProductSurfacePaths[0];
    sources.set(file, sources.get(file).replace("['live', 'source']", "['live', 'source', 'focus']").replace("defaultArticleEditorSurface: ArticleEditorSurface = 'live'", "defaultArticleEditorSurface: ArticleEditorSurface = 'source'"));
    const findings = scanArticleProductSurfaceSources(sources);
    assert.equal(findings.some(item => item.code === 'product-surfaces-not-exact'), true);
    assert.equal(findings.some(item => item.code === 'default-live-missing'), true);
});

test('scans the actual Writer instead of replacing it with the isolated positive fixture', () =>
{
    const sources = fixture();
    const file = articleProductSurfacePaths.at(-1);
    sources.set(file, `${readFileSync(path.join(root, file), 'utf8')}\n<script>const mode = 'split';</script>`);
    // Inject inside the real script block, so the negative survives future Writer integration.
    sources.set(file, sources.get(file).replace('</script>', "const modeMutation = 'split';\n</script>"));
    assert.equal(scanArticleProductSurfaceSources(sources).some(item => item.file === file && item.code === 'legacy-product-surface'), true);
    assert.deepEqual(checkArticleProductSurface(root), scanArticleProductSurfaceSources(new Map(articleProductSurfacePaths.map(item => [item, readFileSync(path.join(root, item), 'utf8')]))));
});
