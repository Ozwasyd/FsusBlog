import { compositionDigest, verifyCompositionIdentity } from './compositionContracts.mjs';

export const compositionAnalyzerVersion = 'fsusblog.composition-analyzer.v1';

/** Runs inside the actual browser. Hidden nodes are deliberately retained. */
export function captureCompositionDom()
{
    const document = globalThis.document;
    const getComputedStyle = globalThis.getComputedStyle;
    const elements = [...document.body.querySelectorAll('*')];
    const indexes = new Map(elements.map((element, index) => [element, index]));
    const inherited = (element, attribute) => element.closest(`[${attribute}]`)?.getAttribute(attribute) ?? null;
    return { url: globalThis.location.href, viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
        nodes: elements.map((element, index) =>
        {
            const style = getComputedStyle(element);
            let hidden = false;
            let current = element;
            while (current && current !== document.documentElement)
            {
                const currentStyle = getComputedStyle(current);
                hidden ||= current.hidden || current.getAttribute('aria-hidden') === 'true'
                    || currentStyle.display === 'none' || currentStyle.visibility !== 'visible' || currentStyle.opacity === '0' || currentStyle.contentVisibility === 'hidden';
                current = current.parentElement;
            }
            const rect = element.getBoundingClientRect();
            const visible = !hidden && rect.width > 0 && rect.height > 0;
            const inert = Boolean(element.closest('[inert]'));
            const disabled = element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true';
            return { index, parent: indexes.get(element.parentElement) ?? null, tag: element.tagName.toLowerCase(),
                semanticRole: element.getAttribute('role'), ariaLevel: element.getAttribute('aria-level'),
                sourceNode: element.getAttribute('data-fsus-composition-node'), sourceCall: element.getAttribute('data-fsus-composition-call'),
                owner: element.getAttribute('data-fsus-owner'), region: element.getAttribute('data-fsus-region'),
                inheritedOwner: inherited(element, 'data-fsus-owner'), inheritedRegion: inherited(element, 'data-fsus-region'),
                action: element.getAttribute('data-fsus-action'), priority: element.getAttribute('data-fsus-action-priority'),
                surface: element.getAttribute('data-fsus-surface'), material: element.getAttribute('data-fsus-material'),
                responsibility: element.getAttribute('data-fsus-chrome'), inheritedChrome: inherited(element, 'data-fsus-chrome'), interactive: element.matches('button,a[href],input,select,textarea,[role=button]'), content: element.getAttribute('data-fsus-content'),
                position: style.position, order: style.order, flexDirection: style.flexDirection,
                visible, hidden, operable: visible && !inert && !disabled,
                attributes: Object.fromEntries([...element.attributes].map(({ name, value }) => [name, value])) };
        }) };
}

function error(reason, node, details = {})
{
    return { reason, node: node?.index ?? null, sourceNode: node?.sourceNode ?? null,
        owner: node?.owner ?? node?.inheritedOwner ?? null, ...details };
}

/** Join a proven component input to this exact rendered call chain, never an icon name. */
function matchCompositionInputCalls(graph, source, ancestors, candidates, declaration)
{
    const markers = ancestors.map((node) => node.sourceCall).filter(Boolean);
    const bindings = (candidates ?? []).filter((binding) =>
    {
        if (!Array.isArray(binding.callPath) || !binding.callPath.length || !Array.isArray(binding.inputDigests)
            || binding.sourceNode !== source.id || !declaration(binding)
            || binding.callNode !== binding.callPath[0] || binding.inputDigests.length !== binding.callPath.length)
        {
            return false;
        }
        let cursor = -1;
        return binding.callPath.every((id, index) =>
        {
            cursor = markers.indexOf(id, cursor + 1);
            const call = graph.nodes.find((node) => node.id === id);
            return cursor >= 0 && call && binding.inputDigests[index] === compositionDigest({
                attributes: call.attributes, directives: call.directives, slots: call.slotInputs });
        });
    });
    return bindings.length === 1 ? bindings[0] : null;
}

export function matchCompositionComponentProp(graph, source, ancestors)
{
    return matchCompositionInputCalls(graph, source, ancestors, graph.componentPropBindings,
        (binding) => binding.declarationDigest === source.origin.declarationDigest);
}

/** Native prop forwarding needs the same exact ordered source-call proof. */
export function matchCompositionNativeProp(graph, source, ancestors)
{
    return matchCompositionInputCalls(graph, source, ancestors, graph.nativePropBindings,
        (binding) => source.origin.kind === 'native-prop' && typeof binding.tag === 'string' && binding.tag.length > 0
            && binding.inputDigest === binding.inputDigests?.[0]);
}

/** Source/DOM observations only; this function cannot issue a geometry or visual verdict. */
export function analyzeCompositionDom({ archetype, graph, observation, identity, currentIdentity, runId, state = null, runBinding })
{
    verifyCompositionIdentity(identity, currentIdentity);
    if (!runId || !observation?.nodes?.length || graph.schema !== 'fsusblog.composition-source.v1')
    {
        throw new Error('[composition-analyzer] missing current graph/DOM/run identity');
    }
    if (!runBinding?.worktree || !runBinding?.analyzerDigest)
    {
        throw new Error('[composition-analyzer] source/worktree/analyzer binding required');
    }
    const contract = archetype.compositionContract;
    const errors = graph.errors.map((item) => ({ ...item, phase: 'static' }));
    const sourceNodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const nodes = observation.nodes;
    const byIndex = new Map(nodes.map((node) => [node.index, node]));
    const ancestry = (node) =>
    {
        const ancestors = [];
        const seen = new Set();
        while (node)
        {
            if (seen.has(node.index))
            {
                throw new Error('[composition-analyzer] cyclic DOM observation');
            }
            seen.add(node.index);
            ancestors.push(node);
            node = byIndex.get(node.parent);
        }
        return ancestors;
    };
    for (const source of graph.nodes.filter((node) => node.conditional?.some((condition) => condition.expression)))
    {
        const calls = graph.nodes.filter((call) => call.origin.kind === 'fsusui-public' && call.definition === source.file);
        const bindings = graph.structuralBindings?.filter((binding) => binding.sourceNode === source.id) ?? [];
        const complete = calls.length > 0 && calls.every((call) => nodes.some((node) => node.sourceCall === call.id) && source.conditional.every((condition) =>
        {
            const matches = bindings.filter((binding) => binding.callNode === call.id && binding.directive === condition.name
                && binding.expression === condition.expression && typeof binding.expected === 'boolean'
                && binding.inputDigest === compositionDigest({ attributes: call.attributes, directives: call.directives, slots: call.slotInputs }));
            return matches.length === 1;
        }));
        if (!complete)
        {
            errors.push({ file: source.file, sourceNode: source.id, reason: 'unknown-conditional-state-binding', phase: 'static-dom' });
            continue;
        }
        for (const binding of bindings)
        {
            for (const callRoot of nodes.filter((node) => node.sourceCall === binding.callNode))
            {
                const rendered = nodes.filter((node) => (node.sourceNode === source.id || node.sourceCall === source.id)
                    && ancestry(node).some((ancestor) => ancestor.index === callRoot.index));
                const mismatch = binding.directive === 'if' ? rendered.length !== (binding.expected ? 1 : 0)
                    : binding.directive === 'show' ? rendered.length !== 1 || (!binding.expected && !rendered[0]?.hidden) : true;
                if (mismatch)
                {
                    errors.push({ file: source.file, sourceNode: source.id, callNode: binding.callNode,
                        reason: 'structural-condition-render-mismatch', phase: 'static-dom', expected: binding.expected, rendered: rendered.length });
                }
            }
        }
    }
    // Every public provenance assertion must reach an actual public component call and its parsed definition.
    function publicSource(node)
    {
        const native = sourceNodes.get(node.sourceNode);
        if (!native)
        {
            return null;
        }
        for (const ancestor of ancestry(node))
        {
            const call = sourceNodes.get(ancestor.sourceCall);
            if (call?.origin.kind !== 'fsusui-public')
            {
                continue;
            }
            const reachable = new Set();
            function visit(file)
            {
                if (!file || reachable.has(file))
                {
                    return;
                }
                reachable.add(file);
                for (const child of graph.nodes.filter((item) => item.file === file))
                {
                    // Slot content authored in Blog never acquires upstream provenance through ancestry.
                    if (child.definition && child.file.startsWith(graph.upstreamRoot + '/'))
                    {
                        visit(child.definition);
                    }
                    if (child.origin.kind === 'component-variants' && child.file.startsWith(graph.upstreamRoot + '/'))
                    {
                        child.definitions?.forEach(visit);
                    }
                    if (['component-prop', 'component-prop-variants'].includes(child.origin.kind) && child.file.startsWith(graph.upstreamRoot + '/'))
                    {
                        const binding = matchCompositionComponentProp(graph, child, ancestry(node));
                        if (binding?.definition?.startsWith(graph.upstreamRoot + '/'))
                        {
                            visit(binding.definition);
                        }
                    }
                }
            }
            visit(call.definition);
            if (reachable.has(native.file))
            {
                return call;
            }
        }
        return null;
    }
    function validateSource(node)
    {
        const source = sourceNodes.get(node.sourceNode ?? node.sourceCall);
        if (!source || source.origin.kind === 'unknown')
        {
            errors.push(error('unknown-rendered-source', node));
            return;
        }
        const chain = ancestry(node);
        const dynamic = chain.map((ancestor) => sourceNodes.get(ancestor.sourceCall))
            .filter((candidate) => ['component-prop', 'component-prop-variants'].includes(candidate?.origin.kind));
        for (const prop of dynamic)
        {
            const binding = matchCompositionComponentProp(graph, prop, chain);
            const reachable = new Set();
            function visit(file)
            {
                if (!file || reachable.has(file))
                {
                    return;
                }
                reachable.add(file);
                graph.nodes.filter((entry) => entry.file === file).forEach((entry) =>
                {
                    visit(entry.definition);
                    entry.definitions?.forEach(visit);
                });
            }
            visit(binding?.definition);
            if (!binding?.target || binding.absent || (binding.target.kind === 'native'
                ? node.tag !== binding.target.name : !reachable.has(source.file)))
            {
                errors.push(error('unknown-rendered-component-prop', node, { sourceNode: prop.id }));
            }
        }
        for (const selector of chain.map((ancestor) => sourceNodes.get(ancestor.sourceCall))
            .filter((candidate) => candidate?.origin.kind === 'component-variants'))
        {
            const reachable = new Set();
            function visit(file)
            {
                if (!file || reachable.has(file))
                {
                    return;
                }
                reachable.add(file);
                graph.nodes.filter((entry) => entry.file === file).forEach((entry) =>
                {
                    visit(entry.definition);
                    entry.definitions?.forEach(visit);
                });
            }
            selector.definitions?.forEach(visit);
            if (source.id !== selector.id && !reachable.has(source.file))
            {
                errors.push(error('unknown-rendered-component-variant', node, { sourceNode: selector.id }));
            }
        }
        if (source.origin.kind === 'native' && source.tag !== node.tag)
        {
            errors.push(error('rendered-source-tag-mismatch', node));
        }
        if (source.origin.kind === 'native-variants' && !source.origin.values.includes(node.tag))
        {
            errors.push(error('unknown-dynamic-native-tag', node));
        }
        if (source.origin.kind === 'native-prop')
        {
            const binding = matchCompositionNativeProp(graph, source, ancestry(node));
            if (!binding || binding.tag !== node.tag)
            {
                errors.push(error('unknown-dynamic-native-tag', node));
            }
        }
        for (const name of ['data-fsus-owner', 'data-fsus-region', 'data-fsus-action', 'data-fsus-action-priority', 'data-fsus-chrome', 'data-fsus-content'])
        {
            if (node.attributes[name] === undefined)
            {
                continue;
            }
            const calls = ancestry(node).map((ancestor) => sourceNodes.get(ancestor.sourceCall)).filter(Boolean);
            if (![source, ...calls].some((candidate) => candidate.attributes[name] === node.attributes[name]))
            {
                errors.push(error('source-owner-attribute-mismatch', node, { attribute: name }));
            }
        }
    }
    const owners = nodes.filter((node) => node.owner);
    for (const node of nodes.filter((node) => node.owner || node.region || node.action || node.surface || node.material
        || node.responsibility || node.content || node.tag === 'h1' || node.semanticRole === 'heading'
        || ['native-prop', 'native-variants'].includes(sourceNodes.get(node.sourceNode)?.origin.kind)))
    {
        validateSource(node);
    }
    const regions = [contract.primaryRegion, ...contract.allowedSecondaryRegions];
    for (const region of regions)
    {
        const matches = nodes.filter((node) => node.region === region.id);
        if (matches.length !== 1 || matches[0]?.owner !== region.ownerId)
        {
            errors.push(error('region-owner-not-exact-one', matches[0], { region: region.id, expectedOwner: region.ownerId, count: matches.length }));
        }
    }
    const knownOwners = new Set(regions.map((region) => region.ownerId));
    for (const node of owners)
    {
        if (!knownOwners.has(node.owner))
        {
            errors.push(error('unknown-owner', node));
        }
        if (owners.filter((candidate) => candidate.owner === node.owner).length !== 1)
        {
            errors.push(error('duplicate-owner-including-hidden', node));
        }
    }
    const headings = nodes.filter((node) => node.tag === 'h1' || (node.semanticRole === 'heading' && node.ariaLevel === '1'));
    if (headings.length !== 1 || !headings[0]?.visible || headings[0]?.inheritedOwner !== contract.pageHeadingOwner.id
        || headings[0]?.inheritedRegion !== contract.pageHeadingOwner.regionId)
    {
        errors.push(error('page-heading-not-exact-one', headings[0], { count: headings.length }));
    }
    const taskHeaders = nodes.filter((node) =>
    {
        const source = sourceNodes.get(node.sourceCall);
        return source?.origin.kind === 'fsusui-public' && source.definition
            && graph.nodes.some((candidate) => candidate.file === source.definition && candidate.tag === 'header')
            && ['ElTaskPageHeader', 'FsusTaskPageHeader'].includes(source.origin.exportName);
    });
    if ((contract.surfaceProfile === 'task' && taskHeaders.length !== 1) || taskHeaders.length > 1)
    {
        errors.push(error('task-header-not-exact-one', taskHeaders[0], { count: taskHeaders.length }));
    }
    const actions = nodes.filter((node) => node.action);
    for (const node of nodes.filter((node) => node.interactive && !node.action && !node.inheritedChrome))
    {
        errors.push(error('unknown-action-identity', node));
    }
    const priority = contract.actionPriority;
    let expected = priority;
    if (priority.kind === 'exclusive-states')
    {
        expected = priority.cases.find((candidate) => candidate.stateId === state?.[priority.stateDimensionId]);
        if (!expected)
        {
            errors.push(error('unknown-exclusive-action-state', null));
        }
        for (const candidate of priority.cases)
        {
            if (candidate !== expected && actions.some((node) => node.action === candidate.primaryActionId && (node.visible || node.operable)))
            {
                errors.push(error('mutually-exclusive-actions-simultaneously-operable', null, { stateId: candidate.stateId }));
            }
        }
    }
    const primaries = actions.filter((node) => node.priority === 'primary' && (priority.kind === 'exact-one' || node.visible));
    const count = expected?.primaryCardinality ?? 1;
    if (primaries.length !== count || (count === 1 && (primaries[0]?.action !== expected?.primaryActionId
        || primaries[0]?.inheritedOwner !== expected?.primaryOwnerId)))
    {
        errors.push(error('primary-action-not-exact', primaries[0], { count: primaries.length, expected: count }));
    }
    for (const node of actions)
    {
        if (!['primary', 'secondary'].includes(node.priority))
        {
            errors.push(error('unknown-action-priority', node));
        }
        if (node.priority === 'secondary' && priority.kind === 'exact-one'
            && !priority.secondaryOwnerIds.includes(node.inheritedOwner))
        {
            errors.push(error('secondary-action-owner-mismatch', node));
        }
        if (node.priority === 'secondary' && priority.kind === 'exclusive-states' && node.visible
            && !expected?.secondaryActions.some((action) => action.actionId === node.action && action.ownerId === node.inheritedOwner))
        {
            errors.push(error('secondary-action-owner-mismatch', node));
        }

    }
    const surfaces = nodes.filter((node) => node.surface || node.material);
    for (const role of contract.surfaceRoles)
    {
        const matches = surfaces.filter((node) => node.inheritedRegion === role.regionId);
        if (matches.length !== 1)
        {
            errors.push(error('surface-role-not-exact-one', matches[0], { region: role.regionId, count: matches.length }));
        }
    }
    const expectedRoles = new Map(contract.surfaceRoles.map((role) => [role.regionId, role]));
    for (const node of surfaces)
    {
        const role = expectedRoles.get(node.inheritedRegion);
        if (!role || node.surface !== role.role || node.material !== role.material)
        {
            errors.push(error('unknown-or-mismatched-surface-role', node));
        }
        const publicCall = publicSource(node);
        const nativeSource = sourceNodes.get(node.sourceNode);
        if (role?.role !== 'document' && publicCall
            && (nativeSource?.attributes['data-fsus-surface'] !== node.surface || nativeSource?.attributes['data-fsus-material'] !== node.material))
        {
            errors.push(error('unproved-public-surface-capability', node));
        }
        if (!publicCall && role?.role !== 'document')
        {
            errors.push(error('local-wrapper-forged-public-surface', node));
        }
        const parent = ancestry(node).slice(1).find((ancestor) => ancestor.surface || ancestor.material);
        if (parent && !contract.allowedSurfaceNesting.pairs.some((pair) => pair.parentRegionId === parent.inheritedRegion
            && pair.childRegionId === node.inheritedRegion))
        {
            errors.push(error('forbidden-surface-nesting', node, { parentRegion: parent.inheritedRegion }));
        }
    }
    for (const node of nodes.filter((node) => node.responsibility || ['fixed', 'sticky'].includes(node.position)))
    {
        const expectedChrome = contract.fixedChromeOwners.find((owner) => owner.id === node.inheritedOwner);
        if (!expectedChrome || node.responsibility !== expectedChrome.responsibility || node.inheritedRegion !== expectedChrome.regionId)
        {
            errors.push(error('unknown-or-excess-chrome-owner', node));
        }
    }
    for (const owner of contract.fixedChromeOwners)
    {
        const matches = nodes.filter((node) => node.responsibility === owner.responsibility && node.inheritedOwner === owner.id);
        if (matches.length !== owner.cardinality)
        {
            errors.push(error('chrome-owner-cardinality', matches[0], { expectedOwner: owner.id, count: matches.length }));
        }
    }
    const order = nodes.filter((node) => contract.contentOrder.includes(node.region)).map((node) => node.region);
    if (JSON.stringify(order) !== JSON.stringify(contract.contentOrder))
    {
        errors.push(error('source-dom-content-order-mismatch', null, { actual: order }));
    }
    for (const node of nodes.filter((node) => contract.contentOrder.includes(node.region)))
    {
        if (node.order !== '0' || ancestry(node).some((ancestor) => ['row-reverse', 'column-reverse'].includes(ancestor.flexDirection)))
        {
            errors.push(error('responsive-content-reorder', node));
        }
        if (node.hidden)
        {
            errors.push(error('hidden-primary-content', node));
        }
    }
    for (const node of nodes.filter((node) => node.content))
    {
        if (nodes.filter((candidate) => candidate.content === node.content).length !== 1 || node.hidden)
        {
            errors.push(error('hidden-or-duplicate-content-owner', node));
        }
    }
    return { schema: 'fsusblog.composition-observation.v1', analyzerVersion: compositionAnalyzerVersion,
        archetype: `${archetype.surface}/${archetype.kind}`, runId, identity, runBinding,
        sourceGraphDigest: compositionDigest(graph), observationDigest: compositionDigest(observation),
        observation, sourceNodes: graph.nodes, errors, observationsPassed: errors.length === 0,
        qualification: 'diagnostic-only', fullVisualVerified: false,
        pendingGates: ['control-legality-admission:#1895', 'required-current-state-bindings:#2099', 'independent-visual-adjudication:#2100'] };
}

export async function probeCompositionPage(page, options)
{
    const observation = await page.evaluate(captureCompositionDom);
    return analyzeCompositionDom({ ...options, observation });
}

export function verifyCompositionObservation(receipt, { graph, identity, runId, runBinding, archetype, state = null })
{
    verifyCompositionIdentity(receipt.identity, identity);
    if (compositionDigest(receipt.runBinding) !== compositionDigest(runBinding) || receipt.runId !== runId || receipt.sourceGraphDigest !== compositionDigest(graph)
        || receipt.observationDigest !== compositionDigest(receipt.observation)
        || receipt.analyzerVersion !== compositionAnalyzerVersion || receipt.fullVisualVerified !== false
        || receipt.qualification !== 'diagnostic-only')
    {
        throw new Error('[composition-analyzer] stale or tampered observation');
    }
    const current = analyzeCompositionDom({ archetype, graph, observation: receipt.observation, identity, currentIdentity: identity, runId, runBinding, state });
    if (compositionDigest(receipt) !== compositionDigest(current))
    {
        throw new Error('[composition-analyzer] analyzer verdict tampered');
    }
    return true;
}
