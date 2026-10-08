import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../../src/frontend/package.json', import.meta.url));
const ts = require('typescript');
export function collectBinaryRouteFunctionNames(source)
{
    const names = [];
    const ast = ts.createSourceFile('routes.ts', source, ts.ScriptTarget.Latest, true);
    function visit(node)
    {
        if (ts.isFunctionDeclaration(node) && node.name && node.parameters[0]?.type?.getText(ast) === 'BinaryRouteRequest') names.push(node.name.text);
        ts.forEachChild(node, visit);
    }
    visit(ast);
    return names;
}

const retired = new Set(['binaryUrl', 'resourceUrl', 'privateScope', 'requestBinaryUrl', 'binary_legacy_request']);

/** Audit parsed imports, route objects and calls, including Vue script bodies. */
export function auditBinaryRouteCalls(source, filename, operations, { transportOwner = false, routeCallNames = new Set() } = {})
{
    if (filename.endsWith('.vue')) source = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)].map(match => match[1]).join('\n');
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const errors = [];
    const aliases = new Set(['requestBinaryOnly', 'requestBinaryJson']);
    const routeFunctions = new Set([...routeCallNames, ...collectBinaryRouteFunctionNames(source)]);
    const rawImports = new Set();
    const fetchAliases = new Set(['fetch']);
    const definitions = new Map();
    const parameters = new Map();
    const functions = new Map();
    const text = node => node.getText(ast);
    const fail = (node, message) => errors.push(`${filename}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${message}`);
    function collect(node)
    {
        if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
        if (ts.isImportSpecifier(node))
        {
            const name = node.propertyName?.text ?? node.name.text;
            if (aliases.has(name)) aliases.add(node.name.text);
            if (routeFunctions.has(name)) routeFunctions.add(node.name.text);
            if (name === 'binaryRequest') rawImports.add(node.name.text);
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        {
            definitions.set(node.name.text, node.initializer);
            if (ts.isIdentifier(node.initializer))
            {
                if (aliases.has(node.initializer.text)) aliases.add(node.name.text);
                if (rawImports.has(node.initializer.text)) rawImports.add(node.name.text);
                if (fetchAliases.has(node.initializer.text)) fetchAliases.add(node.name.text);
            }
            if (ts.isPropertyAccessExpression(node.initializer) && node.initializer.name.text === 'fetch') fetchAliases.add(node.name.text);
        }
        if (ts.isParameter(node) && ts.isIdentifier(node.name)) parameters.set(node.name.text, node.type ? text(node.type) : '');
        ts.forEachChild(node, collect);
    }
    collect(ast);
    function resolveNode(node, depth = 0)
    {
        if (!node || depth > 8) return node;
        if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) return resolveNode(node.expression, depth + 1);
        if (ts.isIdentifier(node) && definitions.has(node.text)) return resolveNode(definitions.get(node.text), depth + 1);
        return node;
    }
    const value = property => ts.isPropertyAssignment(property) ? property.initializer : property.name;
    function operation(node)
    {
        node = resolveNode(node);
        if (ts.isConditionalExpression(node)) { operation(node.whenTrue); operation(node.whenFalse); return; }
        if (ts.isStringLiteral(node) && operations.has(node.text)) return;
        if (ts.isIdentifier(node) && parameters.get(node.text) === 'FsusBinaryOperationId') return;
        fail(node, 'operationId must exist in generated descriptors');
    }
    function route(node)
    {
        node = resolveNode(node);
        if (ts.isConditionalExpression(node)) { route(node.whenTrue); route(node.whenFalse); return; }
        if (ts.isCallExpression(node) && functions.has(text(node.expression)))
        {
            const declaration = functions.get(text(node.expression));
            for (let index = 0; index < declaration.parameters.length; index += 1)
            {
                if (declaration.parameters[index].type?.getText(ast) === 'BinaryRouteRequest' && node.arguments[index]) route(node.arguments[index]);
            }
            function returns(child)
            {
                if (ts.isReturnStatement(child) && child.expression) route(child.expression);
                else if (!ts.isFunctionLike(child)) ts.forEachChild(child, returns);
            }
            returns(declaration.body);
            return;
        }
        if (ts.isIdentifier(node) && parameters.get(node.text) === 'BinaryRouteRequest') return;
        if (!ts.isObjectLiteralExpression(node)) { fail(node, 'binaryRoute must be a generated operation request'); return; }
        const id = node.properties.find(property => property.name && text(property.name) === 'operationId');
        if (id) operation(value(id)); else fail(node, 'operationId missing');
        for (const property of node.properties)
            if (ts.isSpreadAssignment(property) || (property.name && !['operationId', 'params', 'query'].includes(text(property.name)))) fail(property, 'non-contract route field');
    }
    function request(node)
    {
        node = resolveNode(node);
        if (node && ts.isIdentifier(node) && parameters.get(node.text) === 'BinaryTransportRequest') return;
        if (!node || !ts.isObjectLiteralExpression(node)) { fail(node ?? ast, 'requestBinaryOnly needs a typed request'); return; }
        const descriptor = node.properties.find(property => property.name && text(property.name) === 'binaryRoute');
        if (descriptor) route(value(descriptor)); else fail(node, 'binaryRoute missing');
        const options = node.properties.find(property => property.name && text(property.name) === 'requestOptions');
        const resolved = options && resolveNode(value(options));
        if (resolved && ts.isObjectLiteralExpression(resolved)) for (const property of resolved.properties)
            if (property.name && ['method', 'credentials', 'requiresPow'].includes(text(property.name))) fail(property, 'metadata belongs to generated descriptor');
    }
    function binaryPath(node)
    {
        node = resolveNode(node);
        if (!node) return false;
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.includes('/api/binary');
        if (ts.isTemplateExpression(node)) return node.head.text.includes('/api/binary') || node.templateSpans.some(span => span.literal.text.includes('/api/binary') || binaryPath(span.expression));
        if (ts.isBinaryExpression(node)) return binaryPath(node.left) || binaryPath(node.right);
        return false;
    }
    function visit(node)
    {
        if (!transportOwner && ts.isIdentifier(node) && retired.has(node.text)) fail(node, 'retired binary entry point');
        if (ts.isStringLiteral(node) && node.text === 'binary_legacy_request') fail(node, 'retired telemetry operation');
        if (ts.isCallExpression(node))
        {
            const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : text(node.expression);
            if (aliases.has(name)) request(node.arguments[0]);
            if (routeFunctions.has(name)) route(node.arguments[0]);
            if (!transportOwner && rawImports.has(name)) fail(node, 'raw binaryRequest bypasses transport owner');
            if (fetchAliases.has(name) && binaryPath(node.arguments[0])) fail(node, 'direct binary fetch bypasses generated routes');
            if (functions.has(name) && node.arguments.some(argument => binaryPath(argument)))
            {
                function hasFetch(child)
                {
                    if (ts.isCallExpression(child))
                    {
                        const called = ts.isPropertyAccessExpression(child.expression) ? child.expression.name.text : text(child.expression);
                        if (fetchAliases.has(called)) return true;
                    }
                    return ts.forEachChild(child, hasFetch) === true;
                }
                if (hasFetch(functions.get(name).body)) fail(node, 'binary URL wrapper bypasses generated routes');
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(ast);
    return errors;
}
