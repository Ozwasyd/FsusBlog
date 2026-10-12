import { authoringWorkspaceRatioPolicy, isAuthoringWorkspaceRatioPermille } from './authoringWorkspaceRatioOwner';

/**
 * Product engineering choices for this source offer, not inherited minimum-width tokens.
 * 384 = 24 × public space.4; 128 = 8 × space.4.
 * Separator default 40 follows public --fsus-icon-target; actual footprint is measured.
 */
export const authoringWorkspaceGeometryPolicy = Object.freeze({
    schema: 'fsusblog.authoring-workspace-geometry-policy.v1',
    minimumTwoGroupUsableWidthCssPx: 384,
    minimumFocusedUsableWidthCssPx: 128,
    defaultSplitterFootprintCssPx: 40,
    twoGroupMinimumViewportWidthCssPx: 1024,
    effectiveLayouts: Object.freeze(['single-group', 'horizontal-two-group'] as const),
    hiddenGroupAction: 'retain-or-suspend-with-exact-restore',
    widthAnimation: 'none',
    overflow: 'owned-tab-code-tool-regions-only'
} as const);

/** Coverage requirements, not calculated results or an execution/acceptance receipt. */
export const authoringWorkspaceGeometryRequiredMatrix = Object.freeze({
    viewportWidths: Object.freeze([375, 768, 1024, 1366, 1440] as const),
    browserZoomPercents: Object.freeze([100, 150, 200] as const),
    rail: Object.freeze(['closed', 'open'] as const),
    inspector: Object.freeze(['closed', 'open'] as const),
    input: Object.freeze(['pointer', 'keyboard', 'screen-reader', 'soft-keyboard'] as const),
    appearance: Object.freeze(['light', 'dark', 'forced-colors', 'reduced-motion'] as const)
});

export interface AuthoringWorkspaceRect {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

/**
 * All rectangles/deductions are real measurements in the SAME current CSS-pixel space.
 * frame includes the listed disjoint chrome strips; do not pass an already-inset editor
 * rectangle and subtract its ancestors again. Safe-area insets apply to visualViewport.
 */
export interface AuthoringWorkspaceGeometryInput {
    readonly requestedLayout: 'single-group' | 'horizontal-two-group';
    readonly splitRatioPermille: number;
    readonly layoutViewportWidthCssPx: number;
    readonly layoutViewportHeightCssPx: number;
    readonly browserZoomPercent: number;
    readonly visualViewportScale: number;
    readonly frame: AuthoringWorkspaceRect;
    readonly visualViewport: AuthoringWorkspaceRect;
    readonly railWidthCssPx: number;
    readonly inspectorWidthCssPx: number;
    readonly pageChromeStartCssPx: number;
    readonly pageChromeEndCssPx: number;
    readonly pageChromeTopCssPx: number;
    readonly pageChromeBottomCssPx: number;
    readonly scrollbarWidthCssPx: number;
    /** Actual reserved public separator extent, including its hit region; never private DOM. */
    readonly splitterFootprintCssPx: number;
    readonly leadingGroupChromeWidthCssPx: number;
    readonly trailingGroupChromeWidthCssPx: number;
    readonly focusedGroupChromeWidthCssPx: number;
    readonly safeAreaLeftCssPx: number;
    readonly safeAreaRightCssPx: number;
    readonly safeAreaTopCssPx: number;
    readonly safeAreaBottomCssPx: number;
    readonly mobile: boolean;
    readonly softKeyboardOpen: boolean;
}

interface AdmittedGeometryBase {
    readonly available: AuthoringWorkspaceRect;
    readonly requestedRatioPermille: number;
    readonly preserveGroupSessionAndFocusRefs: true;
    readonly widthAnimation: 'none';
}

export interface AuthoringWorkspaceSingleGeometry extends AdmittedGeometryBase {
    readonly status: 'planned';
    readonly effectiveLayout: 'single-group';
    readonly reason: 'requested-single' | 'mobile' | 'soft-keyboard' | 'narrow-viewport' | 'insufficient-two-group-width';
    readonly focusedGroupUsableWidthCssPx: number;
    readonly minimumUsableWidthCssPx: number;
    readonly hiddenGroupAction: 'retain-or-suspend-with-exact-restore';
}

export interface AuthoringWorkspaceTwoGroupGeometry extends AdmittedGeometryBase {
    readonly status: 'planned';
    readonly effectiveLayout: 'horizontal-two-group';
    readonly leadingGroupWidthCssPx: number;
    readonly trailingGroupWidthCssPx: number;
    readonly leadingGroupUsableWidthCssPx: number;
    readonly trailingGroupUsableWidthCssPx: number;
    readonly splitter: AuthoringWorkspaceRect;
    readonly minimumUsableWidthCssPx: number;
    readonly effectiveRatioPermille: number;
    readonly minimumEffectiveRatioPermille: number;
    readonly maximumEffectiveRatioPermille: number;
}

export interface AuthoringWorkspaceBlockedGeometry {
    readonly status: 'blocked';
    readonly reason: 'invalid-measurement' | 'invalid-layout' | 'invalid-ratio' | 'offscreen-or-zero-area' | 'insufficient-focused-width';
}

export type AuthoringWorkspaceGeometryPlan = AuthoringWorkspaceSingleGeometry
    | AuthoringWorkspaceTwoGroupGeometry | AuthoringWorkspaceBlockedGeometry;

const deductionKeys = Object.freeze([
    'railWidthCssPx', 'inspectorWidthCssPx', 'pageChromeStartCssPx', 'pageChromeEndCssPx',
    'pageChromeTopCssPx', 'pageChromeBottomCssPx', 'scrollbarWidthCssPx',
    'leadingGroupChromeWidthCssPx', 'trailingGroupChromeWidthCssPx', 'focusedGroupChromeWidthCssPx',
    'safeAreaLeftCssPx', 'safeAreaRightCssPx', 'safeAreaTopCssPx', 'safeAreaBottomCssPx'
] as const);

function validRect(rect: AuthoringWorkspaceRect): boolean
{
    return !!rect && [rect.left, rect.top, rect.width, rect.height, rect.left + rect.width, rect.top + rect.height].every(Number.isFinite)
        && rect.width > 0 && rect.height > 0;
}

function blocked(reason: AuthoringWorkspaceBlockedGeometry['reason']): AuthoringWorkspaceBlockedGeometry
{
    return Object.freeze({ status: 'blocked', reason });
}

/**
 * Pure geometry only: owns no group IDs, DOM, session, command, storage or runtime receipt.
 * The future sole layout consumer must resolve the current opaque ratio through its owner
 * and bind this plan to an exact original group/host projection before publishing/rendering.
 * Zoom is already reflected in current CSS measurements; dividing them again is incorrect.
 */
export function calculateAuthoringWorkspaceGeometry(input: AuthoringWorkspaceGeometryInput): AuthoringWorkspaceGeometryPlan
{
    if (!input || !validRect(input.frame) || !validRect(input.visualViewport)
        || !Number.isFinite(input.layoutViewportWidthCssPx) || input.layoutViewportWidthCssPx <= 0
        || !Number.isFinite(input.layoutViewportHeightCssPx) || input.layoutViewportHeightCssPx <= 0
        || !Number.isFinite(input.browserZoomPercent) || input.browserZoomPercent <= 0
        || !Number.isFinite(input.visualViewportScale) || input.visualViewportScale <= 0
        || !Number.isFinite(input.splitterFootprintCssPx) || input.splitterFootprintCssPx <= 0
        || typeof input.mobile !== 'boolean' || typeof input.softKeyboardOpen !== 'boolean'
        || deductionKeys.some(key => !Number.isFinite(input[key]) || input[key] < 0))
    {
        return blocked('invalid-measurement');
    }
    if (input.requestedLayout !== 'single-group' && input.requestedLayout !== 'horizontal-two-group')
    {
        return blocked('invalid-layout');
    }
    if (!isAuthoringWorkspaceRatioPermille(input.splitRatioPermille))
    {
        return blocked('invalid-ratio');
    }

    const frameLeft = input.frame.left + input.railWidthCssPx + input.pageChromeStartCssPx;
    const frameRight = input.frame.left + input.frame.width - input.inspectorWidthCssPx
        - input.pageChromeEndCssPx - input.scrollbarWidthCssPx;
    const frameTop = input.frame.top + input.pageChromeTopCssPx;
    const frameBottom = input.frame.top + input.frame.height - input.pageChromeBottomCssPx;
    const viewportLeft = Math.max(0, input.visualViewport.left) + input.safeAreaLeftCssPx;
    const viewportRight = Math.min(input.layoutViewportWidthCssPx, input.visualViewport.left + input.visualViewport.width)
        - input.safeAreaRightCssPx;
    const viewportTop = Math.max(0, input.visualViewport.top) + input.safeAreaTopCssPx;
    const viewportBottom = Math.min(input.layoutViewportHeightCssPx, input.visualViewport.top + input.visualViewport.height)
        - input.safeAreaBottomCssPx;
    const left = Math.max(frameLeft, viewportLeft);
    const right = Math.min(frameRight, viewportRight);
    const top = Math.max(frameTop, viewportTop);
    const bottom = Math.min(frameBottom, viewportBottom);
    const width = right - left;
    const height = bottom - top;
    if (![left, right, top, bottom, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
    {
        return blocked('offscreen-or-zero-area');
    }
    const focusedUsableWidth = width - input.focusedGroupChromeWidthCssPx;
    if (focusedUsableWidth < authoringWorkspaceGeometryPolicy.minimumFocusedUsableWidthCssPx)
    {
        return blocked('insufficient-focused-width');
    }

    const available = Object.freeze({ left, top, width, height });
    const base = Object.freeze({
        available,
        requestedRatioPermille: input.splitRatioPermille,
        preserveGroupSessionAndFocusRefs: true as const,
        widthAnimation: 'none' as const
    });
    const single = (reason: AuthoringWorkspaceSingleGeometry['reason']): AuthoringWorkspaceSingleGeometry => Object.freeze({
        ...base,
        status: 'planned',
        effectiveLayout: 'single-group',
        reason,
        focusedGroupUsableWidthCssPx: focusedUsableWidth,
        minimumUsableWidthCssPx: authoringWorkspaceGeometryPolicy.minimumFocusedUsableWidthCssPx,
        hiddenGroupAction: authoringWorkspaceGeometryPolicy.hiddenGroupAction
    });

    if (input.requestedLayout === 'single-group')
    {
        return single('requested-single');
    }
    if (input.softKeyboardOpen)
    {
        return single('soft-keyboard');
    }
    if (input.mobile)
    {
        return single('mobile');
    }
    if (Math.min(input.layoutViewportWidthCssPx, input.visualViewport.width)
        < authoringWorkspaceGeometryPolicy.twoGroupMinimumViewportWidthCssPx)
    {
        return single('narrow-viewport');
    }

    const contentWidth = width - input.splitterFootprintCssPx;
    const minimumWidth = authoringWorkspaceGeometryPolicy.minimumTwoGroupUsableWidthCssPx;
    const minimumLeadingWidth = minimumWidth + input.leadingGroupChromeWidthCssPx;
    const minimumTrailingWidth = minimumWidth + input.trailingGroupChromeWidthCssPx;
    // Integral permille bounds round inward, so neither group can fall below its minimum.
    const minimumRatio = Math.max(authoringWorkspaceRatioPolicy.minimumPermille, Math.ceil(minimumLeadingWidth / contentWidth * 1000));
    const maximumRatio = Math.min(authoringWorkspaceRatioPolicy.maximumPermille, Math.floor((contentWidth - minimumTrailingWidth) / contentWidth * 1000));
    if (contentWidth < minimumLeadingWidth + minimumTrailingWidth || minimumRatio > maximumRatio)
    {
        return single('insufficient-two-group-width');
    }
    const effectiveRatio = Math.max(minimumRatio, Math.min(maximumRatio, input.splitRatioPermille));
    const leadingWidth = contentWidth * effectiveRatio / 1000;
    const trailingWidth = contentWidth - leadingWidth;
    const leadingUsableWidth = leadingWidth - input.leadingGroupChromeWidthCssPx;
    const trailingUsableWidth = trailingWidth - input.trailingGroupChromeWidthCssPx;
    if (leadingUsableWidth < minimumWidth || trailingUsableWidth < minimumWidth)
    {
        return single('insufficient-two-group-width');
    }
    const splitter = Object.freeze({
        left: left + leadingWidth,
        top,
        width: input.splitterFootprintCssPx,
        height
    });
    // Keep the user ratio untouched: this clamp is an effective projection, never a CAS write.
    return Object.freeze({
        ...base,
        status: 'planned',
        effectiveLayout: 'horizontal-two-group',
        leadingGroupWidthCssPx: leadingWidth,
        trailingGroupWidthCssPx: trailingWidth,
        leadingGroupUsableWidthCssPx: leadingUsableWidth,
        trailingGroupUsableWidthCssPx: trailingUsableWidth,
        splitter,
        minimumUsableWidthCssPx: minimumWidth,
        effectiveRatioPermille: effectiveRatio,
        minimumEffectiveRatioPermille: minimumRatio,
        maximumEffectiveRatioPermille: maximumRatio
    });
}
