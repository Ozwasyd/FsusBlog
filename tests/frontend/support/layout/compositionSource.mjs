import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, dirname, extname } from 'node:path';

import { createControlSourceResolver, controlDigest } from '@fsusblog/control-legality/source';

export const compositionNodeAttribute = 'data-fsus-composition-node';
export const compositionCallAttribute = 'data-fsus-composition-call';
export const compositionSourceVersion = 'fsusblog.composition-source.v1';

function fail(message)
{
    throw new Error(`[composition-source] ${message}`);
}

/** Source identities come from the canonical control resolver, including actual Vite registrations. */
export function createCompositionSource({ repositoryRoot, fsusUIRoot, parserRoot = repositoryRoot })
{
    const resolver = createControlSourceResolver({ repositoryRoot, fsusUIRoot, parserRoot, mode: 'local' });
    const { ts, dom } = resolver;
    const root = realpathSync(repositoryRoot);
    const upstream = realpathSync(fsusUIRoot);
    const records = new Map();
    const nodes = new Map();
    const errors = [];
    const location = (file, offset) => ({ file, offset,
        line: readFileSync(file, 'utf8').slice(0, offset).split('\n').length });
    const key = (file) => file.startsWith(upstream + '/') ? `FsusUI/${relative(upstream, file)}` : `FsusBlog/${relative(root, file)}`;
    const exact = (base) =>
    {
        const found = [base, ...['.ts', '.tsx', '.mjs', '.vue', '/index.ts'].map((suffix) => base + suffix)]
            .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
        if (!found)
        {
            fail(`unresolved module ${base}`);
        }
        return realpathSync(found);
    };
    function importFile(file, specifier)
    {
        if (specifier.startsWith('.'))
        {
            return exact(resolve(dirname(file), specifier));
        }
        if (specifier.startsWith('@/') && file.startsWith(root + '/'))
        {
            return exact(resolve(root, 'src/frontend/src', specifier.slice(2)));
        }
        if (specifier.startsWith('@element-plus/') && file.startsWith(upstream + '/'))
        {
            return exact(resolve(upstream, 'vue/packages', specifier.slice('@element-plus/'.length)));
        }
        fail(`unresolved/private import ${specifier} in ${file}`);
    }
    // Follow the actual public export factory, rather than guessing a component directory from its name.
    function componentFile(source, seen = new Set())
    {
        if (source.kind === 'local')
        {
            return source.file.endsWith('.vue') ? source.file : exportComponent(source.file, source.name, seen);
        }
        if (source.kind === 'fsusui-public')
        {
            return exportComponent(source.definition, source.exportName, seen);
        }
        return null;
    }
    function exportComponent(file, name, seen)
    {
        const identity = `${file}#${name}`;
        if (seen.has(identity))
        {
            fail(`cyclic component factory ${identity}`);
        }
        if (file.endsWith('.vue'))
        {
            resolver.parse(file);
            return file;
        }
        seen.add(identity);
        const record = resolver.parse(file);
        function follow(expression)
        {
            if (ts.isIdentifier(expression))
            {
                const imported = record.imports.get(expression.text);
                if (imported)
                {
                    return exportComponent(importFile(file, imported.specifier), imported.name, seen);
                }
                const value = record.variables.get(expression.text);
                if (value)
                {
                    return follow(value);
                }
            }
            if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression))
            {
                const factory = record.variables.get(expression.expression.text);
                const aliases = factory && ts.isCallExpression(factory) ? factory.arguments[1] : null;
                const property = aliases && ts.isObjectLiteralExpression(aliases)
                    ? aliases.properties.find((item) => item.name?.getText() === expression.name.text) : null;
                if (property && ts.isPropertyAssignment(property))
                {
                    return follow(property.initializer);
                }
                if (property && ts.isShorthandPropertyAssignment(property))
                {
                    return follow(property.name);
                }
                fail(`unknown component alias ${identity}`);
            }
            if (ts.isObjectLiteralExpression(expression))
            {
                const spreads = expression.properties.filter(ts.isSpreadAssignment);
                if (spreads.length === 1)
                {
                    return follow(spreads[0].expression);
                }
                fail(`ambiguous component spread ${identity}`);
            }
            if (ts.isCallExpression(expression) && expression.arguments.length)
            {
                // A factory can only establish a source edge through its component argument.
                return follow(expression.arguments[0]);
            }
            if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isSatisfiesExpression(expression))
            {
                return follow(expression.expression);
            }
            fail(`unknown component factory ${identity}`);
        }
        const expression = record.variables.get(name);
        if (!expression)
        {
            const imported = record.imports.get(name);
            if (imported)
            {
                return exportComponent(importFile(file, imported.specifier), imported.name, seen);
            }
            fail(`unknown component export ${identity}`);
        }
        return follow(expression);
    }
    function expression(source, file)
    {
        const ast = ts.createSourceFile(file + '.expression.ts', `(${source});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        if (ast.parseDiagnostics.length || ast.statements.length !== 1 || !ts.isExpressionStatement(ast.statements[0]))
        {
            fail(`unknown expression ${file}: ${source}`);
        }
        return ast.statements[0].expression.expression;
    }
    function routeBranch(record)
    {
        const routeNames = new Set();
        const routeFactories = new Set([...record.imports].filter(([, entry]) => entry.specifier === 'vue-router' && entry.name === 'useRoute').map(([name]) => name));
        for (const [name, value] of record.variables)
        {
            if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && routeFactories.has(value.expression.text))
            {
                routeNames.add(name);
            }
        }
        const visit = (node, offset) =>
        {
            if ((ts.isPropertyAccessExpression(node) && node.name.text === 'name' && ts.isIdentifier(node.expression) && routeNames.has(node.expression.text))
                || (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && routeNames.has(node.expression.text)
                    && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'name'))
            {
                errors.push({ ...location(record.file, offset + node.getStart()), reason: 'route-name-visual-branch' });
            }
            ts.forEachChild(node, (child) => visit(child, offset));
        };
        for (const script of record.scripts)
        {
            visit(script.ast, script.offset);
        }
        return { routeNames, visit };
    }
    function nativePropTargets(record, identifier)
    {
        function literal(node, file, seen = new Set())
        {
            if (!node)
            {
                return null;
            }
            if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node))
            {
                return literal(node.expression, file, seen);
            }
            if (ts.isStringLiteral(node))
            {
                return node.text;
            }
            if (ts.isArrayLiteralExpression(node))
            {
                return node.elements.map((item) => literal(item, file, seen));
            }
            if (ts.isIdentifier(node))
            {
                const identity = `${file}#${node.text}`;
                if (seen.has(identity))
                {
                    return null;
                }
                seen.add(identity);
                const current = resolver.parse(file);
                const imported = current.imports.get(node.text);
                if (imported)
                {
                    return literal(resolver.parse(importFile(file, imported.specifier)).variables.get(imported.name), importFile(file, imported.specifier), seen);
                }
                return literal(current.variables.get(node.text), file, seen);
            }
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
            {
                const imported = resolver.parse(file).imports.get(node.expression.text);
                if (imported?.name === 'buildProps' && imported.specifier === '@element-plus/utils')
                {
                    return literal(node.arguments[0], file, seen);
                }
            }
            if (ts.isObjectLiteralExpression(node))
            {
                return Object.fromEntries(node.properties.filter(ts.isPropertyAssignment).map((property) => [property.name.getText().replaceAll("'", '').replaceAll('"', ''), literal(property.initializer, file, new Set(seen))]));
            }
            return null;
        }
        for (const value of record.variables.values())
        {
            if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'defineProps')
            {
                const props = literal(value.arguments[0], record.file);
                const prop = props?.[identifier];
                if (Array.isArray(prop?.values) && prop.values.length && prop.values.every((tag) => typeof tag === 'string' && dom.parserOptions.isNativeTag(tag))
                    && prop.values.includes(prop.default))
                {
                    return { kind: 'native-variants', values: prop.values, default: prop.default };
                }
            }
        }
        return null;
    }
    function parse(file)
    {
        file = realpathSync(file);
        if (records.has(file))
        {
            return records.get(file);
        }
        const record = resolver.parse(file);
        const value = { file, digest: controlDigest(record.content), nodes: [], imports: [...record.imports], template: Boolean(record.template) };
        records.set(file, value);
        const branches = routeBranch(record);
        if (!record.template)
        {
            errors.push({ file, reason: 'unknown-render-source' });
            return value;
        }
        function visit(node, parentId = null, ancestors = [])
        {
            if (node.type !== dom.NodeTypes.ELEMENT)
            {
                for (const child of node.children ?? [])
                {
                    visit(child, parentId, ancestors);
                }
                return;
            }
            const offset = record.template.offset + node.loc.start.offset;
            const id = controlDigest({ file: key(file), offset, source: node.loc.source }).slice(0, 24);
            const attributes = {};
            const directives = [];
            for (const prop of node.props)
            {
                if (prop.type === dom.NodeTypes.ATTRIBUTE)
                {
                    if ([compositionNodeAttribute, compositionCallAttribute].includes(prop.name))
                    {
                        fail(`reserved source marker in ${file}:${offset}`);
                    }
                    attributes[prop.name] = prop.value?.content ?? '';
                }
                else if (prop.type === dom.NodeTypes.DIRECTIVE)
                {
                    directives.push({ name: prop.name, argument: prop.arg?.content ?? null, expression: prop.exp?.content ?? null });
                    if (prop.exp?.content.trim() && prop.name !== 'for' && prop.name !== 'slot')
                    {
                        const exp = expression(prop.exp.content, file);
                        branches.visit(exp, offset);
                    }
                }
            }
            let origin;
            let definition = null;
            try
            {
                if (node.tag === 'template' || node.tag === 'slot')
                {
                    origin = { kind: 'framework-structure', package: 'vue', publicName: node.tag };
                }
                else if (node.tag === 'component')
                {
                    const dynamic = directives.find((directive) => directive.name === 'bind' && directive.argument === 'is');
                    if (!dynamic?.expression)
                    {
                        fail(`unknown dynamic component ${file}:${offset}`);
                    }
                    const exp = expression(dynamic.expression, file);
                    origin = ts.isIdentifier(exp) ? nativePropTargets(record, exp.text) : null;
                    if (!origin)
                    {
                        const targets = resolver.resolveExpression(file, exp);
                        if (targets.length !== 1)
                        {
                            fail(`ambiguous dynamic component ${file}:${offset}`);
                        }
                        origin = targets[0];
                    }
                }
                else if (file.startsWith(upstream + '/') && record.imports.has(node.tag))
                {
                    const imported = record.imports.get(node.tag);
                    origin = { kind: 'upstream-internal', file: importFile(file, imported.specifier), name: imported.name };
                    definition = origin.file.endsWith('.vue') ? origin.file : exportComponent(origin.file, origin.name, new Set());
                }
                else
                {
                    origin = resolver.resolveTag(file, node.tag);
                }
                definition ??= componentFile(origin);
            }
            catch (error)
            {
                origin = { kind: 'unknown', message: error.message };
                errors.push({ ...location(file, offset), reason: 'unknown-component-source', message: error.message });
            }
            const current = { id, ...location(file, offset), tag: node.tag, parentId, attributes, directives, origin, definition,
                sourceDigest: controlDigest(node.loc.source), ancestors,
                structural: origin.kind === 'framework-structure',
                conditional: directives.filter(({ name }) => ['if', 'else-if', 'else', 'show', 'for'].includes(name)),
                slot: directives.find(({ name }) => name === 'slot') ?? (node.tag === 'slot' ? { name: attributes.name ?? 'default' } : null),
                teleport: origin.publicName === 'Teleport' };
            nodes.set(id, current);
            value.nodes.push(id);
            for (const child of node.children ?? [])
            {
                visit(child, id, [...ancestors, id]);
            }
            if (definition && !records.has(definition))
            {
                parse(definition);
            }
        }
        visit(record.template.ast);
        return value;
    }
    function graph(entryFiles)
    {
        for (const file of entryFiles)
        {
            try
            {
                parse(file);
            }
            catch (error)
            {
                errors.push({ file, reason: 'unknown-ast-parse', message: error.message });
            }
        }
        const bindings = resolver.sourceBindings();
        errors.push(...bindings.errors);
        const reachable = new Set();
        function visit(file)
        {
            if (reachable.has(file))
            {
                return;
            }
            reachable.add(file);
            for (const id of records.get(file)?.nodes ?? [])
            {
                const definition = nodes.get(id).definition;
                if (definition)
                {
                    visit(definition);
                }
            }
        }
        entryFiles.forEach(visit);
        const files = [...records.values()].filter((record) => reachable.has(record.file));
        const graphNodes = [...nodes.values()].filter((node) => reachable.has(node.file));
        return { schema: compositionSourceVersion, entries: entryFiles, sourceIdentity: resolver.identity, upstreamRoot: upstream,
            files, nodes: graphNodes, errors: errors.filter((error) => !error.file || reachable.has(error.file)), sourceDigest: controlDigest(files.map(({ file, digest }) => ({ file, digest }))) };
    }
    function instrument(file, code)
    {
        file = realpathSync(file);
        const record = parse(file);
        if (controlDigest(code) !== record.digest)
        {
            fail(`source changed before instrumentation ${file}`);
        }
        const edits = record.nodes.map((id) => nodes.get(id)).filter((node) => !node.structural)
            .map((node) => ({ offset: node.offset + 1 + node.tag.length,
                content: ` ${['native', 'native-variants'].includes(node.origin.kind) ? compositionNodeAttribute : compositionCallAttribute}="${node.id}"` }))
            .sort((a, b) => b.offset - a.offset);
        for (const edit of edits)
        {
            code = code.slice(0, edit.offset) + edit.content + code.slice(edit.offset);
        }
        return code;
    }
    return { resolver, parse, graph, instrument, importFile, componentFile, expression, nodes, records, errors };
}

/** Test-only transform. It never writes product source or replaces the actual compiler. */
export function compositionProbePlugin(source)
{
    return { name: 'fsusblog-composition-source-probe', enforce: 'pre',
        transform(code, id)
        {
            if (extname(id) !== '.vue' || id.includes('?'))
            {
                return null;
            }
            return { code: source.instrument(id, code), map: null };
        } };
}
