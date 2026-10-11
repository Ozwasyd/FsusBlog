import { createArticleWorkspaceMountedEditorResolver } from './articleWorkspaceMountedEditorResolver';
import { articleWorkspaceTabRouter } from './articleWorkspaceTabRouter';
import { verifyAuthoringSessionHostState } from './authoringSessionHost';
import { authoringTabGroupCommandSchema } from './authoringTabGroupRegistry';
import { calculateAuthoringWorkspaceGeometry } from './authoringWorkspaceGeometryPolicy';
import { createAuthoringWorkspaceGroupLayoutPorts } from './authoringWorkspaceGroupLayoutPorts';
import { authoringWorkspaceRatioOwner } from './authoringWorkspaceRatioOwner';
import { createAuthoringWorkspaceSeparatorAdapter } from './authoringWorkspaceSeparatorAdapter';
import { calculateOpenArticleDocumentDigest } from './openArticleDocumentRegistry';

import type { ArticleWorkspaceMountedEditorSource } from './articleWorkspaceMountedEditorResolver';
import type { AuthoringTabGroupProjection, AuthoringTabGroupRegistry } from './authoringTabGroupRegistry';
import type { AuthoringWorkspaceGeometryPlan } from './authoringWorkspaceGeometryPolicy';
import type { AuthoringWorkspaceGroupLayoutSource } from './authoringWorkspaceGroupLayoutPorts';
import type { AuthoringWorkspaceSeparatorBinding, AuthoringWorkspaceSeparatorDisposition, AuthoringWorkspaceSeparatorNames } from './authoringWorkspaceSeparatorAdapter';
import type { AuthoringWorkspaceSessionSource } from './authoringWorkspaceSessionSource';
import type { ResizeSeparatorCancelPayload, ResizeSeparatorPayload } from '@ozwasyd/element-plus';

/** Original owners provide observations; this controller never creates a registry or mount. */
export interface AuthoringWorkspaceLayoutSource extends Omit<AuthoringWorkspaceGroupLayoutSource, 'cancelSeparator'> {
    readonly sessions: AuthoringWorkspaceSessionSource | null;
    readonly mountedEditors: ArticleWorkspaceMountedEditorSource | null;
    /** Revoke synchronously before group/host/measurement identity changes; then notify again. */
    subscribeInvalidation(listener: () => void): () => void;
}

export type AuthoringWorkspaceLayoutBlockReason =
    | 'source-unavailable' | 'source-changed' | 'invalid-geometry'
    | 'effective-layout-publication-required' | 'focused-collapse-owner-mismatch'
    | 'component-measurement-unavailable'
    | 'session-source-unavailable' | 'session-retention-unavailable' | 'mounted-session-unavailable';

type LayoutReadonly<Value> = Value extends object
    ? { readonly [Key in keyof Value]: LayoutReadonly<Value[Key]>; } : Value;

/** Readonly presentation of the original state; opaque owner handles are preserved exactly. */
export type AuthoringWorkspaceLayoutProjection = Readonly<{
    state: LayoutReadonly<AuthoringTabGroupProjection['state']>;
    ratioScope: AuthoringTabGroupProjection['ratioScope'];
    splitRatioRef: AuthoringTabGroupProjection['splitRatioRef'];
}>;

export type AuthoringWorkspaceLayoutObservation = Readonly<{
    status: 'planned' | 'blocked';
    reason: AuthoringWorkspaceLayoutBlockReason | null;
    /** Exact original observation; never an independently mutable group model. */
    projection: AuthoringWorkspaceLayoutProjection | null;
    geometry: AuthoringWorkspaceGeometryPlan | null;
    separator: AuthoringWorkspaceSeparatorBinding;
}>;

const noSeparator: AuthoringWorkspaceSeparatorBinding = Object.freeze({ status: 'blocked' });
// One live visual owner per genuine workspace; stores no group/article/session model.
const layoutOwners = new WeakMap<AuthoringTabGroupRegistry, object>();

/** exportProjection already owns a cloned state. Freeze every mutable member before lending it. */
function freezeProjection<Projection extends AuthoringWorkspaceLayoutProjection>(projection: Projection): Projection
{
    const state = projection.state;
    for (const group of state.groups)
    {
        for (const tab of group.tabs)
        {
            Object.freeze(tab);
        }
        Object.freeze(group.tabs);
        Object.freeze(group);
    }
    for (const activation of state.activationHistory)
    {
        Object.freeze(activation);
    }
    Object.freeze(state.groups);
    Object.freeze(state.focusHistory);
    Object.freeze(state.activationHistory);
    Object.freeze(state.splitRatio);
    Object.freeze(state);
    return Object.freeze(projection);
}

/** Isolate external render consumers. Clone only value state, never owner-issued capabilities. */
export function copyAuthoringWorkspaceLayoutProjection(projection: AuthoringWorkspaceLayoutProjection): AuthoringWorkspaceLayoutProjection
{
    return freezeProjection({ state: structuredClone(projection.state),
        ratioScope: projection.ratioScope, splitRatioRef: projection.splitRatioRef });
}

export function copyAuthoringWorkspaceLayoutObservation(observation: AuthoringWorkspaceLayoutObservation): AuthoringWorkspaceLayoutObservation
{
    return Object.freeze({ ...observation,
        projection: observation.projection ? copyAuthoringWorkspaceLayoutProjection(observation.projection) : null });
}

export function unavailableAuthoringWorkspaceLayout(): AuthoringWorkspaceLayoutObservation
{
    return Object.freeze({ status: 'blocked', reason: 'source-unavailable', projection: null,
        geometry: null, separator: noSeparator });
}

/**
 * Concrete source composition, not a ready/receipt issuer. Every visible group must have
 * an actual original host record and mounted public editor, including hidden retained DOM.
 * Missing effective-state publication/retention is refused, not repaired by local CSS state.
 */
export function createAuthoringWorkspaceLayoutController(source: AuthoringWorkspaceLayoutSource,
    names: AuthoringWorkspaceSeparatorNames, cancelSeparator: () => void)
{
    let epoch = 0n;
    let disposed = false;
    let operating = false;
    let measurementDigest: string | null = null;
    let operationEpoch = epoch;
    const groups = source.groups;
    const sessions = source.sessions;
    const mounts = source.mountedEditors;
    const resolveMounted = mounts ? createArticleWorkspaceMountedEditorResolver(mounts) : null;
    const checked = <Value>(callback: () => Value): Value =>
    {
        const expected = operationEpoch;
        if (disposed || epoch !== expected)
        {
            throw new Error('authoring-workspace-layout-disposed');
        }
        const result = callback();
        if (disposed || epoch !== expected)
        {
            throw new Error('authoring-workspace-layout-revoked');
        }
        return result;
    };
    const sameProjection = (expected: AuthoringTabGroupProjection): boolean =>
    {
        if (!groups.verifyBinding(articleWorkspaceTabRouter.getRegistry()))
        {
            return false;
        }
        const current = groups.exportProjection();
        const { contentDigest, ...body } = expected.state;
        const ratio = authoringWorkspaceRatioOwner.resolve(expected.ratioScope, expected.splitRatioRef);
        return current.ratioScope === expected.ratioScope && current.splitRatioRef === expected.splitRatioRef
            && current.state.revision === expected.state.revision
            && current.state.articleRegistryRevision === expected.state.articleRegistryRevision
            && current.state.contentDigest === contentDigest && calculateOpenArticleDocumentDigest(body) === contentDigest
            && ratio.revision === expected.state.splitRatio.revision
            && ratio.splitRatioPermille === expected.state.splitRatio.splitRatioPermille;
    };
    const retentionReason = (projection: AuthoringTabGroupProjection): AuthoringWorkspaceLayoutBlockReason | null =>
    {
        if (sessions?.groups !== groups || !resolveMounted)
        {
            return 'session-source-unavailable';
        }
        const host = checked(() => sessions.readHostState());
        if (!verifyAuthoringSessionHostState(host))
        {
            return 'session-retention-unavailable';
        }
        for (const group of projection.state.groups)
        {
            for (const tab of group.tabs)
            {
                const entry = articleWorkspaceTabRouter.getRegistry().getEntry(tab.tabId);
                const record = host.sessions.find(session => session.editorSessionRef === tab.editorSessionRef);
                if (!entry || !record || entry.owningGroupId !== group.groupId || record.owningGroupId !== group.groupId
                    || entry.editorSessionRef !== tab.editorSessionRef || record.tabId !== tab.tabId
                    || entry.documentContext.documentEpoch !== tab.documentEpoch || entry.lifecycleRevision !== tab.lifecycleRevision
                    || record.registryEntryDigest !== entry.contentDigest || record.blockReason !== null
                    || record.snapshot.editorSessionRef !== tab.editorSessionRef
                    || calculateOpenArticleDocumentDigest(record.snapshot.identity) !== calculateOpenArticleDocumentDigest(entry.identity)
                    || calculateOpenArticleDocumentDigest(record.snapshot.documentContext) !== calculateOpenArticleDocumentDigest(entry.documentContext)
                    || !['active', 'background-retained'].includes(record.lifecycleState))
                {
                    return 'session-retention-unavailable';
                }
                // Inactive tabs need genuine host retention; a group's current tab also
                // needs the original still-mounted public object, even when hidden.
                if (group.activeTabId === tab.tabId)
                {
                    const binding = checked(() => resolveMounted(entry));
                    if (!binding || calculateOpenArticleDocumentDigest(binding.identity) !== calculateOpenArticleDocumentDigest(entry.identity)
                        || calculateOpenArticleDocumentDigest(binding.documentContext) !== calculateOpenArticleDocumentDigest(entry.documentContext))
                    {
                        return 'mounted-session-unavailable';
                    }
                }
            }
        }
        const after = checked(() => sessions.readHostState());
        return after.revision === host.revision && after.contentDigest === host.contentDigest && sameProjection(projection)
            ? null : 'source-changed';
    };
    const originalPorts = createAuthoringWorkspaceGroupLayoutPorts({ groups,
        reserveOperationIdentity: projection => checked(() => source.reserveOperationIdentity(projection)),
        measure: projection =>
        {
            const input = checked(() => source.measure(projection));
            if (measurementDigest !== null && calculateOpenArticleDocumentDigest(input) !== measurementDigest)
            {
                throw new Error('authoring-workspace-layout-measurement-changed');
            }
            return input;
        }, cancelSeparator });
    if (layoutOwners.has(groups))
    {
        throw new Error('authoring-workspace-layout-owner-already-bound');
    }
    const owner = Object.freeze({});
    const adapter = createAuthoringWorkspaceSeparatorAdapter({ ...originalPorts,
        isCurrentProjection: projection => originalPorts.isCurrentProjection(projection)
            && retentionReason(projection) === null }, names);
    layoutOwners.set(groups, owner);
    const invalidate = (): void =>
    {
        epoch++;
        adapter.invalidate();
    };
    const run = <Value>(fallback: Value, callback: () => Value): Value =>
    {
        if (operating || disposed)
        {
            return fallback;
        }
        operating = true;
        const expected = epoch;
        operationEpoch = expected;
        try
        {
            const result = callback();
            return !disposed && epoch === expected ? result : fallback;
        }
        catch
        {
            invalidate();
            return fallback;
        }
        finally
        {
            measurementDigest = null;
            operating = false;
        }
    };
    const refresh = (): AuthoringWorkspaceLayoutObservation => run(unavailableAuthoringWorkspaceLayout(), () =>
    {
        let projection = checked(() => freezeProjection(groups.exportProjection()));
        const block = (reason: AuthoringWorkspaceLayoutBlockReason, geometry: AuthoringWorkspaceGeometryPlan | null = null): AuthoringWorkspaceLayoutObservation =>
        {
            adapter.invalidate();
            return Object.freeze({ status: 'blocked', reason, projection, geometry, separator: noSeparator });
        };
        if (!sameProjection(projection))
        {
            return block('source-changed');
        }
        const ratio = authoringWorkspaceRatioOwner.resolve(projection.ratioScope, projection.splitRatioRef);
        const input = checked(() => source.measure(projection));
        const inputDigest = calculateOpenArticleDocumentDigest(input);
        measurementDigest = inputDigest;
        const geometry = calculateAuthoringWorkspaceGeometry({ ...input,
            requestedLayout: projection.state.layoutState, splitRatioPermille: ratio.splitRatioPermille });
        if (geometry.status !== 'planned')
        {
            return block('invalid-geometry', geometry);
        }
        if (geometry.effectiveLayout === 'single-group'
            && projection.state.effectiveFocusedGroupId !== projection.state.focusedGroupId)
        {
            return block('focused-collapse-owner-mismatch', geometry);
        }
        const reason = retentionReason(projection);
        if (reason)
        {
            return block(reason, geometry);
        }
        if (geometry.effectiveLayout !== projection.state.effectiveLayoutState)
        {
            const identity = checked(() =>
            {
                const issued = source.reserveOperationIdentity(projection);
                return Object.freeze({ commandId: issued.commandId, idempotencyKey: issued.idempotencyKey });
            });
            checked(() => adapter.invalidate());
            if (retentionReason(projection) !== null)
            {
                return block('session-retention-unavailable', geometry);
            }
            const currentInput = checked(() => source.measure(projection));
            if (!sameProjection(projection) || inputDigest !== calculateOpenArticleDocumentDigest(currentInput)
                || disposed || epoch !== operationEpoch)
            {
                return block('source-changed', geometry);
            }
            // A measured-input receipt coordinate, not a runtime capability. The
            // genuine group/revision and opaque ratio handles provide authority.
            const result = groups.execute({ schema: authoringTabGroupCommandSchema, kind: 'set-effective-single',
                commandId: identity.commandId, idempotencyKey: identity.idempotencyKey,
                expectedRevision: projection.state.revision,
                expectedArticleRegistryRevision: projection.state.articleRegistryRevision,
                enabled: geometry.effectiveLayout === 'single-group', viewportStateRef: `viewport:${inputDigest}` });
            if (result.status !== 'applied')
            {
                return block('effective-layout-publication-required', geometry);
            }
            const next = freezeProjection(groups.exportProjection());
            if (next.ratioScope !== projection.ratioScope || next.splitRatioRef !== projection.splitRatioRef
                || next.state.revision !== projection.state.revision + 1
                || next.state.articleRegistryRevision !== projection.state.articleRegistryRevision + 1
                || next.state.activeGroupId !== projection.state.activeGroupId
                || next.state.focusedGroupId !== projection.state.focusedGroupId
                || next.state.effectiveLayoutState !== geometry.effectiveLayout
                || next.state.effectiveFocusedGroupId !== projection.state.focusedGroupId)
            {
                return block('source-changed', geometry);
            }
            projection = next;
            // Publication alone does not realign host records or qualify retention.
            // Refuse until the original host reports the new real entry digests.
            const afterPublication = retentionReason(projection);
            if (afterPublication)
            {
                return block(afterPublication, geometry);
            }
        }
        const separator = geometry.effectiveLayout === 'horizontal-two-group' ? adapter.readBinding() : noSeparator;
        const finalInput = checked(() => source.measure(projection));
        if (!sameProjection(projection) || inputDigest !== calculateOpenArticleDocumentDigest(finalInput)
            || inputDigest !== calculateOpenArticleDocumentDigest(input)
            || geometry.effectiveLayout === 'horizontal-two-group'
                && geometry.minimumEffectiveRatioPermille < geometry.maximumEffectiveRatioPermille && separator.status !== 'planned')
        {
            return block('source-changed', geometry);
        }
        return Object.freeze({ status: 'planned', reason: null, projection, geometry, separator });
    });
    return Object.freeze({ refresh, invalidate,
        start: (payload: ResizeSeparatorPayload): boolean => run(false, () => adapter.start(payload)),
        proposal: (payload: ResizeSeparatorPayload): AuthoringWorkspaceSeparatorDisposition =>
            run<AuthoringWorkspaceSeparatorDisposition>('refused', () => adapter.proposal(payload)),
        end: (payload: ResizeSeparatorPayload): boolean => run(false, () => adapter.end(payload)),
        cancel: (payload: ResizeSeparatorCancelPayload): boolean => run(false, () => adapter.cancel(payload)),
        dispose: (): void =>
        {
            disposed = true;
            epoch++;
            if (layoutOwners.get(groups) === owner)
            {
                layoutOwners.delete(groups);
            }
            adapter.dispose();
        }
    });
}
