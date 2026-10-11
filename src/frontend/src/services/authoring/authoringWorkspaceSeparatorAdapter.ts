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
    let invalidationEpoch = 0n;
    let operating = false;

    const invalidate = (): void =>
    {
        const wasOperating = operating;
        operating = true;
        invalidationEpoch++;
        active = null;
        // Revoke before cancel emits; synchronous cancellation cannot admit a new operation.
        try
        {
            ports.cancelSeparator();
        }
        catch
        {
            // No source admission survives a missing/disposed public handle.
        }
        finally
        {
            operating = wasOperating;
        }
    };
    type Operation = Readonly<{ epoch: bigint; interaction: SeparatorInteraction<Projection> | null; }>;
    const isLive = (operation: Operation): boolean => !disposed
        && invalidationEpoch === operation.epoch && active === operation.interaction;
    const checked = <Value>(operation: Operation, callback: () => Value): Value =>
    {
        if (!isLive(operation))
        {
            throw new Error('separator-operation-invalidated');
        }
        const result = callback();
        if (!isLive(operation))
        {
            throw new Error('separator-operation-invalidated');
        }
        return result;
    };
    const run = <Value>(fallback: Value, callback: (operation: Operation) => Value): Value =>
    {
        if (operating || disposed)
        {
            return fallback;
        }
        operating = true;
        const operation = Object.freeze({ epoch: invalidationEpoch, interaction: active });
        try
        {
            return callback(operation);
        }
        catch
        {
            invalidate();
            return fallback;
        }
        finally
        {
            operating = false;
        }
    };
    const eventValue = (payload: ResizeSeparatorPayload): ResizeSeparatorPayload => Object.freeze({
        value: payload.value, source: payload.source, pointerId: payload.pointerId
    });
    const observe = (operation: Operation): SeparatorSnapshot<Projection> | null =>
    {
        if (!isLive(operation) || !validNames)
        {
            return null;
        }
        try
        {
            const projection = checked(operation, () => ports.readProjection());
            if (!checked(operation, () => ports.isCurrentProjection(projection)))
            {
                return null;
            }
            const scope = checked(operation, () => ports.ratioScope(projection));
            const ratioRef = checked(operation, () => ports.ratioRef(projection));
            const ratio = authoringWorkspaceRatioOwner.resolve(scope, ratioRef);
            const input = checked(operation, () => ports.measure(projection));
            const plan = calculateAuthoringWorkspaceGeometry({ ...input, splitRatioPermille: ratio.splitRatioPermille });
            if (!isLive(operation) || plan.status !== 'planned' || plan.effectiveLayout !== 'horizontal-two-group'
                || plan.minimumEffectiveRatioPermille >= plan.maximumEffectiveRatioPermille)
            {
                return null;
            }
            // Recheck the original owner after measurements and reject callback invalidation.
            if (!checked(operation, () => ports.isCurrentProjection(projection)))
            {
                return null;
            }
            const key = measurementKey(input);
            if (!isLive(operation))
            {
                return null;
            }
            authoringWorkspaceRatioOwner.resolve(scope, ratioRef);
            return isLive(operation) ? Object.freeze({ projection, scope, ratioRef, plan, measurementKey: key }) : null;
        }
        catch
        {
            return null;
        }
    };
    const matches = (interaction: SeparatorInteraction<Projection>, payload: ResizeSeparatorPayload): boolean => validPayload(payload)
        && payload.source === interaction.source && payload.pointerId === interaction.pointerId;
    const currentInteraction = (operation: Operation): SeparatorSnapshot<Projection> | null =>
    {
        const expected = operation.interaction?.snapshot;
        const current = observe(operation);
        try
        {
            if (!current || current.scope !== expected?.scope || current.ratioRef !== expected.ratioRef
                || current.measurementKey !== expected.measurementKey
                || !checked(operation, () => ports.isCurrentProjection(expected.projection)) || !isLive(operation))
            {
                invalidate();
                return null;
            }
            authoringWorkspaceRatioOwner.resolve(current.scope, current.ratioRef);
            return isLive(operation) ? current : null;
        }
        catch
        {
            invalidate();
            return null;
        }
    };
    const blockedBinding: AuthoringWorkspaceSeparatorBinding = Object.freeze({ status: 'blocked' });
    const readBinding = (): AuthoringWorkspaceSeparatorBinding => run<AuthoringWorkspaceSeparatorBinding>(blockedBinding, operation =>
    {
        const snapshot = operation.interaction ? currentInteraction(operation) : observe(operation);
        if (!snapshot || !isLive(operation))
        {
            invalidate();
            return blockedBinding;
        }
        const plan = snapshot.plan;
        const extent = plan.leadingGroupWidthCssPx + plan.trailingGroupWidthCssPx;
        // Coordinates describe the centre of the public handle, in viewport clientX CSS px.
        const origin = plan.available.left + plan.splitter.width / 2;
        const binding: AuthoringWorkspaceSeparatorBinding = Object.freeze({ status: 'planned', props: Object.freeze({ ...naming,
            value: plan.effectiveRatioPermille, min: plan.minimumEffectiveRatioPermille,
            max: plan.maximumEffectiveRatioPermille, step: 1, orientation: 'vertical', disabled: false,
            coordinateRange: Object.freeze({
                start: origin + extent * plan.minimumEffectiveRatioPermille / 1000,
                end: origin + extent * plan.maximumEffectiveRatioPermille / 1000
            }) }) });
        return isLive(operation) ? binding : blockedBinding;
    });
    const start = (payload: ResizeSeparatorPayload): boolean => run(false, operation =>
    {
        const event = eventValue(payload);
        if (!isLive(operation) || operation.interaction || !validPayload(event))
        {
            return false;
        }
        const snapshot = observe(operation);
        if (event.value !== snapshot?.plan.effectiveRatioPermille || !isLive(operation))
        {
            invalidate();
            return false;
        }
        authoringWorkspaceRatioOwner.resolve(snapshot.scope, snapshot.ratioRef);
        if (!isLive(operation))
        {
            return false;
        }
        active = { source: event.source, pointerId: event.pointerId, snapshot };
        return true;
    });
    const proposal = (payload: ResizeSeparatorPayload): AuthoringWorkspaceSeparatorDisposition => run<AuthoringWorkspaceSeparatorDisposition>('refused', operation =>
    {
        const interaction = operation.interaction;
        const event = eventValue(payload);
        if (!isLive(operation) || !interaction || !matches(interaction, event))
        {
            return 'refused';
        }
        const snapshot = currentInteraction(operation);
        if (!snapshot || !isLive(operation) || event.value < snapshot.plan.minimumEffectiveRatioPermille
            || event.value > snapshot.plan.maximumEffectiveRatioPermille)
        {
            invalidate();
            return 'refused';
        }
        if (event.value === snapshot.plan.effectiveRatioPermille)
        {
            return isLive(operation) ? 'unchanged' : 'refused';
        }
        let change: AuthoringWorkspaceRatioChange | null = null;
        let disposition: AuthoringWorkspaceSeparatorDisposition = 'refused';
        try
        {
            // Both barriers precede mutation; the operation lock also covers all observations.
            if (!isLive(operation))
            {
                return 'refused';
            }
            change = authoringWorkspaceRatioOwner.prepare(snapshot.scope, snapshot.ratioRef, event.value);
            if (!isLive(operation))
            {
                return 'refused';
            }
            const projection = checked(operation, () => ports.publishPreparedRatio(snapshot.projection, change!));
            const next = observe(operation);
            if (projection && next?.scope === snapshot.scope && next.ratioRef === change.ratioRef
                && next.measurementKey === snapshot.measurementKey && next.plan.effectiveRatioPermille === event.value
                && checked(operation, () => ports.isCurrentProjection(projection)) && isLive(operation))
            {
                authoringWorkspaceRatioOwner.resolve(next.scope, next.ratioRef);
                if (isLive(operation))
                {
                    interaction.snapshot = next;
                    disposition = 'accepted';
                }
            }
            if (disposition !== 'accepted' && authoringWorkspaceRatioOwner.read(snapshot.scope).ratioRef !== snapshot.ratioRef)
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
        }
        if (disposition !== 'accepted')
        {
            invalidate();
        }
        return disposition;
    });
    const end = (payload: ResizeSeparatorPayload): boolean => run(false, operation =>
    {
        const event = eventValue(payload);
        if (!isLive(operation) || !operation.interaction || !matches(operation.interaction, event))
        {
            return false;
        }
        const snapshot = currentInteraction(operation);
        if (event.value !== snapshot?.plan.effectiveRatioPermille || !isLive(operation))
        {
            invalidate();
            return false;
        }
        active = null;
        invalidationEpoch++;
        // UI921 already emits its final proposal before end; never commit the terminal payload twice.
        return true;
    });
    const cancel = (payload: ResizeSeparatorCancelPayload): boolean =>
    {
        const interaction = active;
        if (!interaction || !matches(interaction, payload) || active !== interaction)
        {
            return false;
        }
        active = null;
        invalidationEpoch++;
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
