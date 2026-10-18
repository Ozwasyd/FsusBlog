using System.Collections.Immutable;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>
/// Pure additive composition over the original registry. Core observations remain opaque and unchanged;
/// plugin findings cannot replace them. This does not execute checks, acquire grants or issue a publication decision.
/// </summary>
public static class AuthoringPrepublishDiagnosticCombiner
{
    /// <summary>
    /// Accounts for the complete canonical roster, revalidates outcomes and binds supplied outcomes to the
    /// host's current context. All context fields must match, including request, source, grant and deadline.
    /// Malformed, foreign or conflicting outcomes throw; missing outcomes retain the registry's unavailable slots.
    /// </summary>
    public static Combination Combine(
        AuthoringPrepublishDiagnosticRegistry registry,
        AuthoringDiagnosticExpectedRoster expectedDiagnostics,
        AuthoringDiagnosticHostContext currentContext,
        ImmutableArray<AuthoringPrepublishDiagnosticResult> outcomes,
        DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(registry);
        ArgumentNullException.ThrowIfNull(currentContext);
        AuthoringDiagnosticOutcomeCoverage coverage = registry.ValidateOutcomeCoverage(expectedDiagnostics, outcomes, now);
        var identities = new HashSet<string>(registry.CoreResults.Select(static core => core.CheckId), StringComparer.Ordinal);
        foreach (AuthoringDiagnosticOutcomeSlot slot in coverage.Slots)
        {
            if (slot.Outcome is not { } outcome)
            {
                continue;
            }

            if (outcome.Input.Context != currentContext)
            {
                throw new AuthoringExtensionContractException("Diagnostic outcome does not belong to the current host context.");
            }

            foreach (AuthoringDiagnosticFact fact in outcome.Facts)
            {
                // Diagnostic namespaces may nest, so per-result uniqueness alone does not prove global uniqueness.
                if (!identities.Add(fact.Id))
                {
                    throw new AuthoringExtensionContractException("Diagnostic fact identity conflicts with another result.");
                }
            }
        }

        return new Combination(registry.CoreResults, registry.CoreResultsSha256, currentContext, coverage);
    }

    /// <summary>
    /// Immutable core observations plus complete diagnostic coverage. HasBlockingPluginDiagnostics is only an
    /// additional plugin veto; false never means core checks passed, all diagnostics evaluated, or publication is allowed.
    /// Absent slots carry no fabricated input, fact or result. Unavailable slots are not receipt-eligible successes.
    /// </summary>
    public sealed class Combination
    {
        internal Combination(
            ImmutableArray<AuthoringDiagnosticCoreResult> coreResults,
            string coreResultsSha256,
            AuthoringDiagnosticHostContext context,
            AuthoringDiagnosticOutcomeCoverage coverage)
        {
            CoreResults = coreResults;
            CoreResultsSha256 = coreResultsSha256;
            Context = context;
            Coverage = coverage;
        }

        public ImmutableArray<AuthoringDiagnosticCoreResult> CoreResults
        {
            get;
        }

        public string CoreResultsSha256
        {
            get;
        }

        public AuthoringDiagnosticHostContext Context
        {
            get;
        }

        public AuthoringDiagnosticOutcomeCoverage Coverage
        {
            get;
        }

        public bool HasBlockingPluginDiagnostics => Coverage.Slots.Any(static slot =>
            slot.Status == AuthoringDiagnosticOutcomeStatus.RequiredUnavailable ||
            slot.Outcome is { Status: AuthoringDiagnosticOutcomeStatus.Findings } outcome &&
                outcome.Facts.Any(static fact => fact.Severity == AuthoringDiagnosticSeverity.Blocking));
    }
}
