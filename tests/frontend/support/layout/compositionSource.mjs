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
    const scriptRenders = new Map();
    const unwrap = (node) =>
    {
        while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)))
        {
            node = node.expression;
        }
        return node;
    };
    function unchangedBinding(record, name, declaration)
    {
        let invalid = false;
        function rootName(node)
        {
            node = unwrap(node);
            while (node && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)))
            {
                node = unwrap(node.expression);
            }
            return node && ts.isIdentifier(node) ? node.text : null;
        }
        function visit(node)
        {
            if (ts.isIdentifier(node) && node.text === name && node !== declaration
                && ((ts.isVariableDeclaration(node.parent) || ts.isParameter(node.parent) || ts.isBindingElement(node.parent))
                    && node.parent.name === node))
            {
                invalid = true;
            }
            if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && rootName(node.left) === name)
            {
                invalid = true;
            }
            if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
                && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && rootName(node.operand) === name)
            {
                invalid = true;
            }
            if (ts.isDeleteExpression(node) && rootName(node.expression) === name)
            {
                invalid = true;
            }
            ts.forEachChild(node, visit);
        }
        record.scripts.forEach(({ ast }) => visit(ast));
        if (invalid)
        {
            fail(`mutated/shadowed render binding ${record.file}#${name}`);
        }
    }
    function vueBinding(record, node, exportedName)
    {
        if (!node || !ts.isIdentifier(node))
        {
            return false;
        }
        const imported = record.imports.get(node.text);
        if (imported?.specifier !== 'vue' || imported.name !== exportedName)
        {
            return false;
        }
        const bindings = record.scripts.flatMap(({ ast }) => ast.statements.filter(ts.isImportDeclaration)
            .flatMap((statement) => statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
                ? statement.importClause.namedBindings.elements.filter((entry) => !entry.isTypeOnly && entry.name.text === node.text) : []));
        if (bindings.length !== 1)
        {
            fail(`ambiguous Vue render import ${record.file}#${node.text}`);
        }
        unchangedBinding(record, node.text, bindings[0].name);
        return true;
    }
    function bindScriptRender(record, call)
    {
        const options = call.arguments.length === 1 ? unwrap(call.arguments[0]) : null;
        if (!options || !ts.isObjectLiteralExpression(options) || options.properties.some((property) => !property.name
            || ts.isComputedPropertyName(property.name) || (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property))))
        {
            fail(`unknown script component options ${record.file}`);
        }
        const fields = options.properties.map((property) => property.name.text);
        if (new Set(fields).size !== fields.length || fields.includes('render'))
        {
            fail(`ambiguous script component render ${record.file}`);
        }
        const setupField = options.properties.find((property) => property.name.text === 'setup');
        const setup = setupField && ts.isPropertyAssignment(setupField) ? unwrap(setupField.initializer) : setupField;
        if (!setup || !(ts.isMethodDeclaration(setup) || ts.isArrowFunction(setup) || ts.isFunctionExpression(setup))
            || !ts.isBlock(setup.body) || setup.modifiers?.length)
        {
            fail(`unknown script component setup ${record.file}`);
        }
        const returns = setup.body.statements.filter(ts.isReturnStatement);
        const render = returns.length === 1 && returns[0] === setup.body.statements.at(-1) ? unwrap(returns[0].expression) : null;
        if (!render || !ts.isArrowFunction(render) || render.parameters.length || render.modifiers?.length)
        {
            fail(`unknown script component render function ${record.file}`);
        }
        // A setup branch can replace the render function even when its final
        // statement is known. Nested callbacks do not return from setup.
        function setupFlow(node)
        {
            if (ts.isFunctionLike(node))
            {
                return;
            }
            if (ts.isReturnStatement(node) && node !== returns[0])
            {
                fail(`conditional script setup return ${record.file}`);
            }
            ts.forEachChild(node, setupFlow);
        }
        setup.body.statements.forEach(setupFlow);
        const previous = scriptRenders.get(record.file);
        if (previous && previous.call !== call)
        {
            fail(`multiple script component definitions ${record.file}`);
        }
        scriptRenders.set(record.file, { call, setup, render });
        return record.file;
    }
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
            return resolver.modulePath(specifier, file, true);
        }
        fail(`unresolved/private import ${specifier} in ${file}`);
    }
    // Follow the actual public export factory, rather than guessing a component directory from its name.
    function componentFile(source, seen = new Set())
    {
        let target = null;
        if (source.kind === 'component-variants')
        {
            source.variantDefinitions = [...new Set(source.variants.map((variant) => componentFile(variant, new Set(seen))))];
            if (source.variantDefinitions.some((definition) => !definition))
            {
                fail('unknown finite component variant render source');
            }
            return null;
        }
        if (source.kind === 'local' || source.kind === 'upstream-internal')
        {
            target = source.file.endsWith('.vue') ? source.file : exportComponent(source.file, source.name, seen);
        }
        if (source.kind === 'fsusui-public')
        {
            target = exportComponent(source.definition, source.exportName, seen);
        }
        if (target?.kind === 'factory-slot-source')
        {
            source.factoryComponent = target;
            return null;
        }
        return target;
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
        const exported = resolver.exportsOf(file).get(name);
        if (exported?.ambiguous || exported?.unresolved)
        {
            fail(`ambiguous/unresolved component export ${identity}`);
        }
        if (exported && (exported.file !== file || exported.name !== name))
        {
            return exportComponent(exported.file, exported.name, seen);
        }
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
                    const declarations = record.scripts.flatMap(({ ast }) => ast.statements.filter(ts.isVariableStatement)
                        .flatMap((statement) => statement.declarationList.declarations.filter((declaration) =>
                            ts.isIdentifier(declaration.name) && declaration.name.text === expression.text)));
                    if (declarations.length !== 1 || !(declarations[0].parent.flags & ts.NodeFlags.Const)
                        || declarations[0].initializer !== value)
                    {
                        fail(`unknown script component binding ${identity}`);
                    }
                    unchangedBinding(record, expression.text, declarations[0].name);
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
                if (vueBinding(record, expression.expression, 'defineComponent'))
                {
                    return bindScriptRender(record, expression);
                }
                // A factory can only establish a source edge through its component argument.
                return follow(expression.arguments[0]);
            }
            if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isSatisfiesExpression(expression))
            {
                return follow(expression.expression);
            }
            fail(`unknown component factory ${identity}`);
        }
        const defaults = name === 'default' ? record.scripts.flatMap(({ ast }) => ast.statements
            .filter((statement) => ts.isExportAssignment(statement) && !statement.isExportEquals)) : [];
        const expression = defaults.length === 1 ? defaults[0].expression : record.variables.get(name);
        if (expression && !defaults.length)
        {
            const declarations = record.scripts.flatMap(({ ast }) => ast.statements.filter(ts.isVariableStatement)
                .flatMap((statement) => statement.declarationList.declarations.filter((declaration) =>
                    ts.isIdentifier(declaration.name) && declaration.name.text === name)));
            if (declarations.length !== 1 || !(declarations[0].parent.flags & ts.NodeFlags.Const)
                || declarations[0].initializer !== expression)
            {
                fail(`unknown script component binding ${identity}`);
            }
            unchangedBinding(record, name, declarations[0].name);
        }
        if (!expression)
        {
            const factory = resolver.resolveFactoryComponent(file, name);
            if (factory)
            {
                return factory;
            }
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
        const tainted = new Set();
        function usesRouteName(node)
        {
            if ((ts.isPropertyAccessExpression(node) && node.name.text === 'name' && ts.isIdentifier(node.expression) && routeNames.has(node.expression.text))
                || (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && routeNames.has(node.expression.text)
                    && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'name')
                || (ts.isIdentifier(node) && tainted.has(node.text)))
            {
                return true;
            }
            let found = false;
            ts.forEachChild(node, (child) =>
            {
                found ||= usesRouteName(child);
            });
            return found;
        }
        function bindings(node)
        {
            if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)
                && node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)
                && routeFactories.has(node.initializer.expression.text))
            {
                for (const element of node.name.elements)
                {
                    if ((element.propertyName ?? element.name).getText() === 'name' && ts.isIdentifier(element.name))
                    {
                        tainted.add(element.name.text);
                    }
                }
            }
            ts.forEachChild(node, bindings);
        }
        record.scripts.forEach(({ ast }) => bindings(ast));
        let changed = true;
        while (changed)
        {
            changed = false;
            for (const [name, value] of record.variables)
            {
                if (!tainted.has(name) && usesRouteName(value))
                {
                    tainted.add(name);
                    changed = true;
                }
            }
        }
        return { usesRouteName };
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
                if (node.properties.some((property) => !ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)))
                {
                    return null;
                }
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
        const declaration = propDeclaration(record, identifier);
        const macroDefault = closedLiteral(declaration?.defaultNode);
        if (typeof macroDefault === 'string' && dom.parserOptions.isNativeTag(macroDefault))
        {
            return { kind: 'native-prop', property: identifier, default: macroDefault };
        }
        let config = declaration?.node;
        while (config && (ts.isAsExpression(config) || ts.isParenthesizedExpression(config) || ts.isSatisfiesExpression(config)))
        {
            config = config.expression;
        }
        if (config && ts.isObjectLiteralExpression(config) && config.properties.every(ts.isPropertyAssignment)
            && !config.properties.some((property) => ts.isComputedPropertyName(property.name) || property.name.getText() === 'values'))
        {
            const defaultValue = config.properties.findLast((property) => property.name.getText() === 'default');
            const value = defaultValue && closedLiteral(defaultValue.initializer);
            if (typeof value === 'string' && dom.parserOptions.isNativeTag(value))
            {
                return { kind: 'native-prop', property: identifier, default: value };
            }
        }
        return null;
    }
    // Resolve only structural conditions determined by this exact public call's
    // literal props/slots. Product state, mutable locals and arbitrary functions
    // remain unbound; this is not a substitute for a qualified state producer.
    const unbound = Symbol('unbound-structural-input');
    function propDeclaration(record, name)
    {
        function find(node, file, seen = new Set())
        {
            if (!node)
            {
                return null;
            }
            if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node))
            {
                return find(node.expression, file, seen);
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
                return imported ? find(resolver.parse(importFile(file, imported.specifier)).variables.get(imported.name), importFile(file, imported.specifier), seen)
                    : find(current.variables.get(node.text), file, seen);
            }
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
            {
                const imported = resolver.parse(file).imports.get(node.expression.text);
                return imported?.name === 'buildProps' && imported.specifier === '@element-plus/utils' ? find(node.arguments[0], file, seen) : null;
            }
            if (ts.isObjectLiteralExpression(node))
            {
                // An explicit field after a spread overrides that spread. An
                // unknown later field/spread may override the requested prop.
                for (const property of [...node.properties].reverse())
                {
                    if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name))
                    {
                        return null;
                    }
                    if (property.name.getText().replaceAll("'", '').replaceAll('"', '') === name)
                    {
                        return { node: property.initializer, file };
                    }
                }
                return null;
            }
            return null;
        }
        for (const value of record.variables.values())
        {
            if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'withDefaults'
                && !record.imports.has('withDefaults') && !record.variables.has('withDefaults')
                && !record.imports.has('defineProps') && !record.variables.has('defineProps'))
            {
                const props = value.arguments[0];
                const defaults = value.arguments[1];
                if (!props || !ts.isCallExpression(props) || !ts.isIdentifier(props.expression) || props.expression.text !== 'defineProps'
                    || props.arguments.length || props.typeArguments?.length !== 1 || !ts.isTypeLiteralNode(props.typeArguments[0])
                    || !defaults || !ts.isObjectLiteralExpression(defaults)
                    || defaults.properties.some((property) => !ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)))
                {
                    return null;
                }
                const member = props.typeArguments[0].members.find((member) => ts.isPropertySignature(member)
                    && !ts.isComputedPropertyName(member.name) && member.name.getText().replaceAll("'", '').replaceAll('"', '') === name);
                if (!member?.type)
                {
                    return null;
                }
                const defaultValue = defaults.properties.findLast((property) => property.name.getText().replaceAll("'", '').replaceAll('"', '') === name);
                return { node: member.type, defaultNode: defaultValue?.initializer, file: record.file };
            }
            if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'defineProps')
            {
                return find(value.arguments[0], record.file);
            }
        }
        return null;
    }
    function closedLiteral(node)
    {
        if (!node)
        {
            return unbound;
        }
        if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
        {
            return closedLiteral(node.expression);
        }
        if (ts.isStringLiteral(node) || ts.isNumericLiteral(node))
        {
            return ts.isStringLiteral(node) ? node.text : Number(node.text);
        }
        if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
        {
            return node.kind === ts.SyntaxKind.TrueKeyword;
        }
        if (node.kind === ts.SyntaxKind.NullKeyword)
        {
            return null;
        }
        return unbound;
    }
    function staticPropValue(record, call, name)
    {
        const declaration = propDeclaration(record, name);
        if (!declaration || call.directives.some((directive) => directive.name === 'bind' && directive.argumentStatic === false))
        {
            return unbound;
        }
        const spreadValues = [];
        for (const directive of call.directives.filter((directive) => directive.name === 'bind' && !directive.argument))
        {
            const spread = directive.expression && expression(directive.expression, call.file);
            if (!spread || !ts.isObjectLiteralExpression(spread)
                || spread.properties.some((property) => !ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)
                    || property.name.text === '__proto__'
                    || closedLiteral(property.initializer) === unbound))
            {
                return unbound;
            }
            const property = spread.properties.findLast((property) => property.name.text === name);
            if (property)
            {
                spreadValues.push(closedLiteral(property.initializer));
            }
        }
        const binding = call.directives.find((directive) => directive.name === 'bind' && directive.argument === name);
        // Separate attribute/directive inventories do not establish their
        // interleaved precedence. Refuse collisions instead of guessing it.
        if (spreadValues.length > 1 || (spreadValues.length && (binding || Object.hasOwn(call.attributes, name))))
        {
            return unbound;
        }
        if (spreadValues.length)
        {
            return spreadValues[0];
        }
        if (binding)
        {
            return binding.expression ? closedLiteral(expression(binding.expression, call.file)) : unbound;
        }
        if (Object.hasOwn(call.attributes, name))
        {
            return call.attributes[name];
        }
        if (declaration.defaultNode)
        {
            return closedLiteral(declaration.defaultNode);
        }
        let config = declaration.node;
        while (ts.isAsExpression(config) || ts.isParenthesizedExpression(config) || ts.isSatisfiesExpression(config))
        {
            config = config.expression;
        }
        if (!ts.isObjectLiteralExpression(config) || config.properties.some((property) => !ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)))
        {
            return unbound;
        }
        const defaultValue = config.properties.findLast((property) => property.name.getText() === 'default');
        return defaultValue ? closedLiteral(defaultValue.initializer) : unbound;
    }
    function structuralCondition(node, call, condition)
    {
        const record = resolver.parse(node.file);
        function slots(name)
        {
            return Object.hasOwn(call.slotInputs.present, name) ? (call.slotInputs.present[name] === null ? unbound : call.slotInputs.present[name])
                : call.slotInputs.unknown ? unbound : false;
        }
        function evaluate(exp, seen = new Set())
        {
            const literal = closedLiteral(exp);
            if (literal !== unbound)
            {
                return literal;
            }
            if (ts.isParenthesizedExpression(exp))
            {
                return evaluate(exp.expression, seen);
            }
            if (ts.isIdentifier(exp) && !seen.has(exp.text))
            {
                const value = record.variables.get(exp.text);
                if (value && ts.isCallExpression(value) && ts.isIdentifier(value.expression)
                    && record.imports.get(value.expression.text)?.specifier === 'vue'
                    && record.imports.get(value.expression.text)?.name === 'computed'
                    && value.arguments.length === 1 && ts.isArrowFunction(value.arguments[0])
                    && value.arguments[0].parameters.length === 0 && !value.arguments[0].modifiers?.length
                    && !ts.isBlock(value.arguments[0].body))
                {
                    return evaluate(value.arguments[0].body, new Set([...seen, exp.text]));
                }
            }
            if (ts.isPropertyAccessExpression(exp) && ts.isIdentifier(exp.expression))
            {
                const variable = record.variables.get(exp.expression.text);
                if (exp.expression.text === '$slots')
                {
                    return slots(exp.name.text);
                }
                if (variable && ts.isCallExpression(variable) && ts.isIdentifier(variable.expression))
                {
                    if (variable.expression.text === 'defineProps')
                    {
                        return staticPropValue(record, call, exp.name.text);
                    }
                    const imported = record.imports.get(variable.expression.text);
                    if (variable.expression.text === 'defineSlots' || (imported?.specifier === 'vue' && imported.name === 'useSlots'))
                    {
                        return slots(exp.name.text);
                    }
                }
            }
            if (ts.isCallExpression(exp) && ts.isIdentifier(exp.expression) && exp.expression.text === 'Boolean'
                && !record.variables.has('Boolean') && !record.imports.has('Boolean')
                && !record.scripts.some(({ ast }) => ast.statements.some((statement) => statement.name?.getText() === 'Boolean'))
                && exp.arguments.length === 1)
            {
                const value = evaluate(exp.arguments[0], seen);
                return value === unbound ? unbound : Boolean(value);
            }
            if (ts.isBinaryExpression(exp) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(exp.operatorToken.kind))
            {
                const left = evaluate(exp.left, seen);
                if (left === unbound)
                {
                    return unbound;
                }
                return exp.operatorToken.kind === ts.SyntaxKind.BarBarToken ? (left || evaluate(exp.right, seen)) : (left && evaluate(exp.right, seen));
            }
            return unbound;
        }
        const value = evaluate(expression(condition.expression, node.file));
        return value === unbound ? null : { sourceNode: node.id, callNode: call.id, directive: condition.name,
            expression: condition.expression, expected: Boolean(value),
            inputDigest: controlDigest({ attributes: call.attributes, directives: call.directives, slots: call.slotInputs }) };
    }
    function nativeFunctionTargets(record, call, scopedNames)
    {
        if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression))
        {
            return null;
        }
        const fn = record.variables.get(call.expression.text);
        if (!fn || !ts.isArrowFunction(fn) || fn.modifiers?.length)
        {
            return null;
        }
        const declarations = record.scripts.flatMap(({ ast }) => ast.statements
            .filter(ts.isVariableStatement).flatMap((statement) => statement.declarationList.declarations
                .filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === call.expression.text)
                .map((declaration) => ({ declaration, flags: statement.declarationList.flags }))));
        if (scopedNames.has(call.expression.text) || declarations.length !== 1
            || declarations[0].declaration.initializer !== fn || !(declarations[0].flags & ts.NodeFlags.Const))
        {
            fail(`unbound native function binding ${record.file}#${call.expression.text}`);
        }
        const values = new Set();
        function returned(node)
        {
            const literal = closedLiteral(node);
            if (typeof literal === 'string' && dom.parserOptions.isNativeTag(literal))
            {
                values.add(literal);
                return;
            }
            if (node && ts.isConditionalExpression(node))
            {
                returned(node.whenTrue);
                returned(node.whenFalse);
                return;
            }
            fail(`unbound native function return ${record.file}#${call.expression.text}`);
        }
        function statement(node)
        {
            if (ts.isReturnStatement(node))
            {
                returned(node.expression);
                return true;
            }
            if (ts.isBlock(node))
            {
                let terminal = false;
                for (const child of node.statements)
                {
                    // Inspect even unreachable returns; an unknown branch is
                    // never discarded to obtain a narrower native union.
                    terminal = statement(child) || terminal;
                }
                return terminal;
            }
            if (ts.isIfStatement(node))
            {
                const thenTerminal = statement(node.thenStatement);
                const elseTerminal = node.elseStatement ? statement(node.elseStatement) : false;
                return thenTerminal && elseTerminal;
            }
            if (ts.isVariableStatement(node) || ts.isExpressionStatement(node) || ts.isEmptyStatement(node))
            {
                return false;
            }
            fail(`unknown native function flow ${record.file}#${call.expression.text}`);
        }
        if (ts.isBlock(fn.body))
        {
            if (!statement(fn.body))
            {
                fail(`native function may fall through ${record.file}#${call.expression.text}`);
            }
        }
        else
        {
            returned(fn.body);
        }
        return { kind: 'native-variants', values: [...values], function: call.expression.text };
    }
    function parseScriptRender(record, value, binding)
    {
        const { setup, render, call } = binding;
        const branches = routeBranch(record);
        value.renderSource = { componentOffset: call.getStart(), componentDigest: controlDigest(call.getText()),
            setupOffset: setup.getStart(), setupDigest: controlDigest(setup.getText()),
            renderOffset: render.getStart(), renderDigest: controlDigest(render.getText()) };
        const context = setup.parameters[1]?.name;
        const slotsElement = context && ts.isObjectBindingPattern(context) ? context.elements.find((element) =>
            (element.propertyName ?? element.name).getText() === 'slots') : null;
        const slots = slotsElement && !slotsElement.initializer && !slotsElement.dotDotDotToken && ts.isIdentifier(slotsElement.name)
            ? slotsElement.name.text : null;
        if (slots)
        {
            unchangedBinding(record, slots, slotsElement.name);
            function slotEscape(node)
            {
                if (ts.isIdentifier(node) && node.text === slots && ts.isCallExpression(node.parent)
                    && node.parent.arguments.includes(node) && !vueBinding(record, node.parent.expression, 'renderSlot'))
                {
                    fail(`escaped script render slots ${record.file}#${slots}`);
                }
                ts.forEachChild(node, slotEscape);
            }
            slotEscape(setup.body);
        }
        function error(node, message)
        {
            errors.push({ ...location(record.file, node.getStart()), reason: 'unknown-render-source', message });
        }
        function add(node, tag, origin, parentId, ancestors, conditional, attributes = {}, directives = [], syntax = null)
        {
            const offset = node.getStart();
            const id = controlDigest({ file: key(record.file), offset, source: node.getText() }).slice(0, 24);
            let definition = null;
            try
            {
                definition = componentFile(origin);
            }
            catch (failure)
            {
                origin = { kind: 'unknown', message: failure.message };
                error(node, failure.message);
            }
            const current = { id, ...location(record.file, offset), tag, parentId, attributes, directives, origin, definition,
                sourceDigest: controlDigest(node.getText()), ancestors, scopedBindings: [],
                structural: origin.kind === 'framework-structure', conditional, slotInputs: { present: {}, unknown: false },
                slot: tag === 'slot' ? { name: attributes.name ?? 'default' } : null, teleport: origin.publicName === 'Teleport',
                sourceSyntax: syntax, renderPaths: [{ parentId, ancestors, conditional }] };
            const previous = nodes.get(id);
            if (previous)
            {
                if (previous.parentId !== parentId || controlDigest(previous.origin) !== controlDigest(origin))
                {
                    fail(`ambiguous script render reuse ${record.file}:${offset}`);
                }
                previous.renderPaths.push(...current.renderPaths);
                previous.conditional = [...new Map([...previous.conditional, ...conditional]
                    .map((entry) => [controlDigest(entry), entry])).values()];
                return previous;
            }
            nodes.set(id, current);
            value.nodes.push(id);
            if (definition && !records.has(definition))
            {
                parse(definition);
            }
            return current;
        }
        function componentOrigin(node, jsx = false)
        {
            if (jsx && ts.isIdentifier(node) && dom.parserOptions.isNativeTag(node.text))
            {
                return { kind: 'native', name: node.text };
            }
            if (ts.isIdentifier(node) && record.imports.has(node.text))
            {
                const identifiers = record.scripts.flatMap(({ ast }) => ast.statements.filter(ts.isImportDeclaration)
                    .flatMap((statement) => [statement.importClause?.name,
                        ...(statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
                            ? statement.importClause.namedBindings.elements.map((entry) => entry.name) : [])])
                    .filter((name) => name?.text === node.text));
                if (identifiers.length !== 1)
                {
                    fail(`ambiguous script render import ${record.file}#${node.text}`);
                }
                unchangedBinding(record, node.text, identifiers[0]);
            }
            const origins = resolver.resolveExpression(record.file, node);
            if (origins.length !== 1)
            {
                fail(`ambiguous script render target ${record.file}:${node.getStart()}`);
            }
            return origins[0];
        }
        function fields(properties)
        {
            const attributes = {};
            const directives = [];
            const names = new Set();
            for (const property of properties)
            {
                const jsx = ts.isJsxAttribute(property);
                const shorthand = ts.isShorthandPropertyAssignment(property);
                const name = property.name?.text;
                if (!name || (!jsx && !shorthand && !ts.isPropertyAssignment(property)) || ts.isComputedPropertyName(property.name)
                    || names.has(name) || [compositionNodeAttribute, compositionCallAttribute].includes(name))
                {
                    fail(`unknown/reserved script render attribute ${record.file}:${property.getStart()}`);
                }
                names.add(name);
                const initializer = shorthand ? property.name : property.initializer;
                if (!initializer)
                {
                    attributes[name] = '';
                }
                else if (ts.isStringLiteral(initializer))
                {
                    attributes[name] = initializer.text;
                }
                else
                {
                    const exp = jsx && ts.isJsxExpression(initializer) ? initializer.expression : initializer;
                    if (!exp)
                    {
                        fail(`unknown script render attribute value ${record.file}:${property.getStart()}`);
                    }
                    if (['class', 'style', 'density', 'layout', 'placement', 'surface', 'material'].includes(name) && branches.usesRouteName(exp))
                    {
                        errors.push({ ...location(record.file, property.getStart()), reason: 'route-name-visual-branch' });
                    }
                    directives.push({ name: 'bind', argument: name, argumentStatic: true, expression: exp.getText() });
                }
            }
            return { attributes, directives };
        }
        function output(node, parentId = null, ancestors = [], conditional = [], seen = new Set())
        {
            node = unwrap(node);
            if (!node || node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword
                || node.kind === ts.SyntaxKind.FalseKeyword || ts.isStringLiteral(node) || ts.isNumericLiteral(node))
            {
                return;
            }
            try
            {
                if (ts.isIdentifier(node))
                {
                    const declarations = [];
                    function find(candidate)
                    {
                        if (ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === node.text)
                        {
                            declarations.push(candidate);
                        }
                        function root(value)
                        {
                            value = unwrap(value);
                            while (value && (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)))
                            {
                                value = unwrap(value.expression);
                            }
                            return value && ts.isIdentifier(value) ? value.text : null;
                        }
                        const argumentsToCheck = ts.isCallExpression(candidate) || ts.isNewExpression(candidate) ? candidate.arguments ?? []
                            : ts.isVariableDeclaration(candidate) && candidate.initializer ? [candidate.initializer] : [];
                        if (argumentsToCheck.some((argument) => root(argument) === node.text)
                            || ((ts.isCallExpression(candidate) || ts.isNewExpression(candidate)) && root(candidate.expression) === node.text))
                        {
                            fail(`escaped script render constant ${record.file}#${node.text}`);
                        }
                        ts.forEachChild(candidate, find);
                    }
                    record.scripts.forEach(({ ast }) => find(ast));
                    if (seen.has(node.text) || declarations.length !== 1 || !(declarations[0].parent.flags & ts.NodeFlags.Const)
                        || !declarations[0].initializer || record.imports.has(node.text))
                    {
                        fail(`unknown script render constant ${record.file}#${node.text}`);
                    }
                    unchangedBinding(record, node.text, declarations[0].name);
                    output(declarations[0].initializer, parentId, ancestors, conditional, new Set([...seen, node.text]));
                    return;
                }
                if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node))
                {
                    const opening = ts.isJsxElement(node) ? node.openingElement : node;
                    const origin = componentOrigin(opening.tagName, true);
                    const { attributes, directives } = fields(opening.attributes.properties);
                    const current = add(node, opening.tagName.getText(), origin, parentId, ancestors, conditional,
                        attributes, directives, { kind: 'jsx', markerOffset: opening.tagName.end });
                    const children = ts.isJsxElement(node) ? node.children : [];
                    current.slotInputs.present.default = children.some((child) => !ts.isJsxText(child) || child.text.trim());
                    for (const child of children)
                    {
                        if (ts.isJsxExpression(child))
                        {
                            if (child.dotDotDotToken)
                            {
                                function finiteArray(node)
                                {
                                    node = unwrap(node);
                                    return node && (ts.isArrayLiteralExpression(node) && node.elements.every((element) => !ts.isSpreadElement(element))
                                        || ts.isConditionalExpression(node) && finiteArray(node.whenTrue) && finiteArray(node.whenFalse));
                                }
                                if (!finiteArray(child.expression))
                                {
                                    fail(`unknown JSX child spread ${record.file}:${child.getStart()}`);
                                }
                            }
                            output(child.expression, current.id, [...ancestors, current.id], conditional, new Set(seen));
                        }
                        else if (!ts.isJsxText(child))
                        {
                            output(child, current.id, [...ancestors, current.id], conditional, new Set(seen));
                        }
                    }
                    return;
                }
                if (ts.isConditionalExpression(node))
                {
                    if (branches.usesRouteName(node.condition))
                    {
                        errors.push({ ...location(record.file, node.getStart()), reason: 'route-name-visual-branch' });
                    }
                    output(node.whenTrue, parentId, ancestors, [...conditional, { name: 'if', expression: node.condition.getText() }], new Set(seen));
                    output(node.whenFalse, parentId, ancestors, [...conditional, { name: 'else', expression: node.condition.getText() }], new Set(seen));
                    return;
                }
                if (ts.isArrayLiteralExpression(node))
                {
                    node.elements.forEach((element) => output(element, parentId, ancestors, conditional, new Set(seen)));
                    return;
                }
                if (ts.isCallExpression(node))
                {
                    const callee = node.expression;
                    if (slots && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
                        && callee.expression.text === slots && callee.name.text === 'default' && !node.arguments.length)
                    {
                        add(node, 'slot', { kind: 'framework-structure', package: 'vue', publicName: 'slot' }, parentId, ancestors, conditional);
                        return;
                    }
                    if (vueBinding(record, callee, 'renderSlot') && node.arguments.length === 2 && slots
                        && ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === slots && ts.isStringLiteral(node.arguments[1]))
                    {
                        add(node, 'slot', { kind: 'framework-structure', package: 'vue', publicName: 'slot' }, parentId, ancestors,
                            conditional, { name: node.arguments[1].text });
                        return;
                    }
                    if (vueBinding(record, callee, 'h') || vueBinding(record, callee, 'createVNode'))
                    {
                        const target = node.arguments[0];
                        const props = unwrap(node.arguments[1]);
                        if (!target || !props || !ts.isObjectLiteralExpression(props) || node.arguments.some(ts.isSpreadElement))
                        {
                            fail(`unknown Vue vnode construction ${record.file}:${node.getStart()}`);
                        }
                        const origin = ts.isStringLiteral(target) ? resolver.resolveTag(record.file, target.text) : componentOrigin(target);
                        const { attributes, directives } = fields(props.properties);
                        const current = add(node, target.getText().replaceAll("'", '').replaceAll('"', ''), origin, parentId,
                            ancestors, conditional, attributes, directives, { kind: 'vue-vnode', markerOffset: props.getStart() + 1 });
                        current.slotInputs.present.default = Boolean(node.arguments[2]);
                        output(node.arguments[2], current.id, [...ancestors, current.id], conditional, new Set(seen));
                        return;
                    }
                }
                fail(`unknown script render output ${record.file}:${node.getStart()}: ${node.getText()}`);
            }
            catch (failure)
            {
                error(node, failure.message);
            }
        }
        function flow(node, conditional = [])
        {
            if (ts.isReturnStatement(node))
            {
                if (!node.expression)
                {
                    error(node, 'script render return has no value');
                }
                else
                {
                    output(node.expression, null, [], conditional);
                }
                return true;
            }
            if (ts.isIfStatement(node))
            {
                if (branches.usesRouteName(node.expression))
                {
                    errors.push({ ...location(record.file, node.getStart()), reason: 'route-name-visual-branch' });
                }
                const yes = flow(node.thenStatement, [...conditional, { name: 'if', expression: node.expression.getText() }]);
                const no = node.elseStatement ? flow(node.elseStatement, [...conditional, { name: 'else', expression: node.expression.getText() }]) : false;
                return yes && no;
            }
            if (ts.isBlock(node))
            {
                let terminal = false;
                node.statements.forEach((statement) =>
                {
                    terminal = flow(statement, conditional) || terminal;
                });
                return terminal;
            }
            if (ts.isVariableStatement(node) || ts.isExpressionStatement(node) || ts.isEmptyStatement(node))
            {
                return false;
            }
            error(node, `unknown script render flow ${record.file}:${node.getStart()}`);
            return false;
        }
        if (ts.isBlock(render.body))
        {
            if (!flow(render.body))
            {
                error(render.body, `script render may fall through ${record.file}`);
            }
        }
        else
        {
            output(render.body);
        }
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
            if (!scriptRenders.has(file))
            {
                exportComponent(file, 'default', new Set());
            }
            const binding = scriptRenders.get(file);
            if (binding)
            {
                parseScriptRender(record, value, binding);
            }
            else
            {
                errors.push({ file, reason: 'unknown-render-source' });
            }
            return value;
        }
        function visit(node, parentId = null, ancestors = [], scopedNames = new Set())
        {
            if (node.type !== dom.NodeTypes.ELEMENT)
            {
                for (const child of node.children ?? [])
                {
                    visit(child, parentId, ancestors, scopedNames);
                }
                return;
            }
            const offset = record.template.offset + node.loc.start.offset;
            const id = controlDigest({ file: key(file), offset, source: node.loc.source }).slice(0, 24);
            const attributes = {};
            const directives = [];
            const localNames = new Set(scopedNames);
            function bindNames(pattern)
            {
                const binding = expression(`(${pattern}) => 0`, file);
                if (!ts.isArrowFunction(binding))
                {
                    fail(`unknown template binding pattern ${file}:${offset}`);
                }
                function collect(name)
                {
                    if (ts.isIdentifier(name))
                    {
                        localNames.add(name.text);
                    }
                    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
                    {
                        for (const element of name.elements.filter(ts.isBindingElement))
                        {
                            collect(element.name);
                        }
                    }
                    else
                    {
                        fail(`unknown template binding name ${file}:${offset}`);
                    }
                }
                binding.parameters.forEach((parameter) => collect(parameter.name));
            }
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
                    if (prop.name === 'for')
                    {
                        if (!prop.forParseResult)
                        {
                            fail(`unknown template loop binding ${file}:${offset}`);
                        }
                        for (const name of ['value', 'key', 'index'])
                        {
                            if (prop.forParseResult[name]?.content)
                            {
                                bindNames(prop.forParseResult[name].content);
                            }
                        }
                    }
                    else if (prop.name === 'slot' && prop.exp?.content.trim())
                    {
                        bindNames(prop.exp.content);
                    }
                    directives.push({ name: prop.name, argument: prop.arg?.content ?? null, argumentStatic: prop.arg?.isStatic ?? null, expression: prop.exp?.content ?? null });
                    if (prop.exp?.content.trim() && prop.name !== 'for' && prop.name !== 'slot')
                    {
                        const exp = expression(prop.exp.content, file);
                        const visual = ['if', 'else-if', 'show'].includes(prop.name)
                            || (prop.name === 'bind' && ['class', 'style', 'density', 'layout', 'placement', 'surface', 'material'].includes(prop.arg?.content));
                        if (visual && branches.usesRouteName(exp))
                        {
                            errors.push({ ...location(file, offset), reason: 'route-name-visual-branch' });
                        }
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
                    if (ts.isIdentifier(exp) && localNames.has(exp.text))
                    {
                        fail(`unbound template component binding ${file}:${offset}`);
                    }
                    origin = ts.isIdentifier(exp) ? nativePropTargets(record, exp.text) : nativeFunctionTargets(record, exp, localNames);
                    if (!origin)
                    {
                        const targets = resolver.resolveComponentInput(file, exp, { templateRefs: true });
                        if (targets.some((target) => target.kind === 'component-prop' && localNames.has(target.property)))
                        {
                            fail(`unbound template component prop ${file}:${offset}`);
                        }
                        if (targets.length > 1 && targets.every((target) => target.kind === 'native'))
                        {
                            origin = { kind: 'native-variants', values: [...new Set(targets.map((target) => target.name))] };
                        }
                        else if (targets.length > 1 && targets.every((target) => ['local', 'fsusui-public', 'upstream-internal'].includes(target.kind)))
                        {
                            origin = { kind: 'component-variants', variants: targets, selectorExpression: dynamic.expression,
                                selectorDigest: controlDigest(dynamic.expression) };
                        }
                        else if (targets.length > 1 && targets.every((target) => target.kind === 'component-prop' && target.file === file))
                        {
                            origin = { kind: 'component-prop-variants', edges: targets,
                                declarationDigest: controlDigest(targets), selectorExpression: dynamic.expression,
                                selectorDigest: controlDigest(dynamic.expression) };
                        }
                        else if (targets.length !== 1)
                        {
                            fail(`ambiguous dynamic component ${file}:${offset}`);
                        }
                        else
                        {
                            origin = targets[0];
                        }
                    }
                }
                else if (file.startsWith(upstream + '/') && record.imports.has(node.tag))
                {
                    const imported = record.imports.get(node.tag);
                    origin = { kind: 'upstream-internal', file: importFile(file, imported.specifier), name: imported.name };
                    definition = componentFile(origin);
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
            const slotInputs = { present: {}, unknown: false };
            const rootSlot = node.props.find((prop) => prop.type === dom.NodeTypes.DIRECTIVE && prop.name === 'slot');
            if (rootSlot)
            {
                if (rootSlot.arg && !rootSlot.arg.isStatic)
                {
                    slotInputs.unknown = true;
                }
                else
                {
                    slotInputs.present[rootSlot.arg?.content ?? 'default'] = true;
                }
            }
            for (const child of rootSlot ? [] : node.children ?? [])
            {
                const slot = child.type === dom.NodeTypes.ELEMENT && child.props.find((prop) => prop.type === dom.NodeTypes.DIRECTIVE && prop.name === 'slot');
                if (slot)
                {
                    if (slot.arg && !slot.arg.isStatic)
                    {
                        slotInputs.unknown = true;
                    }
                    else
                    {
                        slotInputs.present[slot.arg?.content ?? 'default'] = child.props.some((prop) => prop.type === dom.NodeTypes.DIRECTIVE && ['if', 'else-if', 'else', 'for'].includes(prop.name)) ? null : true;
                    }
                }
                else if (child.type !== dom.NodeTypes.COMMENT && (child.type !== dom.NodeTypes.TEXT || child.content.trim()))
                {
                    slotInputs.present.default = true;
                }
            }
            const current = { id, ...location(file, offset), tag: node.tag, parentId, attributes, directives, origin, definition,
                definitions: origin.variantDefinitions ?? [], slotInputs,
                sourceDigest: controlDigest(node.loc.source), ancestors, scopedBindings: [...localNames],
                structural: origin.kind === 'framework-structure' || origin.factoryComponent?.kind === 'factory-slot-source',
                conditional: directives.filter(({ name }) => ['if', 'else-if', 'else', 'show', 'for'].includes(name)),
                slot: directives.find(({ name }) => name === 'slot') ?? (node.tag === 'slot' ? { name: attributes.name ?? 'default' } : null),
                teleport: origin.publicName === 'Teleport' };
            nodes.set(id, current);
            value.nodes.push(id);
            for (const child of node.children ?? [])
            {
                visit(child, id, [...ancestors, id], localNames);
            }
            if (definition && !records.has(definition))
            {
                parse(definition);
            }
            for (const variant of current.definitions)
            {
                if (!records.has(variant))
                {
                    parse(variant);
                }
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
                nodes.get(id).definitions?.forEach(visit);
            }
        }
        entryFiles.forEach(visit);
        const graphNodes = [...nodes.values()].filter((node) => reachable.has(node.file));
        const nativePropBindings = [];
        const nativePropErrors = [];
        for (const node of graphNodes.filter((node) => node.origin.kind === 'native-prop'))
        {
            const calls = graphNodes.filter((call) => call.definition === node.file);
            if (!calls.length)
            {
                nativePropErrors.push({ ...location(node.file, node.offset), reason: 'unbound-native-prop-source', property: node.origin.property });
            }
            for (const call of calls)
            {
                try
                {
                    const value = staticPropValue(resolver.parse(node.file), call, node.origin.property);
                    if (typeof value !== 'string' || !dom.parserOptions.isNativeTag(value))
                    {
                        nativePropErrors.push({ ...location(node.file, node.offset), reason: 'unbound-native-prop-source', property: node.origin.property, callNode: call.id });
                        continue;
                    }
                    nativePropBindings.push({ sourceNode: node.id, callNode: call.id, tag: value,
                        inputDigest: controlDigest({ attributes: call.attributes, directives: call.directives, slots: call.slotInputs }) });
                }
                catch (error)
                {
                    nativePropErrors.push({ ...location(node.file, node.offset), reason: 'unbound-native-prop-source', property: node.origin.property, callNode: call.id, message: error.message });
                }
            }
        }
        const componentPropBindings = [];
        const componentPropErrors = [];
        const objectKeyAbsenceProofs = [];
        const absent = Symbol('absent-component-input');
        const unwrapInput = (node) =>
        {
            while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)))
            {
                node = node.expression;
            }
            return node;
        };
        function spreadInput(file, exp, property, seen = new Set())
        {
            exp = unwrapInput(exp);
            const record = resolver.parse(file);
            if (exp && ts.isIdentifier(exp))
            {
                const props = resolver.componentProps(file);
                if (exp.text === props?.propsName || (exp.text === '$props' && !record.variables.has('$props') && !record.imports.has('$props')))
                {
                    if (!resolver.componentPropDeclaration(file, property))
                    {
                        fail(`undeclared forwarded component input ${file}#${property}`);
                    }
                    return { forwarded: { file, property } };
                }
                // Vue separates declared props from attrs in the actual setup context.
                if (exp.text === props?.attrsName && !record.variables.has(exp.text) && !record.imports.has(exp.text)
                    && resolver.componentPropDeclaration(file, property))
                {
                    return absent;
                }
                const key = `${file}#${exp.text}`;
                const value = record.variables.get(exp.text);
                const declarations = [];
                function collect(node)
                {
                    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === exp.text)
                    {
                        declarations.push(node);
                    }
                    ts.forEachChild(node, collect);
                }
                record.scripts.forEach(({ ast }) => collect(ast));
                if (!value || seen.has(key) || declarations.length !== 1
                    || !(declarations[0].parent.flags & ts.NodeFlags.Const))
                {
                    fail(`unknown component input spread ${file}#${property}`);
                }
                unchangedBinding(record, exp.text, declarations[0].name);
                if (ts.isCallExpression(value) && vueBinding(record, value.expression, 'useAttrs'))
                {
                    objectKeyAbsenceProofs.push(resolver.resolveObjectKeyAbsence(file, exp, property));
                    return absent;
                }
                return spreadInput(file, value, property, new Set([...seen, key]));
            }
            if (exp && ts.isCallExpression(exp) && ts.isIdentifier(exp.expression))
            {
                const imported = record.imports.get(exp.expression.text);
                const fn = exp.arguments[0];
                if (imported?.specifier === 'vue' && imported.name === 'computed' && exp.arguments.length === 1
                    && fn && ts.isArrowFunction(fn) && !fn.parameters.length && !fn.modifiers?.length)
                {
                    const body = ts.isBlock(fn.body) && fn.body.statements.length === 1 && ts.isReturnStatement(fn.body.statements[0])
                        ? fn.body.statements[0].expression : ts.isBlock(fn.body) ? null : fn.body;
                    return spreadInput(file, body, property, seen);
                }
            }
            if (exp && ts.isObjectLiteralExpression(exp))
            {
                for (const field of [...exp.properties].reverse())
                {
                    if (ts.isSpreadAssignment(field))
                    {
                        const value = spreadInput(file, field.expression, property, new Set(seen));
                        if (value !== absent)
                        {
                            return value;
                        }
                    }
                    else if (!field.name || ts.isComputedPropertyName(field.name))
                    {
                        fail(`unknown component input key ${file}#${property}`);
                    }
                    else if (field.name.getText().replaceAll("'", '').replaceAll('"', '') === property)
                    {
                        if (ts.isPropertyAssignment(field) || ts.isShorthandPropertyAssignment(field))
                        {
                            return { expression: ts.isPropertyAssignment(field) ? field.initializer : field.name, file };
                        }
                        fail(`unknown component input member ${file}#${property}`);
                    }
                }
                return absent;
            }
            try
            {
                const proof = resolver.resolveObjectKeyAbsence(file, exp, property);
                objectKeyAbsenceProofs.push(proof);
                return absent;
            }
            catch
            {
                fail(`unknown component input spread ${file}#${property}`);
            }
        }
        function componentInput(call, property, seen = new Set())
        {
            const key = `${call.id}#${property}`;
            if (seen.has(key))
            {
                fail(`cyclic component input ${key}`);
            }
            const next = new Set([...seen, key]);
            const declaration = resolver.componentPropDeclaration(call.definition, property);
            if (!declaration || call.directives.some((entry) => entry.name === 'bind' && entry.argumentStatic === false))
            {
                fail(`unknown component input ${key}`);
            }
            const propName = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
            const named = call.directives.filter((entry) => entry.name === 'bind' && entry.argument && propName(entry.argument) === property);
            const attributes = Object.keys(call.attributes).filter((name) => propName(name) === property);
            if (named.length > 1 || attributes.length > 1 || (named.length && attributes.length))
            {
                fail(`ambiguous component input ${key}`);
            }
            const binding = named[0];
            const spreads = call.directives.filter((entry) => entry.name === 'bind' && !entry.argument);
            const spreadValues = spreads.map((entry) => spreadInput(call.file, expression(entry.expression, call.file), property));
            if ((binding || attributes.length) && spreadValues.some((value) => value !== absent))
            {
                fail(`ambiguous component input ${key}`);
            }
            const suppliedSpreads = spreadValues.filter((value) => value !== absent);
            if (suppliedSpreads.length > 1)
            {
                fail(`ambiguous component input ${key}`);
            }
            let input = suppliedSpreads[0] ?? absent;
            if (binding)
            {
                input = { file: call.file, expression: expression(binding.expression, call.file) };
            }
            else if (attributes.length)
            {
                input = { file: call.file, expression: expression(JSON.stringify(call.attributes[attributes[0]]), call.file) };
            }
            const suppliedUndefined = input !== absent && input.expression && ts.isIdentifier(unwrapInput(input.expression))
                && unwrapInput(input.expression).text === 'undefined' && !resolver.parse(input.file).imports.has('undefined')
                && !resolver.parse(input.file).variables.has('undefined');
            if (input === absent || suppliedUndefined)
            {
                let value = unwrapInput(declaration.defaultNode);
                if (value && ts.isArrowFunction(value) && !value.parameters.length && !value.modifiers?.length && !ts.isBlock(value.body))
                {
                    value = value.body;
                }
                input = value ? { file: declaration.file, expression: value } : absent;
            }
            const expand = (edge) =>
            {
                const parents = graphNodes.filter((entry) => entry.definition === edge.file);
                if (!parents.length)
                {
                    fail(`unbound forwarded component input ${key}`);
                }
                return parents.flatMap((parent) => componentInput(parent, edge.property, next));
            };
            let results;
            if (input === absent || input.expression?.kind === ts.SyntaxKind.NullKeyword)
            {
                results = [{ target: null, callPath: [] }];
            }
            else if (input.forwarded)
            {
                results = expand(input.forwarded);
            }
            else
            {
                const value = unwrapInput(input.expression);
                if (ts.isIdentifier(value) && input.file === call.file && call.scopedBindings?.includes(value.text))
                {
                    fail(`template-shadowed component input ${key}`);
                }
                function immutable(exp, file, seen = new Set())
                {
                    exp = unwrapInput(exp);
                    if (ts.isIdentifier(exp))
                    {
                        const record = resolver.parse(file);
                        if (record.imports.has(exp.text) || resolver.componentPropDeclaration(file, exp.text))
                        {
                            return;
                        }
                        const identity = `${file}#${exp.text}`;
                        const declarations = [];
                        function collect(node)
                        {
                            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === exp.text)
                            {
                                declarations.push(node);
                            }
                            ts.forEachChild(node, collect);
                        }
                        record.scripts.forEach(({ ast }) => collect(ast));
                        if (seen.has(identity) || declarations.length !== 1 || !(declarations[0].parent.flags & ts.NodeFlags.Const))
                        {
                            fail(`mutable/unknown component input ${key}`);
                        }
                        immutable(declarations[0].initializer, file, new Set([...seen, identity]));
                        return;
                    }
                    if (ts.isStringLiteral(exp) && dom.parserOptions.isNativeTag(exp.text))
                    {
                        return;
                    }
                    if (ts.isPropertyAccessExpression(exp) && ts.isIdentifier(exp.expression)
                        && resolver.parse(file).imports.get(exp.expression.text)?.name === '*')
                    {
                        return;
                    }
                    fail(`unknown component value ${key}`);
                }
                immutable(value, input.file);
                const targets = resolver.resolveComponentInput(input.file, input.expression);
                if (targets.length !== 1)
                {
                    fail(`ambiguous component input ${key}`);
                }
                results = targets[0].kind === 'component-prop' ? expand(targets[0]) : [{ target: targets[0], callPath: [] }];
            }
            return results.map((result) => ({ ...result, callPath: [call.id, ...result.callPath] }));
        }
        // Bind every deferred prop to its actual calls. Names and declared types
        // never authorize an unknown supplied value or an unproven default.
        for (const node of graphNodes.filter((entry) => entry.origin.kind === 'component-prop'))
        {
            const calls = graphNodes.filter((entry) => entry.definition === node.file);
            if (!calls.length)
            {
                componentPropErrors.push({ ...location(node.file, node.offset), reason: 'unbound-component-prop-source', property: node.origin.property });
            }
            for (const call of calls)
            {
                try
                {
                    for (const input of componentInput(call, node.origin.property))
                    {
                        const target = input.target ?? node.origin.fallbackSource ?? null;
                        const definition = target ? componentFile(target) : null;
                        function requiresInput(exp)
                        {
                            exp = unwrapInput(exp);
                            if (exp && ts.isIdentifier(exp))
                            {
                                return exp.text === node.origin.property;
                            }
                            return exp && ts.isBinaryExpression(exp) && exp.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
                                && (requiresInput(exp.left) || requiresInput(exp.right));
                        }
                        const guard = !target && [node, ...node.ancestors.map((id) => nodes.get(id))]
                            .filter((entry) => !entry.scopedBindings.includes(node.origin.property))
                            .flatMap((entry) => entry.conditional.map((condition) => ({ ...condition, nodeId: entry.id })))
                            .find((condition) => ['if', 'else-if'].includes(condition.name) && condition.expression
                                && requiresInput(expression(condition.expression, node.file)));
                        const guardedAbsent = Boolean(guard);
                        if ((!target && !guardedAbsent) || (target && target.kind !== 'native' && !definition))
                        {
                            fail(`unknown rendered component input ${node.file}#${node.origin.property}`);
                        }
                        if (definition)
                        {
                            parse(definition);
                            visit(definition);
                        }
                        componentPropBindings.push({ sourceNode: node.id, declarationDigest: node.origin.declarationDigest, callNode: call.id, callPath: input.callPath,
                            inputDigests: input.callPath.map((id) =>
                            {
                                const entry = nodes.get(id);
                                return controlDigest({ attributes: entry.attributes, directives: entry.directives, slots: entry.slotInputs });
                            }), target, definition, absent: guardedAbsent,
                            absenceGuard: guard ? { sourceNode: guard.nodeId, directive: guard.name, expression: guard.expression,
                                expressionDigest: controlDigest(guard.expression) } : null });
                    }
                }
                catch (error)
                {
                    componentPropErrors.push({ ...location(node.file, node.offset), reason: 'unbound-component-prop-source',
                        property: node.origin.property, callNode: call.id, message: error.message });
                }
            }
        }
        for (const node of graphNodes.filter((entry) => entry.origin.kind === 'component-prop-variants'))
        {
            const calls = graphNodes.filter((entry) => entry.definition === node.file);
            if (!calls.length)
            {
                componentPropErrors.push({ ...location(node.file, node.offset), reason: 'unbound-component-prop-source' });
            }
            for (const call of calls)
            {
                try
                {
                    const inputs = node.origin.edges.map((edge) => componentInput(call, edge.property));
                    if (inputs.some((values) => values.length !== 1 || values[0].target !== null)
                        || !inputs.every((values) => controlDigest(values[0].callPath) === controlDigest(inputs[0][0].callPath)))
                    {
                        fail(`unknown component prop alternatives ${node.file}:${node.offset}`);
                    }
                    const properties = node.origin.edges.map((edge) => edge.property);
                    function absentDisjunction(exp)
                    {
                        exp = unwrapInput(exp);
                        if (exp && ts.isIdentifier(exp))
                        {
                            return [exp.text];
                        }
                        if (exp && ts.isBinaryExpression(exp) && exp.operatorToken.kind === ts.SyntaxKind.BarBarToken)
                        {
                            return [...absentDisjunction(exp.left), ...absentDisjunction(exp.right)];
                        }
                        return ['unknown'];
                    }
                    const guard = [node, ...node.ancestors.map((id) => nodes.get(id))]
                        .filter((entry) => !properties.some((property) => entry.scopedBindings.includes(property)))
                        .flatMap((entry) => entry.conditional.map((condition) => ({ ...condition, nodeId: entry.id })))
                        .find((condition) =>
                        {
                            if (!['if', 'else-if'].includes(condition.name) || !condition.expression)
                            {
                                return false;
                            }
                            const leaves = absentDisjunction(expression(condition.expression, node.file));
                            return leaves.length === properties.length && new Set(leaves).size === properties.length
                                && leaves.every((property) => properties.includes(property));
                        });
                    if (!guard)
                    {
                        fail(`unguarded absent component prop alternatives ${node.file}:${node.offset}`);
                    }
                    const callPath = inputs[0][0].callPath;
                    componentPropBindings.push({ sourceNode: node.id, declarationDigest: node.origin.declarationDigest,
                        callNode: call.id, callPath, inputDigests: callPath.map((id) =>
                        {
                            const entry = nodes.get(id);
                            return controlDigest({ attributes: entry.attributes, directives: entry.directives, slots: entry.slotInputs });
                        }), target: null, definition: null, absent: true,
                        absenceGuard: { sourceNode: guard.nodeId, directive: guard.name, expression: guard.expression,
                            expressionDigest: controlDigest(guard.expression), properties } });
                }
                catch (failure)
                {
                    componentPropErrors.push({ ...location(node.file, node.offset), reason: 'unbound-component-prop-source',
                        callNode: call.id, message: failure.message });
                }
            }
        }
        // Newly reached component definitions may contain further inputs. An
        // unbound nested edge remains an error; reaching its file is not proof.
        for (const node of [...nodes.values()].filter((entry) => reachable.has(entry.file)
            && ['component-prop', 'component-prop-variants'].includes(entry.origin.kind) && !graphNodes.some((original) => original.id === entry.id)))
        {
            componentPropErrors.push({ ...location(node.file, node.offset), reason: 'unbound-component-prop-source', property: node.origin.property });
        }
        for (const node of [...nodes.values()].filter((entry) => reachable.has(entry.file)
            && entry.origin.kind === 'native-prop' && !graphNodes.some((original) => original.id === entry.id)))
        {
            nativePropErrors.push({ ...location(node.file, node.offset), reason: 'unbound-native-prop-source', property: node.origin.property });
        }
        const structuralBindings = [];
        for (const node of graphNodes.filter((node) => !node.structural && node.file.startsWith(upstream + '/')))
        {
            const conditions = node.conditional.filter((condition) => ['if', 'show'].includes(condition.name) && condition.expression);
            if (conditions.length !== node.conditional.length || node.ancestors.some((id) => nodes.get(id).conditional.length))
            {
                continue;
            }
            for (const call of graphNodes.filter((call) => call.origin.kind === 'fsusui-public' && call.definition === node.file))
            {
                for (const condition of conditions)
                {
                    try
                    {
                        const binding = structuralCondition(node, call, condition);
                        if (binding)
                        {
                            structuralBindings.push(binding);
                        }
                    }
                    catch (error)
                    {
                        errors.push({ ...location(node.file, node.offset), reason: 'unknown-structural-condition-source', message: error.message });
                    }
                }
            }
        }
        const bindings = resolver.sourceBindings();
        errors.push(...bindings.errors);
        return { schema: compositionSourceVersion, entries: entryFiles, sourceIdentity: resolver.identity, upstreamRoot: upstream,
            files: [...records.values()].filter((record) => reachable.has(record.file)),
            nodes: [...nodes.values()].filter((node) => reachable.has(node.file)), structuralBindings, nativePropBindings, componentPropBindings,
            objectKeyAbsenceProofs: [...new Map(objectKeyAbsenceProofs.map((proof) => [proof.proofDigest, proof])).values()], resolverInputs: bindings.files,
            errors: [...errors.filter((error) => !error.file || reachable.has(error.file)), ...nativePropErrors, ...componentPropErrors], sourceDigest: controlDigest({ files: [...records.values()].filter((record) => reachable.has(record.file)).map(({ file, digest }) => ({ file, digest })), resolverInputs: bindings.files }) };
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
            .map((node) =>
            {
                const attribute = ['native', 'native-variants', 'native-prop'].includes(node.origin.kind) ? compositionNodeAttribute : compositionCallAttribute;
                return { offset: node.sourceSyntax?.markerOffset ?? node.offset + 1 + node.tag.length,
                    content: node.sourceSyntax?.kind === 'vue-vnode' ? ` '${attribute}': '${node.id}',`
                        : ` ${attribute}="${node.id}"` };
            })
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
            if (!['.vue', '.ts', '.tsx'].includes(extname(id)) || id.includes('?')
                || (!source.records.has(id) && extname(id) !== '.vue'))
            {
                return null;
            }
            return { code: source.instrument(id, code), map: null };
        } };
}
