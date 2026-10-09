using System.Collections.Immutable;

using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public enum AuthoringFilterMappingStatus
{
    Blocked = 0,
    Unsupported = 1,
    NeedsUpdate = 2,
    Rejected = 3
}

/// <summary>
/// Structural data only. Even a non-null query is blocked from execution. No result,
/// authorization, cache key, admission or runtime receipt is issued by this mapper.
/// </summary>
public sealed record AuthoringFilterMappingResult(
    AuthoringFilterMappingStatus Status,
    AuthorSavedViewQuery? StructuralQuery,
    string? StructuralQueryDigest,
    ImmutableArray<string> Reasons);

/// <summary>
/// Maps registered closed references into the original SavedView AND AST and invokes
/// its validator. This registry never implements or replaces a query/operator authority.
/// Missing host facts remain blocked; no plugin assertion can make them available.
/// </summary>
public sealed class AuthoringFilterContributionQueryMapper
{
    private readonly ImmutableDictionary<string, AuthoringFilterContribution> _contributions;
    private readonly IAuthorSavedViewQueryValidator _validator;

    public AuthoringFilterContributionQueryMapper(
        IEnumerable<AuthoringFilterContribution> contributions,
        AuthoringCoreAuthorityRegistry coreAuthorities,
        IAuthorSavedViewQueryValidator validator)
    {
        ArgumentNullException.ThrowIfNull(contributions);
        ArgumentNullException.ThrowIfNull(coreAuthorities);
        ArgumentNullException.ThrowIfNull(validator);
        AuthoringFilterContributionContracts.Require(!coreAuthorities.CommandIds.IsDefault
            && !coreAuthorities.RouteIds.IsDefault && !coreAuthorities.PropertyIds.IsDefault
            && !coreAuthorities.SavedViewOperatorIds.IsDefault && !coreAuthorities.SecurityPolicyIds.IsDefault,
            "filter_core_registry_missing");
        var reserved = new HashSet<string>(coreAuthorities.CommandIds, StringComparer.Ordinal);
        reserved.UnionWith(coreAuthorities.RouteIds);
        reserved.UnionWith(coreAuthorities.PropertyIds);
        reserved.UnionWith(coreAuthorities.SavedViewOperatorIds);
        reserved.UnionWith(coreAuthorities.SecurityPolicyIds);
        reserved.UnionWith(AuthorSavedViewContract.Operators.Keys);
        reserved.UnionWith(AuthorSavedViewContract.Fields.Values.SelectMany(static field => field.ExactIdentities));
        reserved.Add(AuthorSavedViewContract.ArticleIdentityTieBreaker);
        var identities = new HashSet<string>(StringComparer.Ordinal);
        var registry = ImmutableDictionary.CreateBuilder<string, AuthoringFilterContribution>(StringComparer.Ordinal);
        foreach (AuthoringFilterContribution contribution in contributions)
        {
            AuthoringFilterContributionContracts.Require(registry.Count < AuthoringFilterContributionContracts.MaximumContributions,
                "filter_registry_budget_exceeded");
            AuthoringFilterContributionContracts.Validate(contribution);
            AuthoringFilterContributionContracts.Require(!reserved.Contains(contribution.PluginId)
                && !reserved.Contains(contribution.FilterId), "filter_core_identity_conflict");
            AuthoringFilterContributionContracts.Require(identities.Add(contribution.FilterId), "filter_identity_duplicate");
            foreach (AuthoringFilterOperatorDeclaration declaration in contribution.Operators)
            {
                AuthoringFilterContributionContracts.Require(!reserved.Contains(declaration.Id), "filter_core_identity_conflict");
                AuthoringFilterContributionContracts.Require(identities.Add(declaration.Id), "filter_operator_duplicate");
            }
            registry.Add(contribution.FilterId, contribution);
        }
        _contributions = registry.ToImmutable();
        _validator = validator;
    }

    /// <summary>
    /// A lifecycle observation can only refuse mapping; Enabled/Running does not prove
    /// active package, permission or lifecycle currentness. Those owners are not wired here.
    /// The asynchronous operation is solely the existing validator, never a plugin callback.
    /// </summary>
    public async Task<AuthoringFilterMappingResult> MapAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewQuery original,
        ImmutableArray<AuthoringFilterConfiguration> configurations,
        AuthoringLifecycleState? lifecycleObservation = null,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            AuthorSavedViewContract.ValidateOwner(owner);
            AuthorSavedViewContract.ValidateQueryShape(original);
            AuthoringFilterContributionContracts.Require(!configurations.IsDefault
                && configurations.Length <= AuthorSavedViewContract.MaxConditions,
                "filter_configuration_budget_exceeded");
            AuthoringFilterContributionContracts.Require(original.Conditions.Count + configurations.Length
                <= AuthorSavedViewContract.MaxConditions, "saved_view_condition_budget_exceeded");
            // Snapshot before awaiting the canonical validator; caller-owned lists cannot change the proposal.
            AuthorSavedViewQuery snapshot = original with
            {
                Conditions = Array.AsReadOnly(original.Conditions.Select(static condition => condition with
                {
                    Values = Array.AsReadOnly(condition.Values.ToArray())
                }).ToArray()),
                Projection = Array.AsReadOnly(original.Projection.ToArray())
            };
            var additions = new List<AuthorSavedViewCondition>();
            var selected = new HashSet<(string, string)>();
            var counts = new Dictionary<string, int>(StringComparer.Ordinal);
            int cost = 0;
            foreach (AuthoringFilterConfiguration configuration in configurations)
            {
                cancellationToken.ThrowIfCancellationRequested();
                AuthoringFilterContributionContracts.ValidateConfiguration(configuration);
                if (!_contributions.TryGetValue(configuration.FilterId, out AuthoringFilterContribution? contribution))
                {
                    return Refusal(AuthoringFilterMappingStatus.Unsupported, "filter_registration_unavailable");
                }
                if (configuration.PluginId != contribution.PluginId
                    || configuration.PluginVersion != contribution.PluginVersion
                    || configuration.PackageSha256 != contribution.PackageSha256
                    || configuration.FilterVersion != contribution.FilterVersion)
                {
                    return Refusal(AuthoringFilterMappingStatus.NeedsUpdate, "filter_binding_drift");
                }
                AuthoringFilterOperatorDeclaration? declaration = contribution.Operators.FirstOrDefault(
                    item => item.Id == configuration.OperatorId);
                if (declaration is null)
                {
                    return Refusal(AuthoringFilterMappingStatus.Unsupported, "filter_operator_unregistered");
                }
                if (declaration.Version != configuration.OperatorVersion)
                {
                    return Refusal(AuthoringFilterMappingStatus.NeedsUpdate, "filter_operator_version_drift");
                }
                AuthoringFilterContributionContracts.Require(selected.Add((configuration.FilterId, configuration.OperatorId)),
                    "filter_configuration_duplicate");
                int count = counts.GetValueOrDefault(configuration.FilterId) + 1;
                counts[configuration.FilterId] = count;
                AuthoringFilterContributionContracts.Require(count <= contribution.MaximumConditions, "filter_condition_budget_exceeded");
                cost += contribution.CostPerCondition;
                AuthoringFilterContributionContracts.Require(cost <= AuthoringFilterContributionContracts.MaximumQueryCost,
                    "filter_query_cost_exceeded");
                additions.Add(MapCondition(declaration, configuration));
            }
            AuthorSavedViewQuery structural = snapshot with
            {
                Conditions = Array.AsReadOnly(snapshot.Conditions.Concat(additions).ToArray())
            };
            AuthorSavedViewContract.ValidateQueryShape(structural);
            string digest = AuthorSavedViewContract.ComputeQueryDigest(structural);
            AuthorSavedViewQueryValidationResult validation = await _validator.ValidateAsync(
                owner, structural, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            // Validation may canonically sort/normalize its output. The structural proposal
            // intentionally retains every original condition and value in the original order.
            var reasons = ImmutableArray.CreateBuilder<string>();
            reasons.AddRange(validation.Reasons);
            if (!validation.IsValid)
            {
                reasons.Add("filter_saved_view_validation_blocked");
            }
            reasons.Add("filter_permission_facts_unavailable");
            reasons.Add("filter_indexability_facts_unavailable");
            reasons.Add("filter_lifecycle_facts_unavailable");
            reasons.Add("filter_canonical_executor_unavailable");
            AuthoringFilterMappingStatus status = AuthoringFilterMappingStatus.Blocked;
            if (lifecycleObservation.HasValue)
            {
                if (!Enum.IsDefined(lifecycleObservation.Value))
                {
                    return Refusal(AuthoringFilterMappingStatus.Rejected, "filter_lifecycle_state_unknown");
                }
                if (lifecycleObservation is AuthoringLifecycleState.MigrationRequired or AuthoringLifecycleState.Updating
                    or AuthoringLifecycleState.Migrating or AuthoringLifecycleState.RollbackRequired)
                {
                    status = AuthoringFilterMappingStatus.NeedsUpdate;
                    reasons.Add("filter_lifecycle_needs_update");
                }
                else if (lifecycleObservation is not AuthoringLifecycleState.Enabled and not AuthoringLifecycleState.Running)
                {
                    status = AuthoringFilterMappingStatus.Unsupported;
                    reasons.Add("filter_lifecycle_not_active");
                }
            }
            return new AuthoringFilterMappingResult(status, structural, digest, reasons.ToImmutable());
        }
        catch (AuthoringFilterContractException exception)
        {
            return Refusal(AuthoringFilterMappingStatus.Rejected, exception.Code);
        }
        catch (AuthorSavedViewValidationException exception)
        {
            return Refusal(AuthoringFilterMappingStatus.Rejected, exception.Code);
        }
    }

    private static AuthorSavedViewCondition MapCondition(
        AuthoringFilterOperatorDeclaration declaration, AuthoringFilterConfiguration configuration)
    {
        AuthoringFilterParameterSchema parameter = declaration.Parameter;
        int count = configuration.Values.Length;
        bool cardinality = parameter.Shape switch
        {
            AuthoringFilterParameterShape.None => count == 0,
            AuthoringFilterParameterShape.Scalar => count == 1,
            AuthoringFilterParameterShape.Range => count == 2,
            AuthoringFilterParameterShape.Set => count >= 1,
            _ => false
        };
        AuthoringFilterContributionContracts.Require(cardinality && count <= parameter.MaximumValues,
            "filter_parameter_cardinality_invalid");
        var values = new List<string>(count);
        foreach (AuthoringFilterScalar scalar in configuration.Values)
        {
            AuthoringFilterContributionContracts.Require(scalar.Kind == parameter.ScalarKind, "filter_parameter_type_conflict");
            values.Add(AuthoringFilterContributionContracts.FormatScalar(scalar, parameter.MaximumValueLength));
        }
        if (parameter.Shape == AuthoringFilterParameterShape.Set)
        {
            AuthoringFilterContributionContracts.Require(values.Distinct(StringComparer.Ordinal).Count() == count,
                "filter_set_value_duplicate");
        }
        if (parameter.Shape == AuthoringFilterParameterShape.Range)
        {
            // The closed registry currently exposes only date ranges. Other ranges cannot
            // become operators without the SavedView owner first registering their semantics.
            AuthoringFilterContributionContracts.Require(configuration.Values[0].Date <= configuration.Values[1].Date,
                "saved_view_date_range_invalid");
        }
        return new AuthorSavedViewCondition(declaration.Field, declaration.SavedViewOperatorId,
            Array.AsReadOnly(values.ToArray()), configuration.TimeZoneId);
    }

    private static AuthoringFilterMappingResult Refusal(AuthoringFilterMappingStatus status, string reason)
        => new(status, null, null, [reason]);
}
