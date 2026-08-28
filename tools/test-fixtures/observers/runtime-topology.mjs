/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import { requireDigest, requireSafeId } from '../../test-runtime/contract.mjs';
import { digestCanonical, freezeDeep, plainObject } from '../receipt/canonical.mjs';

import {
    assertOwnedHandle,
    assertReadonlyPort,
    normalizedObserverResult,
    observeDeclaredAbsence,
    readObserverSideEffects,
    sideEffectDelta,
    stableRecords
} from './common.mjs';

function normalizedServices(services, namespace, label)
{
    return stableRecords((services ?? []).map((service) =>
    {
        if (!plainObject(service) || service.ownerNamespace !== namespace)
        {
            throw new Error(`${label} contains an unowned or cross-session role`);
        }
        const runtimeKind = requireSafeId(service.runtimeKind, `${label} runtimeKind`);
        const executableIdentity = runtimeKind === 'container'
            ? { imageDigest: requireDigest(service.imageDigest, `${label} imageDigest`), executableDigest: null }
            : { imageDigest: null, executableDigest: requireDigest(service.executableDigest, `${label} executableDigest`) };
        if (runtimeKind === 'container' && service.imageTag && !service.imageDigest)
        {
            throw new Error(`${label} cannot use tag-only image identity`);
        }
        const resources = {
            cpuUnits: Number(service.resources?.cpuUnits),
            memoryBytes: Number(service.resources?.memoryBytes),
            processLimit: Number(service.resources?.processLimit)
        };
        if (!Number.isFinite(resources.cpuUnits) || resources.cpuUnits <= 0
      || !Number.isSafeInteger(resources.memoryBytes) || resources.memoryBytes <= 0
      || !Number.isSafeInteger(resources.processLimit) || resources.processLimit <= 0)
        {
            throw new Error(`${label} resource limit vector is invalid`);
        }
        return freezeDeep({
            role: requireSafeId(service.role, `${label} role`),
            ownerNamespace: namespace,
            runtimeKind,
            ...executableIdentity,
            networkNamespace: requireSafeId(service.networkNamespace, `${label} network namespace`),
            endpoints: stableRecords((service.endpoints ?? []).map((endpoint) => ({
                role: requireSafeId(endpoint.role, `${label} endpoint role`),
                protocol: requireSafeId(endpoint.protocol, `${label} endpoint protocol`)
            })), ['role'], `${label} endpoints`),
            resources,
            readinessDigest: requireDigest(service.readinessDigest, `${label} readinessDigest`),
            liveness: service.liveness === 'live' ? 'live' : (() =>
{
 throw new Error(`${label} role is not live`);
})()
        });
    }), ['role'], label);
}

export async function observeRuntimeTopology({ domain, identity, context, signal })
{
    if (!domain.startsWith('runtime.') && !domain.startsWith('network.') && domain !== 'browser.service-worker')
    {
        throw new Error(`runtime-topology observer cannot own ${domain}`);
    }
    const handle = assertOwnedHandle(context?.handles?.[domain], identity, domain, 'runtime topology handle');
    const absent = await observeDeclaredAbsence({ domain, identity, context, kind: 'runtime-topology', handle });
    if (absent)
    {
        return absent;
    }
    const port = assertReadonlyPort(context?.ports?.runtimeTopology, ['readOwnedTopology', 'readSideEffectCounters'], 'runtime-topology observer port');
    const before = await readObserverSideEffects(port);
    const actualDocument = await port.readOwnedTopology({ handle, signal });
    if (!plainObject(actualDocument) || actualDocument.readonly !== true
    || actualDocument.namespace !== handle.namespace
    || actualDocument.plannedTopologyDigest !== handle.plannedTopologyDigest)
    {
        throw new Error('runtime topology observation is unowned or planned authority drifted');
    }
    requireDigest(handle.plannedTopologyDigest, 'planned topology digest');
    const planned = normalizedServices(handle.plannedTopology?.services, handle.namespace, 'planned runtime services');
    const actual = normalizedServices(actualDocument.services, handle.namespace, 'actual runtime services');
    if (digestCanonical(planned) !== digestCanonical(actual))
    {
        const plannedRoles = planned.map((service) => service.role);
        const actualRoles = actual.map((service) => service.role);
        throw new Error(`runtime planned/actual topology mismatch roles=${plannedRoles.join(',')} actual=${actualRoles.join(',')}`);
    }
    const after = await readObserverSideEffects(port);
    return normalizedObserverResult({
        kind: 'runtime-topology',
        namespace: requireSafeId(handle.namespace, 'runtime topology namespace'),
        plannedTopologyDigest: handle.plannedTopologyDigest,
        services: actual
    }, {
        observedRoleCount: actual.length,
        diagnosticPidCount: Number(actualDocument.diagnostics?.pidCount ?? 0),
        diagnosticEphemeralPortCount: Number(actualDocument.diagnostics?.ephemeralPortCount ?? 0)
    }, sideEffectDelta(before, after));
}

export function createRuntimeTopologyObserver()
{
    return Object.freeze({ observerId: 'runtime-topology', version: 'v1', observe: observeRuntimeTopology });
}
