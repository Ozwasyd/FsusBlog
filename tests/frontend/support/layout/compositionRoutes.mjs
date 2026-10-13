import { resolve } from 'node:path';

/** Restricted AST interpreter for the real router imports. Never executes product modules. */
export function resolveCompositionRoutes(source, routerFile)
{
    const { ts, parse } = source.resolver;
    const memo = new Map();
    const resolving = new Set();
    const omitted = new Set(['meta', 'props', 'redirect', 'beforeEnter', 'alias']);
    function fail(node, file)
    {
        throw new Error(`[composition-routes] unknown route expression ${file}:${node?.getStart() ?? 0} ${node?.kind ?? 'missing'}`);
    }
    function name(file, identifier, environment)
    {
        if (environment.has(identifier))
        {
            return environment.get(identifier);
        }
        const identity = `${file}#${identifier}`;
        if (memo.has(identity))
        {
            return memo.get(identity);
        }
        if (resolving.has(identity))
        {
            throw new Error(`[composition-routes] cycle ${identity}`);
        }
        resolving.add(identity);
        const record = parse(file);
        let value;
        const imported = record.imports.get(identifier);
        if (imported)
        {
            value = name(source.importFile(file, imported.specifier), imported.name, new Map());
        }
        else if (record.variables.has(identifier))
        {
            value = evaluate(record.variables.get(identifier), file, environment);
        }
        else
        {
            for (const { ast } of record.scripts)
            {
                const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === identifier);
                if (declaration)
                {
                    value = { callable: declaration, file, environment };
                }
            }
            if (!value)
            {
                fail(null, identity);
            }
        }
        resolving.delete(identity);
        memo.set(identity, value);
        return value;
    }
    function call(fn, args)
    {
        if (!fn?.callable)
        {
            throw new Error('[composition-routes] unknown function');
        }
        const environment = new Map(fn.environment);
        fn.callable.parameters.forEach((parameter, index) =>
        {
            if (!ts.isIdentifier(parameter.name))
            {
                fail(parameter, fn.file);
            }
            environment.set(parameter.name.text, args[index] ?? (parameter.initializer ? evaluate(parameter.initializer, fn.file, environment) : undefined));
        });
        if (!ts.isBlock(fn.callable.body))
        {
            return evaluate(fn.callable.body, fn.file, environment);
        }
        for (const statement of fn.callable.body.statements)
        {
            if (ts.isReturnStatement(statement))
            {
                return evaluate(statement.expression, fn.file, environment);
            }
            if (ts.isVariableStatement(statement))
            {
                for (const declaration of statement.declarationList.declarations)
                {
                    if (!ts.isIdentifier(declaration.name))
                    {
                        fail(declaration, fn.file);
                    }
                    environment.set(declaration.name.text, evaluate(declaration.initializer, fn.file, environment));
                }
                continue;
            }
            if (ts.isIfStatement(statement))
            {
                const branch = evaluate(statement.expression, fn.file, environment) ? statement.thenStatement : statement.elseStatement;
                if (!branch)
                {
                    continue;
                }
                const returned = ts.isReturnStatement(branch) ? branch : ts.isBlock(branch) && branch.statements.length === 1
                    && ts.isReturnStatement(branch.statements[0]) ? branch.statements[0] : null;
                if (returned)
                {
                    return evaluate(returned.expression, fn.file, environment);
                }
            }
            fail(statement, fn.file);
        }
        fail(fn.callable.body, fn.file);
    }
    function evaluate(node, file, environment = new Map())
    {
        if (!node)
        {
            fail(node, file);
        }
        if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))
        {
            return evaluate(node.expression, file, environment);
        }
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        {
            return node.text;
        }
        if (ts.isNumericLiteral(node))
        {
            return Number(node.text);
        }
        if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
        {
            return node.kind === ts.SyntaxKind.TrueKeyword;
        }
        if (node.kind === ts.SyntaxKind.NullKeyword)
        {
            return null;
        }
        if (ts.isIdentifier(node))
        {
            if (node.text === 'undefined')
            {
                return undefined;
            }
            return name(file, node.text, environment);
        }
        if (ts.isArrayLiteralExpression(node))
        {
            return node.elements.flatMap((element) => ts.isSpreadElement(element) ? evaluate(element.expression, file, environment)
                : [evaluate(element, file, environment)]);
        }
        if (ts.isObjectLiteralExpression(node))
        {
            const result = {};
            for (const property of node.properties)
            {
                if (ts.isSpreadAssignment(property))
                {
                    Object.assign(result, evaluate(property.expression, file, environment));
                    continue;
                }
                const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
                if (!propertyName)
                {
                    fail(property, file);
                }
                if (!omitted.has(propertyName))
                {
                    result[propertyName] = evaluate(ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer, file, environment);
                }
            }
            return result;
        }
        if (ts.isArrowFunction(node))
        {
            return { callable: node, file, environment };
        }
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
        {
            const target = evaluate(node.expression, file, environment);
            const field = ts.isPropertyAccessExpression(node) ? node.name.text : evaluate(node.argumentExpression, file, environment);
            if (target === null || target === undefined || !(field in Object(target)))
            {
                fail(node, file);
            }
            return target[field];
        }
        if (ts.isConditionalExpression(node))
        {
            return evaluate(evaluate(node.condition, file, environment) ? node.whenTrue : node.whenFalse, file, environment);
        }
        if (ts.isTemplateExpression(node))
        {
            return node.head.text + node.templateSpans.map((span) => evaluate(span.expression, file, environment) + span.literal.text).join('');
        }
        if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
        {
            return !evaluate(node.operand, file, environment);
        }
        if (ts.isBinaryExpression(node))
        {
            const left = evaluate(node.left, file, environment);
            const right = () => evaluate(node.right, file, environment);
            switch (node.operatorToken.kind)
            {
                case ts.SyntaxKind.PlusToken: return left + right();
                case ts.SyntaxKind.BarBarToken: return left || right();
                case ts.SyntaxKind.AmpersandAmpersandToken: return left && right();
                case ts.SyntaxKind.QuestionQuestionToken: return left ?? right();
                case ts.SyntaxKind.EqualsEqualsEqualsToken: return left === right();
                case ts.SyntaxKind.ExclamationEqualsEqualsToken: return left !== right();
                case ts.SyntaxKind.InKeyword: return left in right();
                default: fail(node, file);
            }
        }
        if (ts.isCallExpression(node))
        {
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]))
            {
                return { componentFile: source.importFile(file, node.arguments[0].text) };
            }
            if (ts.isPropertyAccessExpression(node.expression))
            {
                const member = node.expression.name.text;
                if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object' && member === 'freeze')
                {
                    return evaluate(node.arguments[0], file, environment);
                }
                const receiver = evaluate(node.expression.expression, file, environment);
                const args = node.arguments.map((argument) => evaluate(argument, file, environment));
                if (Array.isArray(receiver) && member === 'map')
                {
                    return receiver.map((item, index) => call(args[0], [item, index]));
                }
                if (typeof receiver === 'string' && ['startsWith', 'endsWith', 'slice'].includes(member))
                {
                    return String.prototype[member].apply(receiver, args);
                }
                fail(node, file);
            }
            return call(evaluate(node.expression, file, environment), node.arguments.map((argument) => evaluate(argument, file, environment)));
        }
        fail(node, file);
    }
    const router = parse(routerFile);
    const createRouterNames = new Set([...router.imports].filter(([, entry]) => entry.specifier === 'vue-router' && entry.name === 'createRouter').map(([name]) => name));
    const routeExpressions = [];
    function find(node)
    {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && createRouterNames.has(node.expression.text))
        {
            let options = node.arguments[0];
            if (ts.isIdentifier(options))
            {
                options = router.variables.get(options.text);
            }
            if (!options || !ts.isObjectLiteralExpression(options))
            {
                fail(options, routerFile);
            }
            const routes = options.properties.find((property) => property.name?.getText() === 'routes');
            routeExpressions.push(ts.isShorthandPropertyAssignment(routes) ? routes.name : routes?.initializer);
        }
        ts.forEachChild(node, find);
    }
    router.scripts.forEach(({ ast }) => find(ast));
    if (routeExpressions.length !== 1)
    {
        throw new Error('[composition-routes] expected one actual createRouter routes binding');
    }
    const records = evaluate(routeExpressions[0], routerFile);
    const flattened = [];
    const normalize = (path) => path === '/' ? path : path.replace(/\/$/, '');
    function visit(records, parentPath = '/', parents = [])
    {
        for (const record of records)
        {
            if (typeof record.path !== 'string')
            {
                throw new Error('[composition-routes] unknown route path');
            }
            const path = record.path.startsWith('/') ? record.path : `${parentPath.replace(/\/$/, '')}/${record.path}`;
            const components = [record.component, ...Object.values(record.components ?? {})].filter(Boolean).map((component) =>
            {
                const resolved = component.componentFile ? component : call(component, []);
                if (!resolved.componentFile)
                {
                    throw new Error('[composition-routes] unresolved route component');
                }
                return resolved.componentFile;
            });
            flattened.push({ path: normalize(path), componentFiles: components, ancestorFiles: parents });
            if (record.children)
            {
                visit(record.children, path, [...parents, ...components]);
            }
        }
    }
    visit(records);
    return { schema: 'fsusblog.composition-routes.v1', routerFile: resolve(routerFile), routes: flattened };
}

export function bindCompositionArchetypes(matrix, routes)
{
    return matrix.archetypes.map((archetype) =>
    {
        const candidates = routes.routes.filter((route) =>
        {
            const routeParts = route.path.split('/');
            const fixtureParts = new URL(archetype.path, 'http://fixture.invalid').pathname.split('/');
            return routeParts.length === fixtureParts.length && routeParts.every((part, index) => part.startsWith(':')
                ? !part.includes('*') && fixtureParts[index].length > 0 : part === fixtureParts[index]);
        }).filter((route) => route.componentFiles.length);
        const specificity = (route) => route.path.split('/').filter((part) => !part.startsWith(':')).length * 100 + route.ancestorFiles.length;
        const best = Math.max(...candidates.map(specificity));
        const matches = candidates.filter((route) => specificity(route) === best);
        if (matches.length !== 1)
        {
            return { archetype, errors: [{ reason: 'route-fixture-binding-not-exact-one', path: archetype.path, count: matches.length }], entryFiles: [] };
        }
        return { archetype, errors: [], entryFiles: [...matches[0].ancestorFiles, ...matches[0].componentFiles] };
    });
}
