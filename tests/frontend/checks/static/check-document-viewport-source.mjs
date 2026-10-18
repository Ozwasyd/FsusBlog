#!/usr/bin/env node
/**
 * Document viewport ownership gate (#1785).
 *
 * `src/frontend/index.html` is the sole authoring source of the SPA document
 * viewport meta. App.vue head runtime, bootstrap, router, and backend minimal
 * HTML fallbacks must not redeclare or synthesize a second copy.
 *
 * FsusBlog owns the document-level viewport only; component safe-area geometry
 * remains under the FsusUI contract (see docs/frontend/public-shell-ownership.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const failures = [];

const CANONICAL_VIEWPORT_CONTENT = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
const CANONICAL_VIEWPORT_META =
    `<meta name="viewport" content="${CANONICAL_VIEWPORT_CONTENT}" />`;

// Tokens built at runtime so the checker itself is not a positive residue hit.
const FORBIDDEN_BACKEND_TOKENS = [
    ['Minimal', 'Index', 'Template'].join(''),
    ['s_minimal', 'Index', 'Template', 'Bytes'].join(''),
    ['Build', 'Minimal', 'Index', 'Html'].join(''),
    ['Template', 'Snapshot', '.Minimal'].join('')
];

const SPA_RUNTIME_SCAN_ROOTS = [
    'src/frontend/src/App.vue',
    'src/frontend/src/bootstrap',
    'src/frontend/src/router',
    'src/frontend/src/composables',
    'src/frontend/src/services',
    'src/frontend/src/public-renderers'
];

const VIEWPORT_NAME_RE = /name\s*=\s*["']viewport["']/giu;

function fail(message)
{
    failures.push(message);
}

function read(relativePath)
{
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function exists(relativePath)
{
    return fs.existsSync(path.join(repoRoot, relativePath));
}

function countViewportMetas(html)
{
    return [...html.matchAll(/name\s*=\s*["']viewport["']/giu)].length;
}

/**
 * @param {string} label
 * @param {string} html
 * @param {(message: string) => void} [sink]
 * @returns {void}
 */
function assertUniqueCanonicalViewport(label, html, sink = fail)
{
    const count = countViewportMetas(html);
    if (count !== 1)
    {
        sink(`${label}: expected exactly one viewport meta, found ${count}`);
    }
    if (!html.includes(CANONICAL_VIEWPORT_META))
    {
        sink(`${label}: missing canonical viewport meta string`);
    }
    if (!html.includes(CANONICAL_VIEWPORT_CONTENT))
    {
        sink(`${label}: missing canonical viewport content`);
    }
    const legacyContent = 'width=device-width, initial-scale=1.0"';
    if (html.includes(`content="${legacyContent}`) || html.includes(`content='${legacyContent}`))
    {
        sink(`${label}: legacy viewport content without viewport-fit=cover is present`);
    }
}

function collectFiles(relativeRoot)
{
    const absRoot = path.join(repoRoot, relativeRoot);
    if (!fs.existsSync(absRoot))
    {
        return [];
    }
    if (fs.statSync(absRoot).isFile())
    {
        return [absRoot];
    }

    /** @type {string[]} */
    const files = [];
    const walk = (dir) =>
    {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
        {
            if (entry.name.startsWith('.'))
            {
                continue;
            }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory())
            {
                if (['node_modules', 'dist', 'generated', 'bin', 'obj'].includes(entry.name))
                {
                    continue;
                }
                walk(full);
                continue;
            }
            if (/\.(ts|tsx|vue|js|mjs|cjs)$/u.test(entry.name))
            {
                files.push(full);
            }
        }
    };
    walk(absRoot);
    return files;
}

function relative(filePath)
{
    return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

/** Pure validators used by live checks and mutation proofs. */
/**
 * @param {string} html
 * @param {string} [label]
 * @returns {string[]}
 */
export function validateIndexHtml(html, label = 'src/frontend/index.html')
{
    /** @type {string[]} */
    const local = [];
    assertUniqueCanonicalViewport(label, html, (message) => local.push(message));
    return local;
}

export { assertUniqueCanonicalViewport, CANONICAL_VIEWPORT_CONTENT, CANONICAL_VIEWPORT_META };

function validateAppVue(source)
{
    /** @type {string[]} */
    const local = [];
    if (/name\s*:\s*['"]viewport['"]/u.test(source))
    {
        local.push('App.vue: SPA runtime must not author name="viewport" (index.html is sole source)');
    }
    if (
        /useHead\s*\(/u.test(source)
        && /viewport/u.test(source)
        && /name\s*:\s*['"]viewport['"]/u.test(source)
    )
    {
        local.push('App.vue: useHead/runtime head must not manage viewport meta');
    }
    if (
        /meta\[name=['"]?viewport/u.test(source)
        || /querySelector(?:All)?\([^)]*viewport/u.test(source)
    )
    {
        local.push('App.vue: must not patch document viewport via DOM selectors');
    }
    return local;
}

function validateLocator(source)
{
    /** @type {string[]} */
    const local = [];
    for (const token of FORBIDDEN_BACKEND_TOKENS)
    {
        if (source.includes(token))
        {
            local.push(`PublicSpaTemplateLocator.cs: retired minimal-template token must be absent: ${token}`);
        }
    }
    if (!source.includes('spa_index_template_unavailable'))
    {
        local.push('PublicSpaTemplateLocator.cs: missing spa_index_template_unavailable fail-closed error');
    }
    if ([...source.matchAll(VIEWPORT_NAME_RE)].length > 0)
    {
        local.push('PublicSpaTemplateLocator.cs: must not embed viewport meta; read the real index.html template');
    }
    if (!/if\s*\(\s*string\.IsNullOrWhiteSpace\(indexPath\)\s*\)\s*\{[\s\S]*?throw new InvalidOperationException\("spa_index_template_unavailable"\)/u
        .test(source))
    {
        local.push('PublicSpaTemplateLocator.cs: missing template must throw spa_index_template_unavailable (no environment branch fallback)');
    }
    if (/IsDevelopment\(\)[\s\S]{0,200}Minimal|minimal.*IsDevelopment/u.test(source))
    {
        local.push('PublicSpaTemplateLocator.cs: development must not retain a minimal HTML fallback branch');
    }
    return local;
}

function validateComposer(source)
{
    /** @type {string[]} */
    const local = [];
    if ([...source.matchAll(VIEWPORT_NAME_RE)].length > 0 || /viewport-fit/u.test(source))
    {
        local.push('PublicAotDocumentComposer.cs: AOT head composer must not inject viewport meta');
    }
    if (/BuildSeoHeadTags[\s\S]{0,1200}viewport/u.test(source))
    {
        local.push('PublicAotDocumentComposer.cs: BuildSeoHeadTags must not mention viewport');
    }
    return local;
}

function runLiveCheck()
{
// --- 1. Source index.html is the sole authoring source ---
    const indexHtmlPath = 'src/frontend/index.html';
    const indexHtml = read(indexHtmlPath);
    for (const message of validateIndexHtml(indexHtml))
    {
        fail(message);
    }

    // --- 2. SPA runtime must not redeclare or patch viewport ---
    const appVuePath = 'src/frontend/src/App.vue';
    const appVue = read(appVuePath);
    for (const message of validateAppVue(appVue))
    {
        fail(message);
    }

    for (const scanRoot of SPA_RUNTIME_SCAN_ROOTS)
    {
        for (const file of collectFiles(scanRoot))
        {
            const rel = relative(file);
            if (rel === appVuePath)
            {
                continue;
            }
            const source = fs.readFileSync(file, 'utf8');
            if (/name\s*=\s*["']viewport["']/iu.test(source) || /name\s*:\s*['"]viewport['"]/u.test(source))
            {
                fail(`${rel}: SPA runtime must not author name="viewport" (index.html is sole source)`);
            }
            if (
                /meta\[name=['"]?viewport/u.test(source)
            || /querySelector(?:All)?\([^)]*viewport/u.test(source)
            )
            {
                fail(`${rel}: must not patch document viewport via DOM selectors`);
            }
        }
    }

    // --- 3. Backend template locator: no minimal HTML fallback ---
    const locatorPath = 'src/backend/Infrastructure/PublicAot/PublicSpaTemplateLocator.cs';
    const locatorSource = read(locatorPath);
    for (const message of validateLocator(locatorSource))
    {
        fail(message);
    }

    // --- 4. Public AOT composer must not inject a second viewport ---
    const composerPath = 'src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs';
    const composerSource = read(composerPath);
    for (const message of validateComposer(composerSource))
    {
        fail(message);
    }

    // --- 5. Dist index (when present) must preserve the unique canonical meta ---
    const distIndexPath = 'src/frontend/dist/index.html';
    if (exists(distIndexPath))
    {
        assertUniqueCanonicalViewport(distIndexPath, read(distIndexPath));
    }

    // --- 6. Docs ownership statement ---
    const ownershipDoc = 'docs/frontend/public-shell-ownership.md';
    if (exists(ownershipDoc))
    {
        const docs = read(ownershipDoc);
        if (!docs.includes('document viewport') && !docs.includes('document-level viewport') && !docs.includes('文档级 viewport'))
        {
            fail(`${ownershipDoc}: must state that FsusBlog owns document-level viewport only`);
        }
        if (!docs.includes('viewport-fit=cover'))
        {
            fail(`${ownershipDoc}: must document the canonical viewport-fit=cover content`);
        }
        if (!docs.includes('FsusUI') || !(/safe-area|安全区/u.test(docs)))
        {
            fail(`${ownershipDoc}: must assign component safe-area geometry to FsusUI`);
        }
    }

    // --- 7. In-process mutation proofs (no re-exec / recursion) ---
    let mutationProofs = 0;

    function assertMutationRejected(label, messages)
    {
        if (!Array.isArray(messages) || messages.length === 0)
        {
            fail(`mutation ${label}: expected non-zero validation failures`);
            return;
        }
        mutationProofs += 1;
    }

    // Mutation: App.vue re-adds useHead viewport meta.
    assertMutationRejected(
        'app-vue-useHead-viewport',
        validateAppVue(
        appVue.includes('meta:')
            ? appVue.replace(
                /meta:\s*isPublicShellRouteName\(route\.name\)[\s\S]*?:\s*\[\{ name: 'description'[\s\S]*?\]/,
                `meta: [
    { name: 'viewport', content: '${CANONICAL_VIEWPORT_CONTENT}' },
    { name: 'description', content: siteStore.siteInfo.description }
  ]`
            )
            : `${appVue}\nuseHead({ meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1.0' }] })\n`
        )
    );

    // Mutation: backend reintroduces minimal HTML fallback with viewport.
    assertMutationRejected(
        'backend-minimal-fallback',
        validateLocator(
            `${locatorSource}\nprivate const string ${['Minimal', 'Index', 'Template'].join('')} = "<meta name=\\"viewport\\" content=\\"width=device-width, initial-scale=1.0\\" />";\n`
        )
    );

    // Mutation: final HTML gains a second viewport meta in source index.
    assertMutationRejected(
        'duplicate-viewport-meta',
        validateIndexHtml(
            indexHtml.replace(
                CANONICAL_VIEWPORT_META,
                `${CANONICAL_VIEWPORT_META}\n    ${CANONICAL_VIEWPORT_META}`
            )
        )
    );

    if (mutationProofs < 3)
    {
        fail(`expected 3 mutation proofs, got ${mutationProofs}`);
    }

    // --- Report ---
    if (failures.length > 0)
    {
        for (const message of failures)
        {
            console.error(`[check-document-viewport-source] ${message}`);
        }
        process.exit(1);
    }

    console.log(
        `[check-document-viewport-source] ok source=1 dist=${exists(distIndexPath) ? 'checked' : 'absent'} mutations=${mutationProofs}`
    );
}

const isDirectRun = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun)
{
    runLiveCheck();
}
