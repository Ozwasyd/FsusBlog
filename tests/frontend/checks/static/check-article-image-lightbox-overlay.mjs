#!/usr/bin/env node
/**
 * ArticleImageLightbox Overlay migration contract (#1788).
 *
 * - Blog adapter re-exports public ElOverlay as FsusUiOverlay only
 * - Lightbox owns article media workflow, not fixed scrim/viewport geometry
 * - No ImageViewer / deep overlay imports / product Overlay root overrides
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const ADAPTER_PATH = 'src/frontend/src/fsusui/overlay.ts';
const LIGHTBOX_PATH = 'src/frontend/src/components/article/ArticleImageLightbox.vue';
const COMPOSABLE_PATH = 'src/frontend/src/composables/article/useArticleImageLightbox.ts';
const BARREL_PATH = 'src/frontend/src/fsusui/index.ts';

const FORBIDDEN_LIGHTBOX_PATTERNS = [
    { id: 'position-fixed', pattern: /position\s*:\s*fixed/iu },
    { id: 'inset-0', pattern: /inset\s*:\s*0/iu },
    { id: 'local-scrim-token', pattern: /--fsusblog-overlay-scrim/u },
    { id: 'backdrop-filter', pattern: /backdrop-filter/iu },
    { id: 'bare-vh', pattern: /\b(?:100|80|88)vh\b/u },
    { id: 'env-safe-area', pattern: /env\(\s*safe-area-inset-/iu },
    { id: 'image-viewer', pattern: /ImageViewer|ElImageViewer/u },
    { id: 'deep-overlay-import', pattern: /@ozwasyd\/element-plus\/es\/components\/overlay|@element-plus\/components\/overlay\/src|useLockscreen/u },
    { id: 'el-overlay-override', pattern: /:deep\(\s*\.el-overlay|\.el-overlay\s*\{/u },
    { id: 'lodash', pattern: /lodash|from\s+['"]lodash/u }
];

/**
 * @param {string} root
 * @param {string} relativePath
 */
function read(root, relativePath)
{
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

/**
 * @param {{ root?: string }} [options]
 * @returns {string[]}
 */
export function findArticleImageLightboxOverlayViolations(options = {})
{
    const root = options.root ? path.resolve(options.root) : repoRoot;
    const violations = [];

    for (const required of [ADAPTER_PATH, LIGHTBOX_PATH, COMPOSABLE_PATH, BARREL_PATH])
    {
        if (!fs.existsSync(path.join(root, required)))
        {
            violations.push(`${required}: required file is missing`);
        }
    }

    if (violations.length > 0)
    {
        return violations;
    }

    const adapter = read(root, ADAPTER_PATH).trim();
    const lightbox = read(root, LIGHTBOX_PATH);
    const composable = read(root, COMPOSABLE_PATH);
    const barrel = read(root, BARREL_PATH);

    if (adapter !== "export { ElOverlay as FsusUiOverlay } from '@ozwasyd/element-plus'")
    {
        violations.push(
            `${ADAPTER_PATH}: must be a single type-preserving named re-export of ElOverlay as FsusUiOverlay from the public package entry`
        );
    }

    if (/as\s+Component|defineComponent|createApp|h\(|render\s*\(/.test(adapter))
    {
        violations.push(`${ADAPTER_PATH}: adapter must not wrap, cast, or re-render Overlay`);
    }

    if (!/export\s*\*\s*from\s*['"]@\/fsusui\/overlay['"]/.test(barrel)
        && !/export\s*\{[^}]*FsusUiOverlay[^}]*\}\s*from\s*['"]@\/fsusui\/overlay['"]/.test(barrel))
    {
        violations.push(`${BARREL_PATH}: must re-export the stable overlay adapter`);
    }

    if (!/<FsusUiOverlay\b/u.test(lightbox) || !lightbox.includes("from '@/fsusui/overlay'"))
    {
        violations.push(`${LIGHTBOX_PATH}: must render scrim/viewport through FsusUiOverlay adapter`);
    }

    if (!lightbox.includes('data-article-lightbox="true"'))
    {
        violations.push(`${LIGHTBOX_PATH}: must keep article lightbox identity marker`);
    }

    if (!lightbox.includes('article-image-lightbox-open'))
    {
        violations.push(`${LIGHTBOX_PATH}: must keep Blog-owned body scroll-lock lifecycle`);
    }

    if (!composable.includes('triggerImage') || !composable.includes('target.focus()'))
    {
        violations.push(`${COMPOSABLE_PATH}: must restore focus to the trigger image on close`);
    }

    for (const rule of FORBIDDEN_LIGHTBOX_PATTERNS)
    {
        if (rule.pattern.test(lightbox))
        {
            violations.push(`${LIGHTBOX_PATH}: forbidden residue ${rule.id}`);
        }
    }

    if (!lightbox.includes('var(--fsus-safe-area-inset-top)')
        || !lightbox.includes('var(--fsus-safe-area-inset-right)')
        || !lightbox.includes('var(--fsus-safe-area-inset-bottom)')
        || !lightbox.includes('var(--fsus-safe-area-inset-left)')
        || !lightbox.includes('var(--fsus-viewport-block-size)'))
    {
        violations.push(`${LIGHTBOX_PATH}: content layer must consume canonical safe-area and viewport tokens`);
    }

    return violations;
}

/**
 * Mutation helpers for unit / self-proofs.
 * @param {string} relativePath
 * @param {string} source
 * @returns {string[]}
 */
export function findLightboxSourceViolations(relativePath, source)
{
    const violations = [];

    if (relativePath.endsWith('overlay.ts'))
    {
        const trimmed = source.trim();
        if (trimmed !== "export { ElOverlay as FsusUiOverlay } from '@ozwasyd/element-plus'")
        {
            violations.push(`${relativePath}: adapter must stay a type-preserving named re-export`);
        }
        if (/components\/overlay\/src|@element-plus\/hooks|useLockscreen/.test(source))
        {
            violations.push(`${relativePath}: deep import of overlay internals is forbidden`);
        }
        return violations;
    }

    if (relativePath.endsWith('ArticleImageLightbox.vue'))
    {
        for (const rule of FORBIDDEN_LIGHTBOX_PATTERNS)
        {
            if (rule.pattern.test(source))
            {
                violations.push(`${relativePath}: forbidden residue ${rule.id}`);
            }
        }
        if (!/<FsusUiOverlay\b/u.test(source))
        {
            violations.push(`${relativePath}: missing FsusUiOverlay root`);
        }
        if (!/min-height:\s*var\(--fsus-viewport-block-size\)/u.test(source))
        {
            violations.push(`${relativePath}: lightbox root must consume the viewport block-size token`);
        }
        if (!/padding:\s*max\(1\.5rem,\s*var\(--fsus-safe-area-inset-top\)\)\s*max\(1\.5rem,\s*var\(--fsus-safe-area-inset-right\)\)\s*max\(1\.5rem,\s*var\(--fsus-safe-area-inset-bottom\)\)\s*max\(1\.5rem,\s*var\(--fsus-safe-area-inset-left\)\)/u.test(source))
        {
            violations.push(`${relativePath}: lightbox root padding must consume all safe-area tokens`);
        }
        if (!/\.article-image-lightbox__close\s*\{[^}]*top:\s*max\(1rem,\s*var\(--fsus-safe-area-inset-top\)\)/su.test(source))
        {
            violations.push(`${relativePath}: close control must keep its safe-area top offset`);
        }
    }

    return violations;
}

function runLiveCheck()
{
    const failures = [...findArticleImageLightboxOverlayViolations()];
    const lightbox = read(repoRoot, LIGHTBOX_PATH);
    let mutationProofs = 0;

    const assertMutationRejected = (label, messages) =>
    {
        if (!Array.isArray(messages) || messages.length === 0)
        {
            failures.push(`mutation ${label}: expected non-zero validation failures`);
            return;
        }
        mutationProofs += 1;
    };

    assertMutationRejected(
        'local-fixed-scrim',
        findLightboxSourceViolations(
            LIGHTBOX_PATH,
            `
            <template><div class="article-image-lightbox"></div></template>
            <style>
            .article-image-lightbox {
              position: fixed;
              inset: 0;
              background: var(--fsusblog-overlay-scrim);
            }
            </style>
            `
        )
    );

    assertMutationRejected(
        'deep-overlay-import',
        findLightboxSourceViolations(
            ADAPTER_PATH,
            "import ElOverlay from '@ozwasyd/element-plus/es/components/overlay/src/overlay'\nexport const FsusUiOverlay = ElOverlay\n"
        )
    );

    assertMutationRejected(
        'el-overlay-override',
        findLightboxSourceViolations(
            LIGHTBOX_PATH,
            `
            <template><FsusUiOverlay /></template>
            <style scoped>
            :deep(.el-overlay) { padding: var(--fsus-safe-area-inset-top); }
            </style>
            `
        )
    );

    assertMutationRejected(
        'bare-vh-geometry',
        findLightboxSourceViolations(
            LIGHTBOX_PATH,
            `
            <template><FsusUiOverlay><img style="max-height: 80vh" /></FsusUiOverlay></template>
            `
        )
    );

    assertMutationRejected(
        'second-background-layer',
        findLightboxSourceViolations(
            LIGHTBOX_PATH,
            `
            <template><FsusUiOverlay><div class="article-image-lightbox" style="background: var(--fsusblog-overlay-scrim)"></div></FsusUiOverlay></template>
            `
        )
    );

    assertMutationRejected(
        'production-container-padding',
        findLightboxSourceViolations(
            LIGHTBOX_PATH,
            lightbox.replace(
                /padding:\s*max\(1\.5rem,\s*var\(--fsus-safe-area-inset-top\)\)\s*max\(1\.5rem,\s*var\(--fsus-safe-area-inset-right\)\)\s*max\(1\.5rem,\s*var\(--fsus-safe-area-inset-bottom\)\)\s*max\(1\.5rem,\s*var\(--fsus-safe-area-inset-left\)\);/u,
                'padding: 0;'
            )
        )
    );

    assertMutationRejected(
        'production-control-offset',
        findLightboxSourceViolations(
            LIGHTBOX_PATH,
            lightbox.replace(
                'top: max(1rem, var(--fsus-safe-area-inset-top));',
                'top: 0;'
            )
        )
    );

    assertMutationRejected(
        'production-viewport-token',
        findLightboxSourceViolations(
            LIGHTBOX_PATH,
            lightbox.replace(
                'min-height: var(--fsus-viewport-block-size);',
                'min-height: 100%;'
            )
        )
    );

    assertMutationRejected(
        'production-overlay-root',
        findLightboxSourceViolations(
            LIGHTBOX_PATH,
            lightbox
                .replace('<FsusUiOverlay', '<div')
                .replace('</FsusUiOverlay>', '</div>')
        )
    );

    if (mutationProofs < 9)
    {
        failures.push(`expected 9 mutation proofs, got ${mutationProofs}`);
    }

    if (failures.length > 0)
    {
        for (const message of failures)
        {
            console.error(`[check-article-image-lightbox-overlay] ${message}`);
        }
        process.exit(1);
    }

    console.log(
        `[check-article-image-lightbox-overlay] ok mutations=${mutationProofs}`
    );
}

const isDirectRun = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun)
{
    runLiveCheck();
}
