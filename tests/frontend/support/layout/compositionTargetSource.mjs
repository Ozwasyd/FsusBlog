import { controlDigest } from '@fsusblog/control-legality/source';

function fail(message)
{
    throw new Error(`[composition-target-source] ${message}`);
}

function closure(source)
{
    const bindings = source.resolver.sourceBindings();
    if (bindings.errors.length)
    {
        fail('canonical source inputs changed');
    }
    return bindings.files;
}

function targetDefinition(source, target)
{
    if (target?.kind === 'native' && source.resolver.dom.parserOptions.isNativeTag(target.name))
    {
        return { targetKind: 'native', definition: null };
    }
    if (target?.kind === 'external' || target?.kind === 'framework-structure')
    {
        // The canonical resolver owns import/registration identity. This module
        // does not infer the framework's rendered element or its slot payload.
        return { targetKind: 'framework', definition: null };
    }
    const definition = target && source.componentFile(target);
    if (!definition || typeof definition !== 'string')
    {
        fail('unbound target definition');
    }
    return { targetKind: 'component', definition };
}

function targetReferences(ts, node, names)
{
    if (ts.isIdentifier(node) && names.has(node.text)
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
        && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node))
    {
        return true;
    }
    let found = false;
    ts.forEachChild(node, (child) =>
    {
        found ||= targetReferences(ts, child, names);
    });
    return found;
}

function closeTargetAliases(source, record, names, requireImmutable)
{
    let changed = true;
    while (changed)
    {
        changed = false;
        for (const [name, value] of record.variables)
        {
            if (!names.has(name) && targetReferences(source.resolver.ts, value, names))
            {
                if (requireImmutable)
                {
                    source.resolver.assertImmutableBinding(record.file, name);
                }
                names.add(name);
                changed = true;
            }
        }
    }
}

function assertTargetExports(source, record, names)
{
    const { ts } = source.resolver;
    // The original export resolver follows actual module edges and aliases.
    // A same-source reexport remains unproved even when its exported name differs.
    for (const exported of source.resolver.exportsOf(record.file).values())
    {
        if (exported.file === record.file && names.has(exported.name))
        {
            fail('escaped target producer output');
        }
    }
    for (const { ast } of record.scripts)
    {
        for (const node of ast.statements)
        {
            if (ts.isExportDeclaration(node) && !node.isTypeOnly && !node.moduleSpecifier
                && node.exportClause && ts.isNamedExports(node.exportClause)
                && node.exportClause.elements.some((entry) => !entry.isTypeOnly && names.has((entry.propertyName ?? entry.name).text)))
            {
                fail('escaped target producer output');
            }
        }
    }
}

function assertClosedSelector(source, record, branch, selector, ownerName)
{
    const { ts } = source.resolver;
    const names = new Set([ownerName]);
    const unwrap = (node) =>
    {
        while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)))
        {
            node = node.expression;
        }
        return node;
    };
    function targets(node)
    {
        node = unwrap(node);
        if (ts.isConditionalExpression(node))
        {
            targets(node.whenTrue);
            targets(node.whenFalse);
        }
        else if (ts.isIdentifier(node))
        {
            names.add(node.text);
            source.resolver.assertImmutableBinding(record.file, node.text);
            const value = record.variables.get(node.text);
            if (value && ts.isIdentifier(unwrap(value)))
            {
                targets(value);
            }
            else if (value && !(ts.isCallExpression(unwrap(value))
                && unwrap(value).arguments.every((argument) => ts.isStringLiteral(argument) || ts.isNumericLiteral(argument)
                    || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(argument.kind))))
            {
                fail('unbound target producer requires a closed effect proof');
            }
        }
        else if (!ts.isStringLiteral(node))
        {
            fail('unbound target member or callback requires a closed effect proof');
        }
    }
    targets(branch);
    const references = (node) => targetReferences(ts, node, names);
    // Close original-record aliases before checking effects. Const containers
    // cannot prevent an unknown consumer from changing the carried target.
    closeTargetAliases(source, record, names, true);
    assertTargetExports(source, record, names);
    function effects(node)
    {
        if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node !== selector
            && (references(node.expression) || (node.arguments ?? []).some(references)))
        {
            fail('escaped target producer or alias');
        }
        if ((ts.isReturnStatement(node) || ts.isExportAssignment(node)) && node.expression && references(node.expression)
            || ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && references(node.right)
            || ts.isVariableStatement(node) && node.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
                && node.declarationList.declarations.some(({ name }) => ts.isIdentifier(name) && names.has(name.text)))
        {
            fail('escaped target producer output');
        }
        ts.forEachChild(node, effects);
    }
    record.scripts.forEach(({ ast }) => effects(ast));
}

/**
 * Consume the original expression resolver without collapsing native, component
 * or framework alternatives. Scoped runtime values require their supplier proof;
 * a type annotation or a framework-looking name cannot provide that proof.
 */
export function resolveCompositionTargetOrigin(source, file, expression, { scopedBindings = [] } = {})
{
    const { ts } = source.resolver;
    function scoped(node)
    {
        if (ts.isIdentifier(node) && scopedBindings.includes(node.text))
        {
            fail(`unbound scoped target ${file}#${node.text}`);
        }
        ts.forEachChild(node, scoped);
    }
    scoped(expression);
    const unwrap = (node) =>
    {
        while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)))
        {
            node = node.expression;
        }
        return node;
    };
    const record = source.resolver.parse(file);
    // Refuse actual exported producers before generic immutable-binding checks,
    // which may already reject an intermediate alias. This is only an escape
    // refusal; finite identities and owned source steps still use the resolver.
    let exportInitializer = expression;
    while (exportInitializer.parent && (ts.isParenthesizedExpression(exportInitializer.parent)
        || ts.isAsExpression(exportInitializer.parent) || ts.isSatisfiesExpression(exportInitializer.parent))
        && exportInitializer.parent.expression === exportInitializer)
    {
        exportInitializer = exportInitializer.parent;
    }
    const exportDeclaration = exportInitializer.parent;
    const exportOwner = ts.isIdentifier(unwrap(expression)) ? unwrap(expression).text
        : exportDeclaration && ts.isVariableDeclaration(exportDeclaration) && exportDeclaration.initializer === exportInitializer
            && ts.isIdentifier(exportDeclaration.name) ? exportDeclaration.name.text : null;
    if (exportOwner)
    {
        const names = new Set([exportOwner]);
        closeTargetAliases(source, record, names, false);
        assertTargetExports(source, record, names);
    }
    const canonical = source.resolver.resolveExpression(file, expression, new Set(), true);
    let selector = unwrap(expression);
    let ownedSelector = expression;
    if (ts.isIdentifier(selector))
    {
        source.resolver.assertImmutableBinding(file, selector.text);
        const value = record.variables.get(selector.text);
        if (!value || !ts.isCallExpression(unwrap(value)))
        {
            fail('target alias requires the canonical immutable branch interface');
        }
        ownedSelector = value;
        selector = unwrap(value);
    }
    // Synthetic template expressions identify a selector; only its original
    // script initializer can supply a source step. No synthetic/foreign node
    // borrows the file's byte identity.
    const selectorStep = source.resolver.sourceStep(file, ownedSelector);
    let initializer = ownedSelector;
    while (initializer.parent && (ts.isParenthesizedExpression(initializer.parent) || ts.isAsExpression(initializer.parent)
        || ts.isSatisfiesExpression(initializer.parent)) && initializer.parent.expression === initializer)
    {
        initializer = initializer.parent;
    }
    const declaration = initializer.parent;
    if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer !== initializer || !ts.isIdentifier(declaration.name))
    {
        fail('target selector requires its actual immutable initializer owner');
    }
    source.resolver.assertImmutableBinding(file, declaration.name.text);
    // The original resolver supplies finite target identities. The bounded
    // effect refusals below also require the actual immutable owner. Reuse
    // its expression-bodied arrow AST to retain repeated
    // branches that its identity-set return intentionally deduplicates. Block
    // flow remains exclusively with the original resolver owner.
    let branchExpression = expression;
    if (ts.isCallExpression(selector) && ts.isIdentifier(selector.expression))
    {
        const imported = record.imports.get(selector.expression.text);
        const fn = selector.arguments[0];
        if (imported?.specifier === 'vue' && imported.name === 'computed')
        {
            if (selector.arguments.length !== 1 || !ts.isArrowFunction(fn) || ts.isBlock(fn.body)
                || fn.parameters.length || fn.modifiers?.length)
            {
                fail('target branch flow requires the canonical raw-return interface');
            }
            branchExpression = fn.body;
        }
    }
    assertClosedSelector(source, record, branchExpression, selector, declaration.name.text);
    const variants = source.resolver.resolveExpression(file, branchExpression, new Set(), true);
    const identities = (targets) => [...new Set(targets.map(controlDigest))].sort();
    if (controlDigest(identities(canonical)) !== controlDigest(identities(variants)))
    {
        fail('target branches differ from the canonical resolver');
    }
    if (!variants.length)
    {
        fail(`empty target alternatives ${file}`);
    }
    const alternatives = variants.map((target) => ({ target, ...targetDefinition(source, target) }));
    const resolverInputs = closure(source);
    const selectorExpression = expression.getText();
    const selectorDigest = controlDigest(selectorExpression);
    const branchDigest = controlDigest(branchExpression.getText());
    const steps = [selectorStep, source.resolver.sourceStep(file, branchExpression)];
    const origin = { file, kind: 'target-variants', variants, alternatives,
        variantDefinitions: [...new Set(alternatives.map(({ definition }) => definition).filter(Boolean))],
        selectorExpression, selectorDigest, branchDigest, steps, resolverInputs };
    return { ...origin, proofDigest: controlDigest(origin) };
}

/**
 * Bind every original componentInput result ({target, callPath}) to actual graph
 * records. The original source API verifies graph identity and resolves the
 * complete ordered supplier set, including defaults/spreads/forwarding. Compare
 * all supplied facts to that set; no caller input is selected or omitted here.
 */
export function bindCompositionTargetInputs(source, node, inputs, graphNodes)
{
    if (!Array.isArray(inputs) || !inputs.length)
    {
        fail('missing canonical target inputs');
    }
    const actual = source.nodes.get(node.id);
    if (!actual || actual !== node || node.origin.kind !== 'native-prop')
    {
        fail('target input owner is not an actual native-prop node');
    }
    const declaration = source.resolver.componentPropDeclaration(node.file, node.origin.property);
    if (!declaration)
    {
        fail('missing actual target prop declaration');
    }
    const nodes = new Map(graphNodes.map((entry) => [entry.id, entry]));
    const bindings = inputs.map(({ target, callPath }) =>
    {
        if (!Array.isArray(callPath) || !callPath.length || new Set(callPath).size !== callPath.length)
        {
            fail('missing/cyclic target call path');
        }
        const calls = callPath.map((id) =>
        {
            const call = nodes.get(id);
            if (!call || source.nodes.get(id) !== call)
            {
                fail('target call path is not in the canonical graph');
            }
            return call;
        });
        if (calls[0].definition !== node.file || calls.slice(1).some((call, index) => call.definition !== calls[index].file))
        {
            fail('target call path does not follow actual component definitions');
        }
        const alternative = targetDefinition(source, target);
        const inputDigests = calls.map((call) => controlDigest({ attributes: call.attributes,
            directives: call.directives, slots: call.slotInputs }));
        const callSteps = [node, ...calls].map((entry) => ({ file: entry.file, offset: entry.offset,
            sourceDigest: entry.sourceDigest }));
        const steps = [source.resolver.sourceStep(declaration.file, declaration.node)];
        // Existing member/selector steps remain part of the proof identity.
        steps.push(...target?.memberSource?.steps ?? [], ...target?.selectorSource?.steps ?? []);
        const binding = { sourceNode: node.id, declarationDigest: declaration.declarationDigest,
            callNode: calls[0].id, callPath: [...callPath], inputDigests, inputDigest: inputDigests[0],
            target, ...alternative, steps, callSteps };
        return binding;
    });
    if (typeof source.resolveTargetInputs !== 'function')
    {
        fail('missing canonical complete target supplier API');
    }
    const canonicalInputs = source.resolveTargetInputs(node, graphNodes);
    const supplierDigest = controlDigest(canonicalInputs);
    if (supplierDigest !== controlDigest(inputs))
    {
        fail('target inputs differ from the complete canonical supplier set');
    }
    // componentFile may add canonical parsed inputs. Seal after every branch.
    const resolverInputs = closure(source);
    return bindings.map((binding) =>
    {
        const facts = { ...binding, supplierDigest, supplierCount: canonicalInputs.length, resolverInputs };
        return { ...facts, proofDigest: controlDigest(facts) };
    });
}

/**
 * Consume original3576's resolveCompositionRouterViewSlot export with the same
 * source instance and original routes observation. The supplied function is the
 * canonical API, not a callback that manufactures supplier records. Keep its
 * complete VNode/empty-view alternatives and actual route-owner call path;
 * backing component definitions never select a route or prove permission/state.
 */
export function bindCompositionRouterViewTargets(source, routes, node, { resolveRouterViewSlot, callPath = [] })
{
    if (typeof resolveRouterViewSlot !== 'function' || source.nodes.get(node.id) !== node
        || node.tag !== 'component' || !source.records.get(node.file)?.nodes.includes(node.id))
    {
        fail('RouterView target requires the canonical API and actual dynamic source node');
    }
    const supplier = resolveRouterViewSlot(source, routes, { file: node.file, offset: node.offset, callPath });
    const selector = node.directives.find(({ name, argument }) => name === 'bind' && argument === 'is');
    const provider = source.nodes.get(supplier.slotOwner.callNode);
    if (supplier.file !== node.file || supplier.offset !== node.offset || supplier.selector.expression !== selector?.expression
        || !provider || provider.file !== node.file || provider.offset !== supplier.slotOwner.offset
        || provider.sourceDigest !== supplier.slotOwner.sourceDigest
        || controlDigest(provider.origin) !== controlDigest(supplier.slotOwner.origin)
        || !node.ancestors.includes(provider.id) || !node.scopedBindings.includes(supplier.slotOwner.binding))
    {
        fail('RouterView supplier does not match the actual graph scope');
    }
    const calls = [provider, ...supplier.routeOwner.callPath.map((entry) =>
    {
        const call = source.nodes.get(entry.id);
        const inputDigest = call && controlDigest({ attributes: call.attributes, directives: call.directives, slots: call.slotInputs });
        if (!call || call.file !== entry.file || call.offset !== entry.offset || call.definition !== entry.definition
            || call.sourceDigest !== entry.sourceDigest || inputDigest !== entry.inputDigest)
        {
            fail('RouterView supplier call facts differ from the actual graph');
        }
        return call;
    })];
    const alternatives = supplier.alternatives.map((alternative) =>
    {
        if (alternative.kind === 'empty-view' && alternative.componentFile === null)
        {
            return { ...alternative, targetKind: 'empty-view', target: null, backingTarget: null, definition: null };
        }
        const backingTarget = supplier.variants.find((target) => target.file === alternative.componentFile);
        if (alternative.kind !== 'component' || !backingTarget)
        {
            fail('unbound RouterView backing target');
        }
        const { definition } = targetDefinition(source, backingTarget);
        return { ...alternative, targetKind: 'framework', target: supplier.slotOwner.origin, backingTarget, definition };
    });
    const inputDigests = calls.map((call) => controlDigest({ attributes: call.attributes,
        directives: call.directives, slots: call.slotInputs }));
    const binding = { kind: 'framework-slot-targets', sourceNode: node.id, supplier,
        alternatives, variantDefinitions: [...new Set(alternatives.map(({ definition }) => definition).filter(Boolean))],
        callNode: provider.id, callPath: calls.map(({ id }) => id), inputDigests, inputDigest: inputDigests[0],
        callSteps: [node, ...calls].map(({ file, offset, sourceDigest }) => ({ file, offset, sourceDigest })),
        conditional: node.conditional, resolverInputs: closure(source),
        runtimeState: 'unbound', permissionState: 'unbound', qualificationEligible: false };
    return { ...binding, proofDigest: controlDigest(binding) };
}
