/**
 * @typedef {{ x: number; y: number; width: number; height: number; }} PublicPreviewRect
 * @typedef {{ phase: string; rect: PublicPreviewRect | null; }} PublicPreviewHeaderSample
 * @typedef {{ id: string; route: string; scope?: string; tier?: string; viewport: { width: number; height: number; }; viewportWidth?: number; viewportHeight?: number; theme: string; locale: string; zoom: number; surfaceRole?: string; linkedIssues?: number[]; primaryTaskSelectors?: string[]; }} PublicPreviewQualityScenario
 * @typedef {{ schema?: string; mobileMaxWidth?: number; normalHitTargetMinPx?: number; primaryHitTargetHeightMinPx?: number; focusClipTolerancePx?: number; layoutShiftMaxPx?: number; overflowTolerancePx?: number; maxTaskPanels?: number; maxBadges?: number; maxPrimaryActions?: number; maxUnscopedRadiusPx?: number; expressiveRadiusPx?: number; zoomMode?: string; reviewerStatuses?: string[]; localeTokens?: Record<string, string[]>; uiChromeSelectors?: string[]; userContentSelectors?: string[]; primaryHitTargetSelectors?: string[]; panelSelectors?: string[]; badgeSelectors?: string[]; primaryActionSelectors?: string[]; localePreferenceCookieName?: string; }} PublicPreviewQualityPolicy
 * @typedef {{ status: 'pass' | 'fail'; findings: unknown[]; [metric: string]: unknown; }} PublicPreviewMachineCheck
 * @typedef {'pass' | 'fail' | 'needs-design-review'} PublicPreviewQualityStatus
 * @typedef {{ schema: string; id: string; route: string; viewport: { width: number; height: number; }; theme: string; locale: string; zoom: number; surfaceRole: string; linkedIssues: number[]; status: PublicPreviewQualityStatus; machine: Record<'overflow' | 'overlaps' | 'clippedText' | 'hitTargets' | 'focusClipping' | 'localeCoherence' | 'headerStability' | 'primaryTask', PublicPreviewMachineCheck>; reviewer: { classification: PublicPreviewQualityStatus; reasons: string[]; metrics: Record<string, unknown>; }; }} PublicPreviewQualityReport
 * @typedef {{ schema: string; status: PublicPreviewQualityStatus; policyDigest: string | null; scenarioCount: number; reports: PublicPreviewQualityReport[]; }} PublicPreviewQualityMatrix
 */

import {
    createPublicPreviewQualityMatrix as createPublicPreviewQualityMatrixImplementation,
    publicPreviewQualityMatrixSchema as publicPreviewQualityMatrixSchemaImplementation,
    publicPreviewQualityReportSchema as publicPreviewQualityReportSchemaImplementation,
    qualitySidecarFile as qualitySidecarFileImplementation,
    validatePublicPreviewQualityMatrix as validatePublicPreviewQualityMatrixImplementation,
    validatePublicPreviewQualityReport as validatePublicPreviewQualityReportImplementation,
    writePublicPreviewQualityMatrix as writePublicPreviewQualityMatrixImplementation,
    writePublicPreviewQualitySidecar as writePublicPreviewQualitySidecarImplementation
} from './public-preview-quality-contract.mjs';
import {
    applyPublicPreviewZoom as applyPublicPreviewZoomImplementation,
    auditPublicPreviewPage as auditPublicPreviewPageImplementation,
    measurePublicPreviewHeader as measurePublicPreviewHeaderImplementation
} from './public-preview-quality-runtime.mjs';

// Type the existing exports at this public facade; runtime implementations remain the authorities.
/** @type {(reports: PublicPreviewQualityReport[], policyDigest?: string | null) => PublicPreviewQualityMatrix} */
export const createPublicPreviewQualityMatrix = createPublicPreviewQualityMatrixImplementation;

/** @type {string} */
export const publicPreviewQualityMatrixSchema = publicPreviewQualityMatrixSchemaImplementation;

/** @type {string} */
export const publicPreviewQualityReportSchema = publicPreviewQualityReportSchemaImplementation;

/** @type {(directory: string, screenshotFile: string) => string} */
export const qualitySidecarFile = qualitySidecarFileImplementation;

/** @type {(document: unknown, scenarios: PublicPreviewQualityScenario[], policy: PublicPreviewQualityPolicy) => string[]} */
export const validatePublicPreviewQualityMatrix = validatePublicPreviewQualityMatrixImplementation;

/** @type {(report: unknown, expected: PublicPreviewQualityScenario, policy: PublicPreviewQualityPolicy) => string[]} */
export const validatePublicPreviewQualityReport = validatePublicPreviewQualityReportImplementation;

/** @type {(directory: string, matrix: PublicPreviewQualityMatrix) => Promise<string>} */
export const writePublicPreviewQualityMatrix = writePublicPreviewQualityMatrixImplementation;

/** @type {(directory: string, screenshotFile: string, report: PublicPreviewQualityReport) => Promise<string>} */
export const writePublicPreviewQualitySidecar = writePublicPreviewQualitySidecarImplementation;

/** @type {(page: import('@playwright/test').Page, zoom: number) => Promise<void>} */
export const applyPublicPreviewZoom = applyPublicPreviewZoomImplementation;

/** @type {(page: import('@playwright/test').Page, scenario: PublicPreviewQualityScenario, policy: PublicPreviewQualityPolicy, options?: { headerSamples?: PublicPreviewHeaderSample[]; }) => Promise<PublicPreviewQualityReport>} */
export const auditPublicPreviewPage = auditPublicPreviewPageImplementation;

/** @type {(page: import('@playwright/test').Page, phase: string) => Promise<PublicPreviewHeaderSample>} */
export const measurePublicPreviewHeader = measurePublicPreviewHeaderImplementation;
