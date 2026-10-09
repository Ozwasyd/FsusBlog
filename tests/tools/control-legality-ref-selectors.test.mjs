import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { controlDigest } = await import(new URL('../../tools/frontend/control-legality/source.mjs', import.meta.url));
const { createFiniteRefSelectorSource } = await import(new URL('../../tools/frontend/control-legality/source-ref-selectors.mjs', import.meta.url));

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const parserRoot = process.env.FSUSBLOG_REF_SELECTOR_PARSER_ROOT ?? repositoryRoot;
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT ?? path.resolve(repositoryRoot, '../FsusUI');
// Read the original package export, without installing dependencies or changing
// exports. This hook exists only while importing the canonical composition owner.
const packageRoot = path.join(repositoryRoot, 'tools/frontend/control-legality');
const packageMetadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const hook = registerHooks({ resolve(specifier, context, next)
{
    if (specifier === `${packageMetadata.name}/source`)
    {
        return { url: pathToFileURL(path.resolve(packageRoot, packageMetadata.exports['./source'])).href, shortCircuit: true };
    }
    return next(specifier, context);
} });
let createCompositionSource;
try
{
    ({ createCompositionSource } = await import(new URL('../frontend/support/layout/compositionSource.mjs', import.meta.url)));
}
finally
{
    hook.deregister();
}

const imageRelative = 'vue/packages/components/image-viewer/src/image-viewer.vue';
const railRelative = 'src/frontend/src/components/admin/article/ArticleWriteInspectorRail.vue';
const registryRelative = 'src/frontend/src/composables/useArticleWriteInspector.ts';
const imageSource = fs.readFileSync(path.join(fsusUIRoot, imageRelative), 'utf8');
const railSource = fs.readFileSync(path.join(repositoryRoot, railRelative), 'utf8');
const registrySource = fs.readFileSync(path.join(repositoryRoot, registryRelative), 'utf8');

function instance(root = repositoryRoot)
{
    const source = createCompositionSource({ repositoryRoot: root, fsusUIRoot, parserRoot });
    return { source, selectors: createFiniteRefSelectorSource({ resolver: source.resolver, expression: source.expression }) };
}

function fixture(t, changes = {}, directEntry = true)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-ref-selectors-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const files = {
        'src/frontend/package.json': fs.readFileSync(path.join(repositoryRoot, 'src/frontend/package.json'), 'utf8'),
        'src/frontend/vite.config.ts': fs.readFileSync(path.join(repositoryRoot, 'src/frontend/vite.config.ts'), 'utf8'),
        'src/frontend/src/fsusui/icons.ts': fs.readFileSync(path.join(repositoryRoot, 'src/frontend/src/fsusui/icons.ts'), 'utf8'),
        [railRelative]: railSource,
        [registryRelative]: registrySource,
        ...changes
    };
    for (const [relative, content] of Object.entries(files))
    {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Ordinary module controls use the actual declared public export entry
        // directly. The separate exact real-source positive retains the failing
        // facade chain, so this never hides the original resolver's missing edge.
        fs.writeFileSync(file, directEntry && relative === railRelative
            ? content.replace("from '@/fsusui/icons'", "from '@ozwasyd/element-plus/icons-vue'") : content);
    }
    return { root, ...instance(root) };
}

function componentExpression(source, file)
{
    const record = source.resolver.parse(file);
    const found = [];
    function visit(node)
    {
        if (node.type === 1 && node.tag === 'component')
        {
            for (const prop of node.props)
            {
                if (prop.type === 7 && prop.name === 'bind' && prop.arg?.content === 'is')
                {
                    found.push(prop.exp.content);
                }
            }
        }
        (node.children ?? []).forEach(visit);
    }
    visit(record.template.ast);
    assert.equal(found.length, 1, 'exact actual component selector');
    return source.expression(found[0], file);
}

function image(instance, file = path.join(fsusUIRoot, imageRelative))
{
    return instance.selectors.resolve(file, componentExpression(instance.source, file), { templateRefs: true });
}

function rail(instance)
{
    const file = path.join(instance.root ?? repositoryRoot, railRelative);
    const record = instance.source.resolver.parse(file);
    const suppliers = [];
    function visit(node)
    {
        for (const prop of node.props ?? [])
        {
            if (prop.type === 7 && prop.name === 'for')
            {
                suppliers.push(instance.source.expression(prop.exp.content, file));
            }
        }
        (node.children ?? []).forEach(visit);
    }
    visit(record.template.ast);
    assert.equal(suppliers.length, 1);
    const supplier = suppliers[0];
    const { ts } = instance.source.resolver;
    assert.ok(ts.isBinaryExpression(supplier) && supplier.operatorToken.kind === ts.SyntaxKind.InKeyword
        && ts.isIdentifier(supplier.left));
    return instance.selectors.resolve(file, componentExpression(instance.source, file), {
        itemBindings: new Map([[supplier.left.text, { file, expression: supplier.right }]])
    });
}

function imageMutation(t, mutate)
{
    const rootFile = 'src/frontend/src/ImageViewer.vue';
    const initial = fixture(t);
    const utility = path.relative(path.dirname(path.join(initial.root, rootFile)), path.join(fsusUIRoot, 'vue/packages/utils/objects.ts'));
    const content = mutate(imageSource).replace("from '@element-plus/utils'", `from '${utility}'`)
        .replace("from '@element-plus/icons-vue'", "from '@ozwasyd/element-plus/icons-vue'");
    const file = path.join(initial.root, rootFile);
    fs.writeFileSync(file, content);
    return image(initial, file);
}

function names(targets)
{
    return targets.map((target) => target.publicName ?? target.name).sort();
}

test('finite selector positive actual ImageViewer shallowRef initializers and every closed modes write', () =>
{
    const result = image(instance());
    assert.deepEqual(result.map((target) => target.exportName ?? target.name).sort(), ['default', 'default']);
    assert.deepEqual(result.map((target) => path.basename(target.definition ?? target.file)).sort(), ['full-screen.vue', 'scale-to-original.vue']);
    assert.ok(result.every((target) => target.selectorSource.steps.some((entry) => entry.digest === controlDigest('mode.value = modes[modeNames[nextIndex]]'))));
});

test('finite selector positive actual InspectorRail v-for registry map retains six public icon identities', () =>
{
    const result = rail(instance());
    assert.deepEqual(names(result), ['Checked', 'DocumentChecked', 'Files', 'Lock', 'Picture', 'View']);
    assert.ok(result.every((target) => target.kind === 'fsusui-public' && target.entry === '@ozwasyd/element-plus/icons-vue'));
});

test('finite selector negative wrong Vue shallowRef import', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace("} from 'vue'", "} from 'fake-vue'")), /unknown supplier/);
});

test('finite selector negative wrong Vue markRaw import', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace('  markRaw,', '').replace("import { imageViewerEmits", "import { markRaw } from 'fake-vue'\nimport { imageViewerEmits")), /unknown supplier/);
});

test('finite selector negative late unknown ref write', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace('</script>', '\nmode.value = externalMode\n</script>')), /unknown runtime item/);
});

test('finite selector negative prototype key in modes write', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace('modes[modeNames[nextIndex]]', "modes['__proto__']")), /prototype selector key/);
});

test('finite selector negative unbounded annotated key in modes write', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace('modes[modeNames[nextIndex]]', "modes[props.urlList[0] as 'CONTAIN']")), /unknown runtime item|nonconstant|unknown supplier/);
});

test('finite selector negative out of range modes item', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace('modes[modeNames[nextIndex]]', 'modes[modeNames[99]]')), /unknown item/);
});

test('finite selector negative ref reassignment', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace('</script>', '\nmode = shallowRef(modes.ORIGINAL)\n</script>')), /unknown ref write/);
});

test('finite selector negative escaped ref unknown call', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace('</script>', '\nexternal(mode)\n</script>')), /escaped supplier/);
});

test('finite selector negative escaped ref alias', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace('</script>', '\nconst alias = mode\n</script>')), /escaped alias/);
});

test('finite selector negative escaped ref closure return', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace('</script>', '\nexternal(() => { return mode })\n</script>')), /escaped alias/);
});

test('finite selector negative mutated selected mode icon', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace('</script>', '\nmode.value.icon = Close\n</script>')), /unknown ref write/);
});

test('finite selector negative modes object mutation', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace('</script>', '\nmodes.CONTAIN.icon = Close\n</script>')), /mutated supplier/);
});

test('finite selector negative template event writes unknown ref value', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace('<teleport ', '<teleport @click="mode.value = externalMode" ')), /unknown runtime item/);
});

test('finite selector negative template callback escapes ref', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace('<teleport ', '<teleport @click="external(mode)" ')), /escaped supplier/);
});

test('finite selector negative unknown registry item despite annotation', (t) =>
{
    const value = fixture(t, { [registryRelative]: registrySource.replace("id: 'publish'", "id: unknownId as 'publish'") });
    assert.throws(() => rail(value), /unknown runtime item/);
});

test('finite selector negative prototype registry item', (t) =>
{
    const value = fixture(t, { [registryRelative]: registrySource.replace("id: 'publish'", "id: 'constructor'") });
    assert.throws(() => rail(value), /prototype selector key/);
});

test('finite selector negative registry reassignment', (t) =>
{
    const value = fixture(t, { [registryRelative]: registrySource + '\narticleWriteInspectorRegistry = [];' });
    assert.throws(() => rail(value), /reassigned or mutated/);
});

test('finite selector negative registry push mutation', (t) =>
{
    const value = fixture(t, { [registryRelative]: registrySource + "\narticleWriteInspectorRegistry.push({ id: 'unknown', label: 'Unknown' });" });
    assert.throws(() => rail(value), /escaped supplier/);
});

test('finite selector negative mapped collection reassignment', (t) =>
{
    const value = fixture(t, { [railRelative]: railSource.replace('</script>', '\ninspectorViews = externalViews;\n</script>') });
    assert.throws(() => rail(value), /reassigned or mutated/);
});

test('finite selector negative mapped item icon mutation', (t) =>
{
    const value = fixture(t, { [railRelative]: railSource.replace('</script>', '\ninspectorViews[0].icon = unknownIcon;\n</script>') });
    assert.throws(() => rail(value), /reassigned or mutated/);
});

test('finite selector negative escaped map callback item', (t) =>
{
    const value = fixture(t, { [railRelative]: railSource.replace('...view,', '...external(view),') });
    assert.throws(() => rail(value), /unknown supplier call/);
});

test('finite selector negative unproved imported key helper body', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace('keysOf(modes)', 'isNumber(modes)')), /unknown imported runtime supplier|unknown supplier import|unknown supplier call/);
});

test('finite selector positive canonical direct-entry InspectorRail supplier control', (t) =>
{
    const result = rail(fixture(t));
    assert.deepEqual(names(result), ['Checked', 'DocumentChecked', 'Files', 'Lock', 'Picture', 'View']);
    assert.ok(result.every((target) => target.kind === 'fsusui-public'));
});

test('finite selector negative escaped registry object alias', (t) =>
{
    const value = fixture(t, { [registryRelative]: registrySource + '\nconst alias = articleWriteInspectorRegistry;' });
    assert.throws(() => rail(value), /escaped alias/);
});

test('finite selector negative late mutation inside captured ref writer', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace('</script>', '\nexternal(() => { mode.value = externalMode })\n</script>')), /unknown runtime item/);
});

test('finite selector negative mutated Object key intrinsic', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace('</script>', '\nObject.keys = externalKeys\n</script>')), /mutated or escaped Object intrinsic/);
});

test('finite selector negative imported icon mutation', (t) =>
{
    const value = fixture(t, { [railRelative]: railSource.replace('</script>', '\nDocumentChecked.render = externalRender;\n</script>') });
    assert.throws(() => rail(value), /mutated runtime import/);
});

test('finite selector negative unknown icon call escape', (t) =>
{
    const value = fixture(t, { [railRelative]: railSource.replace('</script>', '\nexternal(DocumentChecked);\n</script>') });
    assert.throws(() => rail(value), /escaped supplier/);
});

test('finite selector negative template dynamic argument escapes ref', (t) =>
{
    assert.throws(() => imageMutation(t, (source) => source.replace('<teleport ', '<teleport :[external(mode)]="true" ')), /escaped supplier/);
});

test('finite selector negative iterator object mutation', (t) =>
{
    const value = fixture(t, { [registryRelative]: registrySource + "\nfor (const item of articleWriteInspectorRegistry) { item.id = 'unknown'; }" });
    assert.throws(() => rail(value), /unknown supplier use/);
});

test('finite selector negative reference write closure reaches a later unknown key', (t) =>
{
    const file = 'src/frontend/src/ImageViewer.vue';
    const value = fixture(t, { [file]: `<template><component :is="mode.icon" /></template><script setup lang="ts">
import { shallowRef } from 'vue';
import { FullScreen, ScaleToOriginal } from '@ozwasyd/element-plus/icons-vue';
const modes = { A: { next: 'B', icon: FullScreen }, B: { next: 'C', icon: ScaleToOriginal }, C: { next: 'unknown', icon: FullScreen } };
const mode = shallowRef(modes.A);
function advance() { mode.value = modes[mode.value.next]; }
</script>` });
    assert.throws(() => image(value, path.join(value.root, file)), /unknown item or missing own property unknown/);
});

test('finite selector positive source-proven ref write closure enumerates every reachable mode', (t) =>
{
    const file = 'src/frontend/src/ImageViewer.vue';
    const value = fixture(t, { [file]: `<template><component :is="mode.icon" /></template><script setup lang="ts">
import { shallowRef as cell } from 'vue';
import { FullScreen, ScaleToOriginal, Close } from '@ozwasyd/element-plus/icons-vue';
const modes = { A: { next: 'B', icon: FullScreen }, B: { next: 'C', icon: ScaleToOriginal }, C: { next: 'A', icon: Close } };
const mode = cell(modes.A);
function advance() { mode.value = modes[mode.value.next]; }
</script>` });
    assert.deepEqual(names(image(value, path.join(value.root, file))), ['Close', 'FullScreen', 'ScaleToOriginal']);
});

test('finite selector negative shadowed imported supplier declaration', (t) =>
{
    const value = fixture(t, { [registryRelative]: registrySource + "\nfunction other() { const articleWriteInspectorRegistry = [{ id: 'publish' }]; return articleWriteInspectorRegistry; }" });
    assert.throws(() => rail(value), /reassigned or mutated supplier/);
});

test('finite selector negative unbound template local ref name', () =>
{
    const value = instance();
    const file = path.join(fsusUIRoot, imageRelative);
    assert.throws(() => value.selectors.resolve(file, componentExpression(value.source, file), {
        templateRefs: true, shadowedNames: new Set(['mode'])
    }), /unbound template item mode/);
});

test('finite selector positive actual iterable binding shadows unrelated script name', (t) =>
{
    const value = fixture(t, { [railRelative]: railSource.replace('</script>', '\nconst view = unknownView;\n</script>') });
    assert.deepEqual(names(rail(value)), ['Checked', 'DocumentChecked', 'Files', 'Lock', 'Picture', 'View']);
});

test('finite selector negative mismatched canonical v-for supplier', (t) =>
{
    const value = fixture(t);
    const file = path.join(value.root, railRelative);
    assert.throws(() => value.selectors.resolve(file, componentExpression(value.source, file), {
        itemBindings: new Map([['view', { file, expression: value.source.expression('inspectorIcons', file) }]])
    }), /unbound canonical iterable supplier view/);
});

test('finite selector negative missing actual v-for item binding', (t) =>
{
    const value = fixture(t, { [railRelative]: railSource.replace('</script>', '\nconst view = { icon: Checked };\n</script>') });
    const file = path.join(value.root, railRelative);
    assert.throws(() => value.selectors.resolve(file, componentExpression(value.source, file)), /unbound template item view/);
});

test('finite selector negative template iterable icon mutation', (t) =>
{
    const value = fixture(t, { [railRelative]: railSource.replace('<component :is=', '<component @click="view.icon = unknownIcon" :is=') });
    assert.throws(() => rail(value), /reassigned or mutated supplier/);
});

test('finite selector negative template iterable object escape', (t) =>
{
    const value = fixture(t, { [railRelative]: railSource.replace('<component :is=', '<component @click="external(view)" :is=') });
    assert.throws(() => rail(value), /escaped supplier/);
});
