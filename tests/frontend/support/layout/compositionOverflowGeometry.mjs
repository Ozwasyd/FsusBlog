/**
 * Browser-executable, read-only CSS-pixel observation. Keep the exact body
 * traversal and markers used by compositionDom/compositionGeometry. This is
 * no admission entry: callers must retain the original runtime binding guard.
 */
export function captureCompositionOverflowGeometry()
{
    const document = globalThis.document;
    const elements = [...document.body.querySelectorAll('*')];
    const indexes = new Map(elements.map((element, index) => [element, index]));
    const inherited = (element, attribute) => element.closest(`[${attribute}]`)?.getAttribute(attribute) ?? null;
    const measure = (element) =>
    {
        if (!element)
        {
            return null;
        }
        const style = globalThis.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
            clientLeft: element.clientLeft, scrollLeft: element.scrollLeft,
            rect: { left: rect.left, right: rect.right, width: rect.width },
            style: { overflowX: style.overflowX, overflowY: style.overflowY,
                direction: style.direction, writingMode: style.writingMode,
                position: style.position, transform: style.transform,
                clipPath: style.clipPath, contain: style.contain } };
    };
    return { schema: 'fsusblog.composition-overflow-geometry.v1', url: globalThis.location.href,
        viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
        scroll: { x: globalThis.scrollX, y: globalThis.scrollY },
        compatMode: document.compatMode,
        scrollingElement: document.scrollingElement === document.documentElement ? 'documentElement'
            : document.scrollingElement === document.body ? 'body' : null,
        roots: { scrollingElement: measure(document.scrollingElement),
            documentElement: measure(document.documentElement), body: measure(document.body) },
        nodes: elements.map((element, index) =>
        {
            let hidden = false;
            let current = element;
            while (current)
            {
                const style = globalThis.getComputedStyle(current);
                hidden ||= current.hidden || current.getAttribute('aria-hidden') === 'true'
                    || style.display === 'none' || style.visibility !== 'visible'
                    || style.opacity === '0' || style.contentVisibility === 'hidden';
                current = current.parentElement;
            }
            const rect = element.getBoundingClientRect();
            return { index, parent: indexes.get(element.parentElement) ?? null,
                tag: element.tagName.toLowerCase(),
                sourceNode: element.getAttribute('data-fsus-composition-node'),
                sourceCall: element.getAttribute('data-fsus-composition-call'),
                owner: element.getAttribute('data-fsus-owner'), region: element.getAttribute('data-fsus-region'),
                inheritedOwner: inherited(element, 'data-fsus-owner'),
                inheritedRegion: inherited(element, 'data-fsus-region'),
                hidden, visible: !hidden && rect.width > 0 && rect.height > 0,
                ...measure(element) };
        }) };
}

const correspondenceFields = ['index', 'parent', 'tag', 'sourceNode', 'sourceCall', 'owner', 'region', 'inheritedOwner', 'inheritedRegion', 'hidden', 'visible'];
const markerFields = ['sourceNode', 'sourceCall', 'owner', 'region', 'inheritedOwner', 'inheritedRegion'];
const overflowValues = ['visible', 'auto', 'scroll', 'hidden', 'clip'];

function validMeasurement(measurement)
{
    const rect = measurement?.rect;
    const style = measurement?.style;
    return ['scrollWidth', 'clientWidth', 'clientLeft'].every((field) => Number.isInteger(measurement?.[field]) && measurement[field] >= 0)
        && Number.isFinite(measurement?.scrollLeft)
        && ['left', 'right', 'width'].every((field) => Number.isFinite(rect?.[field]))
        && rect.width >= 0 && rect.right >= rect.left && rect.width === rect.right - rect.left
        && overflowValues.includes(style?.overflowX) && overflowValues.includes(style?.overflowY)
        && ['ltr', 'rtl'].includes(style?.direction)
        && ['static', 'relative', 'absolute', 'fixed', 'sticky'].includes(style?.position)
        && ['writingMode', 'position', 'transform', 'clipPath', 'contain'].every((field) => typeof style?.[field] === 'string' && style[field].trim().length > 0);
}

function validNode(node, index)
{
    return node !== null && typeof node === 'object' && !Array.isArray(node)
        && correspondenceFields.every((field) => Object.hasOwn(node, field))
        && node.index === index && (node.parent === null || (Number.isInteger(node.parent) && node.parent >= 0 && node.parent < index))
        && typeof node.tag === 'string' && node.tag.length > 0
        && markerFields.every((field) => node[field] === null || (typeof node[field] === 'string' && node[field].length > 0))
        && typeof node.hidden === 'boolean' && typeof node.visible === 'boolean'
        && !(node.hidden && node.visible);
}

function validViewport(viewport)
{
    return Number.isFinite(viewport?.width) && viewport.width > 0
        && Number.isFinite(viewport?.height) && viewport.height > 0;
}

/**
 * Deterministic document horizontal-bounds diagnostic, with no tolerance or
 * route exceptions. Inner scrollWidth alone is not document overflow. At a
 * nonzero root horizontal scroll position, negative bounds are ambiguous;
 * retain unsupported evidence instead of moving the browser or guessing.
 * This does not prove text clipping, occlusion, hit targets or matrix coverage.
 */
export function compareCompositionOverflowGeometry(options = {})
{
    const { domObservation, overflowObservation } = options ?? {};
    const errors = [];
    const unsupported = [];
    const boundedInnerScrollers = [];
    const predicate = { predicate: 'document-horizontal-bounds', passed: false };
    const result = () => ({ checkedPredicates: [predicate], errors, unsupported, boundedInnerScrollers,
        observationsPassed: predicate.passed, qualification: 'diagnostic-only',
        fullGeometryVerified: false, fullVisualVerified: false,
        pendingGates: ['semantic-text-clipping', 'full-occlusion', 'hit-targets', 'stable-layout',
            'native-zoom', 'required-current-state-viewport-matrix'] });
    const observation = overflowObservation;
    if (observation?.schema !== 'fsusblog.composition-overflow-geometry.v1'
        || !Array.isArray(domObservation?.nodes) || !domObservation.nodes.length
        || !Array.isArray(observation?.nodes) || !observation.nodes.length
        || typeof domObservation.url !== 'string' || !domObservation.url
        || typeof observation.url !== 'string' || !observation.url
        || !validViewport(domObservation.viewport) || !validViewport(observation.viewport)
        || !Number.isFinite(observation.scroll?.x) || !Number.isFinite(observation.scroll?.y)
        || !['documentElement', 'body'].includes(observation.scrollingElement)
        || !['scrollingElement', 'documentElement', 'body'].every((key) => validMeasurement(observation.roots?.[key])))
    {
        errors.push({ reason: 'missing-or-malformed-overflow-observation' });
        return result();
    }
    if (domObservation.url !== observation.url || domObservation.nodes.length !== observation.nodes.length
        || domObservation.viewport.width !== observation.viewport.width || domObservation.viewport.height !== observation.viewport.height)
    {
        errors.push({ reason: 'dom-overflow-page-viewport-correspondence-mismatch' });
    }
    for (let index = 0; index < observation.nodes.length; index += 1)
    {
        const node = observation.nodes[index];
        const dom = domObservation.nodes[index];
        if (!validNode(node, index) || !validNode(dom, index) || !validMeasurement(node))
        {
            errors.push({ reason: 'malformed-node-observation', node: index });
        }
        else if (correspondenceFields.some((field) => dom[field] !== node[field]))
        {
            errors.push({ reason: 'dom-overflow-node-correspondence-mismatch', node: index });
        }
    }
    if (errors.length)
    {
        return result();
    }
    const roots = observation.roots;
    const scroller = roots.scrollingElement;
    const sameMeasurement = (left, right) => ['scrollWidth', 'clientWidth', 'clientLeft', 'scrollLeft'].every((field) => left[field] === right[field])
        && ['left', 'right', 'width'].every((field) => left.rect[field] === right.rect[field])
        && Object.keys(left.style).every((field) => left.style[field] === right.style[field]);
    if (!sameMeasurement(scroller, roots[observation.scrollingElement]))
    {
        errors.push({ reason: 'scrolling-element-correspondence-mismatch' });
    }
    if (observation.compatMode !== 'CSS1Compat' || observation.scrollingElement !== 'documentElement')
    {
        unsupported.push({ reason: 'unsupported-document-scrolling-mode' });
    }
    if (observation.scroll.x !== 0 || scroller.scrollLeft !== 0)
    {
        unsupported.push({ reason: 'unsupported-root-horizontal-scroll-position' });
    }
    const width = roots.documentElement.clientWidth;
    if (width <= 0 || width > observation.viewport.width)
    {
        errors.push({ reason: 'invalid-document-client-width', actual: width, viewport: observation.viewport.width });
    }
    // Root clientWidth and DOMRect can differ with reserved scrollbar gutters.
    // Keep integer CSSOM width comparisons separate from exact rect bounds.
    const bounds = { left: roots.documentElement.clientLeft,
        right: Math.min(width + roots.documentElement.clientLeft, roots.documentElement.rect.right, observation.viewport.width) };
    if (bounds.right <= bounds.left || roots.documentElement.rect.left < 0)
    {
        errors.push({ reason: 'invalid-document-horizontal-bounds', actual: roots.documentElement.rect });
    }
    const inside = (rect) => rect.left >= bounds.left && rect.right <= bounds.right;
    // When html owns overflow, an auto/scroll body can be an independent
    // bounded scroller rather than the viewport overflow-propagation source.
    const boundedBody = roots.documentElement.style.overflowX !== 'visible'
        && ['auto', 'scroll'].includes(roots.body.style.overflowX)
        && roots.body.clientWidth > 0 && inside(roots.body.rect)
        && roots.body.style.transform === 'none';
    if (boundedBody && roots.body.scrollWidth > roots.body.clientWidth)
    {
        boundedInnerScrollers.push({ root: 'body', scrollWidth: roots.body.scrollWidth, clientWidth: roots.body.clientWidth });
    }
    for (const [root, measurement] of Object.entries(roots))
    {
        if (measurement.scrollWidth > width && !(root === 'body' && boundedBody))
        {
            errors.push({ reason: 'document-horizontal-overflow', root, actual: measurement.scrollWidth, expectedMax: width });
        }
        if (['hidden', 'clip'].includes(measurement.style.overflowX))
        {
            unsupported.push({ reason: 'root-horizontal-masking', root, overflowX: measurement.style.overflowX });
        }
        if (measurement.style.writingMode !== 'horizontal-tb' || measurement.style.transform !== 'none'
            || measurement.style.clipPath !== 'none' || measurement.style.contain !== 'none')
        {
            unsupported.push({ reason: 'unsupported-root-geometry-style', root, style: measurement.style });
        }
    }
    if (!inside(roots.body.rect))
    {
        errors.push({ reason: 'uncontained-root-body-extent', actual: roots.body.rect, expected: bounds });
    }
    for (const node of observation.nodes)
    {
        if (!node.visible)
        {
            continue;
        }
        const details = { node: node.index, sourceNode: node.sourceNode, sourceCall: node.sourceCall,
            owner: node.inheritedOwner, region: node.inheritedRegion };
        if (node.style.writingMode !== 'horizontal-tb' || node.style.clipPath !== 'none' || node.style.transform !== 'none'
            || node.style.contain !== 'none' || ['hidden', 'clip'].includes(node.style.overflowX))
        {
            unsupported.push({ reason: 'unsupported-inner-clipping-or-containment', ...details, style: node.style });
        }
        if (['auto', 'scroll'].includes(node.style.overflowX) && node.clientWidth > 0 && inside(node.rect)
            && node.style.transform === 'none' && node.scrollWidth > node.clientWidth)
        {
            boundedInnerScrollers.push({ ...details, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth });
        }
        if (inside(node.rect))
        {
            continue;
        }
        let parent = node.parent;
        let contained = false;
        // A fixed descendant may escape the scroller's clipping viewport.
        let fixed = node.style.position === 'fixed';
        let absolute = node.style.position === 'absolute';
        while (parent !== null)
        {
            const ancestor = observation.nodes[parent];
            if (!fixed && ['auto', 'scroll'].includes(ancestor.style.overflowX)
                && ancestor.clientWidth > 0 && inside(ancestor.rect) && ancestor.style.transform === 'none')
            {
                if (absolute)
                {
                    unsupported.push({ reason: 'unsupported-positioned-scroll-containment', ...details });
                }
                contained = true;
                break;
            }
            fixed ||= ancestor.style.position === 'fixed';
            absolute ||= ancestor.style.position === 'absolute';
            parent = ancestor.parent;
        }
        if (!contained && boundedBody && !fixed)
        {
            contained = true;
            if (absolute)
            {
                unsupported.push({ reason: 'unsupported-positioned-scroll-containment', ...details });
            }
        }
        if (!contained)
        {
            errors.push({ reason: 'uncontained-horizontal-extent', ...details,
                actual: node.rect, expected: bounds });
        }
    }
    predicate.passed = errors.length === 0 && unsupported.length === 0;
    return result();
}
