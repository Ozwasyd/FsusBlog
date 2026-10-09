import { requireCompositionRuntimeBindings, verifyCompositionIdentity } from './compositionContracts.mjs';
import { captureCompositionDom } from './compositionDom.mjs';

/**
 * Runs inside the actual browser, retaining hidden nodes and the DOM capture's
 * traversal/marker correspondence. Reads only; does not establish occlusion.
 */
export function captureCompositionGeometry()
{
    const document = globalThis.document;
    const elements = [...document.body.querySelectorAll('*')];
    const indexes = new Map(elements.map((element, index) => [element, index]));
    const inherited = (element, attribute) => element.closest(`[${attribute}]`)?.getAttribute(attribute) ?? null;
    return {
        url: globalThis.location.href,
        viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
        scroll: { x: globalThis.scrollX, y: globalThis.scrollY },
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
                index,
                parent: indexes.get(element.parentElement) ?? null,
                tag: element.tagName.toLowerCase(),
                sourceNode: element.getAttribute('data-fsus-composition-node'),
                sourceCall: element.getAttribute('data-fsus-composition-call'),
                owner: element.getAttribute('data-fsus-owner'),
                region: element.getAttribute('data-fsus-region'),
                inheritedOwner: inherited(element, 'data-fsus-owner'),
                inheritedRegion: inherited(element, 'data-fsus-region'),
                rect: { x: rect.x, y: rect.y, top: rect.top, right: rect.right,
                    bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height },
                computedVisibility: { display: style.display, visibility: style.visibility,
                    opacity: style.opacity, contentVisibility: style.contentVisibility },
                hidden,
                visible: !hidden && rect.width > 0 && rect.height > 0
            };
        })
    };
}

const correspondenceFields = ['index', 'parent', 'tag', 'sourceNode', 'sourceCall', 'owner', 'region', 'inheritedOwner', 'inheritedRegion'];
const markerFields = ['sourceNode', 'sourceCall', 'owner', 'region', 'inheritedOwner', 'inheritedRegion'];
const rectFields = ['x', 'y', 'top', 'right', 'bottom', 'left', 'width', 'height'];

function validNode(node, index)
{
    return node !== null && typeof node === 'object' && !Array.isArray(node)
        && correspondenceFields.every((field) => Object.hasOwn(node, field))
        && node.index === index && (node.parent === null || (Number.isInteger(node.parent) && node.parent >= 0 && node.parent < index))
        && typeof node.tag === 'string' && node.tag.length > 0
        && markerFields.every((field) => node[field] === null || (typeof node[field] === 'string' && node[field].length > 0))
        && typeof node.hidden === 'boolean' && typeof node.visible === 'boolean';
}

function validViewport(viewport)
{
    return Number.isFinite(viewport?.width) && viewport.width > 0
        && Number.isFinite(viewport?.height) && viewport.height > 0;
}

function validGeometryNode(node)
{
    const rect = node.rect;
    const style = node.computedVisibility;
    return rectFields.every((field) => Number.isFinite(rect?.[field]))
        && rect.width >= 0 && rect.height >= 0 && rect.right >= rect.left && rect.bottom >= rect.top
        && rect.x === rect.left && rect.y === rect.top
        && rect.right === rect.left + rect.width && rect.bottom === rect.top + rect.height
        && ['display', 'visibility', 'opacity', 'contentVisibility'].every((field) => typeof style?.[field] === 'string' && style[field].trim().length > 0)
        && Number.isFinite(Number(style.opacity)) && Number(style.opacity) >= 0 && Number(style.opacity) <= 1
        && (node.hidden || (style.display !== 'none' && style.visibility === 'visible'
            && Number(style.opacity) > 0 && style.contentVisibility !== 'hidden'))
        && node.visible === (!node.hidden && rect.width > 0 && rect.height > 0);
}

/**
 * Pure comparison of the canonical primary-content-visible predicate only.
 * Controlled inputs exercise logic; they are never browser/product evidence.
 * Coordinates are viewport-relative DOMRect values, so scroll is not added.
 */
export function compareCompositionGeometry({ archetype, domObservation, geometryObservation } = {})
{
    const errors = [];
    const checkedPredicates = [];
    const contract = archetype?.compositionContract;
    const invariants = contract?.firstFoldInvariants;
    const primary = contract?.primaryRegion;
    const visible = Array.isArray(invariants) ? invariants.filter((item) => item?.predicate === 'primary-content-visible') : [];
    const result = () => ({ checkedPredicates, errors, observationsPassed: checkedPredicates.length === 1 && errors.length === 0,
        qualification: 'diagnostic-only', fullGeometryVerified: false, fullVisualVerified: false,
        pendingPredicates: Array.isArray(invariants) ? invariants.filter((item) => item?.predicate !== 'primary-content-visible') : [],
        pendingGates: ['full-occlusion', 'focus', 'surface', 'a11y', 'native-zoom', 'required-current-state-matrix'] });
    if (visible.length !== 1 || typeof visible[0]?.id !== 'string' || !visible[0].id
        || typeof primary?.id !== 'string' || !primary.id || typeof primary.ownerId !== 'string' || !primary.ownerId
        || visible[0].regionId !== primary.id)
    {
        errors.push({ reason: 'missing-or-malformed-primary-content-visible-contract' });
        return result();
    }
    const predicate = { id: visible[0].id, predicate: visible[0].predicate, regionId: visible[0].regionId, passed: false };
    checkedPredicates.push(predicate);
    if (!Array.isArray(domObservation?.nodes) || !domObservation.nodes.length
        || !Array.isArray(geometryObservation?.nodes) || !geometryObservation.nodes.length
        || typeof domObservation.url !== 'string' || !domObservation.url
        || domObservation.url !== geometryObservation.url || !validViewport(domObservation.viewport)
        || !validViewport(geometryObservation.viewport) || !Number.isFinite(geometryObservation.scroll?.x)
        || !Number.isFinite(geometryObservation.scroll?.y))
    {
        errors.push({ reason: 'missing-or-malformed-observations' });
        return result();
    }
    if (domObservation.nodes.length !== geometryObservation.nodes.length
        || domObservation.viewport.width !== geometryObservation.viewport.width
        || domObservation.viewport.height !== geometryObservation.viewport.height)
    {
        errors.push({ reason: 'dom-geometry-correspondence-mismatch' });
        return result();
    }
    for (let index = 0; index < domObservation.nodes.length; index += 1)
    {
        const dom = domObservation.nodes[index];
        const geometry = geometryObservation.nodes[index];
        if (!validNode(dom, index) || !validNode(geometry, index) || !validGeometryNode(geometry))
        {
            errors.push({ reason: 'malformed-node-observation', node: index });
            continue;
        }
        const fields = correspondenceFields.filter((field) => dom[field] !== geometry[field]);
        if (fields.length)
        {
            errors.push({ reason: 'dom-geometry-correspondence-mismatch', node: index, fields });
        }
    }
    if (errors.length)
    {
        return result();
    }
    const matches = domObservation.nodes.filter((node) => node.region === primary.id);
    if (matches.length !== 1 || matches[0].owner !== primary.ownerId)
    {
        errors.push({ reason: 'primary-region-owner-not-exact-one', region: primary.id, count: matches.length });
        return result();
    }
    const dom = matches[0];
    const geometry = geometryObservation.nodes[dom.index];
    const rect = geometry.rect;
    const viewport = geometryObservation.viewport;
    if (dom.hidden || !dom.visible || geometry.hidden || !geometry.visible)
    {
        errors.push({ reason: 'primary-content-hidden', node: dom.index });
    }
    if (!(rect.width > 0 && rect.height > 0 && rect.right > rect.left && rect.bottom > rect.top))
    {
        errors.push({ reason: 'primary-content-nonpositive-area', node: dom.index });
    }
    if (!(Math.min(rect.right, viewport.width) > Math.max(rect.left, 0)
        && Math.min(rect.bottom, viewport.height) > Math.max(rect.top, 0)))
    {
        errors.push({ reason: 'primary-content-outside-viewport', node: dom.index });
    }
    predicate.passed = errors.length === 0;
    return result();
}

/**
 * Admission precedes every browser evaluation. The two read-only captures are
 * sequential, not an atomic snapshot; correspondence drift fails comparison.
 * The current contract intentionally refuses pending runtime state bindings.
 */
export async function probeCompositionGeometryPage(page, { inputs, archetypeId, stateId, identity, currentIdentity, runId, runBinding })
{
    requireCompositionRuntimeBindings(inputs);
    verifyCompositionIdentity(identity, currentIdentity);
    const archetype = inputs.matrix.archetypes.find((entry) => `${entry.surface}/${entry.kind}` === archetypeId);
    if (!archetype || !archetype.compositionContract.requiredStateFixtures.some((state) => state.id === stateId)
        || typeof runId !== 'string' || !runId.trim() || !runBinding?.worktree || !runBinding?.analyzerDigest)
    {
        throw new Error('[composition-geometry] current archetype/state/run/source binding required');
    }
    const domObservation = await page.evaluate(captureCompositionDom);
    const geometryObservation = await page.evaluate(captureCompositionGeometry);
    return { archetype: archetypeId, stateId, identity, runId, runBinding, domObservation, geometryObservation,
        ...compareCompositionGeometry({ archetype, domObservation, geometryObservation }) };
}
