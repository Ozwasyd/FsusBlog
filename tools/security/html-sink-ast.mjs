import { createRequire } from 'node:module';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const frontendRequire = createRequire(resolve(repoRoot, 'src/frontend/package.json'));

let ts;
let compileTemplate;
let parseSfc;

function loadParsers()
{
    if (ts)
    {
        return;
    }
    ts = frontendRequire('typescript')
    ;({ compileTemplate, parse: parseSfc } = frontendRequire('@vue/compiler-sfc'));
}

const htmlWriteProperties = new Map([
    ['innerHTML', 'dom-innerHTML-write'],
    ['outerHTML', 'dom-outerHTML-write'],
    ['srcdoc', 'dom-srcdoc-write'],
    ['srcDoc', 'dom-srcdoc-write']
]);

const htmlMethodSinks = new Map([
    ['insertAdjacentHTML', 'dom-insertAdjacentHTML'],
    ['createContextualFragment', 'dom-createContextualFragment']
]);

const renderPropSinks = new Map([
    ['innerHTML', 'render-innerHTML-prop'],
    ['outerHTML', 'render-outerHTML-prop'],
    ['srcdoc', 'render-srcdoc-prop'],
    ['srcDoc', 'render-srcdoc-prop']
]);

const vueBoundSinks = new Map([
    ['innerHTML', 'vue-innerHTML'],
    ['innerhtml', 'vue-innerHTML'],
    ['outerHTML', 'vue-outerHTML'],
    ['outerhtml', 'vue-outerHTML'],
    ['srcdoc', 'vue-srcdoc'],
    ['srcDoc', 'vue-srcdoc']
]);

const sinkReplacements = new Map([
    ['vue-v-html', 'Vue text interpolation ({{ value }}) or FsusUI MarkdownRenderer'],
    ['vue-srcdoc', 'a structured Vue view; never iframe srcdoc'],
    ['vue-innerHTML', 'Vue text interpolation or FsusUI MarkdownRenderer'],
    ['vue-outerHTML', 'createElement and replaceChild, or FsusUI MarkdownRenderer'],
    ['dom-innerHTML-write', 'textContent, createElement, or FsusUI MarkdownRenderer'],
    ['dom-outerHTML-write', 'createElement and replaceChild'],
    ['dom-srcdoc-write', 'a structured Vue view; never iframe srcdoc'],
    ['dom-insertAdjacentHTML', 'createElement, append, or FsusUI MarkdownRenderer'],
    ['dom-createContextualFragment', 'createElement and textContent'],
    ['dom-document-write', 'createElement and textContent'],
    ['dom-setAttribute-srcdoc', 'a structured Vue view; never iframe srcdoc'],
    ['domparser-text-html', 'JSON, Markdown source, or FsusUI MarkdownRenderer'],
    ['render-innerHTML-prop', 'text children or FsusUI MarkdownRenderer'],
    ['render-outerHTML-prop', 'createElement and replaceChild'],
    ['render-srcdoc-prop', 'a structured Vue view; never iframe srcdoc'],
    ['jsx-innerHTML-prop', 'JSX text children or FsusUI MarkdownRenderer'],
    ['jsx-outerHTML-prop', 'createElement and replaceChild'],
    ['jsx-srcdoc-prop', 'a structured Vue view; never iframe srcdoc'],
    ['typescript-parse-error', 'valid TypeScript/JavaScript; parse failures fail closed'],
    ['vue-template-parse-error', 'a valid Vue template; parse failures fail closed'],
    ['vue-sfc-parse-error', 'a valid Vue SFC; parse failures fail closed']
]);

function foldedString(node)
{
    if (!node)
    {
        return null;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    {
        return node.text;
    }
    if (ts.isParenthesizedExpression(node))
    {
        return foldedString(node.expression);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    {
        const left = foldedString(node.left);
        const right = foldedString(node.right);
        return left === null || right === null ? null : `${left}${right}`;
    }
    return null;
}

function propertyName(node)
{
    if (ts.isPropertyAccessExpression(node))
    {
        return node.name.text;
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression)
    {
        return foldedString(node.argumentExpression);
    }
    return null;
}

function declaredPropertyName(node)
{
    if (!node)
    {
        return null;
    }
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    {
        return node.text;
    }
    if (ts.isComputedPropertyName(node))
    {
        return foldedString(node.expression);
    }
    return null;
}

function isDocumentExpression(node)
{
    if (ts.isIdentifier(node))
    {
        return node.text === 'document';
    }
    return propertyName(node) === 'document';
}

function methodSink(node)
{
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node))
    {
        return null;
    }

    const name = propertyName(node);
    if (name && htmlMethodSinks.has(name))
    {
        return htmlMethodSinks.get(name);
    }

    const receiver = node.expression;
    if ((name === 'write' || name === 'writeln') && isDocumentExpression(receiver))
    {
        return 'dom-document-write';
    }
    if (name === 'parseFromString')
    {
        return 'domparser-text-html';
    }
    return null;
}

function literalText(node)
{
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)))
    {
        return node.text;
    }
    return null;
}

function boundSink(initializer, aliases)
{
    if (!initializer)
    {
        return null;
    }
    if (ts.isIdentifier(initializer))
    {
        return aliases.get(initializer.text) ?? null;
    }

    const direct = methodSink(initializer);
    if (direct)
    {
        return direct;
    }

    if (ts.isCallExpression(initializer)
    && propertyName(initializer.expression) === 'bind'
    && (ts.isPropertyAccessExpression(initializer.expression) || ts.isElementAccessExpression(initializer.expression)))
    {
        return methodSink(initializer.expression.expression);
    }
    return null;
}

function collectAliases(sourceFile)
{
    const aliases = new Map();
    let changed = true;
    let pass = 0;

    while (changed && pass < 16)
    {
        changed = false;
        pass += 1;

        const visit = (node) =>
        {
            if (ts.isVariableDeclaration(node))
            {
                if (ts.isIdentifier(node.name))
                {
                    const sink = boundSink(node.initializer, aliases);
                    if (sink && aliases.get(node.name.text) !== sink)
                    {
                        aliases.set(node.name.text, sink);
                        changed = true;
                    }
                }
                else if (ts.isObjectBindingPattern(node.name) && node.initializer)
                {
                    const receiverIsDocument = isDocumentExpression(node.initializer);
                    for (const element of node.name.elements)
                    {
                        if (!ts.isIdentifier(element.name))
                        {
                            continue;
                        }
                        const name = declaredPropertyName(element.propertyName) ?? element.name.text;
                        let sink = htmlMethodSinks.get(name) ?? null;
                        if ((name === 'write' || name === 'writeln') && receiverIsDocument)
                        {
                            sink = 'dom-document-write';
                        }
                        if (name === 'parseFromString')
                        {
                            sink = 'domparser-text-html';
                        }
                        if (sink && aliases.get(element.name.text) !== sink)
                        {
                            aliases.set(element.name.text, sink);
                            changed = true;
                        }
                    }
                }
            }

            if (ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left))
            {
                const sink = boundSink(node.right, aliases);
                if (sink && aliases.get(node.left.text) !== sink)
                {
                    aliases.set(node.left.text, sink);
                    changed = true;
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }

    return aliases;
}

function lineAndColumn(source, offset)
{
    const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    let line = 1;
    for (let index = 0; index < lineStart; index += 1)
    {
        if (source.charCodeAt(index) === 10)
        {
            line += 1;
        }
    }
    return { line, column: offset - lineStart + 1 };
}

function analyzeScript(source, scriptSource, filePath, baseOffset, diagnostics)
{
    const extension = extname(filePath).toLowerCase();
    const scriptKind = extension === '.tsx' || extension === '.jsx'
        ? ts.ScriptKind.TSX
        : extension === '.js' || extension === '.mjs'
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(
        filePath,
        scriptSource,
        ts.ScriptTarget.Latest,
        true,
        scriptKind
    );

    const add = (sink, node) =>
    {
        const location = lineAndColumn(source, baseOffset + node.getStart(sourceFile));
        diagnostics.push({ filePath, sink, ...location });
    };

    for (const parseDiagnostic of sourceFile.parseDiagnostics)
    {
        const location = lineAndColumn(source, baseOffset + (parseDiagnostic.start ?? 0));
        diagnostics.push({ filePath, sink: 'typescript-parse-error', ...location });
    }

    const aliases = collectAliases(sourceFile);
    const visit = (node) =>
    {
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        {
            const name = propertyName(node.left);
            const sink = name ? htmlWriteProperties.get(name) : null;
            if (sink)
            {
                add(sink, node.left);
            }
        }

        if (ts.isCallExpression(node))
        {
            let sink = methodSink(node.expression);
            if (!sink && ts.isIdentifier(node.expression))
            {
                sink = aliases.get(node.expression.text) ?? null;
            }
            if (sink === 'domparser-text-html')
            {
                if (literalText(node.arguments[1])?.toLowerCase() === 'text/html')
                {
                    add(sink, node.expression);
                }
            }
            else if (sink)
            {
                add(sink, node.expression);
            }

            if (propertyName(node.expression) === 'setAttribute'
        && literalText(node.arguments[0])?.toLowerCase() === 'srcdoc')
            {
                add('dom-setAttribute-srcdoc', node.expression);
            }
        }

        if (ts.isPropertyAssignment(node))
        {
            const name = declaredPropertyName(node.name);
            const sink = name ? renderPropSinks.get(name) : null;
            if (sink)
            {
                add(sink, node.name);
            }
        }

        if (ts.isJsxAttribute(node))
        {
            const name = node.name.text;
            const sink = renderPropSinks.get(name);
            if (sink)
            {
                add(`jsx-${sink.slice('render-'.length)}`, node.name);
            }
        }

        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
}

function analyzeVueTemplate(source, template, filePath, diagnostics)
{
    const result = compileTemplate({
        source: template.content,
        filename: filePath,
        id: 'fsusblog-html-sink-governance'
    });

    for (const error of result.errors)
    {
        const offset = template.loc.start.offset + (error.loc?.start?.offset ?? 0);
        diagnostics.push({ filePath, sink: 'vue-template-parse-error', ...lineAndColumn(source, offset) });
    }

    const visit = (node) =>
    {
        if (node?.type === 1 && Array.isArray(node.props))
        {
            for (const prop of node.props)
            {
                const sink = vueTemplatePropSink(prop);
                if (sink)
                {
                    diagnostics.push({
                        filePath,
                        sink,
                        ...lineAndColumn(source, template.loc.start.offset + prop.loc.start.offset)
                    });
                }
            }
        }

        for (const child of node?.children ?? [])
        {
            visit(child);
        }
        for (const branch of node?.branches ?? [])
        {
            visit(branch);
        }
    };
    visit(result.ast);
}

function vueTemplatePropSink(prop)
{
    if (prop.type === 7 && prop.name === 'html')
    {
        return 'vue-v-html';
    }
    const staticName = prop.type === 6 ? prop.name : null;
    const boundName = prop.type === 7
        && prop.name === 'bind'
        && prop.arg?.type === 4
        && prop.arg.isStatic
        ? prop.arg.content
        : null;
    const name = staticName ?? boundName;
    return name ? vueBoundSinks.get(name) ?? vueBoundSinks.get(name.toLowerCase()) ?? null : null;
}

export function formatHtmlSinkDiagnostic(diagnostic)
{
    const replacement = diagnostic.replacement
        ?? sinkReplacements.get(diagnostic.sink)
        ?? 'Vue text interpolation, textContent, createElement, or FsusUI MarkdownRenderer';
    return `${diagnostic.filePath}:${diagnostic.line}:${diagnostic.column}: forbidden HTML sink ${diagnostic.sink}; replace with ${replacement}`;
}

export function analyzeHtmlSinks(source, { filePath = 'input.ts' } = {})
{
    loadParsers();
    const diagnostics = [];
    if (!filePath.toLowerCase().endsWith('.vue'))
    {
        analyzeScript(source, source, filePath, 0, diagnostics);
        return diagnostics;
    }

    const parsed = parseSfc(source, { filename: filePath });
    for (const error of parsed.errors)
    {
        const offset = error.loc?.start?.offset ?? 0;
        diagnostics.push({ filePath, sink: 'vue-sfc-parse-error', ...lineAndColumn(source, offset) });
    }

    const { descriptor } = parsed;
    if (descriptor.template)
    {
        analyzeVueTemplate(source, descriptor.template, filePath, diagnostics);
    }
    for (const block of [descriptor.script, descriptor.scriptSetup])
    {
        if (!block || block.src)
        {
            continue;
        }
        const extension = block.lang === 'tsx' || block.lang === 'jsx'
            ? `.${block.lang}`
            : block.lang === 'js'
        ? '.js'
        : '.ts';
        analyzeScript(source, block.content, `${filePath}${extension}`, block.loc.start.offset, diagnostics);
    }
    return diagnostics;
}
