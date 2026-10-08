import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const articleWritingAidPolicyPath = 'src/frontend/src/services/authoring/articleWritingAidPolicy.ts';
export const articleWritingAidRuntimePath = 'src/frontend/src/services/authoring/articleWritingAidRuntime.ts';

const forbidden = [
    ['private-dom', /\b(?:querySelector(?:All)?|getElementById|MutationObserver|ResizeObserver)\b/u],
    ['scroll-kernel', /\b(?:scrollIntoView|scrollTo|scrollTop|requestAnimationFrame|setInterval|setTimeout)\b/u],
    ['second-runtime', /\b(?:createWritingAidsController|calculateTypewriterScrollTarget|resolveFocusState|calculateMarkdownSourceAnchorY)\b/u],
    ['local-authority', /\b(?:localStorage|sessionStorage|indexedDB|createArticleDocumentContextAdapter|new ArticleDocumentContextAuthority)\b/u],
    ['surface-coupling', /\b(?:mode|surface|documentEpoch|sourceRevision|content|history)\s*:/u],
    ['single-mode', /\b(?:zenEnabled|writingMode|EditorLayoutMode)\b/u],
    ['runtime-import', /import\s+(?!type\b)[^;]*?from\s+['"]@ozwasyd\/element-plus(?:\/[^'"]*)?['"]/u],
    ['private-import', /from\s+['"][^'"]*(?:\/packages\/|\/internal\/|\/es\/|\/lib\/)[^'"]*['"]/u]
];

/** Scoped source governance; this does not certify the mounted editor or the whole repository. */
export function inspectArticleWritingAidPolicy(source)
{
    const failures = forbidden.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
    if (!/import type\s*\{[^}]*MarkdownEditorProps[^}]*\}\s*from '@ozwasyd\/element-plus';/u.test(source))
    {
        failures.push('public-props-type');
    }
    if (!/validateArticleDocumentContext\(input\.document\)/u.test(source)
        || !/input\.documentOwner\.isCurrentContext\(input\.document\)/u.test(source))
    {
        failures.push('document-owner');
    }
    return failures;
}

export function inspectArticleWritingAidRuntime(source)
{
    const failures = forbidden.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
    if (!/binding\.positionBinding\(\)/u.test(source)
        || !/documentOwner\.isCurrentContext\(position\.document\)/u.test(source)
        || !/documentOwner\.isCurrentContext\(document\)/u.test(source))
    {
        failures.push('runtime-document-owner');
    }
    if (!/binding\.anchors\.userIntent\.state/u.test(source)
        || !/return binding\.anchors\.resume\(reason, now\)/u.test(source))
    {
        failures.push('runtime-intent-owner');
    }
    return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const failures = [
        ...inspectArticleWritingAidPolicy(readFileSync(path.join(root, articleWritingAidPolicyPath), 'utf8')),
        ...inspectArticleWritingAidRuntime(readFileSync(path.join(root, articleWritingAidRuntimePath), 'utf8'))
    ];
    console.log(`[article-writing-aids-governance] scoped-source failures=${failures.length}`);
    for (const failure of failures)
    {
        console.error(`- ${failure}`);
    }
    process.exitCode = failures.length ? 1 : 0;
}
