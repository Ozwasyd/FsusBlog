import { articleWorkspaceTabRouter } from './articleWorkspaceTabRouter';
import { authoringTabGroupCommandSchema } from './authoringTabGroupRegistry';
import { authoringWorkspaceRatioOwner, authoringWorkspaceRatioPolicy } from './authoringWorkspaceRatioOwner';
import { calculateOpenArticleDocumentDigest } from './openArticleDocumentRegistry';

import type { AuthoringGroupCommandIdentity, AuthoringTabGroupProjection, AuthoringTabGroupRegistry } from './authoringTabGroupRegistry';
import type { AuthoringWorkspaceGeometryInput } from './authoringWorkspaceGeometryPolicy';
import type { AuthoringWorkspaceRatioChange } from './authoringWorkspaceRatioOwner';
import type { AuthoringWorkspaceSeparatorPorts } from './authoringWorkspaceSeparatorAdapter';

export interface AuthoringWorkspaceGroupLayoutSource {
    /** The original #2298 instance, already bound to its actual article registry and ratio scope. */
    readonly groups: AuthoringTabGroupRegistry;
    /** Existing operation-identity authority; allocation may not publish group/session state. */
    reserveOperationIdentity(projection: AuthoringTabGroupProjection): AuthoringGroupCommandIdentity;
    measure(projection: AuthoringTabGroupProjection): Omit<AuthoringWorkspaceGeometryInput, 'requestedLayout' | 'splitRatioPermille'>;
    /** Only the public ResizeSeparatorInstance.cancel(). */
    cancelSeparator(): void;
}

function hasCurrentRatio(projection: AuthoringTabGroupProjection): boolean
{
    const ratio = authoringWorkspaceRatioOwner.resolve(projection.ratioScope, projection.splitRatioRef);
    return projection.state.splitRatio.policySchema === authoringWorkspaceRatioPolicy.schema
        && projection.state.splitRatio.revision === ratio.revision
        && projection.state.splitRatio.splitRatioPermille === ratio.splitRatioPermille;
}

function hasUntamperedState(projection: AuthoringTabGroupProjection): boolean
{
    const { contentDigest, ...body } = projection.state;
    return calculateOpenArticleDocumentDigest(body) === contentDigest;
}

/**
 * Concrete original-group consumption for the generic separator adapter.
 * No registry, scope, session, group shape or atomic publication is created here.
 * Native/layout/host admission remains separate; this source factory does not mount editors.
 */
export function createAuthoringWorkspaceGroupLayoutPorts(source: AuthoringWorkspaceGroupLayoutSource): AuthoringWorkspaceSeparatorPorts<AuthoringTabGroupProjection>
{
    const groups = source.groups;
    if (!groups.verifyBinding(articleWorkspaceTabRouter.getRegistry()))
    {
        throw new Error('authoring-workspace-group-session-registry-mismatch');
    }
    const identities = new WeakMap<AuthoringTabGroupProjection, AuthoringGroupCommandIdentity>();
    const isCurrentProjection = (expected: AuthoringTabGroupProjection): boolean =>
    {
        try
        {
            if (!groups.verifyBinding(articleWorkspaceTabRouter.getRegistry()))
            {
                return false;
            }
            const current = groups.exportProjection();
            return current.ratioScope === expected.ratioScope && current.splitRatioRef === expected.splitRatioRef
                && current.state.revision === expected.state.revision
                && current.state.articleRegistryRevision === expected.state.articleRegistryRevision
                && current.state.contentDigest === expected.state.contentDigest
                && current.state.groups.length === 2 && current.state.layoutState === 'horizontal-two-group'
                && current.state.effectiveLayoutState === 'horizontal-two-group'
                && hasCurrentRatio(expected) && hasCurrentRatio(current) && hasUntamperedState(expected);
        }
        catch
        {
            return false;
        }
    };
    return Object.freeze({
        readProjection: (): AuthoringTabGroupProjection =>
        {
            const projection = groups.exportProjection();
            // Allocation happens inside the adapter's guarded read callback, never in its
            // publication callback. A synchronous invalidate/dispose is rejected on return.
            const identity = source.reserveOperationIdentity(projection);
            identities.set(projection, Object.freeze({ commandId: identity.commandId, idempotencyKey: identity.idempotencyKey }));
            return projection;
        },
        ratioScope: (projection: AuthoringTabGroupProjection) => projection.ratioScope,
        ratioRef: (projection: AuthoringTabGroupProjection) => projection.splitRatioRef,
        isCurrentProjection,
        measure: (projection: AuthoringTabGroupProjection): Omit<AuthoringWorkspaceGeometryInput, 'splitRatioPermille'> => ({
            ...source.measure(projection), requestedLayout: projection.state.layoutState
        }),
        publishPreparedRatio: (projection: AuthoringTabGroupProjection, change: AuthoringWorkspaceRatioChange): AuthoringTabGroupProjection | null =>
        {
            const identity = identities.get(projection);
            if (!identity || !isCurrentProjection(projection))
            {
                return null;
            }
            const prepared = authoringWorkspaceRatioOwner.readPrepared(projection.ratioScope, change);
            if (prepared.expectedRatioRef !== projection.splitRatioRef
                || prepared.revision !== projection.state.splitRatio.revision + 1)
            {
                return null;
            }
            identities.delete(projection);
            // No configurable callbacks/await follow this pre-staging. The original owner
            // alone performs its validated synchronous ratio/group/article joint commit.
            const result = groups.execute({ schema: authoringTabGroupCommandSchema,
                kind: 'set-split-ratio-ref', commandId: identity.commandId, idempotencyKey: identity.idempotencyKey,
                expectedRevision: projection.state.revision,
                expectedArticleRegistryRevision: projection.state.articleRegistryRevision,
                expectedRatioRevision: projection.state.splitRatio.revision,
                splitRatioPermille: prepared.splitRatioPermille }, change);
            if (result.status !== 'applied')
            {
                return null;
            }
            const next = groups.exportProjection();
            if (next.ratioScope !== projection.ratioScope || next.splitRatioRef !== change.ratioRef
                || next.state.revision !== projection.state.revision + 1
                || next.state.articleRegistryRevision !== projection.state.articleRegistryRevision + 1
                || next.state.splitRatio.revision !== prepared.revision
                || next.state.splitRatio.splitRatioPermille !== prepared.splitRatioPermille)
            {
                return null;
            }
            return next;
        },
        cancelSeparator: (): void => source.cancelSeparator()
    });
}
