import { assert, canonical, readDocument, readRef, runSchema, seal, validateBinding, exactKeys, verifySeal } from './production-fresh-contract.mjs';
const comparisonSchema = 'fsusblog.production-fresh.performance-comparison.v1';

export const verdictSchema = 'fsusblog.production-fresh.performance-verdict.v1';

function validateComparison(root, ref, expectedBinding)
{
    validateBinding(expectedBinding);
    const comparison = readRef(root, ref);
    verifySeal(comparison, comparisonSchema);
    exactKeys(comparison, ['schema', 'terminal', 'binding', 'current', 'baseline', 'baselineIdentityDigest',
        'currentIdentityDigest', 'reproduce', 'verdict', 'reasons', 'classification', 'differences', 'digest'], 'comparison');
    assert(comparison.terminal === true, 'provisional comparator receipt');
    assert(Array.isArray(comparison.reasons) && comparison.reasons.length > 0 && Array.isArray(comparison.differences)
        && comparison.reproduce?.executable === 'node' && Array.isArray(comparison.reproduce.arguments), 'invalid comparison evidence');
    assert(canonical(comparison.binding) === canonical(expectedBinding), 'comparison wrong-run/attempt/source/build/plan');
    assert(['improvement', 'noise-only', 'regression', 'not-evaluable'].includes(comparison.verdict), 'unknown comparison verdict');
    const current = readRef(root, comparison.current);
    verifySeal(current, runSchema);
    assert(canonical(current.binding) === canonical(expectedBinding), 'comparison current-ref wrong execution');
    readRef(root, comparison.baseline);
    return comparison;
}

/** Separate producer binding; the finalizer must only call consumePerformanceVerdicts. */
export function createPerformanceVerdict(root, comparisonLocator, expectedBinding)
{
    const { ref } = readDocument(root, comparisonLocator);
    const comparison = validateComparison(root, ref, expectedBinding);
    return seal({ schema: verdictSchema, binding: expectedBinding, terminal: true,
        verdict: ['improvement', 'noise-only'].includes(comparison.verdict) ? 'pass' : comparison.verdict,
        current: comparison.current, baseline: comparison.baseline, comparison: ref,
        reasons: comparison.reasons, reproduce: comparison.reproduce });
}

/** Zero producers. Returns independent failure attribution; correctness authority is caller-owned. */
export function consumePerformanceVerdicts({ root, verdictRefs, expectedBinding, correctnessFailure = null })
{
    try
    {
        assert(Array.isArray(verdictRefs) && verdictRefs.length === 1, 'exact-one terminal performance verdict required');
        const verdict = readRef(root, verdictRefs[0]);
        verifySeal(verdict, verdictSchema);
        assert(verdict.terminal === true && canonical(verdict.binding) === canonical(expectedBinding), 'provisional/wrong-run performance verdict');
        const comparison = validateComparison(root, verdict.comparison, expectedBinding);
        const expected = seal({ schema: verdictSchema, binding: expectedBinding, terminal: true,
            verdict: ['improvement', 'noise-only'].includes(comparison.verdict) ? 'pass' : comparison.verdict,
            current: comparison.current, baseline: comparison.baseline, comparison: verdict.comparison,
            reasons: comparison.reasons, reproduce: comparison.reproduce });
        assert(canonical(verdict) === canonical(expected), 'verdict differs from terminal comparison');
        const performanceFailure = verdict.verdict === 'pass' ? null : {
            classification: verdict.verdict === 'not-evaluable' ? 'calibration-required/not-evaluable' : 'performance-regression',
            reasons: verdict.reasons, reproduce: verdict.reproduce
        };
        return { qualificationEligible: !correctnessFailure && !performanceFailure,
            correctnessFailure, performanceFailure, firstFailure: correctnessFailure ?? performanceFailure, verdict };
    }
    catch (error)
    {
        const performanceFailure = { classification: 'performance-evidence-invalid', reasons: [error.message] };
        return { qualificationEligible: false, correctnessFailure, performanceFailure,
            firstFailure: correctnessFailure ?? performanceFailure, verdict: null };
    }
}
