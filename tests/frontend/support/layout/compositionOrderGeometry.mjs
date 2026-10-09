const correspondenceFields = ['index', 'parent', 'tag', 'sourceNode', 'sourceCall', 'owner', 'region', 'inheritedOwner', 'inheritedRegion'];
const markerFields = correspondenceFields.slice(3);
const rectFields = ['x', 'y', 'top', 'right', 'bottom', 'left', 'width', 'height'];
const layoutFields = ['writingMode', 'direction', 'transform', 'translate', 'rotate', 'scale', 'perspective', 'columnCount', 'columnWidth'];

/**
 * Browser-executable read-only supplement to the existing DOM/geometry captures.
 * Uses their exact body traversal and indexes, retaining hidden elements. Bounds
 * and scroll are repeated to reject movement between the sequential captures.
 * The original runtime guard must admit the run before this function is evaluated.
 */
export function captureCompositionOrderGeometry()
{
    const elements = [...globalThis.document.body.querySelectorAll('*')];
    const indexes = new Map(elements.map((element, index) => [element, index]));
    const inherited = (element, attribute) => element.closest(`[${attribute}]`)?.getAttribute(attribute) ?? null;
    const layout = (element) =>
    {
        const style = globalThis.getComputedStyle(element);
        return { writingMode: style.writingMode, direction: style.direction,
            transform: style.transform, translate: style.translate, rotate: style.rotate, scale: style.scale,
            perspective: style.perspective, columnCount: style.columnCount, columnWidth: style.columnWidth,
            fragmentCount: element.getClientRects().length };
    };
    return { url: globalThis.location.href,
        viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
        scroll: { x: globalThis.scrollX, y: globalThis.scrollY },
        rootLayouts: [layout(globalThis.document.documentElement), layout(globalThis.document.body)],
        nodes: elements.map((element, index) =>
        {
            const rect = element.getBoundingClientRect();
            const style = globalThis.getComputedStyle(element);
            let hidden = false;
            let current = element;
            while (current)
            {
                const currentStyle = globalThis.getComputedStyle(current);
                hidden ||= current.hidden || current.getAttribute('aria-hidden') === 'true'
                    || currentStyle.display === 'none' || currentStyle.visibility !== 'visible'
                    || currentStyle.opacity === '0' || currentStyle.contentVisibility === 'hidden';
                current = current.parentElement;
            }
            return { index, parent: indexes.get(element.parentElement) ?? null, tag: element.tagName.toLowerCase(),
                sourceNode: element.getAttribute('data-fsus-composition-node'), sourceCall: element.getAttribute('data-fsus-composition-call'),
                owner: element.getAttribute('data-fsus-owner'), region: element.getAttribute('data-fsus-region'),
                inheritedOwner: inherited(element, 'data-fsus-owner'), inheritedRegion: inherited(element, 'data-fsus-region'),
                rect: { x: rect.x, y: rect.y, top: rect.top, right: rect.right, bottom: rect.bottom,
                    left: rect.left, width: rect.width, height: rect.height }, layout: layout(element),
                computedVisibility: { display: style.display, visibility: style.visibility,
                    opacity: style.opacity, contentVisibility: style.contentVisibility },
                hidden, visible: !hidden && rect.width > 0 && rect.height > 0 };
        }) };
}

function nonempty(value)
{
    return typeof value === 'string' && value.trim().length > 0;
}

function denseArray(value)
{
    if (!Array.isArray(value))
    {
        return false;
    }
    for (let index = 0; index < value.length; index += 1)
    {
        if (!Object.hasOwn(value, index))
        {
            return false;
        }
    }
    return true;
}

function validNode(node, index)
{
    return node && correspondenceFields.every((field) => Object.hasOwn(node, field))
        && node.index === index && (node.parent === null || (Number.isInteger(node.parent) && node.parent >= 0 && node.parent < index))
        && nonempty(node.tag) && markerFields.every((field) => node[field] === null || nonempty(node[field]));
}

function validRect(rect)
{
    return rectFields.every((field) => Number.isFinite(rect?.[field]))
        && rect.width >= 0 && rect.height >= 0 && rect.x === rect.left && rect.y === rect.top
        && rect.right === rect.left + rect.width && rect.bottom === rect.top + rect.height;
}

function validLayout(layout)
{
    return layoutFields.every((field) => nonempty(layout?.[field]))
        && Number.isInteger(layout.fragmentCount) && layout.fragmentCount >= 0;
}

function validVisibility(node)
{
    const style = node.computedVisibility;
    return typeof node.hidden === 'boolean' && typeof node.visible === 'boolean'
        && ['display', 'visibility', 'opacity', 'contentVisibility'].every((field) => nonempty(style?.[field]))
        && Number.isFinite(Number(style.opacity)) && Number(style.opacity) >= 0 && Number(style.opacity) <= 1
        && (node.hidden || (style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0 && style.contentVisibility !== 'hidden'))
        && node.visible === (!node.hidden && node.rect.width > 0 && node.rect.height > 0);
}

/**
 * Checks only content-order-preserved CSS visibility/positive area, declared ancestry, and bounded
 * peer block-flow relations for ONE viewport observation. Call once per admitted
 * viewport; every result must be retained, including unresolved results.
 *
 * The admitted caller must authenticate source/DOM ownership using the original
 * analyzer and verifyCompositionObservation before consuming this comparison.
 * This pure comparator binds the exact DOM markers and known contract owners;
 * it cannot authenticate source/run, qualify a fixture, or replace that verifier
 * or the original runtime guard. Raw observations alone never establish admission.
 * Numeric unit inputs exercise logic only. No scroll offset is added to DOMRect.
 * Offscreen flow content is retained; first-fold intersection, clipping, occlusion,
 * inline reading/focus order and complete responsive/a11y qualification are not checked.
 */
export function compareCompositionOrderGeometry(observation = {})
{
    const { archetype, domObservation, geometryObservation, orderObservation } = observation ?? {};
    const errors = [];
    const unresolved = [];
    const relationships = [];
    const checkedPredicates = [];
    const contract = archetype?.compositionContract;
    const result = () => ({ checkedPredicates, relationships, errors, unresolved,
        observationsPassed: checkedPredicates.length === 1 && errors.length === 0 && unresolved.length === 0,
        qualification: 'diagnostic-only', fullGeometryVerified: false, fullVisualVerified: false,
        pendingGates: ['source-dom-admission', 'full-occlusion', 'focus', 'surface', 'a11y', 'native-zoom', 'required-current-state-matrix'] });
    const invariants = denseArray(contract?.firstFoldInvariants)
        ? contract.firstFoldInvariants.filter((item) => item?.predicate === 'content-order-preserved') : null;
    const order = contract?.contentOrder;
    const regions = [contract?.primaryRegion, ...(Array.isArray(contract?.allowedSecondaryRegions) ? contract.allowedSecondaryRegions : [])];
    const nesting = contract?.allowedSurfaceNesting;
    if (!Array.isArray(invariants) || invariants.length !== 1 || !nonempty(invariants[0].id)
        || invariants[0].regionId !== contract?.primaryRegion?.id
        || !denseArray(contract?.allowedSecondaryRegions)
        || !denseArray(order) || order.length < 2 || order.some((id) => !nonempty(id)) || new Set(order).size !== order.length
        || regions.some((region) => !nonempty(region?.id) || !nonempty(region?.ownerId))
        || new Set(regions.map((region) => region.id)).size !== regions.length
        || new Set(regions.map((region) => region.ownerId)).size !== regions.length
        || order.some((id) => !regions.some((region) => region.id === id)) || !order.includes(contract.primaryRegion.id)
        || nesting?.mode !== 'explicit-region-pairs' || !denseArray(nesting.pairs))
    {
        errors.push({ reason: 'missing-or-malformed-content-order-contract' });
        return result();
    }
    const predicate = { id: invariants[0].id, predicate: 'content-order-preserved', regionIds: [...order], passed: false };
    checkedPredicates.push(predicate);
    const parents = new Map();
    for (const pair of nesting.pairs)
    {
        if (!regions.some((region) => region.id === pair?.parentRegionId)
            || !regions.some((region) => region.id === pair?.childRegionId)
            || pair.parentRegionId === pair.childRegionId || parents.has(pair.childRegionId))
        {
            errors.push({ reason: 'malformed-nesting-contract' });
            return result();
        }
        parents.set(pair.childRegionId, pair.parentRegionId);
    }
    const regionAncestors = (id) =>
    {
        const ancestors = [];
        while (parents.has(id) && !ancestors.includes(id))
        {
            ancestors.push(id);
            id = parents.get(id);
        }
        return { ancestors, terminal: id };
    };
    if (regions.some(({ id }) => regionAncestors(id).ancestors.includes(regionAncestors(id).terminal)))
    {
        errors.push({ reason: 'cyclic-nesting-contract' });
        return result();
    }
    const captures = [domObservation, geometryObservation, orderObservation];
    if (captures.some((capture) => !nonempty(capture?.url) || !denseArray(capture.nodes) || !capture.nodes.length
        || !Number.isFinite(capture.viewport?.width) || capture.viewport.width <= 0
        || !Number.isFinite(capture.viewport?.height) || capture.viewport.height <= 0)
        || [geometryObservation, orderObservation].some((capture) => !Number.isFinite(capture?.scroll?.x) || !Number.isFinite(capture?.scroll?.y))
        || !denseArray(orderObservation?.rootLayouts) || orderObservation.rootLayouts.length !== 2
        || !orderObservation.rootLayouts.every(validLayout))
    {
        unresolved.push({ reason: 'missing-or-malformed-observations' });
        return result();
    }
    if (captures.some((capture) => capture.url !== domObservation.url || capture.nodes.length !== domObservation.nodes.length
        || capture.viewport.width !== domObservation.viewport.width || capture.viewport.height !== domObservation.viewport.height)
        || geometryObservation.scroll.x !== orderObservation.scroll.x || geometryObservation.scroll.y !== orderObservation.scroll.y)
    {
        unresolved.push({ reason: 'capture-correspondence-mismatch' });
        return result();
    }
    for (let index = 0; index < domObservation.nodes.length; index += 1)
    {
        const dom = domObservation.nodes[index];
        const geometry = geometryObservation.nodes[index];
        const supplemental = orderObservation.nodes[index];
        if (!captures.every((capture) => validNode(capture.nodes[index], index)) || !validRect(geometry?.rect)
            || !validRect(supplemental?.rect) || !validLayout(supplemental?.layout)
            || typeof dom?.hidden !== 'boolean' || typeof dom?.visible !== 'boolean'
            || !validVisibility(geometry) || !validVisibility(supplemental))
        {
            unresolved.push({ reason: 'malformed-node-observation', node: index });
            continue;
        }
        if (dom.hidden !== geometry.hidden || dom.visible !== geometry.visible
            || dom.hidden !== supplemental.hidden || dom.visible !== supplemental.visible
            || ['display', 'visibility', 'opacity', 'contentVisibility'].some((field) => geometry.computedVisibility[field] !== supplemental.computedVisibility[field])
            || correspondenceFields.some((field) => dom[field] !== geometry[field] || dom[field] !== supplemental[field])
            || rectFields.some((field) => geometry.rect[field] !== supplemental.rect[field]))
        {
            unresolved.push({ reason: 'capture-correspondence-mismatch', node: index });
        }
    }
    if (unresolved.length)
    {
        return result();
    }
    const nodes = domObservation.nodes;
    const ancestry = (node) =>
    {
        const chain = [];
        while (node)
        {
            chain.push(node.index);
            node = nodes[node.parent];
        }
        return chain;
    };
    const selected = new Map();
    // Include nesting ancestors even if they are absent from contentOrder.
    const relevant = new Set(order.flatMap((id) => [id, ...regionAncestors(id).ancestors, regionAncestors(id).terminal]));
    for (const id of relevant)
    {
        const region = regions.find((entry) => entry.id === id);
        const matches = nodes.filter((node) => node.region === id);
        if (matches.length !== 1 || matches[0]?.owner !== region.ownerId || (!matches[0]?.sourceNode && !matches[0]?.sourceCall))
        {
            errors.push({ reason: 'region-owner-source-not-exact-one', regionId: id, count: matches.length });
            continue;
        }
        selected.set(id, matches[0]);
        if (!geometryObservation.nodes[matches[0].index].visible)
        {
            errors.push({ reason: 'content-order-region-hidden', regionId: id, node: matches[0].index,
                owner: matches[0].owner, viewport: domObservation.viewport, rect: geometryObservation.nodes[matches[0].index].rect });
        }
    }
    if (errors.length)
    {
        return result();
    }
    for (const id of relevant)
    {
        // Qualify the whole ancestor chain even when this region has no peers.
        // Nested children must not silently escape mixed-mode refusal.
        const layouts = [...orderObservation.rootLayouts, ...ancestry(selected.get(id)).map((index) => orderObservation.nodes[index].layout)];
        if (layouts.some((layout) => layout.transform !== 'none' || layout.translate !== 'none' || layout.rotate !== 'none'
            || layout.scale !== 'none' || layout.perspective !== 'none' || layout.columnCount !== 'auto' || layout.columnWidth !== 'auto'
            || layout.fragmentCount > 1 || !['ltr', 'rtl'].includes(layout.direction)
            || !['horizontal-tb', 'vertical-rl', 'vertical-lr'].includes(layout.writingMode)
            || layout.writingMode !== orderObservation.rootLayouts[0].writingMode))
        {
            unresolved.push({ reason: 'unsupported-flow-arrangement', regionId: id, node: selected.get(id).index,
                viewport: domObservation.viewport, layouts });
        }
    }
    if (unresolved.length)
    {
        return result();
    }
    for (const id of relevant)
    {
        const node = selected.get(id);
        const actualParent = ancestry(node).slice(1).map((index) => nodes[index].region).find((region) => regions.some((entry) => entry.id === region)) ?? null;
        const expectedParent = parents.get(id) ?? null;
        if (actualParent !== expectedParent)
        {
            errors.push({ reason: 'declared-region-ancestry-mismatch', regionId: id, expectedParent, actualParent });
        }
        if (expectedParent)
        {
            relationships.push({ kind: 'declared-ancestry', parentRegionId: expectedParent, childRegionId: id, passed: actualParent === expectedParent });
        }
    }
    if (errors.length)
    {
        return result();
    }
    for (let before = 0; before < order.length; before += 1)
    {
        for (let after = before + 1; after < order.length; after += 1)
        {
            const firstId = order[before];
            const secondId = order[after];
            // Different nesting groups and ancestor/descendant pairs carry no
            // sibling order assertion. Never flatten a nested child into flow.
            if ((parents.get(firstId) ?? null) !== (parents.get(secondId) ?? null))
            {
                continue;
            }
            const first = selected.get(firstId);
            const second = selected.get(secondId);
            const indexes = [...new Set([...ancestry(first), ...ancestry(second)])];
            const layouts = [...orderObservation.rootLayouts, ...indexes.map((index) => orderObservation.nodes[index].layout)];
            const common = ancestry(first).find((index) => ancestry(second).includes(index));
            const flow = common === undefined ? orderObservation.rootLayouts[1] : orderObservation.nodes[common].layout;
            const details = { beforeRegionId: firstId, afterRegionId: secondId, viewport: domObservation.viewport,
                writingMode: flow.writingMode, direction: flow.direction,
                beforeRect: geometryObservation.nodes[first.index].rect, afterRect: geometryObservation.nodes[second.index].rect };
            if (layouts.some((layout) => layout.writingMode !== flow.writingMode))
            {
                unresolved.push({ reason: 'unsupported-flow-arrangement', ...details });
                continue;
            }
            const block = (rect) => flow.writingMode === 'horizontal-tb' ? [rect.top, rect.bottom]
                : flow.writingMode === 'vertical-lr' ? [rect.left, rect.right] : [-rect.right, -rect.left];
            const a = block(details.beforeRect);
            const b = block(details.afterRect);
            if (b[1] <= a[0])
            {
                errors.push({ reason: 'visible-peer-region-inversion', ...details });
                relationships.push({ kind: 'peer-block-flow', ...details, passed: false });
            }
            else if (a[1] <= b[0] || (a[0] === b[0]
                && (details.beforeRect.right <= details.afterRect.left || details.afterRect.right <= details.beforeRect.left
                    || details.beforeRect.bottom <= details.afterRect.top || details.afterRect.bottom <= details.beforeRect.top)))
            {
                relationships.push({ kind: a[1] <= b[0] ? 'peer-block-flow' : 'same-block-start', ...details, passed: true });
            }
            else
            {
                unresolved.push({ reason: 'ambiguous-peer-block-overlap', ...details });
            }
        }
    }
    predicate.passed = errors.length === 0 && unresolved.length === 0;
    return result();
}
