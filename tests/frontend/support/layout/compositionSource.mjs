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
            return resolver.modulePath(specifier, file, true);
        }
        fail(`unresolved/private import ${specifier} in ${file}`);
    }
    // Follow the actual public export factory, rather than guessing a component directory from its name.
    function componentFile(source, seen = new Set())
    {
        let target = null;
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
                        const targets = resolver.resolveComponentInput(file, exp);
                        if (targets.length > 1 && targets.every((target) => target.kind === 'native'))
                        {
                            origin = { kind: 'native-variants', values: [...new Set(targets.map((target) => target.name))] };
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
            const current = { id, ...location(file, offset), tag: node.tag, parentId, attributes, directives, origin, definition, slotInputs,
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
            fail(`unknown component input spread ${file}#${property}`);
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
            if (spreads.length > 1 || (spreads.length && (binding || attributes.length)))
            {
                fail(`ambiguous component input ${key}`);
            }
            let input = spreads.length ? spreadInput(call.file, expression(spreads[0].expression, call.file), property) : absent;
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
                        const target = input.target;
                        const definition = target ? componentFile(target) : null;
                        const guards = [node, ...node.ancestors.map((id) => nodes.get(id))].flatMap((entry) => entry.conditional);
                        const guardedAbsent = !target && guards.some((guard) => guard.name === 'if' && guard.expression === node.origin.property);
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
                            }), target, definition, absent: guardedAbsent });
                    }
                }
                catch (error)
                {
                    componentPropErrors.push({ ...location(node.file, node.offset), reason: 'unbound-component-prop-source',
                        property: node.origin.property, callNode: call.id, message: error.message });
                }
            }
        }
        // Newly reached component definitions may contain further inputs. An
        // unbound nested edge remains an error; reaching its file is not proof.
        for (const node of [...nodes.values()].filter((entry) => reachable.has(entry.file)
            && entry.origin.kind === 'component-prop' && !graphNodes.some((original) => original.id === entry.id)))
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
            nodes: [...nodes.values()].filter((node) => reachable.has(node.file)), structuralBindings, nativePropBindings, componentPropBindings, resolverInputs: bindings.files,
            errors: [...errors.filter((error) => !error.file || reachable.has(error.file)), ...nativePropErrors, ...componentPropErrors, ...bindings.errors], sourceDigest: controlDigest({ files: [...records.values()].filter((record) => reachable.has(record.file)).map(({ file, digest }) => ({ file, digest })), resolverInputs: bindings.files }) };
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
                content: ` ${['native', 'native-variants', 'native-prop'].includes(node.origin.kind) ? compositionNodeAttribute : compositionCallAttribute}="${node.id}"` }))
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
