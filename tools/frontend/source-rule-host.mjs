import crypto from 'node:crypto';

import { validateFrontendSourceIndex } from './source-index.mjs';

function sha256(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

function stable(value)
{
    if (Array.isArray(value))
    {
        return value.map(stable);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
}

function digest(value)
{
    return sha256(JSON.stringify(stable(value)));
}

function normalizeFinding(finding, ruleId)
{
    return {
        id: finding.id ?? `${ruleId}:${finding.path}:${finding.span?.start ?? -1}:${digest(finding.message).slice(0, 12)}`,
        message: finding.message,
        path: finding.path,
        span: finding.span
    };
}

function expectedLineColumn(content, offset)
{
    const prefix = content.slice(0, offset);
    const lines = prefix.split('\n');
    return { line: lines.length, column: lines.at(-1).length + 1 };
}

function validateFinding(finding, files, label)
{
    const errors = [];
    const source = files.get(finding.path);
    const span = finding.span;
    if (!source || !span || !Number.isInteger(span.start) || !Number.isInteger(span.end)
    || span.start < 0 || span.end < span.start || span.end > (source?.content.length ?? -1))
    {
        errors.push(`${label}: source span cannot be located`);
        return errors;
    }
    const expected = expectedLineColumn(source.content, span.start);
    if (span.line !== expected.line || span.column !== expected.column)
    {
        errors.push(`${label}: source span line/column does not match its offset`);
    }
    return errors;
}

async function evaluateRule(rule, index, ruleOptions)
{
    const result = await rule.evaluate(index, ruleOptions);
    const findings = (result?.findings ?? []).map((finding) => normalizeFinding(finding, rule.id))
        .sort((left, right) => left.id.localeCompare(right.id));
    const receiptCore = {
        schema: 'fsusblog.frontend-source-rule-receipt.v1',
        ruleId: rule.id,
        status: findings.length === 0 ? 'pass' : 'fail',
        findings,
        coverageIds: [...rule.coverageIds].sort(),
        sourceIdentity: {
            commit: index.identity.commit,
            worktreeFingerprint: index.identity.worktreeFingerprint,
            runId: index.identity.runId,
            inputTreeDigest: index.identity.inputTreeDigest
        },
        findingIdentityDigest: digest(findings.map(({ id, path, span, message }) => ({ id, path, span, message })))
    };
    return {
        ...receiptCore,
        contentDigest: digest(receiptCore),
        ruleCompatibility: {
            directEvaluation: async (directIndex, options) => evaluateRule(rule, directIndex, options)
        }
    };
}

export function validateRuleHostEvidence(evidence, index, { expectedRuleIds = [] } = {})
{
    const errors = [...validateFrontendSourceIndex(index)];
    if (evidence?.schema !== 'fsusblog.frontend-source-rule-host-evidence.v1')
    {
        errors.push('rule host evidence schema is invalid');
    }
    const receipts = Array.isArray(evidence?.receipts) ? evidence.receipts : [];
    const ids = receipts.map(({ ruleId }) => ruleId);
    if (new Set(ids).size !== ids.length)
    {
        errors.push('rule host contains duplicate rule receipts');
    }
    for (const id of expectedRuleIds)
    {
        if (!ids.includes(id))
        {
            errors.push(`missing rule receipt: ${id}`);
        }
    }
    const files = new Map(index.files.map((file) => [file.path, file]));
    for (const receipt of receipts)
    {
        if (!Array.isArray(receipt.coverageIds) || receipt.coverageIds.length === 0)
        {
            errors.push(`${receipt.ruleId}: coverage IDs are missing`);
        }
        if (receipt.error)
        {
            continue;
        }
        for (const finding of receipt.findings ?? [])
        {
            errors.push(...validateFinding(finding, files, `${receipt.ruleId}/${finding.id}`));
        }
        const core = { ...receipt };
        const contentDigest = core.contentDigest;
        delete core.contentDigest;
        delete core.ruleCompatibility;
        if (digest(core) !== contentDigest)
        {
            errors.push(`${receipt.ruleId}: receipt content digest mismatch`);
        }
    }
    return errors;
}

export async function executeSourceRules({ index, rules, ruleOptions = {} })
{
    const indexErrors = validateFrontendSourceIndex(index);
    const receipts = [];
    if (indexErrors.length === 0)
    {
        for (const rule of rules)
        {
            try
            {
                receipts.push(await evaluateRule(rule, index, ruleOptions));
            }
            catch (error)
            {
                const receiptCore = {
                    schema: 'fsusblog.frontend-source-rule-receipt.v1',
                    ruleId: rule.id,
                    status: 'error',
                    error: error instanceof Error ? error.message : String(error),
                    findings: [],
                    coverageIds: [...(rule.coverageIds ?? [])].sort(),
                    sourceIdentity: {
                        commit: index.identity.commit,
                        worktreeFingerprint: index.identity.worktreeFingerprint,
                        runId: index.identity.runId,
                        inputTreeDigest: index.identity.inputTreeDigest
                    },
                    findingIdentityDigest: digest([])
                };
                receipts.push({ ...receiptCore, contentDigest: digest(receiptCore) });
            }
        }
    }
    const evidence = {
        schema: 'fsusblog.frontend-source-rule-host-evidence.v1',
        sourceIdentity: index.identity,
        receipts,
        metrics: {
            nodeProcessCount: 1,
            sourceInventoryCount: index.metrics.inventoryCount,
            sourceReadCount: index.metrics.readCount,
            sourcePrimaryParseCount: index.metrics.primaryParseCount,
            ruleCount: rules.length
        }
    };
    const validationErrors = [
        ...indexErrors,
        ...validateRuleHostEvidence(evidence, index, { expectedRuleIds: rules.map(({ id }) => id) })
    ];
    evidence.validationErrors = [...new Set(validationErrors)];
    evidence.status = evidence.validationErrors.length === 0
    && receipts.every(({ status }) => status === 'pass')
        ? 'pass'
        : 'failure';
    return evidence;
}
