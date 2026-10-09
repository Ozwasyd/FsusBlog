import { verifyCompositionObservation } from './compositionDom.mjs';
import { compareCompositionGeometry } from './compositionGeometry.mjs';

export const compositionChromeGeometryVersion = 'fsusblog.composition-chrome-geometry.v1';

/**
 * Browser-executable, read-only supplemental observation. Uses the existing
 * body-descendant traversal and indexes. Re-reading rectangles, visibility and
 * position detects drift between the sequential DOM/geometry/style captures.
 * The outer html/body styles are retained because they can transform or clip
 * every descendant while being outside the shared indexed traversal.
 */
export function captureCompositionChromeGeometry()
{
    const document = globalThis.document;
    const elements = [...document.body.querySelectorAll('*')];
    const indexes = new Map(elements.map((element, index) => [element, index]));
    const inherited = (element, attribute) => element.closest(`[${attribute}]`)?.getAttribute(attribute) ?? null;
    const paint = (style) => ({ transform: style.transform, perspective: style.perspective,
        filter: style.filter, clipPath: style.clipPath, maskImage: style.maskImage,
        contain: style.contain, overflowX: style.overflowX, overflowY: style.overflowY,
        zIndex: style.zIndex, isolation: style.isolation });
    return {
        url: globalThis.location.href,
        viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
        scroll: { x: globalThis.scrollX, y: globalThis.scrollY },
        roots: [document.documentElement, document.body].map((element) => ({
            tag: element.tagName.toLowerCase(), owner: element.getAttribute('data-fsus-owner'),
            region: element.getAttribute('data-fsus-region'), paint: paint(globalThis.getComputedStyle(element))
        })),
        nodes: elements.map((element, index) =>
        {
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
            const rect = element.getBoundingClientRect();
            return {
                index, parent: indexes.get(element.parentElement) ?? null,
                tag: element.tagName.toLowerCase(), sourceNode: element.getAttribute('data-fsus-composition-node'),
                sourceCall: element.getAttribute('data-fsus-composition-call'),
                owner: element.getAttribute('data-fsus-owner'), region: element.getAttribute('data-fsus-region'),
                inheritedOwner: inherited(element, 'data-fsus-owner'), inheritedRegion: inherited(element, 'data-fsus-region'),
                position: style.position, hidden, visible: !hidden && rect.width > 0 && rect.height > 0,
                rect: { x: rect.x, y: rect.y, top: rect.top, right: rect.right, bottom: rect.bottom,
                    left: rect.left, width: rect.width, height: rect.height },
                paint: paint(style)
            };
        })
    };
}

const correspondenceFields = ['index', 'parent', 'tag', 'sourceNode', 'sourceCall', 'owner', 'region', 'inheritedOwner', 'inheritedRegion'];
const rectFields = ['x', 'y', 'top', 'right', 'bottom', 'left', 'width', 'height'];
const paintFields = ['transform', 'perspective', 'filter', 'clipPath', 'maskImage', 'contain', 'overflowX', 'overflowY', 'zIndex', 'isolation'];
const positions = ['static', 'relative', 'absolute', 'fixed', 'sticky'];

function validPaint(paint)
{
    return paintFields.every((field) => typeof paint?.[field] === 'string' && paint[field].trim().length > 0)
        && (paint.zIndex === 'auto' || /^-?\d+$/u.test(paint.zIndex))
        && ['visible', 'hidden', 'clip', 'scroll', 'auto'].includes(paint.overflowX)
        && ['visible', 'hidden', 'clip', 'scroll', 'auto'].includes(paint.overflowY)
        && ['auto', 'isolate'].includes(paint.isolation);
}

function clip(rect, viewport)
{
    return { left: Math.max(0, rect.left), top: Math.max(0, rect.top),
        right: Math.min(viewport.width, rect.right), bottom: Math.min(viewport.height, rect.bottom) };
}

function positiveArea(rect)
{
    return rect.right > rect.left && rect.bottom > rect.top;
}

function intersection(left, right)
{
    const rect = { left: Math.max(left.left, right.left), top: Math.max(left.top, right.top),
        right: Math.min(left.right, right.right), bottom: Math.min(left.bottom, right.bottom) };
    return positiveArea(rect) ? { ...rect, area: (rect.right - rect.left) * (rect.bottom - rect.top) } : null;
}

/**
 * Rectangular band coverage only; never a generic paint/unoccluded verdict.
 * domReceipt must be the original analyzer result, replayable against currentDom
 * (graph, identity, runId, runBinding, state). This reuses its source, owner and
 * cardinality proof instead of implementing a second ownership analyzer.
 * All coordinates are viewport-relative; scroll is checked, never added.
 * No browser is evaluated here and no runtime binding/receipt is issued.
 * The integrator must retain runtime admission before ALL browser evaluations
 * and include this source in its analyzer/capture source-digest closure.
 */
export function compareCompositionChromeGeometry({ archetype, domReceipt, currentDom, geometryObservation, chromeObservation } = {})
{
    const errors = [];
    const unsupported = [];
    const bands = [];
    const excludedBands = [];
    const checks = [
        { predicate: 'distinct-chrome-bands-no-positive-area-overlap', status: 'unsupported' },
        { predicate: 'primary-region-no-positive-area-band-intersection', status: 'unsupported' }
    ];
    const contract = archetype?.compositionContract;
    const result = () => ({ version: compositionChromeGeometryVersion,
        slice: 'viewport-clipped-rectangular-chrome-band-coverage', checks, bands, excludedBands, errors, unsupported,
        archetype: archetype ? `${archetype.surface}/${archetype.kind}` : null,
        viewport: geometryObservation?.viewport ?? null,
        rectangularCoveragePassed: checks.every((check) => check.status === 'passed'),
        qualification: 'diagnostic-only', fullGeometryVerified: false, fullVisualVerified: false,
        primaryVisualAnchor: { id: contract?.primaryVisualAnchor?.id ?? null, status: 'unsupported',
            reason: 'no-proven-anchor-node-binding-in-current-captures' },
        pendingGates: ['full-paint-transform-stacking-occlusion', 'primary-visual-anchor-binding',
            'required-current-state-matrix', 'native-zoom', 'focus', 'surface', 'a11y'] });
    const unavailable = (reason, details = {}) => unsupported.push({ reason, ...details });
    if (!contract || !Array.isArray(contract.fixedChromeOwners) || !contract.primaryRegion
        || !contract.primaryVisualAnchor || contract.primaryVisualAnchor.regionId !== contract.primaryRegion.id)
    {
        unavailable('missing-or-malformed-chrome-primary-contract');
        return result();
    }
    try
    {
        if (!Array.isArray(currentDom?.graph?.nodes) || !currentDom.identity || !currentDom.runId || !currentDom.runBinding
            || currentDom.graph.nodes.some((node) => typeof node?.id !== 'string' || !node.id)
            || new Set(currentDom.graph.nodes.map((node) => node.id)).size !== currentDom.graph.nodes.length)
        {
            throw new Error('current source/DOM binding unavailable');
        }
        verifyCompositionObservation(domReceipt, { ...currentDom, archetype });
    }
    catch (error)
    {
        unavailable('unproved-current-dom-source-owners', { detail: error.message });
        return result();
    }
    if (!domReceipt.observationsPassed)
    {
        unavailable('dom-analysis-not-passed', { domErrors: domReceipt.errors });
        return result();
    }
    const domObservation = domReceipt.observation;
    const geometry = compareCompositionGeometry({ archetype, domObservation, geometryObservation });
    if (!geometry.observationsPassed)
    {
        unavailable('geometry-correspondence-or-primary-visibility-unavailable', { geometryErrors: geometry.errors });
        return result();
    }
    if (!Array.isArray(chromeObservation?.nodes) || chromeObservation.nodes.length !== domObservation.nodes.length
        || chromeObservation.url !== geometryObservation.url
        || chromeObservation.viewport?.width !== geometryObservation.viewport.width
        || chromeObservation.viewport?.height !== geometryObservation.viewport.height
        || chromeObservation.scroll?.x !== geometryObservation.scroll.x
        || chromeObservation.scroll?.y !== geometryObservation.scroll.y
        || !Array.isArray(chromeObservation.roots) || chromeObservation.roots.length !== 2
        || chromeObservation.roots[0]?.tag !== 'html' || chromeObservation.roots[1]?.tag !== 'body')
    {
        unavailable('chrome-geometry-capture-correspondence-mismatch');
        return result();
    }
    for (const root of chromeObservation.roots)
    {
        if (!validPaint(root.paint) || !['owner', 'region'].every((field) => root[field] === null
            || (typeof root[field] === 'string' && root[field].length > 0)))
        {
            unavailable('malformed-outer-root-evidence', { tag: root.tag });
        }
    }
    for (let index = 0; index < domObservation.nodes.length; index += 1)
    {
        const dom = domObservation.nodes[index];
        const observed = chromeObservation.nodes[index];
        const bounds = geometryObservation.nodes[index];
        if (!observed || correspondenceFields.some((field) => observed[field] !== bounds[field])
            || rectFields.some((field) => !Number.isFinite(observed.rect?.[field]) || observed.rect[field] !== bounds.rect[field])
            || observed.hidden !== bounds.hidden || observed.visible !== bounds.visible
            || dom.hidden !== bounds.hidden || dom.visible !== bounds.visible
            || !positions.includes(observed.position) || observed.position !== dom.position || !validPaint(observed.paint))
        {
            unavailable('chrome-node-layout-or-position-correspondence-mismatch', { node: index });
        }
    }
    if (unsupported.length)
    {
        return result();
    }
    const nodes = domObservation.nodes;
    const ancestry = (node) =>
    {
        const chain = [];
        while (node)
        {
            chain.push(node);
            node = node.parent === null ? null : nodes[node.parent];
        }
        return chain;
    };
    const sourceKeys = new Set();
    function retain(node)
    {
        const chain = ancestry(node);
        for (const field of ['owner', 'region'])
        {
            const provenAncestor = chain.find((ancestor) => ancestor[field] !== null);
            const nearest = provenAncestor?.[field]
                ?? [...chromeObservation.roots].reverse().find((root) => root[field] !== null)?.[field] ?? null;
            const inherited = field === 'owner' ? node.inheritedOwner : node.inheritedRegion;
            if (!provenAncestor)
            {
                unavailable('selected-owner-region-not-in-proven-ancestry', { node: node.index, field });
            }
            if (nearest !== inherited)
            {
                unavailable('nested-owner-region-correspondence-mismatch', { node: node.index, field });
            }
        }
        const key = JSON.stringify([node.sourceNode, chain.map((ancestor) => ancestor.sourceCall).filter(Boolean)]);
        if ((!node.sourceNode && !node.sourceCall) || sourceKeys.has(key))
        {
            unavailable('missing-or-duplicate-selected-source-evidence', { node: node.index });
        }
        sourceKeys.add(key);
        for (const observed of [...chain.map((ancestor) => chromeObservation.nodes[ancestor.index]), ...chromeObservation.roots])
        {
            const effects = ['transform', 'perspective', 'filter', 'clipPath', 'maskImage', 'contain']
                .filter((field) => observed.paint[field] !== 'none');
            // Descendant clipping is not the same rectangle as viewport clipping.
            if (observed !== chromeObservation.nodes[node.index])
            {
                effects.push(...['overflowX', 'overflowY'].filter((field) => !['visible', 'auto', 'scroll'].includes(observed.paint[field])));
            }
            if (effects.length)
            {
                unavailable('unsupported-transformed-or-clipped-rectangular-evidence', {
                    node: node.index, ancestor: observed.index ?? observed.tag, effects
                });
            }
        }
        return clip(geometryObservation.nodes[node.index].rect, geometryObservation.viewport);
    }
    const primary = nodes.find((node) => node.region === contract.primaryRegion.id);
    const primaryRect = retain(primary);
    for (const declared of contract.fixedChromeOwners)
    {
        // Cardinality/ownership were already proven by the original DOM analyzer.
        for (const node of nodes.filter((candidate) => candidate.responsibility === declared.responsibility
            && candidate.inheritedOwner === declared.id && candidate.inheritedRegion === declared.regionId))
        {
            const bounds = geometryObservation.nodes[node.index];
            const band = { node: node.index, sourceNode: node.sourceNode, owner: declared.id,
                region: declared.regionId, responsibility: declared.responsibility, position: node.position };
            if (!['fixed', 'sticky'].includes(node.position) || !bounds.visible)
            {
                excludedBands.push({ ...band, reason: bounds.hidden ? 'hidden' : !bounds.visible ? 'nonpositive-area' : 'not-fixed-or-sticky' });
                continue;
            }
            const rect = retain(node);
            if (!positiveArea(rect))
            {
                excludedBands.push({ ...band, reason: 'outside-viewport' });
                continue;
            }
            // Inert/disabled controls still paint; operability is not visibility.
            bands.push({ ...band, rect });
        }
    }
    if (unsupported.length)
    {
        return result();
    }
    for (let left = 0; left < bands.length; left += 1)
    {
        for (let right = left + 1; right < bands.length; right += 1)
        {
            const overlap = intersection(bands[left].rect, bands[right].rect);
            if (bands[left].owner !== bands[right].owner && overlap)
            {
                errors.push({ reason: 'distinct-chrome-band-positive-area-overlap',
                    bands: [bands[left], bands[right]], intersection: overlap, expected: { intersectionArea: 0 } });
            }
        }
    }
    for (const band of bands)
    {
        const overlap = intersection(primaryRect, band.rect);
        if (overlap)
        {
            errors.push({ reason: 'primary-region-positive-area-band-intersection', band,
                primary: { node: primary.index, sourceNode: primary.sourceNode,
                    owner: primary.owner, region: primary.region, rect: primaryRect }, intersection: overlap, expected: { intersectionArea: 0 } });
        }
    }
    checks[0].status = errors.some((error) => error.reason === 'distinct-chrome-band-positive-area-overlap') ? 'failed' : 'passed';
    checks[1].status = errors.some((error) => error.reason === 'primary-region-positive-area-band-intersection') ? 'failed' : 'passed';
    return result();
}
