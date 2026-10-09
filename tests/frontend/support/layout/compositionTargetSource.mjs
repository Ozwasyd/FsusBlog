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
    const canonical = source.resolver.resolveExpression(file, expression, new Set(), true);
    const unwrap = (node) =>
    {
        while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)))
        {
            node = node.expression;
        }
        return node;
    };
    const record = source.resolver.parse(file);
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
    // The original resolver first proves the complete computed binding and its
    // effects. Reuse its actual expression-bodied arrow AST to retain repeated
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
 * Bind the original componentInput results ({target, callPath}) to actual graph
 * records. Call this inside the central graph closure, after its ordered input
 * supplier/default/spread checks. No caller input is selected or omitted here.
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
    // componentFile may add canonical parsed inputs. Seal after every branch.
    const resolverInputs = closure(source);
    return bindings.map((binding) => ({ ...binding, resolverInputs,
        proofDigest: controlDigest({ ...binding, resolverInputs }) }));
}
