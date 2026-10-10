import { controlDigest } from '@fsusblog/control-legality/source';

/** Bounded AST helpers for the original composition renderer, never a second graph.
 * vueBinding is the original owner's observation for this same resolver context.
 * Recognized construction facts do not qualify the framework callable's effects.
 */
export function createCompositionFunctionalSource({ resolver, vueBinding })
{
    const { ts, dom } = resolver;
    const reserved = new Set(['data-fsus-composition-node', 'data-fsus-composition-call']);
    const bindings = new WeakMap();
    const fail = (record, message) =>
    {
        throw new Error(`[composition-source] ${message} ${record.file}`);
    };
    function unwrap(node)
    {
        while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
            || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)))
        {
            node = node.expression;
        }
        return node;
    }
    function step(record, node)
    {
        return resolver.sourceStep(record.file, node);
    }
    function visit(record, callback)
    {
        function walk(node)
        {
            callback(node);
            ts.forEachChild(node, walk);
        }
        record.scripts.forEach(({ ast }) => walk(ast));
    }
    function names(pattern)
    {
        if (ts.isIdentifier(pattern))
        {
            return [pattern];
        }
        if (ts.isObjectBindingPattern(pattern) || ts.isArrayBindingPattern(pattern))
        {
            return pattern.elements.filter(ts.isBindingElement).flatMap((element) => names(element.name));
        }
        return [];
    }
    function declarations(record, name)
    {
        const result = [];
        visit(record, (node) =>
        {
            if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
                || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
                || ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node)
                || ts.isFunctionExpression(node)) && node.name)
            {
                result.push(...names(node.name).filter((entry) => entry.text === name));
            }
        });
        return [...new Set(result)];
    }
    function root(node)
    {
        node = unwrap(node);
        while (node && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)))
        {
            node = unwrap(node.expression);
        }
        return node && ts.isIdentifier(node) ? node.text : null;
    }
    function reference(node)
    {
        for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent)
        {
            if (ts.isTypeNode(ancestor) || ts.isInterfaceDeclaration(ancestor))
            {
                return false;
            }
        }
        const parent = node.parent;
        return !(parent && ((ts.isPropertyAccessExpression(parent) && parent.name === node)
            || ((ts.isPropertyAssignment(parent) || ts.isJsxAttribute(parent)) && parent.name === node)
            || (ts.isBindingElement(parent) && parent.propertyName === node)));
    }
    function readonly(record, name, declaration, metadata = false)
    {
        if (declarations(record, name).length !== 1 || declarations(record, name)[0] !== declaration)
        {
            fail(record, `shadowed functional binding #${name}`);
        }
        const metadataSteps = [];
        visit(record, (node) =>
        {
            const assignment = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
            if (assignment && root(node.left) === name)
            {
                const left = unwrap(node.left);
                const inert = metadata && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
                    && ts.isExpressionStatement(node.parent) && ts.isSourceFile(node.parent.parent)
                    && ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression)
                    && ((left.name.text === 'displayName' && ts.isStringLiteral(node.right))
                        || (left.name.text === 'inheritAttrs' && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.right.kind)));
                if (!inert)
                {
                    fail(record, `mutated functional binding #${name}`);
                }
                metadataSteps.push(step(record, node));
            }
            if (((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
                && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && root(node.operand) === name)
                || (ts.isDeleteExpression(node) && root(node.expression) === name))
            {
                fail(record, `mutated functional binding #${name}`);
            }
        });
        return metadataSteps;
    }
    function noEscape(record, name, declaration, allow)
    {
        visit(record, (node) =>
        {
            if (ts.isIdentifier(node) && node.text === name && node !== declaration && reference(node) && !allow(node))
            {
                fail(record, `escaped functional binding #${name}`);
            }
        });
    }
    function memberUse(node)
    {
        while (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
        {
            node = node.parent;
        }
        return node;
    }
    function captured(node, render)
    {
        for (let parent = node.parent; parent && parent !== render; parent = parent.parent)
        {
            if (ts.isFunctionLike(parent))
            {
                return true;
            }
        }
        return false;
    }
    function within(node, render)
    {
        for (let parent = node; parent; parent = parent.parent)
        {
            if (parent === render)
            {
                return true;
            }
        }
        return false;
    }
    function parameter(record, parameter)
    {
        if (parameter.initializer || parameter.dotDotDotToken || parameter.modifiers?.length)
        {
            fail(record, 'unknown functional parameter');
        }
        const pattern = parameter.name;
        if (!ts.isIdentifier(pattern) && (!ts.isObjectBindingPattern(pattern) || pattern.elements.some((element) =>
            element.initializer || element.dotDotDotToken || !ts.isIdentifier(element.name)
                || element.propertyName && !(ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)))))
        {
            fail(record, 'unknown functional parameter pattern');
        }
        names(pattern).forEach((identifier) => readonly(record, identifier.text, identifier));
        return pattern;
    }
    function renderCall(record, node, render, calls)
    {
        const callee = ts.isCallExpression(node) ? node.expression : null;
        if (!callee || !vueBinding?.(record, callee, 'h'))
        {
            return false;
        }
        const imported = record.imports.get(callee.text);
        // Classify this source construction only after the real export graph
        // binds its callable. The callable's effects are not qualified here.
        const declaration = declarations(record, callee.text);
        readonly(record, callee.text, declaration[0]);
        resolver.assertImmutableBinding(record.file, callee.text);
        noEscape(record, callee.text, declaration[0], (entry) =>
            (ts.isImportSpecifier(entry.parent) || ts.isImportClause(entry.parent))
            || render && within(entry, render) && !captured(entry, render)
                && ts.isCallExpression(entry.parent) && entry.parent.expression === entry);
        if (!render || !within(node, render) || node.questionDotToken || node.typeArguments?.length
            || node.arguments.length < 2 || node.arguments.length > 3 || node.arguments.some(ts.isSpreadElement))
        {
            fail(record, 'unbound functional Vue construction shape');
        }
        const [target, props, child] = node.arguments.map(unwrap);
        if (!ts.isStringLiteral(target) || resolver.resolveTag(record.file, target.text).kind !== 'native'
            || !ts.isObjectLiteralExpression(props))
        {
            fail(record, 'unbound functional Vue construction supplier');
        }
        const keys = new Set();
        for (const property of props.properties)
        {
            const name = property.name?.text;
            if (!name || name === '__proto__' || reserved.has(name) || keys.has(name)
                || ts.isComputedPropertyName(property.name)
                || !(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)))
            {
                fail(record, 'unknown/duplicate/reserved functional prop field');
            }
            keys.add(name);
        }
        if (child && !(ts.isStringLiteral(child) || ts.isNumericLiteral(child)
            || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(child.kind)))
        {
            fail(record, 'unbound functional Vue construction child');
        }
        const framework = resolver.resolveFrameworkExport(record.file, callee);
        const identity = framework.exportIdentity;
        if (identity.specifier !== imported.specifier || identity.exportedName !== imported.name
            || identity.file !== framework.file || framework.qualificationEligible !== false)
        {
            fail(record, 'changed canonical Vue construction identity');
        }
        const facts = Object.freeze({ source: Object.freeze(step(record, node)), callee: Object.freeze(step(record, callee)),
            exportIdentity: Object.freeze({ ...identity }), definition: Object.freeze(step(resolver.parse(framework.file), framework.fn)),
            edges: Object.freeze(framework.edges.map((edge) => Object.freeze({
                source: Object.freeze(step(resolver.parse(edge.file), edge.originalImportOrExportAST)),
                resolvedFile: edge.resolvedFile, exportedName: edge.exportedName }))),
            dependencies: Object.freeze(framework.dependencies.map((dependency) => Object.freeze(
                step(resolver.parse(dependency.file), dependency.fn ?? dependency.classDeclaration)))),
            unresolvedDependencies: Object.freeze(framework.unresolvedDependencies.map((dependency) => Object.freeze({ ...dependency,
                source: Object.freeze({ ...dependency.source }), binding: dependency.binding ? Object.freeze({ ...dependency.binding }) : null }))),
            dependencyScope: framework.dependencyScope, qualificationEligible: false });
        calls.set(node, facts);
        return true;
    }
    function effects(record, expression, slots = null, render = null, calls = null)
    {
        function walk(node)
        {
            if (ts.isFunctionLike(node))
            {
                return;
            }
            const assignment = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
            const update = (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
                && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator);
            if (assignment || update || ts.isDeleteExpression(node))
            {
                fail(record, 'unbound functional write effects');
            }
            if (ts.isTaggedTemplateExpression(node) || ts.isNewExpression(node) || ts.isCallExpression(node) && !(slots
                && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
                && node.expression.expression.text === slots && !node.arguments.length && !node.typeArguments?.length)
                && !(calls && renderCall(record, node, render, calls)))
            {
                fail(record, 'unbound functional call effects');
            }
            ts.forEachChild(node, walk);
        }
        walk(expression);
    }
    function propAliases(record, render, props)
    {
        const identifiers = new Map((props ? names(props) : []).map((node) => [node.text, node]));
        const candidates = [];
        function collect(node)
        {
            if (ts.isFunctionLike(node))
            {
                return;
            }
            if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer)
            {
                candidates.push(node);
            }
            ts.forEachChild(node, collect);
        }
        collect(render.body);
        const facts = [];
        const proved = new Set();
        let changed = true;
        while (changed)
        {
            changed = false;
            for (const declaration of candidates)
            {
                const supplier = identifiers.get(root(declaration.initializer));
                if (!supplier || proved.has(declaration))
                {
                    continue;
                }
                if (!(declaration.parent.flags & ts.NodeFlags.Const) || supplier.getStart() >= declaration.getStart())
                {
                    fail(record, 'mutable/uninitialized functional props alias');
                }
                proved.add(declaration);
                changed = true;
                for (const identifier of names(declaration.name))
                {
                    readonly(record, identifier.text, identifier);
                    identifiers.set(identifier.text, identifier);
                    facts.push(Object.freeze({ name: identifier.text, declaration: Object.freeze(step(record, declaration)),
                        supplier: Object.freeze(step(record, declaration.initializer)) }));
                }
            }
        }
        return { identifiers: [...identifiers.values()], facts: Object.freeze(facts) };
    }
    function dependencies(record, render)
    {
        const found = new Map();
        const active = new Set();
        const declarationsUsed = [];
        function collect(node)
        {
            if (ts.isTypeNode(node))
            {
                return;
            }
            if (ts.isIdentifier(node) && reference(node))
            {
                const matches = declarations(record, node.text);
                let declaration = matches.length === 1 ? matches[0].parent : null;
                while (declaration && (ts.isBindingElement(declaration) || ts.isObjectBindingPattern(declaration)
                    || ts.isArrayBindingPattern(declaration)))
                {
                    declaration = declaration.parent;
                }
                const variable = declaration && ts.isVariableDeclaration(declaration)
                    && ts.isVariableStatement(declaration.parent.parent) && ts.isSourceFile(declaration.parent.parent.parent);
                const fn = declaration && ts.isFunctionDeclaration(declaration) && ts.isSourceFile(declaration.parent);
                const imported = record.imports.has(node.text);
                if ((variable || fn || imported) && node !== matches[0]
                    && declaration?.initializer !== render && !found.has(node.text))
                {
                    if (active.has(node.text))
                    {
                        fail(record, 'cyclic functional module dependency');
                    }
                    readonly(record, node.text, matches[0]);
                    resolver.assertImmutableBinding(record.file, node.text);
                    active.add(node.text);
                    let source = declaration;
                    if (imported)
                    {
                        while (source && !ts.isImportDeclaration(source))
                        {
                            source = source.parent;
                        }
                    }
                    if (!source)
                    {
                        fail(record, 'unknown functional module dependency');
                    }
                    const initializer = variable ? declaration.initializer : fn ? declaration : null;
                    if (initializer)
                    {
                        effects(record, initializer);
                        collect(initializer);
                    }
                    declarationsUsed.push(source);
                    found.set(node.text, Object.freeze({ name: node.text, declaration: Object.freeze(step(record, source)),
                        initializer: initializer ? Object.freeze(step(record, initializer)) : null }));
                    active.delete(node.text);
                }
            }
            ts.forEachChild(node, collect);
        }
        collect(render.body);
        return { facts: Object.freeze([...found.values()]), declarations: declarationsUsed };
    }
    function bind(record, expression)
    {
        if (resolver.parse(record.file) !== record)
        {
            fail(record, 'noncanonical functional record');
        }
        const render = unwrap(expression);
        if (!render || !ts.isArrowFunction(render) || render.modifiers?.length || render.asteriskToken
            || render.parameters.length > 2)
        {
            fail(record, 'unknown functional definition');
        }
        step(record, render);
        const declaration = render.parent;
        let metadata = [];
        if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
            && declaration.initializer === render && declaration.parent.flags & ts.NodeFlags.Const
            && ts.isVariableStatement(declaration.parent.parent) && ts.isSourceFile(declaration.parent.parent.parent))
        {
            metadata = readonly(record, declaration.name.text, declaration.name, true);
            noEscape(record, declaration.name.text, declaration.name, (node) =>
                ts.isExportAssignment(node.parent) || ts.isExportSpecifier(node.parent)
                || ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
                    && ts.isBinaryExpression(node.parent.parent) && node.parent.parent.left === node.parent);
        }
        else if (!(ts.isExportAssignment(declaration) && !declaration.isExportEquals))
        {
            fail(record, 'noncanonical functional declaration');
        }
        if (ts.isVariableDeclaration(declaration) && !metadata.length
            && resolver.resolveSourceFunction(record.file, declaration.name).fn !== render)
        {
            fail(record, 'changed canonical functional definition');
        }
        const props = render.parameters[0] ? parameter(record, render.parameters[0]) : null;
        const context = render.parameters[1] ? parameter(record, render.parameters[1]) : null;
        let slots = null;
        if (context)
        {
            if (!ts.isObjectBindingPattern(context) || context.elements.length !== 1
                || (context.elements[0].propertyName ?? context.elements[0].name).text !== 'slots')
            {
                fail(record, 'unknown functional context');
            }
            slots = context.elements[0].name;
            noEscape(record, slots.text, slots, (node) =>
            {
                const member = memberUse(node);
                return within(node, render) && !captured(node, render) && (member === node && ts.isJsxExpression(node.parent)
                    || member !== node && ts.isPropertyAccessExpression(member) && member.expression === node
                    && (ts.isCallExpression(member.parent) && member.parent.expression === member && !member.parent.arguments.length
                        || ts.isConditionalExpression(member.parent) && member.parent.condition === member
                        || ts.isBinaryExpression(member.parent) && member.parent.left === member
                            && member.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken));
            });
        }
        // Passing a props object or a destructured field to arbitrary code can
        // mutate it. A type annotation cannot make such a supplier readonly.
        const aliases = propAliases(record, render, props);
        for (const identifier of aliases.identifiers)
        {
            noEscape(record, identifier.text, identifier, (node) =>
            {
                const member = memberUse(node);
                const parent = member.parent;
                return within(node, render) && !captured(node, render) && (ts.isJsxExpression(parent) || ts.isShorthandPropertyAssignment(parent)
                    || ts.isPropertyAssignment(parent) && parent.initializer === member
                    || ts.isVariableDeclaration(parent) && parent.initializer === member
                        && ts.isObjectBindingPattern(parent.name)
                    || ts.isSpreadAssignment(parent) || ts.isJsxSpreadAttribute(parent)
                    || member !== node && (ts.isConditionalExpression(parent) && parent.condition === member
                        || ts.isBinaryExpression(parent) && parent.left === member
                            && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
                        || ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken));
            });
        }
        const renderCalls = new Map();
        effects(record, render.body, slots?.text, render, renderCalls);
        const closure = dependencies(record, render);
        const branches = [];
        const conditions = [];
        function flow(node, paths)
        {
            if (ts.isReturnStatement(node))
            {
                paths.forEach((conditional) => branches.push({ node: node.expression ?? null, conditional, step: step(record, node) }));
                return [];
            }
            if (ts.isBlock(node))
            {
                return node.statements.reduce((remaining, statement) => remaining.length ? flow(statement, remaining) : remaining, paths);
            }
            if (ts.isIfStatement(node))
            {
                conditions.push(node.expression);
                const yes = paths.map((path) => [...path, { name: 'if', expression: node.expression.getText() }]);
                const no = paths.map((path) => [...path, { name: 'else', expression: node.expression.getText() }]);
                return [...flow(node.thenStatement, yes), ...(node.elseStatement ? flow(node.elseStatement, no) : no)];
            }
            if (ts.isVariableStatement(node) || ts.isEmptyStatement(node) || ts.isFunctionDeclaration(node))
            {
                return paths;
            }
            fail(record, `unknown functional return flow at ${node.getStart()}`);
        }
        if (ts.isBlock(render.body))
        {
            if (flow(render.body, [[]]).length)
            {
                fail(record, 'functional return fallthrough');
            }
        }
        else
        {
            branches.push({ node: render.body, conditional: [], step: step(record, render.body) });
        }
        const steps = [step(record, declaration), step(record, render), ...render.parameters.map((node) => step(record, node)),
            ...metadata, ...branches.map((branch) => branch.step), ...aliases.facts.map((entry) => entry.declaration),
            ...closure.facts.map((entry) => entry.declaration)];
        branches.forEach((branch) =>
        {
            branch.conditional.forEach(Object.freeze);
            Object.freeze(branch.conditional);
            Object.freeze(branch.step);
            Object.freeze(branch);
        });
        steps.forEach(Object.freeze);
        // Supplier steps bind local source facts only. Imported definitions and
        // the complete current-file closure remain the canonical resolver's job.
        const proofFacts = Object.freeze({ steps, render: Object.freeze(step(record, render)), props: props?.getText() ?? null,
            slots: slots?.text ?? null,
            branches: Object.freeze(branches.map((branch) => Object.freeze({
                source: branch.node ? Object.freeze(step(record, branch.node)) : null, conditional: branch.conditional }))),
            conditions: Object.freeze(conditions.map((node) => Object.freeze(step(record, node)))),
            aliases: aliases.facts, dependencies: closure.facts,
            ...(renderCalls.size ? { renderCalls: Object.freeze([...renderCalls.values()]) } : {}) });
        const binding = Object.freeze({ call: render, setup: render, render, props, slots: slots?.text ?? null,
            branches: Object.freeze(branches), conditions: Object.freeze(conditions), steps: Object.freeze(steps),
            proofFacts, proofDigest: controlDigest(proofFacts), functional: true });
        bindings.set(binding, { record, declarations: closure.declarations, renderCalls });
        return binding;
    }
    function check(record, node, binding)
    {
        const context = bindings.get(binding);
        if (!context || context.record !== record || resolver.parse(record.file) !== record
            || binding.render.getSourceFile() !== node.getSourceFile()
            || !within(node, binding.render) && !context.declarations.some((declaration) => within(node, declaration)))
        {
            fail(record, 'foreign functional binding/input');
        }
        step(record, node);
    }
    function constant(record, node, binding)
    {
        const identifier = unwrap(node);
        const found = declarations(record, identifier.text);
        const declaration = found.length === 1 ? found[0].parent : null;
        if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
            || !(declaration.parent.flags & ts.NodeFlags.Const) || record.imports.has(identifier.text))
        {
            fail(record, `unbound functional output/spread #${identifier.text}`);
        }
        // Only declarations directly in this render or in its module are in scope.
        const scope = declaration.parent.parent.parent;
        if (scope !== binding.render.body && !ts.isSourceFile(scope))
        {
            fail(record, `out-of-scope functional constant #${identifier.text}`);
        }
        if (scope === binding.render.body && declaration.getStart() >= identifier.getStart())
        {
            fail(record, `uninitialized functional constant #${identifier.text}`);
        }
        readonly(record, identifier.text, found[0]);
        resolver.assertImmutableBinding(record.file, identifier.text);
        noEscape(record, identifier.text, found[0], (entry) =>
            ts.isReturnStatement(entry.parent) || ts.isJsxExpression(entry.parent)
            || ts.isJsxSpreadAttribute(entry.parent) || ts.isSpreadAssignment(entry.parent));
        return declaration.initializer;
    }
    function outputValue(record, node, binding, seen = new Set())
    {
        if (!node)
        {
            return null;
        }
        check(record, node, binding);
        node = unwrap(node);
        if (node && ts.isIdentifier(node))
        {
            if (seen.has(node.text))
            {
                fail(record, 'cyclic functional output');
            }
            return outputValue(record, constant(record, node, binding), binding, new Set([...seen, node.text]));
        }
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
        {
            fail(record, 'unbound functional output member');
        }
        if (ts.isCallExpression(node) && !slotCall(record, node, binding))
        {
            const facts = bindings.get(binding).renderCalls.get(node);
            if (!facts || resolver.sourceBindings().errors.length)
            {
                fail(record, 'unbound functional output call');
            }
        }
        return node;
    }
    function spreadFields(record, node, binding, seen = new Set())
    {
        node = unwrap(node);
        if (node && ts.isIdentifier(node))
        {
            if (seen.has(node.text))
            {
                fail(record, 'cyclic functional spread');
            }
            return spreadFields(record, constant(record, node, binding), binding, new Set([...seen, node.text]));
        }
        if (!node || !ts.isObjectLiteralExpression(node))
        {
            fail(record, 'unbound functional prop spread supplier');
        }
        return fields(record, node.properties, binding, seen);
    }
    function fields(record, properties, binding, seen = new Set())
    {
        check(record, binding.render, binding);
        const result = [];
        const keys = new Set();
        for (const property of properties)
        {
            check(record, property, binding);
            const expanded = ts.isJsxSpreadAttribute(property) || ts.isSpreadAssignment(property)
                ? spreadFields(record, property.expression, binding, new Set(seen)) : [property];
            for (const field of expanded)
            {
                const name = field.name?.text;
                if (!name || name === '__proto__' || reserved.has(name) || keys.has(name) || ts.isComputedPropertyName(field.name)
                    || !(ts.isJsxAttribute(field) || ts.isPropertyAssignment(field) || ts.isShorthandPropertyAssignment(field)))
                {
                    fail(record, 'unknown/duplicate/reserved functional prop field');
                }
                keys.add(name);
                result.push(field);
            }
        }
        return result;
    }
    function componentOrigin(record, node, jsx = false)
    {
        if (resolver.parse(record.file) !== record)
        {
            fail(record, 'noncanonical functional record');
        }
        step(record, node);
        node = unwrap(node);
        if (jsx && ts.isIdentifier(node) && dom.parserOptions.isNativeTag(node.text))
        {
            if (declarations(record, node.text).length)
            {
                fail(record, 'shadowed functional native target');
            }
            return { kind: 'native', name: node.text };
        }
        if (!node || !ts.isIdentifier(node) || !record.imports.has(node.text))
        {
            fail(record, 'unbound functional component target');
        }
        const declaration = declarations(record, node.text);
        if (declaration.length !== 1 || !(ts.isImportClause(declaration[0].parent)
            || ts.isImportSpecifier(declaration[0].parent)))
        {
            fail(record, 'shadowed functional import');
        }
        readonly(record, node.text, declaration[0]);
        resolver.assertImmutableBinding(record.file, node.text);
        noEscape(record, node.text, declaration[0], (entry) =>
            ts.isImportClause(entry.parent) || ts.isImportSpecifier(entry.parent)
            || (ts.isJsxOpeningElement(entry.parent) || ts.isJsxClosingElement(entry.parent)
                || ts.isJsxSelfClosingElement(entry.parent)) && entry.parent.tagName === entry);
        const origins = resolver.resolveExpression(record.file, node);
        if (origins.length !== 1)
        {
            fail(record, 'ambiguous functional imported target');
        }
        if (!origins[0].file && !origins[0].definition && origins[0].kind !== 'framework-structure')
        {
            fail(record, 'unbound functional imported definition');
        }
        return origins[0];
    }
    function slotCall(record, node, binding)
    {
        check(record, node, binding);
        node = unwrap(node);
        const callee = node && ts.isCallExpression(node) ? unwrap(node.expression) : null;
        if (!callee || !ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)
            || callee.expression.text !== binding.slots)
        {
            return null;
        }
        if (!within(node, binding.render) || captured(node, binding.render))
        {
            fail(record, 'out-of-scope functional slot');
        }
        if (node.arguments.length || node.typeArguments?.length)
        {
            fail(record, 'unbound functional slot payload');
        }
        return { name: callee.name.text, steps: [step(record, binding.render), step(record, node)] };
    }
    return { bind, fields, componentOrigin, outputValue, slotCall };
}
