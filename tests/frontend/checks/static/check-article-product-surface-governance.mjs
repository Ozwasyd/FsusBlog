import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { default: ts } = await import(pathToFileURL(path.join(root, 'src/frontend/node_modules/typescript/lib/typescript.js')).href);
export const articleProductSurfacePaths = [
    'src/frontend/src/services/authoring/articleEditorSurface.ts',
    'src/frontend/src/services/authoring/articleLiveCapability.ts',
    'src/frontend/src/services/authoring/articleSourceCompare.ts',
    'src/frontend/src/components/admin/article/ArticleWriteEditor.vue'
];

/** Bounded source gate only. Runtime, storage inventory, whole-tree retirement and UX remain independent gates. */
export function scanArticleProductSurfaceSources(sources)
{
    const findings = [];
    const add = (file, code) => findings.push({ file, code });
    for (const file of articleProductSurfacePaths)
    {
        const source = sources.get(file);
        if (typeof source !== 'string')
        {
            add(file, 'required-product-source-missing');
            continue;
        }
        const script = file.endsWith('.vue') ? source.match(/<script[^>]*>([\s\S]*?)<\/script>/u)?.[1] ?? '' : source;
        const tree = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        let surfaceDefault = false;
        let exactSurfaces = false;
        let writerPreference = false;
        const walk = node =>
        {
            if (ts.isStringLiteralLike(node) && ['write', 'preview', 'split'].includes(node.text))
            {
                add(file, 'legacy-product-surface');
            }
            if (ts.isIdentifier(node) && node.text === 'MarkdownEditorMode')
            {
                add(file, 'generic-editor-mode-leaks-to-product');
            }
            if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'defaultArticleEditorSurface')
            {
                surfaceDefault = ts.isStringLiteralLike(node.initializer) && node.initializer.text === 'live';
            }
            if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'articleEditorSurfaces')
            {
                const initializer = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
                exactSurfaces = ts.isArrayLiteralExpression(initializer) && initializer.elements.length === 2
                    && initializer.elements.every((item, index) => ts.isStringLiteralLike(item) && item.text === ['live', 'source'][index]);
            }
            if (ts.isCallExpression(node))
            {
                const callee = node.expression.getText(tree);
                if (callee === 'createArticleEditorSurfacePreference')
                {
                    writerPreference = true;
                }
                if (/(?:querySelector|querySelectorAll|closest|renderMarkdown|createMarkdownEditorProjection|createArticleDocumentContextAdapter|createArticleDocumentContextAuthority)/u.test(callee))
                {
                    add(file, 'second-owner-or-private-detection');
                }
                if (/(?:localStorage|sessionStorage)\.(?:setItem|getItem)/u.test(callee))
                {
                    add(file, 'product-state-bypasses-preference-owner');
                }
                if (/\.(?:message|stack)\.(?:includes|match|startsWith|endsWith)$/u.test(callee))
                {
                    add(file, 'error-text-capability-detection');
                }
            }
            if (ts.isImportDeclaration(node) && node.moduleSpecifier.text.includes('articleEditorSurfaceMigration'))
            {
                add(file, 'migration-in-normal-product-reader');
            }
            ts.forEachChild(node, walk);
        };
        walk(tree);
        if (file.endsWith('/articleEditorSurface.ts') && !surfaceDefault)
        {
            add(file, 'default-live-missing');
        }
        if (file.endsWith('/articleEditorSurface.ts') && !exactSurfaces)
        {
            add(file, 'product-surfaces-not-exact');
        }
        if (file.endsWith('/ArticleWriteEditor.vue') && !writerPreference)
        {
            add(file, 'writer-preference-integration-missing');
        }
    }
    return findings;
}

export function checkArticleProductSurface(repositoryRoot = root)
{
    const sources = new Map(articleProductSurfacePaths.map(file =>
    {
        try
        {
            return [file, readFileSync(path.join(repositoryRoot, file), 'utf8')];
        }
        catch
        {
            return [file, null];
        }
    }));
    return scanArticleProductSurfaceSources(sources);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const findings = checkArticleProductSurface();
    if (findings.length > 0)
    {
        console.error(JSON.stringify({ qualification: false, findings }, null, 4));
        process.exitCode = 1;
    }
    else
    {
        console.log('[article-product-surface] bounded source gate passed; qualification=false');
    }
}
