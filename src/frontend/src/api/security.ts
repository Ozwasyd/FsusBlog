import type { BinaryRouteRequest, BinaryTransportRequest } from '@/contracts/binaryTransport';
import { encodeJsonRequest } from '@/codecs/binary/jsonRequestEncoder';
import {
    encodeSecurityChallengeCancelRequest,
    encodeSecurityChallengeIssueRequest,
    encodeSecurityChallengeVerifyRequest
} from '@/codecs/binary/securityRequestEncoder';
import { requestBinaryOnly } from '@/composition/binaryTransport';
import {
    SecurityChallengeKind,
    type PerceptionCharacterV3VerifyPayload,
    type SecurityChallengeIssueResponse,
    type SecurityChallengeVerifyResponse
} from '@/contracts/binaryApi';
import type { SecuritySystemModesValue, SecurityRiskPolicyOutcomesValue, SecurityRiskPolicyReasonsValue } from '@/contracts/securityRiskPolicyCatalog.generated';
import { getBrowserFp } from '@/utils/fingerprint';

import { FrameType } from '@wasm/protocol/frame';

import { encodeAedsFrame } from './binaryFrame';
import { FSUS_HEADERS } from './contracts';


import type { ApiRequestConfig } from './requestConfig';

export { SecurityChallengeKind };
export type {
    PerceptionCharacterV3IssuePayload,
    PerceptionCharacterV3Representation,
    PerceptionCharacterV3VerifyPayload,
    SecurityChallengeAssignment,
    SecurityChallengeEnvelope,
    SecurityChallengeIssueResponse,
    SecurityChallengeProviderPayload,
    SecurityChallengeVerifyResponse
} from '@/contracts/binaryApi';

export type SecurityMode = SecuritySystemModesValue;

export interface AntiCrawlerPolicyOptions {
    mode: SecurityMode;
    publicReadChallengeEnabled: boolean;
    searchCrawlerVerificationEnabled: boolean;
    socialPreviewGuardEnabled: boolean;
    riskScoringEnabled: boolean;
    eventPersistenceEnabled: boolean;
    dashboardAggregationEnabled: boolean;
    cidrAutoUpdateEnabled: boolean;
    illegalPathHardAbortEnabled: boolean;
    requireChallengeScore: number;
    blockScore: number;
    maxRiskScore: number;
    defaultRiskTtlSeconds: number;
    fixedIpPermitLimit: number;
    fixedIpQueueLimit: number;
    verifiedCrawlerFixedIpPermitLimit: number;
    publicReadPermitLimit: number;
    publicReadQueueLimit: number;
    verifiedCrawlerPublicReadPermitLimit: number;
    socialPreviewPublicReadPermitLimit: number;
    readProofPermitLimit: number;
    cidrUpdateIntervalMinutes: number;
    cidrInitialDelaySeconds: number;
    cidrMinUpdateIntervalMinutes: number;
    googleCrawlerRangesUrl: string;
    bingCrawlerRangesUrl: string;
    snapshotPath: string | null;
    socialPreviewAllowedPathPrefixes: string[];
    blockedUserAgentKeywords: string[];
    securityChallengeReference: string;
}

export type AntiCrawlerOptionsUpdateRequest = Partial<AntiCrawlerPolicyOptions> & {
    reason?: string | null;
};

export interface PowPolicyOptions {
    mode: SecurityMode;
    defaultDifficulty: number;
    adaptiveDifficultyEnabled: boolean;
    proofTtlSeconds: number;
    replayProtectionEnabled: boolean;
    riskScoreLinkEnabled: boolean;
    challengeEndpoint: string;
    verificationStrategy: string;
}

export type PowOptionsUpdateRequest = Partial<PowPolicyOptions> & {
    reason?: string | null;
};

export interface AntiCrawlerPolicySnapshot {
    snapshotId: string;
    updatedAtUtc: string;
    updatedBy: string;
    reason: string | null;
    options: AntiCrawlerPolicyOptions;
}

export interface PowPolicySnapshot {
    snapshotId: string;
    updatedAtUtc: string;
    updatedBy: string;
    reason: string | null;
    options: PowPolicyOptions;
}

export interface AntiCrawlerOverviewSummary {
    mode: SecurityMode;
    enabled: boolean;
    enforcing: boolean;
    eventsLastHour: number;
    eventsLastDay: number;
    verifiedCrawlerEvents: number;
    fakeCrawlerEvents: number;
    unknownBotEvents: number;
    blockedUserAgentEvents: number;
    socialPreviewEvents: number;
    riskSnapshotCount: number;
    cidrSource: string;
    googleRanges: number;
    bingRanges: number;
    lastSyncAt: string | null;
    nextSyncAt: string | null;
}

export interface SecurityRiskOverviewResponse {
    eventsLastHour: number;
    eventsLastDay: number;
    snapshotCount: number;
    highRiskSnapshotCount: number;
    topReason: string;
    topSource: string;
}

export interface CrawlerRangesAdminStatus {
    autoUpdateEnabled: boolean;
    updateIntervalMinutes: number;
    minUpdateIntervalMinutes: number;
    initialDelaySeconds: number;
    nextSyncAt: string | null;
    lastStartedAt: string | null;
    lastFinishedAt: string | null;
    lastOutcome: string;
    running: boolean;
    googleRanges: number;
    bingRanges: number;
    lastSyncAt: string | null;
    lastSuccessAt: string | null;
    source: string;
    lastError: string | null;
    googleUrl: string;
    bingUrl: string;
    snapshotPath: string | null;
}

export interface AntiCrawlerRiskEventResponse {
    id: string;
    occurredAtUtc: string;
    source: string;
    reason: string;
    action: string;
    scoreDelta: number;
    totalScore: number;
    ip: string;
    path: string;
    method: string;
    userAgent: string | null;
    detail: string | null;
}

export interface SecurityRiskSnapshotResponse {
    subject: string;
    score: number;
    lastReason: string;
    lastSource: string;
    updatedAtUtc: string;
    expiresAtUtc: string;
}

export interface AntiCrawlerRuleResponse {
    id: string;
    name: string;
    enabled: boolean;
    matchType: string;
    pattern: string;
    action: string;
    score: number;
    notes: string | null;
    updatedAtUtc: string;
    updatedBy: string;
}

export type AntiCrawlerRuleRequest = Omit<AntiCrawlerRuleResponse, 'id' | 'updatedAtUtc' | 'updatedBy'>;

export interface AntiCrawlerListEntryResponse {
    id: string;
    listType: string;
    value: string;
    scope: string;
    reason: string | null;
    enabled: boolean;
    updatedAtUtc: string;
    updatedBy: string;
}

export interface AntiCrawlerListEntryRequest {
    value: string;
    scope: string;
    reason: string | null;
    enabled: boolean;
}

export interface AntiCrawlerSimulationRequest {
    method: string;
    path: string;
    userAgent: string;
    ip: string;
    referer: string | null;
    currentRiskScore: number;
}

export interface AntiCrawlerSimulationResult {
    mode: SecurityMode;
    finalAction: string;
    wouldVerifyCrawler: boolean;
    wouldApplySocialPreviewGuard: boolean;
    wouldRequireChallenge: boolean;
    wouldBlock: boolean;
    scoreDelta: number;
    resultingRiskScore: number;
    matchedRules: string[];
    matchedLists: string[];
    securityChallengeReference: string;
}

export interface PowOverviewResponse {
    policy: PowPolicySnapshot;
    validationFailuresLastHour: number;
    replayRejectsLastHour: number;
    challengeRequiredLastHour: number;
    challengeEndpointStatus: string;
}

export interface SecurityOverviewResponse {
    status: string;
    checkedAtUtc: string;
    antiCrawler: AntiCrawlerOverviewSummary;
    pow: PowOverviewResponse;
    risk: SecurityRiskOverviewResponse;
}

export interface SecurityRiskActionThresholds {
    allowScore: number;
    challengeScore: number;
    hardChallengeScore: number;
    queueScore: number;
    blockScore: number;
}

export interface SecurityRiskDecisionBand {
    outcome: SecurityRiskPolicyOutcomesValue;
    minScore: number;
    maxScore: number;
    challengeKinds: string[];
    escalationLevel: number;
    reason: SecurityRiskPolicyReasonsValue;
}

export interface SecurityRiskActionPolicy {
    actionName: string;
    thresholds: SecurityRiskActionThresholds;
    challengeKind: string;
    escalationLevel: number;
    modeOverride: SecurityMode | null;
    anonymousWriteAllowed: boolean;
    hardChallengeKinds: string[];
    hardChallengeEscalationLevel: number;
    decisionMatrix: string;
    decisionBands: SecurityRiskDecisionBand[];
}

export interface SecurityRiskPolicy {
    digest: string;
    snapshotId: string;
    policyVersion: string;
    updatedAtUtc: string;
    globalMode: SecurityMode;
    maxRiskScore: number;
    strictRiskMultiplierPercent: number;
    lastKnownGoodSnapshotId: string | null;
    defaultAction: SecurityRiskActionPolicy;
    actionOverrides: Record<string, SecurityRiskActionPolicy>;
    subsystemModes: Record<string, string>;
}

export interface PerceptionSealedV2PolicyOptions {
    enabled: boolean;
    localizationEnabled: boolean;
    microInteractionEnabled: boolean;
    poSpaceFallbackEnabled: boolean;
    earlyRejectThreshold: number;
    maxAttempts: number;
    minSolveDurationMs: number;
    maxSolveDurationMs: number;
}

export type PerceptionSealedV2PolicyUpdateRequest = Partial<PerceptionSealedV2PolicyOptions> & {
    reason?: string | null;
};

export interface PerceptionSealedV2PolicySnapshot {
    snapshotId: string;
    policyVersion: string;
    updatedAtUtc: string;
    updatedBy: string;
    reason: string | null;
    lastKnownGoodSnapshotId: string | null;
    options: PerceptionSealedV2PolicyOptions;
}

export interface PerceptionSealedV2TaskKindMetricResponse {
    taskKind: string;
    challengeKind: string;
    issued: number;
    verified: number;
    failed: number;
    replayed: number;
    successRate: number;
    failureRate: number;
    averageSolveDurationMs: number;
    averagePayloadBytes: number;
}

export interface PerceptionSealedV2MetricsResponse {
    windowStartedAtUtc: string;
    issued: number;
    verified: number;
    failed: number;
    replayed: number;
    successRate: number;
    failureRate: number;
    averageSolveDurationMs: number;
    p95SolveDurationMs: number;
    averagePayloadBytes: number;
    p95PayloadBytes: number;
    taskKindDistribution: PerceptionSealedV2TaskKindMetricResponse[];
    recentAttempts: SecurityChallengeAttemptSummaryResponse[];
}

export interface PerceptionSealedV2ConsoleResponse {
    policy: PerceptionSealedV2PolicySnapshot;
    metrics: PerceptionSealedV2MetricsResponse;
    activeRiskPolicy: SecurityRiskPolicy;
}

export interface SecurityRiskEventAggregateResponse {
    source: string;
    reason: string;
    count: number;
    scoreDeltaSum: number;
    maxTotalScore: number;
    lastOccurredAtUtc: string;
}

export interface SecurityChallengeKindBreakdownResponse {
    kind: string;
    totalIssued: number;
    totalAttempts: number;
    verified: number;
    failed: number;
    successRate: number;
    failureRate: number;
}

export interface SecurityChallengeAttemptSummaryResponse {
    attemptId: string;
    challengeId: string;
    kind: string;
    outcome: string;
    reason: string | null;
    action: string;
    routeKey: string;
    attemptedAtUtc: string;
}

export interface SecurityChallengeMetricsResponse {
    kind: string | null;
    windowStartedAtUtc: string;
    totalIssued: number;
    totalAttempts: number;
    verified: number;
    failed: number;
    replayed: number;
    expired: number;
    revoked: number;
    successRate: number;
    failureRate: number;
    kindBreakdown: SecurityChallengeKindBreakdownResponse[];
    recentAttempts: SecurityChallengeAttemptSummaryResponse[];
}

export interface SecurityPolicyVersionSummaryResponse {
    policyId: string;
    version: number;
    mode: SecurityMode;
    active: boolean;
    lastKnownGood: boolean;
    rollbackOfVersion: number | null;
    createdByAdminId: number | null;
    createdAtUtc: string;
    activatedAtUtc: string | null;
    revokedAtUtc: string | null;
    reason: string | null;
}

export interface RiskControlConsoleResponse {
    activePolicy: SecurityRiskPolicy;
    risk: SecurityRiskOverviewResponse;
    riskEventAggregate: SecurityRiskEventAggregateResponse[];
    challengeMetrics: SecurityChallengeMetricsResponse;
    recentEvents: AntiCrawlerRiskEventResponse[];
    topRiskSnapshots: SecurityRiskSnapshotResponse[];
}

export interface RiskControlSimulationRequest {
    action?: string | null;
    routeKey?: string | null;
    subject?: string | null;
    riskScore?: number | null;
    clientIp?: string | null;
    userAgent?: string | null;
    deviceFingerprint?: string | null;
    region?: string | null;
    actorStatus?: string | null;
    identityKind?: string | null;
    verifiedCrawler?: boolean | null;
    socialPreviewBot?: boolean | null;
}

export interface RiskControlSimulationResponse {
    riskScore: number;
    effectiveRiskScore: number;
    decision: string;
    decisionKind: string;
    reasons: string[];
    requiredChallenges: string[];
    policyVersion: string;
    action: string;
    routeKey: string;
    subject: string;
    clientIp: string;
    actorStatus: string;
    identityKind: string;
    escalationLevel: number;
    simulated: boolean;
}

export interface SecurityPolicyConsoleResponse {
    activePolicy: SecurityRiskPolicy;
    antiCrawler: AntiCrawlerPolicySnapshot;
    pow: PowPolicySnapshot;
    policyVersions: SecurityPolicyVersionSummaryResponse[];
}

export interface AntiCrawlerOverviewResponse {
    policy: AntiCrawlerPolicySnapshot;
    summary: AntiCrawlerOverviewSummary;
    crawlerRanges: CrawlerRangesAdminStatus;
    recentEvents: AntiCrawlerRiskEventResponse[];
    rules: AntiCrawlerRuleResponse[];
    allowlist: AntiCrawlerListEntryResponse[];
    blocklist: AntiCrawlerListEntryResponse[];
}

export interface CrawlerRangeSyncResponse {
    status: CrawlerRangesAdminStatus;
    outcome: string;
    completedAtUtc: string;
}

export interface SecurityRiskResetRequest {
    subject: string;
    reason: string;
}

export interface SecurityRiskResetResponse {
    subject: string;
    reset: boolean;
    resetAtUtc: string;
}

const ADMIN_SENSITIVE_MFA_HEADER = 'X-Fsus-Mfa-Proof';

interface SecurityBinaryRequestOptions {
    requestFrame?: FrameType;
    request?: unknown;
}

export interface IssueSecurityChallengeRequest {
    action: string;
    routeKey: string;
    attributes?: Record<string, unknown>;
    deviceFingerprint?: string;
    capabilityManifestVersion?: string;
    representation?: 'visual' | 'audio';
    replacement?: {
        challengeId: string;
        envelopeId: string;
        stateToken: string;
    };
}

export interface VerifySecurityChallengeRequest {
    envelopeId: string;
    challengeId: string;
    kind: SecurityChallengeKind;
    action: string;
    routeKey: string;
    providerPayload?: Record<string, string>;
    perceptionCharacterV3?: PerceptionCharacterV3VerifyPayload;
}

export interface CancelSecurityChallengeRequest {
    envelopeId: string;
    action: string;
    routeKey: string;
    deviceFingerprint?: string;
    policyVersion: string;
}

const securityHeaders = (mfaProofToken?: string | null): Headers =>
{
    const headers = new Headers();
    headers.set(FSUS_HEADERS.deviceFingerprint, getBrowserFp());

    const proofToken = mfaProofToken?.trim();
    if (proofToken)
    {
        headers.set(ADMIN_SENSITIVE_MFA_HEADER, proofToken);
    }
    return headers;
};

function securityBody(frameType: FrameType, request: unknown): ArrayBuffer
{
    return encodeAedsFrame(frameType, encodeJsonRequest(request));
}

function resolveDeviceFingerprint(value?: string): string
{
    const normalized = value?.trim() ?? '';
    return normalized.length > 0 ? normalized : getBrowserFp();
}

function securityChallengeHeaders(
    deviceFingerprint?: string,
    replacement?: IssueSecurityChallengeRequest['replacement'],
    representation?: IssueSecurityChallengeRequest['representation']
): Headers
{
    const headers = new Headers();
    headers.set(FSUS_HEADERS.deviceFingerprint, resolveDeviceFingerprint(deviceFingerprint));
    if (representation)
    {
        headers.set('X-Fsus-Challenge-Representation', representation);
    };
    if (replacement)
    {
        headers.set('X-Fsus-Replaces-Challenge', replacement.challengeId);
        headers.set('X-Fsus-Replaces-Envelope', replacement.envelopeId);
        headers.set('X-Fsus-Replaces-State-Token', replacement.stateToken);
    }
    return headers;
}

function requestSecurityBinary<T>(
    binaryRoute: BinaryRouteRequest,
    frameType: FrameType,
    config?: ApiRequestConfig,
    options: SecurityBinaryRequestOptions = {}
): Promise<T>
{
    const requestOptions: NonNullable<BinaryTransportRequest['requestOptions']> = {
        headers: securityHeaders(config?.mfaProofToken)
    };
    if (options.requestFrame !== undefined)
    {
        requestOptions.body = securityBody(options.requestFrame, options.request);
    }

    return requestBinaryOnly<T>({
        binaryRoute,
        frameType,
        requestOptions,
        signal: config?.signal
    });
}

function securityQuery(params: Record<string, string | number | null | undefined>): URLSearchParams
{
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
    {
        if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
    }
    return search;
}

export const getSecurityOverview = (config?: ApiRequestConfig) =>
    requestSecurityBinary<SecurityOverviewResponse>({ operationId: 'binary_get_admin_security_overview' }, FrameType.SecurityOverview, config);

export const getRiskControlConsole = (config?: ApiRequestConfig) =>
    requestSecurityBinary<RiskControlConsoleResponse>({ operationId: 'binary_get_admin_security_risk_control_overview' }, FrameType.SecurityOverview, config);

export const simulateRiskControl = (request: RiskControlSimulationRequest, config?: ApiRequestConfig) =>
    requestSecurityBinary<RiskControlSimulationResponse>({ operationId: 'binary_post_admin_security_risk_control_simulate' }, FrameType.SecurityOverview, config, {
        requestFrame: FrameType.SecurityOverview,
        request
    });

export const getSecurityChallengeMetrics = (params: { kind?: string | null; } = {}, config?: ApiRequestConfig) =>
    requestSecurityBinary<SecurityChallengeMetricsResponse>({ operationId: 'binary_get_admin_security_challenges_overview', query: securityQuery(params) }, FrameType.SecurityOverview, config);

export const getSecurityPolicyConsole = (config?: ApiRequestConfig) =>
    requestSecurityBinary<SecurityPolicyConsoleResponse>({ operationId: 'binary_get_admin_security_policies_overview' }, FrameType.SecurityOverview, config);

export const getRiskControlOptions = (config?: ApiRequestConfig) =>
    requestSecurityBinary<SecurityRiskPolicy>({ operationId: 'binary_get_admin_security_risk_control_options' }, FrameType.SecurityOverview, config);

export const getPerceptionSealedV2Console = (config?: ApiRequestConfig) =>
    requestSecurityBinary<PerceptionSealedV2ConsoleResponse>({ operationId: 'binary_get_admin_security_perception_v2_overview' }, FrameType.SecurityOverview, config);

export const getPerceptionSealedV2Options = (config?: ApiRequestConfig) =>
    requestSecurityBinary<PerceptionSealedV2PolicySnapshot>({ operationId: 'binary_get_admin_security_perception_v2_options' }, FrameType.SecurityOverview, config);

export const updatePerceptionSealedV2Options = (request: PerceptionSealedV2PolicyUpdateRequest, config?: ApiRequestConfig) =>
    requestSecurityBinary<PerceptionSealedV2PolicySnapshot>({ operationId: 'binary_put_admin_security_perception_v2_options' }, FrameType.SecurityOverview, config, {
        requestFrame: FrameType.SecurityOverview,
        request
    });

export const rollbackPerceptionSealedV2Options = (config?: ApiRequestConfig) =>
    requestSecurityBinary<PerceptionSealedV2PolicySnapshot>({ operationId: 'binary_post_admin_security_perception_v2_options_rollback' }, FrameType.SecurityOverview, config, { });

export const issueSecurityChallenge = (request: IssueSecurityChallengeRequest, config?: ApiRequestConfig) =>
    requestBinaryOnly<SecurityChallengeIssueResponse>({
        binaryRoute: { operationId: 'binary_post_security_challenge' },
        frameType: FrameType.SecurityChallengeIssueResponse,
        requestOptions: {
            headers: securityChallengeHeaders(request.deviceFingerprint, request.replacement, request.representation),
            body: encodeAedsFrame(
                FrameType.SecurityChallengeIssueRequest,
                encodeSecurityChallengeIssueRequest({
                    action: request.action,
                    routeKey: request.routeKey,
                    deviceFingerprint: resolveDeviceFingerprint(request.deviceFingerprint),
                    attributesJson: JSON.stringify(request.attributes ?? {}),
                    capabilityManifestVersion: request.capabilityManifestVersion ?? ''
                })
            )
        },
        signal: config?.signal
    });

export const verifySecurityChallenge = (request: VerifySecurityChallengeRequest, config?: ApiRequestConfig) =>
    requestBinaryOnly<SecurityChallengeVerifyResponse>({
        binaryRoute: { operationId: 'binary_post_security_challenge_verify' },
        frameType: FrameType.SecurityChallengeVerifyResponse,
        requestOptions: {
            headers: securityChallengeHeaders(),
            body: encodeAedsFrame(
                FrameType.SecurityChallengeVerifyRequest,
                encodeSecurityChallengeVerifyRequest({
                    envelopeId: request.envelopeId,
                    challengeId: request.challengeId,
                    kind: request.kind,
                    action: request.action,
                    routeKey: request.routeKey,
                    providerPayloadJson: request.perceptionCharacterV3 ? '' : JSON.stringify(request.providerPayload ?? {}),
                    perceptionCharacterV3: request.perceptionCharacterV3
                })
            )
        },
        signal: config?.signal
    });

export const cancelSecurityChallenge = (request: CancelSecurityChallengeRequest, config?: ApiRequestConfig) =>
    requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_post_security_challenge_cancel' },
        frameType: FrameType.EmptySuccess,
        requestOptions: {
            keepalive: true,
            headers: securityChallengeHeaders(request.deviceFingerprint),
            body: encodeAedsFrame(
                FrameType.SecurityChallengeCancelRequest,
                encodeSecurityChallengeCancelRequest({
                    envelopeId: request.envelopeId,
                    action: request.action,
                    routeKey: request.routeKey,
                    deviceFingerprint: resolveDeviceFingerprint(request.deviceFingerprint),
                    policyVersion: request.policyVersion
                })
            )
        },
        signal: config?.signal
    });

export const getAntiCrawlerOverview = (config?: ApiRequestConfig) =>
    requestSecurityBinary<AntiCrawlerOverviewResponse>({ operationId: 'binary_get_admin_security_anti_crawler_overview' }, FrameType.AntiCrawlerOverview, config);

export const getAntiCrawlerOptions = (config?: ApiRequestConfig) =>
    requestSecurityBinary<AntiCrawlerPolicySnapshot>({ operationId: 'binary_get_admin_security_anti_crawler_options' }, FrameType.AntiCrawlerPolicySnapshot, config);

export const updateAntiCrawlerOptions = (request: AntiCrawlerOptionsUpdateRequest, config?: ApiRequestConfig) =>
    requestSecurityBinary<AntiCrawlerPolicySnapshot>({ operationId: 'binary_put_admin_security_anti_crawler_options' }, FrameType.AntiCrawlerPolicySnapshot, config, {
        requestFrame: FrameType.AntiCrawlerOptionsUpdateRequest,
        request
    });

export const rollbackAntiCrawlerOptions = (config?: ApiRequestConfig) =>
    requestSecurityBinary<AntiCrawlerPolicySnapshot>({ operationId: 'binary_post_admin_security_anti_crawler_options_rollback' }, FrameType.AntiCrawlerPolicySnapshot, config, { });

export const getCrawlerRangesStatus = (config?: ApiRequestConfig) =>
    requestSecurityBinary<CrawlerRangesAdminStatus>({ operationId: 'binary_get_admin_security_anti_crawler_crawler_ranges_status' }, FrameType.CrawlerRangesAdminStatus, config);

export const syncCrawlerRanges = (config?: ApiRequestConfig) =>
    requestSecurityBinary<CrawlerRangeSyncResponse>({ operationId: 'binary_post_admin_security_anti_crawler_crawler_ranges_sync' }, FrameType.CrawlerRangeSyncResponse, config, { });

export const listSecurityRiskEvents = (params: { source?: string | null; reason?: string | null; limit?: number; } = {}, config?: ApiRequestConfig) =>
    requestSecurityBinary<AntiCrawlerRiskEventResponse[]>({ operationId: 'binary_get_admin_security_risk_events', query: securityQuery(params) }, FrameType.SecurityRiskEventList, config);

export const listSecurityRiskSnapshots = (limit = 100, config?: ApiRequestConfig) =>
    requestSecurityBinary<SecurityRiskSnapshotResponse[]>({ operationId: 'binary_get_admin_security_risk_snapshots', query: securityQuery({ limit }) }, FrameType.SecurityRiskSnapshotList, config);

export const resetSecurityRisk = (request: SecurityRiskResetRequest, config?: ApiRequestConfig) =>
    requestSecurityBinary<SecurityRiskResetResponse>({ operationId: 'binary_post_admin_security_risk_dimension_reset', params: { dimension: 'ip' } }, FrameType.SecurityRiskResetResponse, config, {
        requestFrame: FrameType.SecurityRiskResetRequest,
        request
    });

export const listAntiCrawlerRules = (config?: ApiRequestConfig) =>
    requestSecurityBinary<AntiCrawlerRuleResponse[]>({ operationId: 'binary_get_admin_security_anti_crawler_rules' }, FrameType.AntiCrawlerRuleList, config);

export const createAntiCrawlerRule = (request: AntiCrawlerRuleRequest, config?: ApiRequestConfig) =>
    requestSecurityBinary<AntiCrawlerRuleResponse>({ operationId: 'binary_post_admin_security_anti_crawler_rules' }, FrameType.AntiCrawlerRuleResponse, config, {
        requestFrame: FrameType.AntiCrawlerRuleRequest,
        request
    });

export const updateAntiCrawlerRule = (id: string, request: AntiCrawlerRuleRequest, config?: ApiRequestConfig) =>
    requestSecurityBinary<AntiCrawlerRuleResponse>({ operationId: 'binary_put_admin_security_anti_crawler_rules_id', params: { id } }, FrameType.AntiCrawlerRuleResponse, config, {
        requestFrame: FrameType.AntiCrawlerRuleRequest,
        request
    });

export const deleteAntiCrawlerRule = (id: string, config?: ApiRequestConfig) =>
    requestSecurityBinary<{ deleted: boolean; }>({ operationId: 'binary_delete_admin_security_anti_crawler_rules_id', params: { id } }, FrameType.AntiCrawlerRuleDeleteResponse, config, { });

export const listAntiCrawlerEntries = (listType: 'allowlist' | 'blocklist', config?: ApiRequestConfig) =>
    requestSecurityBinary<AntiCrawlerListEntryResponse[]>({ operationId: listType === 'allowlist' ? 'binary_get_admin_security_anti_crawler_allowlist' : 'binary_get_admin_security_anti_crawler_blocklist' }, FrameType.AntiCrawlerListEntryList, config);

export const createAntiCrawlerEntry = (listType: 'allowlist' | 'blocklist', request: AntiCrawlerListEntryRequest, config?: ApiRequestConfig) =>
    requestSecurityBinary<AntiCrawlerListEntryResponse>({ operationId: listType === 'allowlist' ? 'binary_post_admin_security_anti_crawler_allowlist' : 'binary_post_admin_security_anti_crawler_blocklist' }, FrameType.AntiCrawlerListEntryResponse, config, {
        requestFrame: FrameType.AntiCrawlerListEntryRequest,
        request
    });

export const deleteAntiCrawlerEntry = (listType: 'allowlist' | 'blocklist', id: string, config?: ApiRequestConfig) =>
    requestSecurityBinary<{ deleted: boolean; }>({ operationId: listType === 'allowlist' ? 'binary_delete_admin_security_anti_crawler_allowlist_id' : 'binary_delete_admin_security_anti_crawler_blocklist_id', params: { id } }, FrameType.AntiCrawlerListEntryDeleteResponse, config, { });

export const simulateAntiCrawlerPolicy = (request: AntiCrawlerSimulationRequest, config?: ApiRequestConfig) =>
    requestSecurityBinary<AntiCrawlerSimulationResult>({ operationId: 'binary_post_admin_security_anti_crawler_simulate' }, FrameType.AntiCrawlerSimulationResult, config, {
        requestFrame: FrameType.AntiCrawlerSimulationRequest,
        request
    });

export const getPowOverview = (config?: ApiRequestConfig) =>
    requestSecurityBinary<PowOverviewResponse>({ operationId: 'binary_get_admin_security_pow_overview' }, FrameType.PowOverview, config);

export const getPowOptions = (config?: ApiRequestConfig) =>
    requestSecurityBinary<PowPolicySnapshot>({ operationId: 'binary_get_admin_security_pow_options' }, FrameType.PowPolicySnapshot, config);

export const updatePowOptions = (request: PowOptionsUpdateRequest, config?: ApiRequestConfig) =>
    requestSecurityBinary<PowPolicySnapshot>({ operationId: 'binary_put_admin_security_pow_options' }, FrameType.PowPolicySnapshot, config, {
        requestFrame: FrameType.PowOptionsUpdateRequest,
        request
    });

export const rollbackPowOptions = (config?: ApiRequestConfig) =>
    requestSecurityBinary<PowPolicySnapshot>({ operationId: 'binary_post_admin_security_pow_options_rollback' }, FrameType.PowPolicySnapshot, config, { });
