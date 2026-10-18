using System.Collections.Immutable;
using System.Text.Json;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Bounded typed input and original index-stage evidence only. The properties have not
/// filtered these candidates. IndexEvidence retains the original request instance and
/// generation; intake cannot bind them to a replacement writer. This is not a typed
/// query AST, current value projection, permission grant, result, cursor, receipt
/// or full-source fingerprint.
/// </summary>
public sealed record AuthorSearchPropertyOperandIntake(
    AuthorSearchTokenEvaluation IndexEvidence,
    ImmutableArray<AuthorSearchPropertyOperand> Operands,
    string ContentDigest);

public sealed partial class AuthorFullTextSearchQueryEvaluator
{
    /// <summary>
    /// Accepts the original typed operands directly, without parsing Saved View strings.
    /// Reuses the original query/index inspector and canonical operand validator. The
    /// original source port has no typed entry/field-digest binding, so no property
    /// predicate, value comparison, facet or source permission is executed here.
    /// </summary>
    public async Task<AuthorSearchPropertyOperandIntake> InspectPropertyOperandsAsync(
        AuthorSearchQuery query,
        IReadOnlyDictionary<Guid, ArticlePropertyDefinition> definitions,
        IEnumerable<AuthorSearchPropertyOperand> operands,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentNullException.ThrowIfNull(definitions);
        ArgumentNullException.ThrowIfNull(operands);
        cancellationToken.ThrowIfCancellationRequested();
        AuthorFullTextSearchContract.ValidateQuery(query, definitions);
        // All eight payload variants own immutable data in the supplied contract;
        // retain a bounded immutable outer copy before the original inspector awaits.
        ImmutableArray<AuthorSearchPropertyOperand> held = operands
            .Take(AuthorFullTextSearchContract.MaxQueryClauses + 1).ToImmutableArray();
        ValidatePropertyIntake(query, definitions, held, cancellationToken);
        AuthorSearchTokenEvaluation evidence = await InspectIndexAsync(query, definitions, cancellationToken)
            .ConfigureAwait(false);
        // Resolve again from the supplied definition collection: a replaced schema,
        // owner or digest cannot survive the original asynchronous index inspection.
        ValidatePropertyIntake(query, definitions, held, cancellationToken);
        await RevalidateIndexAsync(query, evidence, cancellationToken).ConfigureAwait(false);
        ValidatePropertyIntake(query, definitions, held, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        var intake = new AuthorSearchPropertyOperandIntake(evidence, held, string.Empty);
        return intake with
        {
            ContentDigest = PropertyIntakeDigest(intake)
        };
    }

    /// <summary>Rejects changed typed inputs/definitions/index facts; it admits no property execution.</summary>
    public async Task RevalidatePropertyOperandsAsync(
        AuthorSearchQuery query,
        AuthorSearchPropertyOperandIntake intake,
        IReadOnlyDictionary<Guid, ArticlePropertyDefinition> definitions,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentNullException.ThrowIfNull(intake);
        ArgumentNullException.ThrowIfNull(definitions);
        cancellationToken.ThrowIfCancellationRequested();
        AuthorFullTextSearchContract.ValidateQuery(query, definitions);
        ValidatePropertyIntake(query, definitions, intake.Operands, cancellationToken);
        if (intake.IndexEvidence is null || intake.ContentDigest != PropertyIntakeDigest(intake))
        {
            throw new AuthorSearchContractException("author_search_property_intake_tampered");
        }
        await RevalidateIndexAsync(query, intake.IndexEvidence, cancellationToken).ConfigureAwait(false);
        ValidatePropertyIntake(query, definitions, intake.Operands, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
    }

    private static void ValidatePropertyIntake(
        AuthorSearchQuery query,
        IReadOnlyDictionary<Guid, ArticlePropertyDefinition> definitions,
        ImmutableArray<AuthorSearchPropertyOperand> operands,
        CancellationToken cancellationToken)
    {
        if (operands.IsDefaultOrEmpty || operands.Length > AuthorFullTextSearchContract.MaxQueryClauses
            || query.Clauses.Length > AuthorFullTextSearchContract.MaxQueryClauses - operands.Length)
        {
            throw new AuthorSearchContractException("author_search_query_budget_invalid");
        }
        var seen = new HashSet<(Guid DefinitionId, string OperatorId)>();
        foreach (AuthorSearchPropertyOperand operand in operands)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (operand is null || !definitions.TryGetValue(operand.DefinitionId, out ArticlePropertyDefinition? definition)
                || definition is null)
            {
                throw new AuthorSearchContractException("author_search_property_unknown");
            }
            // The existing full-text definition eligibility/owner restrictions still
            // apply. These supplied metadata facts cannot establish fresh access.
            AuthorFullTextSearchContract.ValidatePropertyOperand(operand, definition);
            if (!definition.SearchEligible || definition.Owner.SiteScope != query.SiteScope
                || definition.Owner.UserId.HasValue && definition.Owner.UserId.Value != query.UserId)
            {
                throw new AuthorSearchContractException("author_search_property_not_eligible");
            }
            if (!seen.Add((operand.DefinitionId, operand.OperatorId)))
            {
                throw new AuthorSearchContractException("author_search_duplicate_filter");
            }
        }
    }

    private static string PropertyIntakeDigest(AuthorSearchPropertyOperandIntake intake)
        => AuthorFullTextSearchContract.Digest(JsonSerializer.Serialize(new
        {
            intake.IndexEvidence,
            Operands = intake.Operands.Select(static operand => operand.ContentDigest).ToArray()
        }));
}
