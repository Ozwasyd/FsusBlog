#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const errors = [];

const screenshots = [
    'public-home-light.png',
    'article-detail-light.png',
    'article-detail-mobile.png',
    'public-dark.png',
    'admin-dashboard.png',
    'article-editor.png',
    'comment-moderation.png',
    'security-console.png',
    'operations-status.png'
];
const screenshotSet = new Set(screenshots);

function read(path)
{
    try
    {
        return readFileSync(resolve(root, path), 'utf8');
    }
    catch
    {
        errors.push(`missing ${path}`);
        return '';
    }
}

function includes(path, source, token)
{
    if (!source.includes(token))
    {
        errors.push(`${path} missing ${token}`);
    }
}

for (const file of screenshots)
{
    const path = `docs/assets/screenshots/${file}`;
    const fullPath = resolve(root, path);
    try
    {
        const buffer = readFileSync(fullPath);
        const stat = statSync(fullPath);
        const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
        if (!isPng)
        {
            errors.push(`${path} is not a PNG`);
        }
        if (stat.size < 2048)
        {
            errors.push(`${path} is unexpectedly small`);
        }
    }
    catch
    {
        errors.push(`missing ${path}`);
    }
}

const gallery = read('docs/assets/screenshots/README.md');
for (const token of [
    'Public home page',
    'Article detail page',
    'Mobile article page',
    'Dark mode public page',
    'Admin dashboard',
    'Article editor',
    'Comment moderation console',
    'Security / anti-crawler console',
    'AOT / cache / operations status',
    'no real production domains',
    'no real personal emails',
    'no real IP addresses',
    'Cover Evidence Rules',
    'cover-art-manifest.json',
    'center-80',
    'Brand And Asset Rights',
    'live frontend route audit flow',
    'manual-layout-screenshots',
    'capture:manual-layout-screenshots',
    'frontend router',
    'FSUSBLOG_MANUAL_SCREENSHOT_VIEWPORTS',
    'FSUSBLOG_MANUAL_SCREENSHOT_THEMES',
    'FSUSBLOG_MANUAL_SCREENSHOT_SCOPES',
    'FSUSBLOG_MANUAL_SCREENSHOT_SHARD_NAME',
    'FSUSBLOG_MANUAL_SCREENSHOT_WRITE_DOCS_ASSETS',
    'runtime and layout'
])
{
    includes('docs/assets/screenshots/README.md', gallery, token);
}

try
{
    const extraScreenshots = readdirSync(resolve(root, 'docs/assets/screenshots'), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.png') && !screenshotSet.has(entry.name))
        .map((entry) => entry.name);
    if (extraScreenshots.length > 0)
    {
        errors.push(`docs/assets/screenshots contains stale PNG files: ${extraScreenshots.join(', ')}`);
    }
}
catch
{
    errors.push('missing docs/assets/screenshots');
}

if (existsSync(resolve(root, 'tools/docs/generate-public-preview-screenshots.mjs')))
{
    errors.push('tools/docs/generate-public-preview-screenshots.mjs must not exist; use capture:public-preview-docs');
}

const publicShellCritical = read('src/frontend/src/assets/public-shell-critical.css');
for (const token of [
    '@ozwasyd/element-plus/theme-chalk/el-var.css',
    '@ozwasyd/element-plus/theme-chalk/el-radio-group.css',
    '@ozwasyd/element-plus/theme-chalk/el-radio-button.css',
    '@ozwasyd/element-plus/theme-chalk/el-theme-mode-toggle.css'
])
{
    includes('src/frontend/src/assets/public-shell-critical.css', publicShellCritical, token);
}

const manualCapture = read('tests/frontend/e2e/manual/manual-layout-screenshots.spec.ts');
for (const token of [
    'APP_ROUTE_RECORDS',
    'buildManualRoutesFromRouteRecords',
    'materializeRoutePath',
    'ensureThemeApplied',
    'assertThemeModeToggleStyled',
    'parseManualScreenshotFilter',
    'filterManualScreenshotItems',
    'manualScreenshotShardName',
    'waitForHomeSecondaryContent',
    'manual screenshot shards cannot write docs assets',
    'public-preview docs capture requires the complete unfiltered registry',
    'assertContentDrivenCoverContract',
    'await page.screenshot(screenshotOptions)',
    'await waitForScreenshotPaintStability(page)',
    'data-content-cover',
    'data-cover-concept=',
    'cover should avoid a large bright block'
])
{
    includes('tests/frontend/e2e/manual/manual-layout-screenshots.spec.ts', manualCapture, token);
}
const manualConfiguration = read('tests/frontend/support/playwright/manualScreenshotConfiguration.ts');
for (const token of [
    'normalizeManualScreenshotShardName',
    'resolveDocsScreenshotRoot',
    'FSUSBLOG_MANUAL_SCREENSHOT_SHARD_NAME must match',
    'public-preview docs staging path mismatch',
    'public-preview docs writer lock identity mismatch'
])
{
    includes('tests/frontend/support/playwright/manualScreenshotConfiguration.ts', manualConfiguration, token);
}
const playwrightConfiguration = read('src/frontend/playwright.config.ts');
for (const token of [
    'FSUSBLOG_PUBLIC_PREVIEW_DOCS_CAPTURE',
    '--disable-gpu',
    '--disable-lcd-text',
    '--disable-font-subpixel-positioning'
])
{
    includes('src/frontend/playwright.config.ts', playwrightConfiguration, token);
}
for (const token of [
    'buildAnonymousRoutes',
    'buildUserRoutes',
    'buildAdminRoutes'
])
{
    if (manualCapture.includes(token))
    {
        errors.push(`manual layout screenshot script must not use static route matrix helper: ${token}`);
    }
}

const frontendPackage = read('src/frontend/package.json');
for (const token of [
    'capture:manual-layout-screenshots:desktop-light',
    'capture:manual-layout-screenshots:mobile-light',
    'FSUSBLOG_MANUAL_SCREENSHOT_VIEWPORTS=desktop',
    'FSUSBLOG_MANUAL_SCREENSHOT_THEMES=light',
    'FSUSBLOG_MANUAL_SCREENSHOT_SHARD_NAME=desktop-light'
])
{
    includes('src/frontend/package.json', frontendPackage, token);
}

const pageAssemblies = read('src/frontend/src/public-renderers/pageAssemblies.ts');
for (const token of [
    'FeaturedArticlesSection',
    'HomeTextFirstRecommendations',
    'createHomeEditorialPageState',
    'showArticleCta: false'
])
{
    includes('src/frontend/src/public-renderers/pageAssemblies.ts', pageAssemblies, token);
}

const coverManifestPath = 'src/frontend/public/fixtures/cover-art-manifest.json';
const coverManifestSource = read(coverManifestPath);
try
{
    const coverManifest = JSON.parse(coverManifestSource);
    if (coverManifest?.cropSafeArea?.token !== 'center-80')
    {
        errors.push(`${coverManifestPath} crop safe area must be center-80`);
    }

    const positiveExamples = Array.isArray(coverManifest?.positiveExamples)
        ? coverManifest.positiveExamples
        : [];
    if (positiveExamples.length < 5)
    {
        errors.push(`${coverManifestPath} must register at least five semantic cover examples`);
    }

    const concepts = new Set();
    for (const example of positiveExamples)
    {
        if (!example?.concept || concepts.has(example.concept))
        {
            errors.push(`${coverManifestPath} cover concepts must be present and unique`);
        }
        concepts.add(example?.concept);
        if (example?.embeddedArticleCopy !== false)
        {
            errors.push(`${coverManifestPath} ${example?.id ?? 'unknown'} must disable embedded article copy`);
        }
        if (example?.darkSafe !== true)
        {
            errors.push(`${coverManifestPath} ${example?.id ?? 'unknown'} must record dark review`);
        }

        const publicPath = String(example?.path ?? '');
        const assetPath = publicPath.startsWith('/fixtures/')
            ? `src/frontend/public${publicPath}`
            : '';
        if (!assetPath)
        {
            errors.push(`${coverManifestPath} ${example?.id ?? 'unknown'} has an invalid fixture path`);
            continue;
        }

        const asset = read(assetPath);
        includes(assetPath, asset, `data-cover-concept="${example.concept}"`);
        for (const forbidden of ['<text', '<linearGradient', '<radialGradient', '<filter', '<feDropShadow'])
        {
            if (asset.includes(forbidden))
            {
                errors.push(`${assetPath} contains forbidden cover token ${forbidden}`);
            }
        }
    }

    const negativeIds = new Set(
        (Array.isArray(coverManifest?.negativeExamples) ? coverManifest.negativeExamples : [])
            .map((example) => example?.id)
    );
    for (const id of ['article-title-card', 'recolored-abstract-curve', 'decorative-gradient-glow', 'empty-media-placeholder'])
    {
        if (!negativeIds.has(id))
        {
            errors.push(`${coverManifestPath} missing negative example ${id}`);
        }
    }
}
catch (error)
{
    errors.push(`${coverManifestPath} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

const fixtureDiscovery = read('tests/frontend/fixtures/discover-playwright-fixtures.mjs');
for (const token of ['copyFile', 'checkedInCoverFixtureDir', 'managedCoverFiles'])
{
    includes('tests/frontend/fixtures/discover-playwright-fixtures.mjs', fixtureDiscovery, token);
}
for (const forbidden of ['function buildCoverSvg', '<linearGradient', 'FsusBlog public fixture</text>'])
{
    if (fixtureDiscovery.includes(forbidden))
    {
        errors.push(`tests/frontend/fixtures/discover-playwright-fixtures.mjs contains retired cover template ${forbidden}`);
    }
}

const homeCover = read('src/frontend/src/components/home/FeaturedArticlesSection.vue');
const detailCover = read('src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue');
for (const [path, source] of [
    ['src/frontend/src/components/home/FeaturedArticlesSection.vue', homeCover],
    ['src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue', detailCover]
])
{
    for (const token of ['data-content-cover', 'data-cover-safe-area', 'object-cover', 'object-center', 'shadow-none'])
    {
        includes(path, source, token);
    }
    for (const forbidden of ['bg-gradient-', 'drop-shadow', 'backdrop-filter'])
    {
        if (source.includes(forbidden))
        {
            errors.push(`${path} contains forbidden cover decoration ${forbidden}`);
        }
    }
}

const coverContract = read('src/frontend/src/view-contracts/coverArt.ts');
for (const token of ['PUBLIC_COVER_SAFE_AREA_TOKEN', "'center-80'", "'50% 50%'", 'return null'])
{
    includes('src/frontend/src/view-contracts/coverArt.ts', coverContract, token);
}

const publicLayoutRules = read('docs/public-layout-rules.md');
for (const token of [
    '内容驱动的封面规范',
    '界面截图、图表、代码或命令输出',
    '中心 80% 安全区',
    'object-position: 50% 50%',
    "Don't：",
    'Light/Dark 审核清单'
])
{
    includes('docs/public-layout-rules.md', publicLayoutRules, token);
}

const publicEntryRegistry = read('src/frontend/src/public-renderers/publicEntryRegistry.ts');
for (const token of [
    'featuredArticles',
    'hotArticles',
    'normalizeFeaturedArticle',
    'normalizeHotArticle'
])
{
    includes('src/frontend/src/public-renderers/publicEntryRegistry.ts', publicEntryRegistry, token);
}

const readme = read('README.md');
for (const token of [
    'docs/assets/screenshots/',
    'public-home-light.png',
    'docs/known-limitations.md'
])
{
    includes('README.md', readme, token);
}

const releaseNotes = read('docs/releases/public-preview-policy.md');
for (const token of [
    'Known Limitations',
    'ROADMAP.md',
    'API Stability',
    'Production SLA: none'
])
{
    includes('docs/releases/public-preview-policy.md', releaseNotes, token);
}

const limitations = read('docs/known-limitations.md');
for (const token of [
    'Public Preview and is not stable production software',
    'Internal API contracts may change unless a dedicated stability document',
    'AEDS frame contracts are experimental',
    'Multi-node runtime has not entered the supported deployment baseline',
    'What Is Safe To Try',
    'What Should Not Be Relied On Yet',
    'Reporting Issues',
    'ROADMAP.md'
])
{
    includes('docs/known-limitations.md', limitations, token);
}

if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[public-preview-screenshots] ${error}`);
    }
    process.exit(1);
}

console.log(`[public-preview-screenshots] ok screenshots=${screenshots.length}`);
