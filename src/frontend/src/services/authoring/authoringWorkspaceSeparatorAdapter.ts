import { calculateAuthoringWorkspaceGeometry } from './authoringWorkspaceGeometryPolicy';
import { authoringWorkspaceRatioOwner, isAuthoringWorkspaceRatioPermille } from './authoringWorkspaceRatioOwner';

import type { AuthoringWorkspaceGeometryInput, AuthoringWorkspaceTwoGroupGeometry } from './authoringWorkspaceGeometryPolicy';
import type { AuthoringWorkspaceRatioChange, AuthoringWorkspaceRatioRef, AuthoringWorkspaceRatioScope } from './authoringWorkspaceRatioOwner';
import type { ResizeSeparatorCancelPayload, ResizeSeparatorCoordinateRange, ResizeSeparatorPayload } from '@ozwasyd/element-plus';

/**
 * Projection is the original group owner's exact exported type, never a local group model.
 * All ports are required. There is no default admission or standalone ratio publication.
 */
export interface AuthoringWorkspaceSeparatorPorts<Projection> {
    readProjection(): Projection;
    ratioScope(projection: Projection): AuthoringWorkspaceRatioScope;
    ratioRef(projection: Projection): AuthoringWorkspaceRatioRef;
    /** Original owner checks group/article revision, digest, focus/epochs and effective state. */
    isCurrentProjection(projection: Projection): boolean;
    measure(projection: Projection): Omit<AuthoringWorkspaceGeometryInput, 'splitRatioPermille'>;
    /** Synchronous original joint transaction; null means refused, not an accepted receipt. */
    publishPreparedRatio(projection: Projection, change: AuthoringWorkspaceRatioChange): Projection | null;
    /** Only the documented ResizeSeparatorInstance.cancel(), never component-private DOM. */
    cancelSeparator(): void;
}

export interface AuthoringWorkspaceSeparatorNames {
    readonly label: string;
    readonly primaryRegionId: string;
    readonly secondaryRegionId: string;
}

export interface AuthoringWorkspaceSeparatorProps extends AuthoringWorkspaceSeparatorNames {
    readonly value: number;
    readonly min: number;
    readonly max: number;
    readonly step: 1;
    readonly orientation: 'vertical';
    readonly disabled: false;
    readonly coordinateRange: ResizeSeparatorCoordinateRange;
}

export type AuthoringWorkspaceSeparatorBinding =
    | { readonly status: 'planned'; readonly props: AuthoringWorkspaceSeparatorProps; }
    | { readonly status: 'blocked'; };

export type AuthoringWorkspaceSeparatorDisposition = 'accepted' | 'unchanged' | 'refused' | 'recovery-required';

interface SeparatorSnapshot<Projection> {
    readonly projection: Projection;
    readonly scope: AuthoringWorkspaceRatioScope;
    readonly ratioRef: AuthoringWorkspaceRatioRef;
    readonly plan: AuthoringWorkspaceTwoGroupGeometry;
    readonly measurementKey: string;
}

interface SeparatorInteraction<Projection> {
    readonly source: ResizeSeparatorPayload['source'];
    readonly pointerId: number | null;
    snapshot: SeparatorSnapshot<Projection>;
}

function validPayload(payload: ResizeSeparatorPayload): boolean
{
    return !!payload && isAuthoringWorkspaceRatioPermille(payload.value)
        && (payload.source === 'keyboard' && payload.pointerId === null
            || payload.source === 'pointer' && Number.isSafeInteger(payload.pointerId) && Number(payload.pointerId) >= 0);
}

/** Numeric measurement fingerprint only; not a capability, content digest or receipt. */
function measurementKey(input: Omit<AuthoringWorkspaceGeometryInput, 'splitRatioPermille'>): string
{
    return JSON.stringify([
        input.requestedLayout, input.layoutViewportWidthCssPx, input.layoutViewportHeightCssPx,
        input.browserZoomPercent, input.visualViewportScale,
        input.frame.left, input.frame.top, input.frame.width, input.frame.height,
        input.visualViewport.left, input.visualViewport.top, input.visualViewport.width, input.visualViewport.height,
        input.railWidthCssPx, input.inspectorWidthCssPx, input.pageChromeStartCssPx, input.pageChromeEndCssPx,
        input.pageChromeTopCssPx, input.pageChromeBottomCssPx, input.scrollbarWidthCssPx, input.splitterFootprintCssPx,
        input.leadingGroupChromeWidthCssPx, input.trailingGroupChromeWidthCssPx, input.focusedGroupChromeWidthCssPx,
        input.safeAreaLeftCssPx, input.safeAreaRightCssPx, input.safeAreaTopCssPx, input.safeAreaBottomCssPx,
        input.mobile, input.softKeyboardOpen
    ]);
}

/**
 * UI921 public proposals -> sole ratio prepare -> original group joint transaction.
 * This adapter neither mounts a separator nor renders/collapses/retains a group/session.
 * An accepted disposition validates the source interaction only; it is no layout receipt.
 */
export function createAuthoringWorkspaceSeparatorAdapter<Projection>(
    ports: AuthoringWorkspaceSeparatorPorts<Projection>, names: AuthoringWorkspaceSeparatorNames)
{
    const naming = Object.freeze({ label: names.label, primaryRegionId: names.primaryRegionId,
        secondaryRegionId: names.secondaryRegionId });
    const validNames = typeof naming.label === 'string' && !!naming.label.trim()
        && [naming.primaryRegionId, naming.secondaryRegionId].every(id => typeof id === 'string' && !!id && !/\s/u.test(id))
        && naming.primaryRegionId !== naming.secondaryRegionId;
    let active: SeparatorInteraction<Projection> | null = null;
    let disposed = false;
    let publishing = false;

    const invalidate = (): void =>
    {
        active = null;
        // Clear first: cancel emits synchronously and may reenter the consumer callback.
        try
        {
            ports.cancelSeparator();
        }
        catch
        {
            // No source admission survives a missing/disposed public handle.
        }
    };
    const observe = (): SeparatorSnapshot<Projection> | null =>
    {
        if (disposed || !validNames)
        {
            return null;
        }
        try
        {
            const projection = ports.readProjection();
            if (!ports.isCurrentProjection(projection))
            {
                return null;
            }
            const scope = ports.ratioScope(projection);
            const ratioRef = ports.ratioRef(projection);
            const ratio = authoringWorkspaceRatioOwner.resolve(scope, ratioRef);
            const input = ports.measure(projection);
            const plan = calculateAuthoringWorkspaceGeometry({ ...input, splitRatioPermille: ratio.splitRatioPermille });
            if (plan.status !== 'planned' || plan.effectiveLayout !== 'horizontal-two-group'
                || plan.minimumEffectiveRatioPermille >= plan.maximumEffectiveRatioPermille)
            {
                return null;
            }
            // Recheck after measurements: host getters must not silently drift the original owner.
            if (!ports.isCurrentProjection(projection))
            {
                return null;
            }
            authoringWorkspaceRatioOwner.resolve(scope, ratioRef);
            return Object.freeze({ projection, scope, ratioRef, plan, measurementKey: measurementKey(input) });
        }
        catch
        {
            return null;
        }
    };
    const sameInteraction = (payload: ResizeSeparatorPayload): boolean => !!active && validPayload(payload)
        && payload.source === active.source && payload.pointerId === active.pointerId;
    const currentInteraction = (): SeparatorSnapshot<Projection> | null =>
    {
        const expected = active?.snapshot;
        const current = observe();
        try
        {
            if (!current || current.scope !== expected?.scope || current.ratioRef !== expected.ratioRef
                || current.measurementKey !== expected.measurementKey || !ports.isCurrentProjection(expected.projection))
            {
                invalidate();
                return null;
            }
            return current;
        }
        catch
        {
            invalidate();
            return null;
        }
    };
    const readBinding = (): AuthoringWorkspaceSeparatorBinding =>
    {
        const snapshot = active ? currentInteraction() : observe();
        if (!snapshot)
        {
            invalidate();
            return Object.freeze({ status: 'blocked' });
        }
        const plan = snapshot.plan;
        const extent = plan.leadingGroupWidthCssPx + plan.trailingGroupWidthCssPx;
        // Coordinates describe the centre of the public handle, in viewport clientX CSS px.
        const origin = plan.available.left + plan.splitter.width / 2;
        return Object.freeze({ status: 'planned', props: Object.freeze({ ...naming,
            value: plan.effectiveRatioPermille, min: plan.minimumEffectiveRatioPermille,
            max: plan.maximumEffectiveRatioPermille, step: 1, orientation: 'vertical', disabled: false,
            coordinateRange: Object.freeze({
                start: origin + extent * plan.minimumEffectiveRatioPermille / 1000,
                end: origin + extent * plan.maximumEffectiveRatioPermille / 1000
            }) }) });
    };
    const start = (payload: ResizeSeparatorPayload): boolean =>
    {
        if (publishing || active || !validPayload(payload))
        {
            return false;
        }
        const snapshot = observe();
        if (payload.value !== snapshot?.plan.effectiveRatioPermille)
        {
            invalidate();
            return false;
        }
        active = { source: payload.source, pointerId: payload.pointerId, snapshot };
        return true;
    };
    const proposal = (payload: ResizeSeparatorPayload): AuthoringWorkspaceSeparatorDisposition =>
    {
        if (publishing || !sameInteraction(payload))
        {
            return 'refused';
        }
        const interaction = active!;
        const snapshot = currentInteraction();
        if (!snapshot || payload.value < snapshot.plan.minimumEffectiveRatioPermille
            || payload.value > snapshot.plan.maximumEffectiveRatioPermille)
        {
            invalidate();
            return 'refused';
        }
        if (payload.value === snapshot.plan.effectiveRatioPermille)
        {
            return 'unchanged';
        }
        let change: AuthoringWorkspaceRatioChange | null = null;
        let disposition: AuthoringWorkspaceSeparatorDisposition = 'refused';
        publishing = true;
        try
        {
            change = authoringWorkspaceRatioOwner.prepare(snapshot.scope, snapshot.ratioRef, payload.value);
            const projection = ports.publishPreparedRatio(snapshot.projection, change);
            const next = observe();
            if (projection && next && active === interaction && next.scope === snapshot.scope
                && next.ratioRef === change.ratioRef && next.measurementKey === snapshot.measurementKey
                && next.plan.effectiveRatioPermille === payload.value && ports.isCurrentProjection(projection))
            {
                interaction.snapshot = next;
                disposition = 'accepted';
            }
            else if (authoringWorkspaceRatioOwner.read(snapshot.scope).ratioRef !== snapshot.ratioRef)
            {
                disposition = 'recovery-required';
            }
        }
        catch
        {
            try
            {
                if (authoringWorkspaceRatioOwner.read(snapshot.scope).ratioRef !== snapshot.ratioRef)
                {
                    disposition = 'recovery-required';
                }
            }
            catch
            {
                disposition = 'recovery-required';
            }
        }
        finally
        {
            if (change)
            {
                try
                {
                    authoringWorkspaceRatioOwner.discard(snapshot.scope, change);
                }
                catch
                {
                    // The original successful transaction consumed it, or its scope was revoked.
                }
            }
            publishing = false;
        }
        if (disposition !== 'accepted')
        {
            invalidate();
        }
        return disposition;
    };
    const end = (payload: ResizeSeparatorPayload): boolean =>
    {
        if (publishing || !sameInteraction(payload))
        {
            return false;
        }
        const snapshot = currentInteraction();
        if (payload.value !== snapshot?.plan.effectiveRatioPermille)
        {
            invalidate();
            return false;
        }
        active = null;
        // UI921 already emits its final proposal before end; never commit the terminal payload twice.
        return true;
    };
    const cancel = (payload: ResizeSeparatorCancelPayload): boolean =>
    {
        if (!sameInteraction(payload))
        {
            return false;
        }
        active = null;
        // Accepted proposals remain accepted. A cancellation is neither rollback nor acceptance.
        return true;
    };
    const dispose = (): void =>
    {
        disposed = true;
        invalidate();
        // Workspace ratio lifetime belongs to the original workspace owner, not this handle.
    };
    return Object.freeze({ readBinding, start, proposal, end, cancel, invalidate, dispose });
}
