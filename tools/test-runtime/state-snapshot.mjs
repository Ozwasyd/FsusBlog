/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import { digestCanonical, freezeDeep, plainObject } from '../test-fixtures/receipt/canonical.mjs';

import {
    normalizeRuntimeIdentity,
    normalizeSemantic,
    requireDigest,
    requireSafeId,
    requireText,
    runtimeBoundaries,
    sealDocument,
    verifySealedDocument
} from './contract.mjs';

export const runtimeStateFragmentSchema = 'fsusblog.runtime-state-fragment.v1';
export const runtimeStateSnapshotSchema = 'fsusblog.runtime-state-snapshot.v1';

function normalizeBoundary(boundary, stepId)
{
    if (!runtimeBoundaries.has(boundary))
    {
        throw new Error(`unknown runtime state boundary ${boundary}`);
    }
    const requiresStep = ['before-mutating-step', 'after-mutating-step'].includes(boundary);
    if (requiresStep !== Boolean(stepId))
    {
        throw new Error(`${boundary} ${requiresStep ? 'requires' : 'forbids'} stepId`);
    }
    return { boundary, stepId: stepId == null ? null : requireSafeId(stepId, 'snapshot stepId') };
}

function indexObservers(authority, observers)
{
    const map = observers instanceof Map ? new Map(observers) : new Map((observers ?? []).map((observer) => [observer?.observerId, observer]));
    const requiredIds = new Set(Object.values(authority.observerBindings ?? {}).map((binding) => binding.observerId));
    for (const id of requiredIds)
    {
        const observer = map.get(id);
        if (!observer || typeof observer.observe !== 'function')
        {
            throw new Error(`required runtime state observer is unavailable: ${id}`);
        }
        if (observer.version !== authority.observerBindings[Object.keys(authority.observerBindings)
            .find((domain) => authority.observerBindings[domain].observerId === id)]?.observerVersion)
        {
            throw new Error(`runtime state observer version drifted: ${id}`);
        }
    }
    for (const id of map.keys())
    {
        if (!requiredIds.has(id))
        {
            throw new Error(`unknown runtime state observer registration: ${id}`);
        }
    }
    return map;
}

export function validateRuntimeStateObserverRegistry(authority, observers)
{
    indexObservers(authority, observers);
    return true;
}

function assertZeroSideEffects(sideEffects, observerId, domain)
{
    if (!plainObject(sideEffects))
    {
        throw new Error(`${observerId}/${domain} did not report side-effect counters`);
    }
    for (const field of ['writes', 'networkMutations', 'tokenRefreshes', 'repairs', 'lifecycleTransitions'])
    {
        if (sideEffects[field] !== 0)
        {
            throw new Error(`${observerId}/${domain} observer side effect detected: ${field}`);
        }
    }
    return freezeDeep(sideEffects);
}

export function buildRuntimeStateFragment({
    identity,
    domain,
    observerId,
    observerVersion,
    boundary,
    stepId = null,
    semantic,
    metadata = {},
    sideEffects
})
{
    const runtimeIdentity = normalizeRuntimeIdentity(identity);
    const location = normalizeBoundary(boundary, stepId);
    const normalizedSemantic = normalizeSemantic(semantic, `${domain} semantic state`);
    const body = {
        schema: runtimeStateFragmentSchema,
        status: 'observed',
        identity: runtimeIdentity,
        domain: requireText(domain, 'fragment domain'),
        observer: {
            id: requireSafeId(observerId, 'observerId'),
            version: requireText(observerVersion, 'observerVersion')
        },
        ...location,
        semantic: normalizedSemantic,
        semanticDigest: digestCanonical(normalizedSemantic),
        metadata: freezeDeep(metadata ?? {}),
        sideEffects: assertZeroSideEffects(sideEffects, observerId, domain)
    };
    return sealDocument(body, 'fragmentDigest');
}

export function validateRuntimeStateFragment(fragment, { identity, binding, boundary, stepId, domain } = {})
{
    if (fragment?.schema !== runtimeStateFragmentSchema || fragment.status !== 'observed')
    {
        throw new Error('runtime state fragment schema/status is invalid');
    }
    verifySealedDocument(fragment, 'fragmentDigest');
    const actualIdentity = normalizeRuntimeIdentity(fragment.identity);
    if (identity && digestCanonical(actualIdentity) !== digestCanonical(normalizeRuntimeIdentity(identity)))
    {
        throw new Error('runtime state fragment is cross-session');
    }
    if (domain && fragment.domain !== domain)
    {
        throw new Error(`runtime state fragment domain mismatch: ${domain}`);
    }
    if (binding && (fragment.observer?.id !== binding.observerId || fragment.observer?.version !== binding.observerVersion))
    {
        throw new Error(`runtime state fragment observer binding drifted: ${fragment.domain}`);
    }
    const expectedLocation = normalizeBoundary(boundary ?? fragment.boundary, stepId ?? fragment.stepId);
    if (fragment.boundary !== expectedLocation.boundary || fragment.stepId !== expectedLocation.stepId)
    {
        throw new Error('runtime state fragment boundary mismatch');
    }
    const semantic = normalizeSemantic(fragment.semantic);
    if (digestCanonical(semantic) !== requireDigest(fragment.semanticDigest, 'semanticDigest'))
    {
        throw new Error('runtime state fragment semantic digest mismatch');
    }
    assertZeroSideEffects(fragment.sideEffects, fragment.observer.id, fragment.domain);
    return true;
}

export async function captureRuntimeStateSnapshot({
    authority,
    identity,
    boundary,
    stepId = null,
    requiredDomains,
    observers,
    context = {},
    signal
})
{
    const runtimeIdentity = normalizeRuntimeIdentity(identity);
    if (runtimeIdentity.catalogDigest !== authority?.catalogDigest)
    {
        throw new Error('snapshot catalog identity drifted before observation');
    }
    const location = normalizeBoundary(boundary, stepId);
    const domains = [...new Set(requiredDomains ?? authority.accessedDomains ?? [])].sort();
    if (domains.length === 0)
    {
        throw new Error('runtime state snapshot has no required domains');
    }
    const observerMap = indexObservers(authority, observers);
    const fragments = [];
    for (const domain of domains)
    {
        if (signal?.aborted)
        {
            throw signal.reason ?? new Error('runtime state observation cancelled');
        }
        const binding = authority.observerBindings?.[domain];
        if (!binding)
        {
            throw new Error(`runtime state domain has no exact observer binding: ${domain}`);
        }
        const observer = observerMap.get(binding.observerId);
        let observed;
        try
        {
            observed = await observer.observe({
                domain,
                identity: runtimeIdentity,
                boundary,
                stepId,
                context,
                signal
            });
        }
        catch (error)
        {
            throw new Error(`runtime state observer ${binding.observerId} failed for ${domain}`, { cause: error });
        }
        if (!plainObject(observed) || observed.status !== 'observed' || !Object.hasOwn(observed, 'semantic'))
        {
            throw new Error(`runtime state observer ${binding.observerId} returned unsupported state for ${domain}`);
        }
        const fragment = buildRuntimeStateFragment({
            identity: runtimeIdentity,
            domain,
            observerId: binding.observerId,
            observerVersion: binding.observerVersion,
            ...location,
            semantic: observed.semantic,
            metadata: observed.metadata,
            sideEffects: observed.sideEffects
        });
        validateRuntimeStateFragment(fragment, { identity: runtimeIdentity, binding, ...location, domain });
        fragments.push(fragment);
    }
    if (new Set(fragments.map((fragment) => fragment.domain)).size !== domains.length)
    {
        throw new Error('runtime state snapshot has duplicate domain fragments');
    }
    const refs = fragments.map((fragment) => ({
        domain: fragment.domain,
        observerId: fragment.observer.id,
        observerVersion: fragment.observer.version,
        fragmentDigest: fragment.fragmentDigest,
        semanticDigest: fragment.semanticDigest
    })).sort((left, right) => left.domain.localeCompare(right.domain));
    const body = {
        schema: runtimeStateSnapshotSchema,
        status: 'complete',
        identity: runtimeIdentity,
        ...location,
        domains,
        fragments: refs,
        semanticDigest: digestCanonical(refs.map(({ domain, semanticDigest }) => ({ domain, semanticDigest })))
    };
    return freezeDeep({ snapshot: sealDocument(body, 'snapshotDigest'), fragments: Object.freeze(fragments) });
}

export function validateRuntimeStateSnapshot(snapshot, { authority, identity, fragments } = {})
{
    if (snapshot?.schema !== runtimeStateSnapshotSchema || snapshot.status !== 'complete')
    {
        throw new Error('runtime state snapshot schema/status is invalid');
    }
    verifySealedDocument(snapshot, 'snapshotDigest');
    const actualIdentity = normalizeRuntimeIdentity(snapshot.identity);
    if (identity && digestCanonical(actualIdentity) !== digestCanonical(normalizeRuntimeIdentity(identity)))
    {
        throw new Error('runtime state snapshot is cross-session');
    }
    if (authority && actualIdentity.catalogDigest !== authority.catalogDigest)
    {
        throw new Error('runtime state snapshot catalog drifted');
    }
    if (!Array.isArray(snapshot.domains) || !Array.isArray(snapshot.fragments)
    || snapshot.domains.length !== snapshot.fragments.length
    || new Set(snapshot.domains).size !== snapshot.domains.length)
    {
        throw new Error('runtime state snapshot domain coverage is incomplete or duplicate');
    }
    const refs = snapshot.fragments;
    if (JSON.stringify(refs.map((entry) => entry.domain)) !== JSON.stringify([...snapshot.domains].sort()))
    {
        throw new Error('runtime state snapshot refs are non-canonical');
    }
    if (digestCanonical(refs.map(({ domain, semanticDigest }) => ({ domain, semanticDigest }))) !== snapshot.semanticDigest)
    {
        throw new Error('runtime state snapshot semantic digest mismatch');
    }
    if (fragments)
    {
        const byDigest = new Map(fragments.map((fragment) => [fragment.fragmentDigest, fragment]));
        for (const ref of refs)
        {
            const fragment = byDigest.get(ref.fragmentDigest);
            if (!fragment)
            {
                throw new Error(`runtime state fragment is missing: ${ref.domain}`);
            }
            validateRuntimeStateFragment(fragment, {
                authority,
                identity: actualIdentity,
                binding: authority?.observerBindings?.[ref.domain],
                boundary: snapshot.boundary,
                stepId: snapshot.stepId,
                domain: ref.domain
            });
            if (fragment.semanticDigest !== ref.semanticDigest)
            {
                throw new Error(`runtime state fragment ref mismatch: ${ref.domain}`);
            }
        }
    }
    return true;
}

export function firstSemanticMismatch(left, right, path = '$')
{
    if (Object.is(left, right))
    {
        return null;
    }
    if (Array.isArray(left) && Array.isArray(right))
    {
        if (left.length !== right.length)
        {
            return { path: `${path}.length`, left: left.length, right: right.length };
        }
        for (let index = 0; index < left.length; index += 1)
        {
            const mismatch = firstSemanticMismatch(left[index], right[index], `${path}[${index}]`);
            if (mismatch)
            {
                return mismatch;
            }
        }
        return null;
    }
    if (plainObject(left) && plainObject(right))
    {
        const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
        for (const key of keys)
        {
            if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key))
            {
                return { path: `${path}.${key}`, left: Object.hasOwn(left, key) ? left[key] : '<absent>', right: Object.hasOwn(right, key) ? right[key] : '<absent>' };
            }
            const mismatch = firstSemanticMismatch(left[key], right[key], `${path}.${key}`);
            if (mismatch)
            {
                return mismatch;
            }
        }
        return null;
    }
    return { path, left, right };
}
