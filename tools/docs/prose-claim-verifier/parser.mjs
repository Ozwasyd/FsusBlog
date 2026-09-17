/**
 * Bound-block prose parser: checks only the claim-bound body against a verification plan.
 * Never scans the whole document for semantics. Never converts units.
 */

import {
    ProseClaimErrorCode
} from './errors.mjs';
import {
    bodyIncludesToken,
    normalizeBody
} from './phrases.mjs';

/**
 * Find the earliest index of any token in body (case-insensitive Latin).
 * Returns -1 when none match.
 */
export function earliestTokenIndex(body, tokens)
{
    const haystack = normalizeBody(body).toLowerCase();
    let best = -1;
    for (const token of tokens)
    {
        const needle = normalizeBody(token).toLowerCase();
        if (!needle)
        {
            continue;
        }
        const index = haystack.indexOf(needle);
        if (index >= 0 && (best < 0 || index < best))
        {
            best = index;
        }
    }
    return best;
}

export function latestTokenIndex(body, tokens)
{
    const haystack = normalizeBody(body).toLowerCase();
    let best = -1;
    for (const token of tokens)
    {
        const needle = normalizeBody(token).toLowerCase();
        if (!needle)
        {
            continue;
        }
        const index = haystack.lastIndexOf(needle);
        if (index > best)
        {
            best = index;
        }
    }
    return best;
}

function groupSatisfied(body, group)
{
    return group.some((token) => bodyIncludesToken(body, token));
}

/**
 * Collect numeric literals that appear adjacent to a unit token of the plan dimension.
 * Does not convert across units.
 */
export function collectDimensionValues(body, dimension)
{
    if (!dimension)
    {
        return [];
    }
    const unitInfoTokens = [...(dimension.unitTokens ?? [])];
    if (dimension.unit && !unitInfoTokens.includes(dimension.unit))
    {
        unitInfoTokens.push(String(dimension.unit));
    }
    // Match numbers with an immediately adjacent unit token for this dimension only.
    // Window is intentionally tight so "5 分钟 … 3 次" does not treat 3 as minutes.
    const values = [];
    const numberPattern = /(?<![A-Za-z0-9_])(\d+(?:\.\d+)?)(?![A-Za-z0-9_])/gu;
    let match;
    const text = String(body);
    while ((match = numberPattern.exec(text)) !== null)
    {
        const number = Number(match[1]);
        if (!Number.isFinite(number))
        {
            continue;
        }
        const start = match.index;
        const end = start + match[1].length;
        const after = text.slice(end, Math.min(text.length, end + 8));
        const before = text.slice(Math.max(0, start - 8), start);
        const adjacent = `${before}${after}`;
        if (unitInfoTokens.length === 0)
        {
            values.push(number);
            continue;
        }
        const nearUnit = unitInfoTokens.some((token) =>
        {
            const needle = String(token).toLowerCase();
            // Prefer unit after the number (5 分钟 / 5 minutes).
            return after.toLowerCase().includes(needle) || before.toLowerCase().endsWith(needle);
        });
        if (nearUnit)
        {
            values.push(number);
        }
        else
        {
            void adjacent;
        }
    }
    return values;
}

/**
 * Parse/verify one claim body against a plan. Returns diagnostic objects (not thrown).
 */
export function verifyBodyAgainstPlan(bodyText, plan, context = {})
{
    const diagnostics = [];
    const body = String(bodyText ?? '');
    const base = {
        claimId: context.claimId,
        documentPath: context.documentPath,
        line: context.line
    };

    if (!plan || typeof plan !== 'object')
    {
        diagnostics.push({
            ...base,
            code: ProseClaimErrorCode.RENDER_SHAPE,
            message: 'verification plan missing'
        });
        return diagnostics;
    }

    // Required token groups: each group needs at least one match.
    for (const group of plan.requiredAnyOfGroups ?? [])
    {
        if (!groupSatisfied(body, group))
        {
            diagnostics.push({
                ...base,
                code: ProseClaimErrorCode.REQUIRED_TOKEN_MISSING,
                message: `body missing required token group [${group.join(' | ')}] for render ${plan.render}`,
                details: { group, render: plan.render }
            });
        }
    }

    // Forbidden tokens.
    for (const token of plan.forbiddenTokens ?? [])
    {
        if (bodyIncludesToken(body, token))
        {
            const code = plan.kind === 'failure-mode'
                ? ProseClaimErrorCode.FAILURE_POLICY_CONFLICT
                : plan.kind === 'boolean'
                    ? ProseClaimErrorCode.BOOLEAN_CONFLICT
                    : ProseClaimErrorCode.FORBIDDEN_TOKEN_PRESENT;
            diagnostics.push({
                ...base,
                code,
                message: `body contains forbidden token "${token}" for render ${plan.render}`,
                details: { token, render: plan.render }
            });
        }
    }

    // Simultaneous positive/negative semantic phrases.
    if (plan.conflictPair)
    {
        const hasPositive = groupSatisfied(body, plan.conflictPair.positive);
        const hasNegative = groupSatisfied(body, plan.conflictPair.negative);
        if (hasPositive && hasNegative)
        {
            const code = plan.kind === 'failure-mode'
                ? ProseClaimErrorCode.FAILURE_POLICY_CONFLICT
                : ProseClaimErrorCode.BOOLEAN_CONFLICT;
            diagnostics.push({
                ...base,
                code,
                message: `body asserts both positive and negative phrases for render ${plan.render}`,
                details: { render: plan.render }
            });
        }
    }

    // Scalar dimension: other values of the same dimension fail unless interval projection allowed.
    if (plan.kind === 'scalar' && plan.dimension)
    {
        const unitInfoTokens = plan.quantity?.unit
            ? undefined
            : [];
        // Import unit tokens via plan.quantity.unit through dimension extension.
        const dimension = {
            ...plan.dimension,
            unitTokens: plan.dimension.unitTokens
        };
        // Attach unit tokens from plan if present on quantity.
        if (plan.quantity?.unit && !dimension.unitTokens)
        {
            // Lazy: reconstruct common unit tokens from unit string only (exact unit + dimension id).
            dimension.unitTokens = [plan.quantity.unit];
            // Also include known aliases already baked into required groups (second group).
            if (Array.isArray(plan.requiredAnyOfGroups?.[1]))
            {
                dimension.unitTokens = [...plan.requiredAnyOfGroups[1]];
            }
        }
        const found = collectDimensionValues(body, dimension);
        const expected = plan.dimension.expectedValue;
        const distinct = [...new Set(found)];
        if (!plan.dimension.allowInterval)
        {
            for (const value of distinct)
            {
                if (value !== expected)
                {
                    diagnostics.push({
                        ...base,
                        code: ProseClaimErrorCode.CONFLICTING_VALUE,
                        message: `body contains conflicting ${plan.dimension.id} value ${value}; expected ${expected}`,
                        details: {
                            found: value,
                            expected,
                            dimension: plan.dimension.id
                        }
                    });
                }
            }
        }
        if (plan.quantity?.inclusivity && plan.requiredPhraseIds?.some((id) => id.startsWith('inclusivity.')))
        {
            // Boundary mismatch already covered by required/forbidden token groups.
            void unitInfoTokens;
        }
    }

    // Relation / implication direction: subject ... predicate ... object order required.
    if (plan.direction)
    {
        const subjectIndex = earliestTokenIndex(body, plan.direction.subjectTokens);
        const predicateIndex = earliestTokenIndex(body, plan.direction.predicateTokens);
        const objectIndex = earliestTokenIndex(body, plan.direction.objectTokens);
        if (subjectIndex >= 0 && predicateIndex >= 0 && objectIndex >= 0)
        {
            const forward = subjectIndex < predicateIndex && predicateIndex < objectIndex;
            // Also allow subject ... object when predicate wraps both only if subject still precedes object.
            const subjectBeforeObject = subjectIndex < objectIndex;
            if (!forward && !subjectBeforeObject)
            {
                const code = plan.kind === 'implication'
                    ? ProseClaimErrorCode.IMPLICATION_MISMATCH
                    : ProseClaimErrorCode.RELATION_DIRECTION;
                diagnostics.push({
                    ...base,
                    code,
                    message: `body relation direction is reversed for render ${plan.render}`,
                    details: {
                        subjectIndex,
                        predicateIndex,
                        objectIndex,
                        render: plan.render
                    }
                });
            }
            else if (!forward && subjectBeforeObject && !(subjectIndex < predicateIndex && predicateIndex < objectIndex))
            {
                // subject before object but predicate not between them — still check reverse pattern
                // object ... predicate ... subject
                const reverse = objectIndex < predicateIndex && predicateIndex < subjectIndex;
                if (reverse || objectIndex < subjectIndex)
                {
                    const code = plan.kind === 'implication'
                        ? ProseClaimErrorCode.IMPLICATION_MISMATCH
                        : ProseClaimErrorCode.RELATION_DIRECTION;
                    diagnostics.push({
                        ...base,
                        code,
                        message: `body relation direction is reversed for render ${plan.render}`,
                        details: {
                            subjectIndex,
                            predicateIndex,
                            objectIndex,
                            render: plan.render
                        }
                    });
                }
            }
        }
        // If object appears before subject with a predicate token between — reverse.
        if (subjectIndex >= 0 && objectIndex >= 0 && objectIndex < subjectIndex)
        {
            const code = plan.kind === 'implication'
                ? ProseClaimErrorCode.IMPLICATION_MISMATCH
                : ProseClaimErrorCode.RELATION_DIRECTION;
            // Avoid duplicate messages
            if (!diagnostics.some((entry) => entry.code === code && entry.claimId === base.claimId))
            {
                diagnostics.push({
                    ...base,
                    code,
                    message: `body places object before subject for render ${plan.render}`,
                    details: {
                        subjectIndex,
                        objectIndex,
                        render: plan.render
                    }
                });
            }
        }
    }

    if (plan.kind === 'preservation-rule' && diagnostics.some((entry) => entry.code === ProseClaimErrorCode.REQUIRED_TOKEN_MISSING))
    {
        // Re-tag primary miss as preservation mismatch when no required groups matched at all.
        const missing = diagnostics.filter((entry) => entry.code === ProseClaimErrorCode.REQUIRED_TOKEN_MISSING);
        if (missing.length > 0)
        {
            for (const entry of missing)
            {
                entry.code = ProseClaimErrorCode.PRESERVATION_MISMATCH;
            }
        }
    }

    return diagnostics;
}
