// Data-only validation for the original final-report owner. Materials supplied
// here are values, not evidence of producer execution, held source provenance,
// completed tiers or native qualification. The original I/O facade obtains its
// own source materials before delegating; downstream custody remains separate.
import { createHash } from 'node:crypto'
import path from 'node:path'
import { partitionBehaviorDocClaims } from './behavior-doc-static-admission-contract.mjs'

export const finalReportSchema = 'fsusblog.behavior-document-consistency-final-report.v2'

export const zeroLegacyScanSchema = 'fsusblog.zero-legacy-governance-scan.v1'

export const scanRoots = Object.freeze([
    Object.freeze({ path: 'config', pathClass: 'config' }),
    Object.freeze({ path: 'docs', pathClass: 'docs' }),
    Object.freeze({ path: 'src', pathClass: 'production' }),
    Object.freeze({ path: 'tests', pathClass: 'tests' }),
    Object.freeze({ path: 'tools', pathClass: 'tools' })
])

export const zeroLegacyRequiredPathClasses = Object.freeze([
    'config',
    'docs',
    'production',
    'tests',
    'tools',
    'package-scripts',
    'generated-projection',
    'output-schema'
])

const stable = (value) => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
        : value;
export const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
export const withoutDigest = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'contentDigest'));
export const normalizeDigest = (value) => String(value ?? '').replace(/^sha256:/u, '');
export function fail(message)
{
    throw new Error(`[behavior-document-consistency-final] ${message}`);
}

export function zeroLegacyFail(message)
{
    throw new Error(`[zero-legacy-governance] ${message}`)
}

export function validateZeroLegacyScan(scan)
{
    if (!scan || typeof scan !== 'object' || Array.isArray(scan)
        || JSON.stringify(Object.keys(scan).sort()) !== JSON.stringify([
            'findings', 'pathClassCounts', 'scanRoots', 'scannedFileCount', 'schema'
        ]))
    {
        zeroLegacyFail('scan shape is open')
    }
    if (scan?.schema !== zeroLegacyScanSchema) zeroLegacyFail('scan schema mismatch')
    if (JSON.stringify(scan.scanRoots) !== JSON.stringify(scanRoots)) zeroLegacyFail('scan roots are incomplete')
    const pathClassKeys = Object.keys(scan.pathClassCounts ?? {}).sort()
    if (JSON.stringify(pathClassKeys) !== JSON.stringify([...zeroLegacyRequiredPathClasses].sort())) zeroLegacyFail('path classes are incomplete')
    if (!Number.isInteger(scan.scannedFileCount) || scan.scannedFileCount < 0) zeroLegacyFail('scanned file count is invalid')
    if (pathClassKeys.some((key) => !Number.isInteger(scan.pathClassCounts[key]) || scan.pathClassCounts[key] < 0)) zeroLegacyFail('path class count is invalid')
    if (!Array.isArray(scan.findings)) zeroLegacyFail('findings are invalid')
    for (const finding of scan.findings)
    {
        if (!finding || typeof finding.file !== 'string' || finding.file.length === 0
            || JSON.stringify(Object.keys(finding).sort()) !== JSON.stringify(['file', 'location', 'pathClasses', 'rule'])
            || !Array.isArray(finding.pathClasses) || finding.pathClasses.length === 0
            || new Set(finding.pathClasses).size !== finding.pathClasses.length
            || finding.pathClasses.some((entry) => !zeroLegacyRequiredPathClasses.includes(entry))
            || typeof finding.rule !== 'string' || finding.rule.length === 0
            || typeof finding.location !== 'string' || finding.location.length === 0)
        {
            zeroLegacyFail('finding shape is invalid')
        }
    }
    return scan
}

const claimStageDischargeKeys = Object.freeze([
    'catalogDigest', 'parseReceiptDigest', 'migrationLedgerDigest',
    'admissionClaimStagesDigest', 'preVerificationReceiptDigest',
    'verifiedPreProseClaimIds', 'verifiedPostClaimIds', 'unclearedPostClaimIds',
    'contentDigest'
])

export function validateClaimStageDischarge(value)
{
    if (!value || Object.keys(value).sort().join('\0')
        !== [...claimStageDischargeKeys].sort().join('\0')
        || value.contentDigest !== digest(withoutDigest(value)))
    {
        fail('claim-stage discharge is not closed and sealed')
    }
    for (const key of claimStageDischargeKeys.filter((key) => key.endsWith('Digest')))
    {
        if (typeof value[key] !== 'string' || value[key].length !== 71
            || !/^sha256:[a-f0-9]{64}$/u.test(value[key]))
        {
            fail('claim-stage discharge digest is incomplete')
        }
    }
    const ids = new Set()
    for (const key of ['verifiedPreProseClaimIds', 'verifiedPostClaimIds', 'unclearedPostClaimIds'])
    {
        if (!Array.isArray(value[key]))
        {
            fail('claim-stage discharge claim roster is missing')
        }
        let previous = null
        for (const id of value[key])
        {
            if (typeof id !== 'string' || id.length === 0 || ids.has(id)
                || (previous !== null && previous.localeCompare(id) >= 0))
            {
                fail('claim-stage discharge has duplicate, unordered or invalid claim identities')
            }
            ids.add(id)
            previous = id
        }
    }
    // There is currently no typed native FactObservation reader bridge.
    // A boolean, class-reference map or caller-supplied verified list cannot
    // clear this boundary. A real bridge requires a separate source change.
    if (value.verifiedPostClaimIds.length !== 0)
    {
        fail('native post-runtime FactObservation bridge is unavailable')
    }
    return value
}

export function validateFinalReportValue(report, {
    expectedWorktree = null, expectedSourceIdentity = null, expectedClaimStageAuthority = null
} = {})
{
    if (report?.schema !== finalReportSchema) fail('report schema mismatch')
    validateClaimStageDischarge(report.claimStageDischarge)
    if (typeof expectedWorktree !== 'string' || !path.isAbsolute(expectedWorktree)
        || report.worktreeIdentity?.root !== path.resolve(expectedWorktree))
    {
        fail('final report requires the independent expected source worktree')
    }
    if (!expectedClaimStageAuthority || typeof expectedClaimStageAuthority !== 'object'
        || Array.isArray(expectedClaimStageAuthority)
        || Object.keys(expectedClaimStageAuthority).sort().join('\0')
            !== ['catalog', 'claimReceipt', 'migrationLedger'].join('\0'))
    {
        fail('final report value validation requires closed claim-stage materials')
    }
    const { catalog, claimReceipt, migrationLedger } = expectedClaimStageAuthority
    const { stages } = partitionBehaviorDocClaims({ catalog, claimReceipt, migrationLedger })
    const discharge = report.claimStageDischarge
    if (discharge.catalogDigest !== `sha256:${stages.catalogDigest}`
        || discharge.parseReceiptDigest !== `sha256:${stages.parseReceiptDigest}`
        || discharge.migrationLedgerDigest !== `sha256:${stages.migrationLedgerDigest}`
        || discharge.admissionClaimStagesDigest !== `sha256:${stages.contentDigest}`
        || normalizeDigest(discharge.preVerificationReceiptDigest)
            !== normalizeDigest(report.receiptDigests?.docClaimVerification))
    {
        fail('final report claim-stage source authority binding mismatch')
    }
    const expectedPreIds = stages.preRuntimeClaims
        .filter((claim) => claim.claimType !== 'generated-section').map((claim) => claim.claimId)
    const expectedPostIds = stages.deferredPostClaims.map((claim) => claim.claimId)
    if (JSON.stringify(discharge.verifiedPreProseClaimIds) !== JSON.stringify(expectedPreIds)
        || JSON.stringify(discharge.unclearedPostClaimIds) !== JSON.stringify(expectedPostIds))
    {
        fail('final report must retain the exact original source claim roster')
    }
    const source = expectedSourceIdentity
    if (!source || typeof source.sourceCommit !== 'string'
        || typeof source.worktreeFingerprint !== 'string'
        || report.sourceIdentity?.commit !== source.sourceCommit
        || normalizeDigest(report.sourceIdentity?.worktreeFingerprint) !== source.worktreeFingerprint)
    {
        fail('final report actual source/worktree identity mismatch')
    }
    const reportPostClaimIds = (report.behaviorNodes ?? [])
        .filter((node) => node.evidenceStage === 'post-runtime')
        .flatMap((node) => node.docClaimIds ?? []).sort((left, right) => left.localeCompare(right))
    if (JSON.stringify(reportPostClaimIds) !== JSON.stringify(report.claimStageDischarge.unclearedPostClaimIds))
    {
        fail('current final refusal must retain every post-runtime claim identity')
    }
    validateZeroLegacyScan(report.zeroLegacyScan)
    if (report.contentDigest !== digest(withoutDigest(report))) fail('report contentDigest mismatch')
    if (!['ok', 'failed'].includes(report.status)) fail('report status is invalid')
    if (report.status === 'ok' && report.failureReasons.length > 0) fail('ok report has failures')
    if (report.status === 'ok' && report.zeroLegacyScan.findings.length > 0) fail('ok report has zero-legacy findings')
    if (report.status === 'ok' && report.claimStageDischarge.unclearedPostClaimIds.length > 0)
    {
        fail('ok report cannot retain undischargeable post-runtime claims')
    }
    if (report.status === 'failed' && report.failureReasons.length === 0) fail('failed report lacks failures')
    return report
}
