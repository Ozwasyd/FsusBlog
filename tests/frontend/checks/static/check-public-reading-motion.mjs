#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import './check-reading-layout-primitive.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../../..');
const errors = [];
let accountFocusMutationProofs = 0;

function read(path)
{
    return readFileSync(resolve(repoRoot, path), 'utf8');
}

function exists(path)
{
    return existsSync(resolve(repoRoot, path));
}

function expectIncludes(source, token, label)
{
    if (!source.includes(token))
    {
        errors.push(`${label} missing ${token}`);
    }
}

function expectNotMatches(source, pattern, message)
{
    if (pattern.test(source))
    {
        errors.push(message);
    }
}

function expectMatches(source, pattern, message)
{
    if (!pattern.test(source))
    {
        errors.push(`${message} missing ${pattern}`);
    }
}

function stripCssComments(source)
{
    let output = '';
    let quote = null;

    for (let index = 0; index < source.length; index += 1)
    {
        const character = source[index];
        const nextCharacter = source[index + 1];

        if (quote !== null)
        {
            output += character;
            if (character === '\\' && nextCharacter !== undefined)
            {
                output += nextCharacter;
                index += 1;
            }
            else if (character === quote)
            {
                quote = null;
            }
            continue;
        }

        if (character === '"' || character === "'")
        {
            quote = character;
            output += character;
            continue;
        }

        if (character !== '/' || nextCharacter !== '*')
        {
            output += character;
            continue;
        }

        index += 2;
        while (index < source.length && !(source[index] === '*' && source[index + 1] === '/'))
        {
            output += source[index] === '\n' ? '\n' : ' ';
            index += 1;
        }
        if (index >= source.length)
        {
            throw new Error('unterminated CSS comment');
        }
        output += '  ';
        index += 1;
    }

    return output;
}

function enumerateCssRules(source)
{
    const rules = [];
    const blockStack = [];
    let segmentStart = 0;
    let quote = null;
    let parenthesisDepth = 0;

    for (let index = 0; index < source.length; index += 1)
    {
        const character = source[index];
        const nextCharacter = source[index + 1];

        if (quote !== null)
        {
            if (character === '\\' && nextCharacter !== undefined)
            {
                index += 1;
            }
            else if (character === quote)
            {
                quote = null;
            }
            continue;
        }

        if (character === '"' || character === "'")
        {
            quote = character;
            continue;
        }

        if (character === '(')
        {
            parenthesisDepth += 1;
            continue;
        }
        if (character === ')')
        {
            parenthesisDepth = Math.max(0, parenthesisDepth - 1);
            continue;
        }
        if (parenthesisDepth > 0)
        {
            continue;
        }

        if (character === '{')
        {
            blockStack.push({
                prelude: source.slice(segmentStart, index).trim(),
                bodyStart: index + 1,
                inMedia: blockStack.some((ancestor) => ancestor.prelude.startsWith('@media'))
            });
            segmentStart = index + 1;
            continue;
        }

        if (character === ';')
        {
            segmentStart = index + 1;
            continue;
        }

        if (character !== '}')
        {
            continue;
        }

        const block = blockStack.pop();
        if (!block)
        {
            throw new Error('unmatched CSS closing brace');
        }
        if (!block.prelude.startsWith('@'))
        {
            rules.push({
                selector: block.prelude,
                body: source.slice(block.bodyStart, index),
                inMedia: block.inMedia
            });
        }
        segmentStart = index + 1;
    }

    if (quote !== null)
    {
        throw new Error('unterminated CSS string');
    }
    if (blockStack.length > 0)
    {
        throw new Error('unterminated CSS block');
    }

    return rules;
}

function parseCssDeclarations(body)
{
    const declarations = [];
    let segmentStart = 0;
    let quote = null;
    let parenthesisDepth = 0;

    function appendDeclaration(segmentEnd)
    {
        const segment = body.slice(segmentStart, segmentEnd).trim();
        const colonIndex = segment.indexOf(':');
        if (colonIndex <= 0)
        {
            return;
        }
        declarations.push({
            property: segment.slice(0, colonIndex).trim().toLowerCase(),
            value: segment.slice(colonIndex + 1).trim()
        });
    }

    for (let index = 0; index < body.length; index += 1)
    {
        const character = body[index];
        const nextCharacter = body[index + 1];

        if (quote !== null)
        {
            if (character === '\\' && nextCharacter !== undefined)
            {
                index += 1;
            }
            else if (character === quote)
            {
                quote = null;
            }
            continue;
        }

        if (character === '"' || character === "'")
        {
            quote = character;
        }
        else if (character === '(')
        {
            parenthesisDepth += 1;
        }
        else if (character === ')')
        {
            parenthesisDepth = Math.max(0, parenthesisDepth - 1);
        }
        else if (character === ';' && parenthesisDepth === 0)
        {
            appendDeclaration(index);
            segmentStart = index + 1;
        }
    }
    appendDeclaration(body.length);

    return declarations;
}

function validateAccountHeaderFocusContract(source)
{
    const contractFailures = [];
    let cssRules;
    let focusRules;
    try
    {
        const commentFreeSource = stripCssComments(source);
        cssRules = enumerateCssRules(commentFreeSource);
        focusRules = cssRules
            .filter((rule) => rule.selector === '.account-header-link:focus-visible' && !rule.inMedia);
    }
    catch (error)
    {
        contractFailures.push(`account-shell-base.css cannot enumerate account header focus owners: ${error.message}`);
        return contractFailures;
    }

    if (cssRules.some((rule) => rule.selector.includes('\\')))
    {
        contractFailures.push('account-shell-base.css selectors must not hide account focus ownership behind CSS identifier escapes');
    }
    if (cssRules.some((rule) => parseCssDeclarations(rule.body)
        .some((declaration) => declaration.property.includes('\\'))))
    {
        contractFailures.push('account-shell-base.css properties must not hide account focus behavior behind CSS identifier escapes');
    }

    if (focusRules.length !== 1)
    {
        contractFailures.push(`account-shell-base.css must have exactly one account header focus owner; found ${focusRules.length}`);
        return contractFailures;
    }

    const focusDeclarations = parseCssDeclarations(focusRules[0].body);
    const boxShadowDeclarations = focusDeclarations
        .filter((declaration) => declaration.property === 'box-shadow');
    const insetFocusRing = /^inset\s+0\s+0\s+0\s+2px\s+var\(--fsusblog-color-focus-ring\)$/u;
    if (boxShadowDeclarations.length !== 1 || !insetFocusRing.test(boxShadowDeclarations[0].value))
    {
        contractFailures.push('account-shell-base.css account header focus owner must retain its inset 2px focus ring');
    }

    return contractFailures;
}

function mutateAccountHeaderFocus(source, replacement)
{
    return source.replace(
        /((?:^|\n)\.account-header-link:focus-visible\s*\{[^}]*?)box-shadow\s*:[^;]+;/u,
        `$1${replacement}`
    );
}

function assertAccountFocusMutationRejected(source, label, mutate)
{
    const mutated = mutate(source);
    if (mutated === source)
    {
        errors.push(`account focus mutation fixture ${label} did not alter its source`);
        return;
    }

    const mutationFailures = validateAccountHeaderFocusContract(mutated);
    if (mutationFailures.length === 0)
    {
        errors.push(`account focus mutation fixture ${label} was not rejected`);
    }
    else
    {
        accountFocusMutationProofs += 1;
    }
}

const motionCss = read('src/frontend/src/assets/motion.css');
const markdownCss = read('src/frontend/src/assets/markdown.css');
const navigationProgressCss = read('src/frontend/src/assets/navigation-progress.css');
const indexHtml = read('src/frontend/index.html');
const packageJson = JSON.parse(read('src/frontend/package.json'));
const publicPageCss = read('src/frontend/src/assets/public-page.css');
const publicShellFoundation = read('src/frontend/src/assets/public-shell-foundation.css');
const themeTokens = read('src/frontend/src/ui-tokens/themeTokens.ts');
const accountLayout = read('src/frontend/src/layouts/AccountLayout.vue');
const accountShellBase = read('src/frontend/src/assets/account-shell-base.css');
const progress = read('src/frontend/src/components/article/ArticleReadingProgress.vue');
const toc = read('src/frontend/src/components/article/ArticleTocPanel.vue');
const lightbox = read('src/frontend/src/components/article/ArticleImageLightbox.vue');
const publicArticleList = read('src/frontend/src/components/public/PublicArticleList.vue');
const publicArticleDetail = read('src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue');
const publicFilter = read('src/frontend/src/components/public/pages/PublicFilterPageContent.vue');
const publicShell = read('src/frontend/src/components/public/PublicBlogLayoutShell.vue');
const publicComplianceFooter = read('src/frontend/src/components/public/PublicComplianceFooter.vue');
const articleDetailLoading = read('src/frontend/src/components/article/ArticleDetailLoadingState.vue');
const homeArticleLoading = read('src/frontend/src/components/home/HomeArticleLoadingState.vue');
const publicAbout = read('src/frontend/src/components/public/pages/PublicAboutPageContent.vue');
const publicArchive = read('src/frontend/src/components/public/pages/PublicArchivePageContent.vue');
const filterHeader = read('src/frontend/src/components/filter/FilterHeader.vue');
const filterArticleLoading = read('src/frontend/src/components/filter/FilterArticleLoadingState.vue');
const markdownRenderer = read('src/frontend/src/components/ui/MarkdownRenderer.vue');
const readingNotice = read('src/frontend/src/components/article/ArticleReadingNotice.vue');
const articleDetailHeader = read('src/frontend/src/components/article/ArticleDetailHeader.vue');
const commentsVirtualList = read('src/frontend/src/components/article/ArticleCommentsVirtualList.vue');
const commentTreeNode = read('src/frontend/src/components/article/ArticleCommentTreeNode.vue');
const commentMarkdown = read('src/frontend/src/components/article/CommentMarkdownRenderer.vue');
const commentComposer = read('src/frontend/src/components/article/ArticleCommentComposer.vue');
const commentsEmpty = read('src/frontend/src/components/public/ArticleCommentsEmptyState.vue');
const commentDetailContract = read('src/frontend/src/view-contracts/commentDetail.ts');
const targetHelper = read('src/frontend/src/composables/article/useArticleReadingTarget.ts');
const tocComposable = read('src/frontend/src/composables/article/useArticleToc.ts');
const codeCopy = read('src/frontend/src/composables/article/useCodeBlockCopy.ts');
const imageLightboxComposable = read('src/frontend/src/composables/article/useArticleImageLightbox.ts');
const articleDetail = read('src/frontend/src/views/ArticleDetail.vue');
const featuredArticles = read('src/frontend/src/components/home/FeaturedArticlesSection.vue');
const homeRecommendations = read('src/frontend/src/components/home/HomeTextFirstRecommendations.vue');
const hotArticlesIsland = read('src/frontend/src/public-renderers/homeHotArticlesIsland.ts');
const articleLocaleZh = read('src/frontend/src/locales/zh-CN/article.ts');

for (const token of [
    '.blog-motion-reading-control',
    '.blog-motion-mobile-bar',
    '.blog-motion-reading-target'
])
{
    expectIncludes(motionCss, token, 'motion.css');
}

expectIncludes(
    navigationProgressCss,
    'background: var(--fsusblog-color-primary, var(--fsus-scholarly-blue, #2A599C));',
    'navigation-progress.css scholarly fallback'
);
expectNotMatches(
    navigationProgressCss,
    /#409eff|#409EFF/,
    'navigation-progress.css must not fall back to saturated Element Plus blue'
);
expectNotMatches(
    navigationProgressCss,
    /#nprogress \.peg\s*\{[^}]*box-shadow:/s,
    'navigation-progress.css peg must not use a decorative glow'
);

for (const token of [
    'loader-document-placeholder',
    'loader-placeholder-line',
    '--fsusblog-loader-muted: var(--fsusblog-text-muted)',
    '--fsusblog-loader-rule: var(--fsusblog-panel-border)'
])
{
    expectIncludes(indexHtml, token, 'index.html');
}

for (const pattern of [
    /\bpulse-dot\b/i,
    /\bslide-bar\b/i,
    /\bline-grow\b/i,
    /\bshimmer\b/i,
    /\bglow\b/i,
    /--fsusblog-loader-accent/i,
    /--fsusblog-color-primary[^;]*loader/i,
    /--fsus-scholarly-blue[^;]*loader/i
])
{
    expectNotMatches(indexHtml, pattern, `index.html boot loader must not match ${pattern}`);
}

const scripts = packageJson.scripts ?? {};
expectIncludes(
    String(scripts['check:public-reading-motion'] ?? ''),
    'check-public-reading-motion.mjs',
    'package.json check:public-reading-motion'
);
expectIncludes(
    String(scripts['check:views-constraints'] ?? ''),
    'check:public-reading-motion',
    'package.json check:views-constraints'
);

expectIncludes(
    themeTokens,
    'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)] focus-visible:outline-none',
    'themeTokens.ts'
);
expectNotMatches(
    themeTokens,
    /const\s+focusRing\s*=\s*['"][^'"]*\bfocus-visible:ring-1\b/,
    'themeTokens.ts shared focusRing must not use ring-1'
);

expectIncludes(
    publicPageCss,
    'box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);',
    'public-page.css'
);
expectIncludes(publicPageCss, 'border-bottom-color: var(--fsusblog-color-primary);', 'public-page.css');
expectIncludes(publicPageCss, 'box-shadow: inset 0 -2px 0 var(--fsusblog-color-primary);', 'public-page.css');
expectIncludes(publicPageCss, '--fsusblog-skeleton-bg: var(--surface-subtle);', 'public-page.css');
expectIncludes(publicPageCss, '--fsusblog-overlay-scrim: rgba(15, 15, 17, 0.72);', 'public-page.css');
expectIncludes(publicPageCss, '--fsusblog-overlay-button-bg: rgba(255, 255, 255, 0.12);', 'public-page.css');
expectIncludes(publicPageCss, '--fsusblog-overlay-button-fg: rgba(255, 255, 255, 0.92);', 'public-page.css');
expectIncludes(publicPageCss, '--fsusblog-overlay-button-border: rgba(255, 255, 255, 0.24);', 'public-page.css');
expectIncludes(publicShellFoundation, '.public-colophon__primary', 'public-shell-foundation.css compact colophon primary row');
expectNotMatches(publicPageCss, /\.public-colophon/, 'public-page.css must not own public colophon appearance');
expectNotMatches(publicPageCss, /\.public-mobile-nav-menu/, 'public-page.css must not reimplement FsusUI PublicShell mobile navigation');
expectNotMatches(publicPageCss, /\.fsu-bottom-tab-bar/, 'public-page.css must not keep fixed bottom tab fallbacks');
expectNotMatches(publicPageCss, /\.fsusblog-public-bottom-tab/, 'public-page.css must not keep Blog fixed bottom tab selectors');
expectNotMatches(
    publicPageCss,
    /#fsus-aot-shell\s*\{\s*padding-bottom:[^}]*safe-area-inset-bottom/,
    'public-page.css must not reserve global bottom-dock safe area'
);
expectNotMatches(publicPageCss, /el-public-shell__bottom-tab/, 'public-page.css must not keep local PublicShell bottom tab selectors');
expectNotMatches(publicPageCss, /repeating-linear-gradient/, 'public-page.css chrome must not use noise gradients');
expectNotMatches(publicPageCss, /mix-blend-mode:\s*soft-light/, 'public-page.css chrome must not use blend-mode decoration');
expectNotMatches(publicPageCss, /\[class\*=["'](?:fade-in|slide-in|animate-)/, 'public-page.css reduced-motion selector must not use broad class* matching');
expectIncludes(publicPageCss, '.slide-in-from-right-1', 'public-page.css reduced-motion precise selector');
expectIncludes(publicPageCss, '--fsusblog-reading-shadow-floating: 0 8px 24px rgba(15, 23, 42, 0.32);', 'public-page.css dark reading shadow');
expectNotMatches(
    publicPageCss,
    /box-shadow:\s*inset 0 0 0 1px var\(--fsusblog-color-focus-ring\)/,
    'public-page.css public focus must use 2px ring'
);

for (const [source, label] of [
    [articleDetailLoading, 'ArticleDetailLoadingState.vue'],
    [homeArticleLoading, 'HomeArticleLoadingState.vue'],
    [featuredArticles, 'FeaturedArticlesSection.vue'],
    [publicAbout, 'PublicAboutPageContent.vue'],
    [publicArchive, 'PublicArchivePageContent.vue'],
    [filterHeader, 'FilterHeader.vue'],
    [filterArticleLoading, 'FilterArticleLoadingState.vue']
])
{
    expectNotMatches(source, /<el-skeleton[^>]*\sanimated\b/, `${label} public reading skeleton must not be animated`);
}
expectIncludes(publicPageCss, '.fsusblog-skeleton-surface {', 'public-page.css shared neutral skeleton surface');
expectIncludes(publicPageCss, '--el-skeleton-color: var(--fsusblog-skeleton-bg);', 'public-page.css shared neutral skeleton color');
expectIncludes(publicPageCss, '--el-skeleton-to-color: var(--fsusblog-skeleton-bg);', 'public-page.css shared neutral skeleton shimmer target');

for (const [source, label] of [
    [publicArticleDetail, 'PublicArticleDetailPageContent.vue'],
    [toc, 'ArticleTocPanel.vue'],
    [markdownRenderer, 'MarkdownRenderer.vue'],
    [progress, 'ArticleReadingProgress.vue'],
    [readingNotice, 'ArticleReadingNotice.vue'],
    [articleDetailHeader, 'ArticleDetailHeader.vue'],
    [commentsVirtualList, 'ArticleCommentsVirtualList.vue'],
    [commentComposer, 'ArticleCommentComposer.vue'],
    [publicArticleList, 'PublicArticleList.vue'],
    [featuredArticles, 'FeaturedArticlesSection.vue']
])
{
    expectIncludes(source, 'data-fsus-surface="reading"', label);
}
expectIncludes(readingNotice, 'text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-secondary)]', 'ArticleReadingNotice.vue long-read label stays secondary at 500');
expectIncludes(readingNotice, 'text-[13px] font-normal text-[var(--fsusblog-text-secondary)]', 'ArticleReadingNotice.vue connective copy stays secondary at 400');
expectIncludes(readingNotice, "translatePlural('article.metadata.wordCount'", 'ArticleReadingNotice.vue word count uses typed plural API');
expectIncludes(readingNotice, "translatePlural('article.metadata.readingMinuteCount'", 'ArticleReadingNotice.vue reading minutes use typed plural API');
expectMatches(readingNotice, /tabular-nums\b[^"]*\bfont-bold\b[^"]*text-\[var\(--fsusblog-text-primary\)\][^"]*"[\s\S]*?\{\{\s*wordCountText\s*\}\}/, 'ArticleReadingNotice.vue word count remains the primary 700 focal point');
expectMatches(readingNotice, /tabular-nums\b[^"]*\bfont-bold\b[^"]*text-\[var\(--fsusblog-text-primary\)\][^"]*"[\s\S]*?\{\{\s*readingMinuteCountText\s*\}\}/, 'ArticleReadingNotice.vue reading minutes remain the primary 700 focal point');
expectIncludes(articleLocaleZh, "other: '全文约 {count} 字'", 'zh-CN article locale preserves the word-count plural framing copy');
expectIncludes(articleLocaleZh, "other: '预计阅读 {count} 分钟'", 'zh-CN article locale preserves the reading-minutes plural framing copy');
expectNotMatches(readingNotice, /text-xs font-medium normal-case tracking-normal text-\[var\(--fsusblog-text-primary\)\]/, 'ArticleReadingNotice.vue long-read label must not compete with numeric focal points');
expectNotMatches(readingNotice, /text-\[13px\] font-medium text-\[var\(--fsusblog-text-secondary\)\]/, 'ArticleReadingNotice.vue connective copy must not regain medium emphasis');
expectIncludes(publicArticleDetail, 'id="fsus-comments-island"', 'PublicArticleDetailPageContent.vue comments island');
expectIncludes(toc, '<el-drawer', 'ArticleTocPanel.vue drawer');

const homeRecommendationsCopy = read('src/frontend/src/locales/zh-CN/layout.ts');
expectIncludes(featuredArticles, 'copy.leadEyebrow', 'FeaturedArticlesSection.vue lead eyebrow registry binding');
expectIncludes(homeRecommendationsCopy, "leadEyebrow: '本期推荐'", 'FeaturedArticlesSection.vue lead eyebrow (via layout locale)');
expectIncludes(homeRecommendationsCopy, "eyebrow: '热门文章'", 'HomeTextFirstRecommendations.vue eyebrow (via layout locale)');
expectIncludes(hotArticlesIsland, '热门文章', 'homeHotArticlesIsland.ts');
expectNotMatches(homeRecommendations, /顺着读/, 'HomeTextFirstRecommendations.vue hot fallback heading must not drift to 顺着读');

expectIncludes(progress, 'data-reading-progress="true"', 'ArticleReadingProgress.vue');
expectIncludes(progress, 'height: 2px;', 'ArticleReadingProgress.vue track height');
expectIncludes(progress, 'z-index: 50;', 'ArticleReadingProgress.vue stacking order');
expectIncludes(progress, 'background: color-mix(in srgb, var(--fsusblog-panel-border) 72%, transparent);', 'ArticleReadingProgress.vue neutral track');
expectIncludes(progress, 'transform: scaleX(var(--article-reading-progress, 0))', 'ArticleReadingProgress.vue');
expectIncludes(progress, 'background: color-mix(in srgb, var(--fsusblog-color-primary) 58%, transparent);', 'ArticleReadingProgress.vue Scholarly Blue progress');
expectNotMatches(progress, /background:\s*color-mix\(in srgb, var\(--fsusblog-text-primary\)/, 'ArticleReadingProgress.vue progress must not use text color');
expectIncludes(progress, 'transition: transform var(--blog-motion-fast) var(--blog-motion-ease)', 'ArticleReadingProgress.vue');
expectIncludes(progress, 'transition-duration: 1ms;', 'ArticleReadingProgress.vue reduced motion');
expectNotMatches(progress, /transition\s*:[^;]*width/s, 'ArticleReadingProgress.vue must not animate width');
expectNotMatches(progress, /transition:\s*none/, 'ArticleReadingProgress.vue reduced motion must use 1ms instead of none');

expectIncludes(toc, 'aria-current', 'ArticleTocPanel.vue');
expectIncludes(toc, 'blog-motion-reading-control', 'ArticleTocPanel.vue');
expectIncludes(toc, 'border-left-color: var(--fsusblog-color-primary);', 'ArticleTocPanel.vue');
expectIncludes(toc, 'box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);', 'ArticleTocPanel.vue');
expectNotMatches(toc, /\b(?:translate|scale|stagger)\b/i, 'ArticleTocPanel.vue must not use translate/scale/stagger');
expectNotMatches(
    toc,
    /border-left-color:\s*color-mix\(in srgb,\s*var\(--fsusblog-text-primary\)/,
    'ArticleTocPanel.vue active/focus must use Scholarly Blue'
);

errors.push(...validateAccountHeaderFocusContract(accountShellBase));
assertAccountFocusMutationRejected(
    accountShellBase,
    'none',
    (source) => mutateAccountHeaderFocus(source, 'box-shadow: none;')
);
assertAccountFocusMutationRejected(
    accountShellBase,
    'non-inset',
    (source) => mutateAccountHeaderFocus(source, 'box-shadow: 0 0 0 2px var(--fsusblog-color-focus-ring);')
);
assertAccountFocusMutationRejected(
    accountShellBase,
    'duplicate exact owner impersonation',
    (source) => `.account-header-link:focus-visible {\n  box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);\n}\n${mutateAccountHeaderFocus(source, 'box-shadow: none;')}`
);
assertAccountFocusMutationRejected(
    accountShellBase,
    'comment impersonation',
    (source) => `/*\n.account-header-link:focus-visible {\n  box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);\n}\n*/\n${mutateAccountHeaderFocus(source, 'box-shadow: none;')}`
);
assertAccountFocusMutationRejected(
    accountShellBase,
    'other selector impersonation',
    (source) => `${mutateAccountHeaderFocus(source, 'box-shadow: none;')}\n.account-shell-copy .account-header-link:focus-visible {\n  box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);\n}\n`
);
assertAccountFocusMutationRejected(
    accountShellBase,
    'quoted selector impersonation',
    (source) => `.account-shell-copy::before {\n  content: "}.account-header-link:focus-visible { box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring); }";\n}\n${mutateAccountHeaderFocus(source, 'box-shadow: none;')}`
);
assertAccountFocusMutationRejected(
    accountShellBase,
    'escaped box-shadow suffix',
    (source) => mutateAccountHeaderFocus(
        source,
        'box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);\n  box-shado\\77: none;'
    )
);
assertAccountFocusMutationRejected(
    accountShellBase,
    'escaped box-shadow hyphen',
    (source) => mutateAccountHeaderFocus(
        source,
        'box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);\n  box\\2d shadow: none;'
    )
);
assertAccountFocusMutationRejected(
    accountShellBase,
    'escaped focus owner selector',
    (source) => source.replace(
        '.account-header-link:focus-visible',
        '.account-header\\2d link:focus-visible'
    )
);
expectNotMatches(accountShellBase, /\bfocus-visible:ring-1\b/, 'account-shell-base.css must not use ring-1 focus');
expectNotMatches(accountLayout, /backdrop-filter:\s*blur\(/, 'AccountLayout.vue default shell must not use blur');

expectNotMatches(articleDetail, /ArticleMobileActionBar/, 'ArticleDetail.vue must not render removed mobile action bar');

expectIncludes(lightbox, 'data-article-lightbox="true"', 'ArticleImageLightbox.vue');
expectIncludes(lightbox, 'ElImageViewer', 'ArticleImageLightbox.vue');
expectIncludes(lightbox, "from '@ozwasyd/element-plus'", 'ArticleImageLightbox.vue');
expectIncludes(lightbox, ':show-toolbar="false"', 'ArticleImageLightbox.vue');
expectIncludes(lightbox, '#caption=', 'ArticleImageLightbox.vue');
expectIncludes(lightbox, 'color: var(--fsusblog-overlay-button-fg)', 'ArticleImageLightbox.vue');
expectNotMatches(lightbox, /article-lightbox-fade/, 'ArticleImageLightbox.vue must use FsusUI transition instead of local fade CSS');
expectNotMatches(lightbox, /scale\(/, 'ArticleImageLightbox.vue must not use zoom/scale');
expectNotMatches(lightbox, /rgb\(/, 'ArticleImageLightbox.vue must use overlay tokens instead of raw rgb()');
expectNotMatches(lightbox, /position:\s*fixed/, 'ArticleImageLightbox.vue must not own fixed viewport root');
expectNotMatches(lightbox, /inset:\s*0/, 'ArticleImageLightbox.vue must not own full-viewport inset root');
expectNotMatches(lightbox, /background:\s*var\(--fsusblog-overlay-scrim\)/, 'ArticleImageLightbox.vue must not paint a local scrim');
expectNotMatches(lightbox, /backdrop-filter/, 'ArticleImageLightbox.vue must not own overlay backdrop material');
expectNotMatches(lightbox, /\b(?:100|80|88)vh\b/, 'ArticleImageLightbox.vue must not use bare vh viewport geometry');
expectNotMatches(lightbox, /env\(\s*safe-area-inset-/, 'ArticleImageLightbox.vue must consume FsusUI safe-area tokens');
expectNotMatches(lightbox, /<FsusUiOverlay|article-image-lightbox-open/, 'ArticleImageLightbox.vue must not retain a second viewer owner');

expectIncludes(publicShell, '<FsusUiPublicShell', 'PublicBlogLayoutShell.vue FsusUI public shell boundary');
expectIncludes(publicShell, ':active-nav="activeNav"', 'PublicBlogLayoutShell.vue delegated desktop nav aria-current state');
expectNotMatches(publicShell, /el-public-shell__header-action/, 'PublicBlogLayoutShell.vue desktop header must not use bordered header action affordance');
const publicShellTemplate = publicShell.match(/<template>(?<body>[\s\S]*?)<\/template>/u)?.groups?.body ?? '';
const publicSkipLinkIndex = publicShellTemplate.indexOf('href="#main-content"');
const firstPublicFocusableIndex = publicShellTemplate.search(/<(?:a|button|input|select|textarea)\b/u);
if (
    publicSkipLinkIndex < 0
  || publicShellTemplate.lastIndexOf('<a', publicSkipLinkIndex) !== firstPublicFocusableIndex
)
{
    errors.push('PublicBlogLayoutShell.vue skip link must remain the first focusable element');
}
expectMatches(
    publicShell,
    /<template>[\s\S]*?<a[\s\S]*?href="#main-content"[\s\S]*?<FsusUiPublicShell/u,
    'PublicBlogLayoutShell.vue skip link must remain the first focusable shell control'
);
expectMatches(
    publicShell,
    /id="main-content"[\s\S]*?tabindex="-1"/u,
    'PublicBlogLayoutShell.vue skip target must remain programmatically focusable'
);
expectIncludes(
    publicShell,
    'class="fsusblog-public-skip-link sr-only',
    'PublicBlogLayoutShell.vue owned skip-link hook'
);
expectNotMatches(publicShell, /focus:top-4/u, 'PublicBlogLayoutShell.vue skip link must not use the retired fixed top offset');
expectMatches(
    publicShellFoundation,
    /#fsus-aot-shell \.fsusblog-public-skip-link:focus\s*\{\s*top: calc\(var\(--fsusblog-public-header-height-current\) \+ 8px\);\s*\}/u,
    'public-shell-foundation.css skip link must sit eight pixels below measured header geometry'
);

expectMatches(
    publicShellFoundation,
    /#fsus-aot-shell \.public-colophon__link\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;[^}]*padding-inline:\s*8px;/su,
    'public-shell-foundation.css footer links must preserve a padded 44px touch target'
);
expectMatches(
    publicShellFoundation,
    /#fsus-aot-shell \.public-colophon__policy-links,\s*#fsus-aot-shell \.public-colophon__records\s*\{[^}]*gap:\s*2px 12px;/su,
    'public-shell-foundation.css footer link groups must use the compact two-dimensional gap'
);
expectMatches(
    publicShellFoundation,
    /#fsus-aot-shell \.public-colophon__record-link\s*\{[^}]*line-height:\s*20px;/su,
    'public-shell-foundation.css record links must own stable text metrics'
);
expectMatches(
    publicShellFoundation,
    /#fsus-aot-shell \.public-colophon__record-icon\s*\{[^}]*display:\s*inline-flex;[^}]*flex:\s*0 0 16px;[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/su,
    'public-shell-foundation.css record icons must remain centered in a fixed box'
);
expectMatches(
    publicComplianceFooter,
    /<span v-if="record\.icon" class="public-colophon__record-icon">\s*<img/u,
    'PublicComplianceFooter.vue record icon must use the centered wrapper'
);

expectNotMatches(publicArticleList, /\bv-motion\b/, 'PublicArticleList.vue reading surface must not use v-motion');
expectNotMatches(publicArticleList, /fsusBlogMotionPresets\.articleCards/, 'PublicArticleList.vue reading surface must not use articleCards preset');
expectNotMatches(publicArticleList, /@ozwasyd\/element-plus\/motion/, 'PublicArticleList.vue must not import motion directives');
expectNotMatches(publicArticleDetail, /\bv-motion\b/, 'PublicArticleDetailPageContent.vue article title must render statically');
expectNotMatches(publicArticleDetail, /\bv-scroll-reveal\b/, 'PublicArticleDetailPageContent.vue article cover must render statically');
expectNotMatches(publicArticleDetail, /fsusBlog(?:MotionPresets|ScrollRevealMotion)/, 'PublicArticleDetailPageContent.vue reading surface must not import motion presets');
expectNotMatches(publicArticleDetail, /@ozwasyd\/element-plus\/motion/, 'PublicArticleDetailPageContent.vue must not import motion directives');
expectIncludes(publicArticleDetail, 'data-article-tail-group', 'PublicArticleDetailPageContent.vue groups article tail sections');
expectIncludes(
    publicArticleDetail,
    '<!-- reading layout 的 content line 将中文正文限制在 760px，并为 wide media 提供共享 bleed line。 -->',
    'PublicArticleDetailPageContent.vue Chinese reading-line rationale'
);
expectIncludes(publicArticleDetail, 'data-fsus-reading-layout', 'PublicArticleDetailPageContent.vue shared reading geometry');
expectIncludes(
    publicArticleDetail,
    ':class="themeTokens.articleDetail.commentsSectionHeading"',
    'PublicArticleDetailPageContent.vue comments heading uses the shared rhythm token'
);
expectIncludes(
    themeTokens,
    'commentsSectionHeading: `mb-6 border-b ${lineBorder} pb-3 text-sm font-bold ${textPrimary} normal-case`',
    'themeTokens.ts owns the 12px comments divider rhythm'
);
expectIncludes(publicArticleDetail, 'class="fsus-appendix"', 'PublicArticleDetailPageContent.vue restrained appendix boundary');
expectIncludes(publicArticleDetail, 'data-fsus-surface="reading"', 'PublicArticleDetailPageContent.vue appendix reading surface');
expectIncludes(publicArticleDetail, 'class="fsus-appendix__tags"', 'PublicArticleDetailPageContent.vue inline appendix tags');
expectIncludes(publicArticleDetail, 'class="fsus-appendix__copyright article-rights-notice"', 'PublicArticleDetailPageContent.vue compressed copyright prose');
expectIncludes(publicArticleDetail, 'class="fsus-appendix__nav"', 'PublicArticleDetailPageContent.vue appendix navigation');
expectIncludes(publicArticleDetail, 'class="fsus-appendix__nav-label"', 'PublicArticleDetailPageContent.vue promoted navigation label');
expectIncludes(publicArticleDetail, 'class="fsus-appendix__nav-list"', 'PublicArticleDetailPageContent.vue clean navigation list');
expectIncludes(publicArticleDetail, 'class="fsus-appendix__meta"', 'PublicArticleDetailPageContent.vue demoted related metadata');
expectIncludes(publicArticleDetail, 'class="fsus-appendix__link"', 'PublicArticleDetailPageContent.vue restrained related links');
expectIncludes(publicArticleDetail, 'border-top: 1px solid var(--fsusblog-panel-border);', 'PublicArticleDetailPageContent.vue appendix keeps only the article boundary');
expectMatches(publicArticleDetail, /\.fsus-appendix\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s, 'PublicArticleDetailPageContent.vue appendix remains transparent and flat');
expectIncludes(publicArticleDetail, 'letter-spacing: 0.05em;', 'PublicArticleDetailPageContent.vue appendix navigation label editorial tracking');
expectIncludes(publicArticleDetail, 'min-height: 44px;', 'PublicArticleDetailPageContent.vue appendix links preserve mobile touch targets');
expectIncludes(publicArticleDetail, 'transition: color var(--blog-motion-control) var(--blog-motion-ease);', 'PublicArticleDetailPageContent.vue related links use the reading motion token');
expectIncludes(publicArticleDetail, 'color: var(--fsusblog-color-primary);', 'PublicArticleDetailPageContent.vue related link semantic hover');
expectMatches(publicArticleDetail, /\.fsus-appendix__tag:visited\s*\{[^}]*color:\s*var\(--fsusblog-text-quiet\)\s*!important;/s, 'PublicArticleDetailPageContent.vue visited tags keep quiet semantics');
expectMatches(publicArticleDetail, /\.fsus-appendix__link:visited\s*\{[^}]*color:\s*var\(--fsusblog-text-primary\);/s, 'PublicArticleDetailPageContent.vue visited related links keep primary semantics');
expectNotMatches(publicArticleDetail, /fsus-colophon/, 'PublicArticleDetailPageContent.vue must not restore the large colophon');
expectNotMatches(publicArticleDetail, /article-tail-group mt-8 sm:mt-10 divide-y/, 'PublicArticleDetailPageContent.vue appendix must not restore internal row dividers');
expectNotMatches(publicArticleDetail, /blog-link-underline/, 'PublicArticleDetailPageContent.vue appendix links must not use underline decoration');
expectNotMatches(publicArticleDetail, /\.fsus-appendix__(?:tags|tag|copyright|nav|nav-label|nav-list|nav-item|meta|link)\s*\{[^}]*(?:border-top|border-bottom):/s, 'PublicArticleDetailPageContent.vue appendix descendants must not add dividers');
expectMatches(publicArticleDetail, /\.fsus-appendix__nav-label\s*\{[^}]*font-weight:\s*700;/s, 'PublicArticleDetailPageContent.vue related-reading label owns the appendix hierarchy');
expectMatches(publicArticleDetail, /\.fsus-appendix__(?:tag|copyright|link)\s*\{[^}]*font-weight:\s*400;/s, 'PublicArticleDetailPageContent.vue appendix content remains restrained below its label');
expectMatches(publicArticleDetail, /\.fsus-appendix\s*\{[^}]*gap:\s*24px;/su, 'PublicArticleDetailPageContent.vue appendix group spacing');
expectMatches(
    publicArticleDetail,
    /\.fsus-appendix__copyright\s*\{[^}]*padding:\s*16px;[^}]*border-radius:\s*var\(--fsusblog-radius-control, 6px\);[^}]*background:\s*var\(--fsusblog-page-bg-soft\);[^}]*color:\s*var\(--fsusblog-text-tertiary\);[^}]*font-size:\s*13px;[^}]*font-weight:\s*400;[^}]*line-height:\s*1\.7;/su,
    'PublicArticleDetailPageContent.vue copyright treatment'
);
expectMatches(
    publicArticleDetail,
    /\.fsus-appendix__nav-label\s*\{[^}]*margin-bottom:\s*12px;[^}]*color:\s*var\(--fsusblog-text-muted\);[^}]*font-size:\s*12px;[^}]*font-weight:\s*700;[^}]*letter-spacing:\s*0\.05em;[^}]*text-transform:\s*uppercase;/su,
    'PublicArticleDetailPageContent.vue related-reading label rhythm'
);
expectMatches(
    publicArticleDetail,
    /\.fsus-appendix__tag:hover,\s*\.fsus-appendix__tag:focus-visible\s*\{[^}]*color:\s*var\(--fsusblog-text-primary\) !important;/su,
    'PublicArticleDetailPageContent.vue tag interaction color'
);
expectMatches(publicArticleDetail, /\.fsus-appendix__nav-item\s*\{[^}]*gap:\s*6px;/su, 'PublicArticleDetailPageContent.vue related-reading content gap');
expectMatches(
    publicArticleDetail,
    /\.fsus-appendix__link:focus-visible,\s*\.fsus-appendix__tag:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--fsusblog-color-focus-ring\);[^}]*outline-offset:\s*-2px;/su,
    'PublicArticleDetailPageContent.vue related links must use the inset Scholarly Blue focus ring'
);
expectNotMatches(
    publicArticleDetail,
    /box-shadow:\s*inset 0 0 0 2px var\(--fsusblog-color-focus-ring\)/u,
    'PublicArticleDetailPageContent.vue appendix focus must retain its forced-colors-compatible outline owner'
);
expectIncludes(
    publicArticleDetail,
    ':class="themeTokens.articleDetail.commentsRoot"',
    'PublicArticleDetailPageContent.vue comments island uses the shared section rhythm token'
);
expectIncludes(
    themeTokens,
    "commentsRoot: 'mt-10 sm:mt-14'",
    'themeTokens.ts owns the 40px mobile and 56px desktop comments section gap'
);
expectMatches(publicArticleDetail, /id="fsus-comments-island-content"[^>]*class="min-h-0"/, 'PublicArticleDetailPageContent.vue comments mount must not reserve a tall empty block');
expectNotMatches(publicArticleDetail, /class="mt-12 sm:mt-16 border-t border-\[var\(--fsusblog-panel-border\)\] pt-8 sm:pt-10"/, 'PublicArticleDetailPageContent.vue comments island must not add a duplicate top rule and large whitespace after related reading');
expectNotMatches(publicArticleDetail, /class="min-h-\[10rem\]"/, 'PublicArticleDetailPageContent.vue comments mount must not keep the old tall empty state');
expectIncludes(publicArticleDetail, ':aria-label="messages.article.content.relatedAria"', 'PublicArticleDetailPageContent.vue localized related reading row-list aria label');
expectIncludes(articleLocaleZh, "relatedAria: '延伸阅读文章'", 'zh-CN article locale preserves the related-reading aria label');
expectNotMatches(publicArticleDetail, /grid-cols-\[4rem_minmax\(0,1fr\)\]/, 'PublicArticleDetailPageContent.vue related reading must not squeeze content with a narrow label column');
expectNotMatches(publicArticleDetail, /class="flex flex-col gap-8"/, 'PublicArticleDetailPageContent.vue extended reading must not keep large vertical gaps');
expectNotMatches(publicArticleDetail, /class="flex flex-col gap-4"/, 'PublicArticleDetailPageContent.vue extended reading must use compact rows instead of stacked blocks');
expectNotMatches(publicArticleDetail, /class="grid gap-3 sm:grid-cols-2"/, 'PublicArticleDetailPageContent.vue related reading must not split previous/next into a separate card grid');
expectNotMatches(publicArticleDetail, /v-if="item\.summary"/, 'PublicArticleDetailPageContent.vue compact related reading must not render summaries');
expectNotMatches(publicArticleDetail, /\{\{\s*item\.reason\s*\}\}\s*·\s*\{\{\s*item\.displayTime\s*\}\}/, 'PublicArticleDetailPageContent.vue related rows must not expose denser metadata than previous rows');
expectIncludes(commentDetailContract, "guestShell: 'fsus-comment-login'", 'commentDetail.ts guest composer prompt must use the compact comment login row');
expectIncludes(commentComposer, 'flex-wrap: wrap;', 'ArticleCommentComposer.vue comment login row remains responsive without vertical stacking');
expectIncludes(commentComposer, 'align-items: center;', 'ArticleCommentComposer.vue comment login row keeps a shared baseline');
expectIncludes(commentComposer, 'padding-block: 16px;', 'ArticleCommentComposer.vue comment login row stays compact');
expectIncludes(commentComposer, 'border-top: 1px solid var(--fsusblog-panel-border);', 'ArticleCommentComposer.vue comment login row uses the semantic top divider');
expectIncludes(commentComposer, 'font-size: 14px;', 'ArticleCommentComposer.vue comment login prompt uses the demoted text size');
expectIncludes(commentComposer, 'height: 40px;', 'ArticleCommentComposer.vue comment login action keeps the compact height');
expectIncludes(commentComposer, 'padding-inline: 12px;', 'ArticleCommentComposer.vue comment login action keeps the compact horizontal padding');
expectIncludes(commentComposer, 'border-radius: 6px;', 'ArticleCommentComposer.vue reading gate action keeps the specified radius');
expectIncludes(commentComposer, 'color var(--blog-motion-control) var(--blog-motion-ease),\n    border-color var(--blog-motion-control) var(--blog-motion-ease);', 'ArticleCommentComposer.vue comment login action keeps the reading motion token');
expectNotMatches(commentComposer, /\.fsus-comment-login__btn:hover\s*\{[^}]*(?:translate|box-shadow|background-color)/s, 'ArticleCommentComposer.vue comment login hover must not move, glow, or fill');
expectNotMatches(commentComposer, /\.fsus-comment-login\s*\{[^}]*justify-content:\s*space-between/s, 'ArticleCommentComposer.vue comment login row must not restore the split layout');
expectNotMatches(commentComposer, /fsus-reading-gate|fsus-auth-gate|参与讨论/, 'ArticleCommentComposer.vue compact comment login row must not retain the demoted title gate');
expectNotMatches(commentDetailContract, /guestShell:\s*'mb-12 py-8 bg-\[var\(--fsusblog-panel-bg\)\]\/50 flex items-center justify-center border border-\[var\(--fsusblog-panel-border\)\]'/, 'commentDetail.ts guest composer prompt must not render as a tall card');
expectIncludes(commentsVirtualList, 'class="fsus-comments-list"', 'ArticleCommentsVirtualList.vue uses an open editorial comment list');
expectIncludes(commentsVirtualList, "import ArticleCommentTreeNode from '@/components/article/ArticleCommentTreeNode.vue'", 'ArticleCommentsVirtualList.vue delegates recursive comment rendering to its authoritative node owner');
expectIncludes(commentsVirtualList, '<ArticleCommentTreeNode', 'ArticleCommentsVirtualList.vue renders the recursive node owner');
expectIncludes(commentTreeNode, "const isAnonymous = computed(() => props.node.author.mode !== 'public')", 'ArticleCommentTreeNode.vue distinguishes anonymous authors');
expectIncludes(commentTreeNode, 'class="fsus-comment-tree-node__badge">匿名', 'ArticleCommentTreeNode.vue labels anonymous identity plainly');
expectIncludes(commentTreeNode, 'class="fsus-comment-tree-node__footer"', 'ArticleCommentTreeNode.vue places actions in a quiet footer');
expectIncludes(commentTreeNode, 'relativeTimeText: formatRelativeTime(props.node.createTime)', 'ArticleCommentTreeNode.vue renders relative comment times in Chinese');
expectIncludes(commentTreeNode, 'padding-block: 20px;', 'ArticleCommentTreeNode.vue root item uses the editorial vertical rhythm');
expectIncludes(commentTreeNode, 'border-bottom: 1px solid var(--fsusblog-panel-border);', 'ArticleCommentTreeNode.vue root item uses the restrained semantic divider');
expectIncludes(commentTreeNode, 'box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);', 'ArticleCommentTreeNode.vue actions keep the shared inset focus ring');
expectMatches(commentTreeNode, /\.fsus-comment-tree-node__author\.is-authenticated\s*\{[^}]*font-weight:\s*700;/s, 'ArticleCommentTreeNode.vue authenticated authors keep the strong identity weight');
expectMatches(commentTreeNode, /\.fsus-comment-tree-node__badge\s*\{[^}]*border:\s*1px solid var\(--fsusblog-panel-border-strong\);[^}]*color:\s*var\(--fsusblog-text-muted\);/s, 'ArticleCommentTreeNode.vue anonymous badge keeps readable text and boundary roles');
expectMatches(commentTreeNode, /\.fsus-comment-tree-node__action\s*\{[^}]*color:\s*var\(--fsusblog-text-muted\);/s, 'ArticleCommentTreeNode.vue actions remain readable at rest');
expectMatches(commentTreeNode, /\.fsus-comment-tree-node__children\s*\{[^}]*border-left:\s*2px solid var\(--fsusblog-panel-border-strong\);/s, 'ArticleCommentTreeNode.vue replies retain a visible nested boundary');
expectMatches(commentTreeNode, /\.fsus-comment-tree-node__action\.is-danger:hover\s*\{[^}]*color:\s*var\(--el-color-danger\);/s, 'ArticleCommentTreeNode.vue destructive hover keeps the danger semantic');
expectNotMatches(commentsVirtualList, /comment-thread-action/, 'ArticleCommentsVirtualList.vue must not retain the old Element Plus action styling');
expectIncludes(commentMarkdown, 'class="comment-markdown-renderer fsus-markdown-body"', 'CommentMarkdownRenderer.vue exposes the restrained markdown surface');
expectIncludes(commentMarkdown, 'data-fsus-surface="reading"', 'CommentMarkdownRenderer.vue declares the shared reading surface');
expectIncludes(commentMarkdown, 'margin-bottom: 0;', 'CommentMarkdownRenderer.vue removes the last paragraph margin at its stable content boundary');
expectIncludes(commentMarkdown, 'font-size: 16px;', 'CommentMarkdownRenderer.vue uses the canonical reading size');
expectIncludes(commentMarkdown, 'line-height: 1.8;', 'CommentMarkdownRenderer.vue uses the canonical reading line height');
expectNotMatches(commentMarkdown, /font-family:\s*monospace|font-size:\s*14px\s*!important|line-height:\s*1\.6\s*!important/, 'CommentMarkdownRenderer.vue must not fork the shared reading typography');
expectNotMatches(commentMarkdown, /linear-gradient/, 'CommentMarkdownRenderer.vue markdown collapse must not use a gradient veil');
expectIncludes(articleDetail, "import ArticleCommentsEmptyState from '@/components/public/ArticleCommentsEmptyState.vue'", 'ArticleDetail.vue unified comments empty state component');
expectIncludes(articleDetail, ':redirect-path="commentRedirectPath"', 'ArticleDetail.vue keeps the empty-state login redirect');
expectIncludes(articleDetail, 'v-if="!isGuestCommentEndState"', 'ArticleDetail.vue hides the legacy guest row after the comment stream reaches its end');
expectIncludes(articleDetail, 'v-if="threads.length > 0"', 'ArticleDetail.vue keeps existing comments visible alongside the unified end state');
expectIncludes(articleDetail, 'v-if="isCommentsAtEnd"', 'ArticleDetail.vue renders the unified end state after comment loading resolves');
expectIncludes(articleDetail, 'v-if="!isCommentsAtEnd"', 'ArticleDetail.vue removes the legacy cursor end placeholder when the unified end state is visible');
expectIncludes(commentsEmpty, 'class="fsus-comments-empty"', 'ArticleCommentsEmptyState.vue unified empty state root');
expectIncludes(commentsEmpty, 'class="fsus-comments-empty__text"', 'ArticleCommentsEmptyState.vue empty state copy');
expectIncludes(commentsEmpty, 'class="fsus-comments-empty__btn"', 'ArticleCommentsEmptyState.vue guest login action');
expectIncludes(articleDetail, ":message=\"isCommentsEmpty ? '暂无评论。' : pageDetailView.comments.endText\"", 'ArticleDetail.vue preserves the empty-state copy and end-of-list copy');
expectIncludes(commentsEmpty, '{{ messages.article.comments.loginCta }}', 'ArticleCommentsEmptyState.vue localized empty state login text binding');
expectIncludes(articleLocaleZh, "loginCta: '登录以参与讨论'", 'zh-CN article locale preserves the empty state login text');
expectIncludes(commentsEmpty, 'flex-direction: column;', 'ArticleCommentsEmptyState.vue centered vertical grouping');
expectIncludes(commentsEmpty, 'align-items: center;', 'ArticleCommentsEmptyState.vue centered horizontal alignment');
expectIncludes(commentsEmpty, 'justify-content: center;', 'ArticleCommentsEmptyState.vue centered vertical alignment');
expectIncludes(commentsEmpty, 'padding-block: 0;', 'ArticleCommentsEmptyState.vue does not stack empty-state padding onto the section rhythm');
expectIncludes(commentsEmpty, 'gap: 16px;', 'ArticleCommentsEmptyState.vue fixed vertical rhythm');
expectIncludes(commentsEmpty, 'min-height: 44px;', 'ArticleCommentsEmptyState.vue mobile-safe secondary action');
expectIncludes(commentsEmpty, 'padding-inline: 16px;', 'ArticleCommentsEmptyState.vue compact action padding');
expectIncludes(commentsEmpty, 'border: 1px solid var(--fsusblog-panel-border);', 'ArticleCommentsEmptyState.vue ghost action border');
expectIncludes(commentsEmpty, 'color var(--blog-motion-control) var(--blog-motion-ease),\n    border-color var(--blog-motion-control) var(--blog-motion-ease);', 'ArticleCommentsEmptyState.vue restrained interaction timing');
expectNotMatches(commentsEmpty, /\.fsus-comments-empty\s*\{[^}]*(?:border-top|border-bottom|border-radius):/s, 'ArticleCommentsEmptyState.vue root must remain open and unframed');
expectIncludes(commentsEmpty, '.fsus-comments-empty__btn:hover {\n  border-color: var(--fsusblog-color-primary);\n  background-color: transparent;\n  color: var(--fsusblog-color-primary);', 'ArticleCommentsEmptyState.vue hover must stay transparent and static');
expectNotMatches(commentsEmpty, /\.fsus-comments-empty__btn:hover\s*\{[^}]*transform:/s, 'ArticleCommentsEmptyState.vue hover must not add transform motion');
expectIncludes(commentComposer, '.comment-identity-panel {\n  margin-bottom: 0.75rem;\n  border: 0;', 'ArticleCommentComposer.vue identity row must not render as a heavy card');
expectIncludes(commentComposer, 'border-bottom: 1px solid var(--fsusblog-panel-border);', 'ArticleCommentComposer.vue identity row keeps only a light divider');
expectIncludes(commentComposer, 'background: transparent;', 'ArticleCommentComposer.vue identity row must inherit the reading surface');
expectNotMatches(commentComposer, /\.comment-identity-panel\s*\{[^}]*linear-gradient/s, 'ArticleCommentComposer.vue identity row must not use card gradients');
expectNotMatches(commentComposer, /\.comment-identity-panel\s*\{[^}]*border-radius:\s*0\.5rem/s, 'ArticleCommentComposer.vue identity row must not use card radius');
expectIncludes(publicPageCss, '#fsus-aot-shell .blog-link-underline {\n  display: inline-block;', 'public-page.css editorial link underline must fit title text width');
for (const [source, label] of [
    [publicArticleDetail, 'PublicArticleDetailPageContent.vue'],
    [commentsVirtualList, 'ArticleCommentsVirtualList.vue'],
    [commentTreeNode, 'ArticleCommentTreeNode.vue'],
    [commentMarkdown, 'CommentMarkdownRenderer.vue'],
    [commentComposer, 'ArticleCommentComposer.vue'],
    [commentsEmpty, 'ArticleCommentsEmptyState.vue']
])
{
    expectNotMatches(source, /#(?:0F0F11|A1A1AA|E4E4E7|2A599C|F7F7F8)\b/i, `${label} must consume semantic theme tokens instead of frozen light colors`);
    expectNotMatches(source, /html(?:\.dark|\[data-theme-resolved=['"]dark['"]\])/, `${label} must not add component-level dark selectors`);
}
for (const [source, label] of [
    [publicPageCss, 'public-page.css'],
    [publicShellFoundation, 'public-shell-foundation.css']
])
{
    expectIncludes(source, '--fsusblog-text-quiet: var(--fsus-color-text-quiet, #A1A1AA);', `${label} quiet text alias`);
    expectIncludes(source, '--fsusblog-text-decorative: var(--fsus-color-text-decorative, var(--text-decorative));', `${label} decorative text alias`);
    expectIncludes(source, '--fsusblog-reading-inline-code-bg: var(--fsus-color-surface-raised, var(--surface-subtle));', `${label} raised inline-code alias`);
}
expectIncludes(publicPageCss, "html.dark,\nhtml[data-theme-resolved='dark']", 'full public CSS shares explicit and system-resolved dark selectors');
expectIncludes(publicShellFoundation, "html.dark,\nhtml[data-theme-resolved='dark']", 'critical/AOT foundation shares explicit and system-resolved dark selectors');
expectNotMatches(publicFilter, /\bv-motion\b/, 'PublicFilterPageContent.vue search panel must render statically');
expectNotMatches(publicFilter, /fsusBlogMotionPresets\.searchDialog/, 'PublicFilterPageContent.vue reading surface must not use searchDialog preset');
expectNotMatches(publicFilter, /@ozwasyd\/element-plus\/motion/, 'PublicFilterPageContent.vue must not import motion directives');

expectIncludes(targetHelper, 'resolveMotionScrollBehavior()', 'useArticleReadingTarget.ts');
expectIncludes(targetHelper, 'ARTICLE_READING_TARGET_CLASS', 'useArticleReadingTarget.ts');
expectIncludes(targetHelper, "target.focus({ preventScroll: true })", 'useArticleReadingTarget.ts');
expectIncludes(targetHelper, 'highlightArticleReadingTarget', 'useArticleReadingTarget.ts');
expectIncludes(tocComposable, 'scrollToArticleTarget(target)', 'useArticleToc.ts');
expectNotMatches(articleDetail, /navigateToComments/, 'ArticleDetail.vue must not keep removed mobile comments shortcut');

expectIncludes(codeCopy, 'fsus-code-copy-button--copied', 'useCodeBlockCopy.ts');
expectIncludes(codeCopy, 'useScrollReveal', 'useCodeBlockCopy.ts');
expectIncludes(codeCopy, "'article-code-block'", 'useCodeBlockCopy.ts');
expectIncludes(codeCopy, "button.setAttribute('aria-live', 'polite')", 'useCodeBlockCopy.ts');
expectIncludes(codeCopy, 'globalThis.setTimeout', 'useCodeBlockCopy.ts');
expectIncludes(imageLightboxComposable, 'useScrollReveal', 'useArticleImageLightbox.ts');
expectIncludes(imageLightboxComposable, "'article-body-image'", 'useArticleImageLightbox.ts');
expectIncludes(markdownCss, '.fsus-code-copy-button--copied', 'markdown.css');
expectIncludes(markdownCss, 'var(--blog-motion-fast) var(--blog-motion-ease)', 'markdown.css');
expectIncludes(markdownCss, 'box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);', 'markdown.css image preview inset focus');
expectMatches(markdownCss, /\.fsus-article-preview-image:focus-visible\s*\{[^}]*outline:\s*none;/s, 'markdown.css image preview removes the exterior outline');
expectIncludes(markdownCss, 'font-size: 1rem;', 'markdown.css canonical 16px editorial reading size');
expectIncludes(markdownCss, 'line-height: 1.8;', 'markdown.css canonical editorial line height');
expectIncludes(markdownCss, 'letter-spacing: 0.015em;', 'markdown.css natural reading letter spacing');
expectMatches(markdownCss, /\.markdown-body\s*\{[^}]*text-align:\s*justify;/s, 'markdown.css justified reading surface');
expectIncludes(markdownCss, '.markdown-body h1 {\n  font-size: 1.5rem;', 'markdown.css 24px reading H1 rule');
expectIncludes(markdownCss, '.markdown-body h2 {\n  font-size: 1.25rem;', 'markdown.css 20px reading H2 rule');
expectIncludes(markdownCss, 'margin-bottom: 2em;\n  border-bottom: none;', 'markdown.css section heading spacing');
expectMatches(markdownCss, /\.markdown-body p\s*\{[^}]*text-indent:\s*2em;/s, 'markdown.css paragraphs use 2em first-line indentation for editorial prose');
expectMatches(markdownCss, /\.markdown-body \.markdown-renderer__text\s*\{[^}]*letter-spacing:\s*0\.015em;[^}]*text-align:\s*justify;/s, 'markdown.css FsusUI paragraph override');
expectMatches(markdownCss, /\.markdown-body h1\s*\{[^}]*text-align:\s*left;/s, 'markdown.css left-aligned reading h1');
expectMatches(markdownCss, /\.markdown-body h2\s*\{[^}]*text-align:\s*left;/s, 'markdown.css left-aligned reading h2');
expectIncludes(markdownCss, 'font-family: var(--fsus-typography-code-family, var(--fsus-font-code, ui-monospace, monospace));', 'markdown.css fenced code semantic font token');
expectIncludes(markdownCss, 'font-family: var(--fsus-typography-code-family, var(--fsus-font-code, ui-monospace, monospace)) !important;', 'markdown.css inline code semantic font token');
expectNotMatches(markdownCss, /font-family:[^;]*(?:Monaco|Consolas|var\(--font-sans\)|['"]JetBrains Mono['"])/, 'markdown.css must not fork the semantic code font token');
expectNotMatches(markdownCss, /\.fsus-article-preview-image:focus-visible\s*\{[^}]*outline-offset:/, 'markdown.css image preview must not use an exterior focus offset');

if (!exists('docs/public-layout-rules.md'))
{
    errors.push('docs/public-layout-rules.md missing');
}
else
{
    const publicLayoutRules = read('docs/public-layout-rules.md');
    for (const heading of [
        '## 1. Token 命名空间策略',
        '## 2. Public shell 边界',
        '## 3. Reading surface 契约',
        '## 4. Dialog 宽度变体白名单',
        '## 5. Glass material 启用 surface 白名单',
        '## 6. 暗色 Scholarly Blue 决策',
        '## 7. 排版边界',
        '## 8. 圆角标度规则',
        '## 9. 动效标度规则',
        '## 10. Commit 评审 checklist'
    ])
    {
        expectIncludes(publicLayoutRules, heading, 'docs/public-layout-rules.md');
    }
}

if (!exists('docs/index.md'))
{
    errors.push('docs/index.md missing');
}
else
{
    expectIncludes(read('docs/index.md'), 'public-layout-rules.md', 'docs/index.md');
}

if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[public-reading-motion] ${error}`);
    }
    process.exit(1);
}

console.log(`[public-reading-motion] ok accountFocusMutationProofs=${accountFocusMutationProofs}`);
