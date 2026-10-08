#!/usr/bin/env node
/** Article lightbox public viewer ownership contract (#1892). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const LIGHTBOX_PATH = 'src/frontend/src/components/article/ArticleImageLightbox.vue';
const COMPOSABLE_PATH = 'src/frontend/src/composables/article/useArticleImageLightbox.ts';
const forbidden = [
    ['local-dialog', /role\s*=\s*["']dialog["']/u],
    ['second-overlay', /<FsusUiOverlay|<Teleport|<FsuTransition/u],
    ['local-body-lock', /article-image-lightbox-open|document\.body|useLockscreen/u],
    ['local-viewer-geometry', /position\s*:\s*(?:fixed|absolute)|--fsus-safe-area|--fsus-viewport-block-size|\b(?:100|80|88)vh\b/u],
    ['private-api', /@ozwasyd\/element-plus\/(?:es|lib|packages|internal)|@element-plus\//u],
    ['private-selector', /\.el-image-viewer|:deep\(|querySelector/u],
    ['local-scrim', /backdrop-filter|--fsusblog-overlay-scrim/u],
    ['local-controls', /<button|keydown\.esc/u]
];

export function findLightboxSourceViolations(relativePath, source)
{
    if (!relativePath.endsWith('ArticleImageLightbox.vue'))
    {
        return /components\/overlay\/src|@element-plus\/hooks|useLockscreen/u.test(source)
            ? [`${relativePath}: private overlay API`] : [];
    }
    const violations = forbidden.filter(([, pattern]) => pattern.test(source))
        .map(([id]) => `${relativePath}: forbidden ${id}`);
    const required = [
        ['public-viewer', /<ElImageViewer\b/u],
        ['public-import', /import\s*\{\s*ElImageViewer\s*\}\s*from\s*['"]@ozwasyd\/element-plus['"]/u],
        ['alt-list', /:alt-list=/u],
        ['caption', /#caption=/u],
        ['controlled-index', /:active-index="activeIndex"/u],
        ['localized-title', /messages\.article\.actions\.viewImage/u],
        ['localized-close', /messages\.article\.actions\.closeImage/u],
        ['localized-navigation', /previousImage[\s\S]*nextImage/u],
        ['navigation-only', /:show-toolbar="false"/u],
        ['previous-intent', /@previous="emit\('previous'\)"/u],
        ['next-intent', /@next="emit\('next'\)"/u],
        ['close', /@close="emit\('close'\)"/u]
    ];
    for (const [id, pattern] of required)
    {
        if (!pattern.test(source))
        {
            violations.push(`${relativePath}: missing ${id}`);
        }
    }
    return violations;
}

export function findArticleImageLightboxOverlayViolations(options = {})
{
    const root = options.root ? path.resolve(options.root) : repoRoot;
    const lightbox = fs.readFileSync(path.join(root, LIGHTBOX_PATH), 'utf8');
    const composable = fs.readFileSync(path.join(root, COMPOSABLE_PATH), 'utf8');
    const failures = findLightboxSourceViolations(LIGHTBOX_PATH, lightbox);
    if (/target\.focus\(|article-image-lightbox-open|document\.body/u.test(composable))
    {
        failures.push(`${COMPOSABLE_PATH}: duplicate modal focus/lock owner`);
    }
    return failures;
}

function runLiveCheck()
{
    const source = fs.readFileSync(path.join(repoRoot, LIGHTBOX_PATH), 'utf8');
    const failures = findArticleImageLightboxOverlayViolations();
    const mutations = [
        ['local-fixed-scrim', `${source}<style>.viewer { position: fixed; inset: 0; }</style>`],
        ['deep-import', source.replace("'@ozwasyd/element-plus'", "'@ozwasyd/element-plus/es/components/image-viewer'")],
        ['private-override', `${source}<style>:deep(.el-image-viewer) { padding: 0; }</style>`],
        ['bare-vh-geometry', `${source}<style>.viewer { height: 100vh; }</style>`],
        ['second-overlay', source.replace('<ElImageViewer', '<FsusUiOverlay><ElImageViewer')],
        ['local-safe-padding', `${source}<style>.viewer { padding: var(--fsus-safe-area-inset-top); }</style>`],
        ['local-control-offset', `${source}<style>.close { position: absolute; top: 0; }</style>`],
        ['local-viewport', `${source}<style>.viewer { min-height: var(--fsus-viewport-block-size); }</style>`],
        ['viewer-root-removed', source.replace('<ElImageViewer', '<div')],
        ['caption-removed', source.replace('#caption=', '#default=')],
        ['alt-removed', source.replace(':alt-list=', ':title-list=')],
        ['body-lock-retained', `${source}<script>document.body.classList.add('article-image-lightbox-open')</script>`],
        ['tools-added', source.replace(':show-toolbar="false"', ':show-toolbar="true"')]
    ];
    for (const [name, candidate] of mutations)
    {
        if (findLightboxSourceViolations(LIGHTBOX_PATH, candidate).length === 0)
        {
            failures.push(`mutation ${name}: expected rejection`);
        }
    }
    if (failures.length)
    {
        failures.forEach((failure) => console.error(`[check-article-image-lightbox-overlay] ${failure}`));
        process.exitCode = 1;
        return;
    }
    console.log(`[check-article-image-lightbox-overlay] ok mutations=${mutations.length}`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
{
    runLiveCheck();
}
