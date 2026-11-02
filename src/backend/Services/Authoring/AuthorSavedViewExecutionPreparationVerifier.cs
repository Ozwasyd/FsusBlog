namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Recomputes preparation identities against supplied current source/dependency facts. It
/// verifies only saved-view preparation, never claims query execution, permission filtering,
/// index freshness, cursor validity or article result parity on behalf of another authority.
/// </summary>
public static class AuthorSavedViewExecutionPreparationVerifier
{
    public static string ComputePlanDigest(AuthorSavedViewResolvedPlan plan)
        => AuthorSavedViewStorageContract.ComputeCommandDigest(
            AuthorSavedViewContract.SchemaVersion, plan.Owner.AdminPrincipalId, plan.Owner.SiteScope,
            plan.ViewId, plan.ViewRevision, plan.ViewContentDigest,
            plan.QueryDigest, plan.DependencyDigest, plan.Limit);

    public static string ComputePreparationDigest(AuthorSavedViewExecutionPreparation preparation)
        => AuthorSavedViewStorageContract.ComputeCommandDigest(
            preparation.RequestId, preparation.RequestSequence, (int)preparation.Status,
            preparation.Plan?.ContentDigest,
            AuthorSavedViewContract.ComputeDependencyDigest(preparation.Dependencies), preparation.ReasonCode);

    public static AuthorSavedViewVerificationResult VerifyResolvedPlan(
        AuthorSavedViewResolvedPlan plan,
        AuthorSavedView source,
        AuthorSavedViewQueryValidationResult currentDependencies,
        int expectedLimit)
    {
        try
        {
            ValidateSource(source);
            ValidateResolution(source, currentDependencies);
            AuthorSavedViewContract.ValidateQueryShape(plan.Query);
            if (!currentDependencies.IsValid || source.LifecycleState != AuthorSavedViewLifecycleState.Active
                || plan.Owner != source.Owner || plan.ViewId != source.Id || plan.ViewRevision != source.Revision
                || plan.ViewContentDigest != source.ContentDigest || plan.QueryDigest != source.QueryDigest
                || AuthorSavedViewContract.ComputeQueryDigest(plan.Query) != source.QueryDigest
                || plan.DependencyDigest != currentDependencies.DependencyDigest
                || plan.Limit != expectedLimit || expectedLimit is < 1 or > AuthorSavedViewContract.MaxPageSize
                || expectedLimit > source.Query.PageSize
                || plan.ContentDigest != ComputePlanDigest(plan)
                || !SameDependencies(plan.Dependencies, currentDependencies.Resolutions))
            {
                return new(false, ["saved_view_preparation_plan_tampered"]);
            }
            return new(true, []);
        }
        catch (AuthorSavedViewValidationException)
        {
            return new(false, ["saved_view_preparation_source_or_dependencies_invalid"]);
        }
    }

    internal static void ValidateSource(AuthorSavedView source)
    {
        AuthorSavedViewContract.ValidateOwner(source.Owner);
        AuthorSavedViewContract.ValidateQueryShape(source.Query);
        if (source.SchemaVersion != AuthorSavedViewContract.SchemaVersion
            || source.Id == Guid.Empty || source.Revision < 1 || !Enum.IsDefined(source.LifecycleState)
            || AuthorSavedViewContract.ComputeQueryDigest(source.Query) != source.QueryDigest
            || source.ContentDigest != AuthorSavedViewStorageContract.ComputeViewDigest(
                source.Owner, source.Id, source.Revision, source.Name, source.QueryDigest,
                source.DependencyDigest, source.Pinned, source.OrderKey, source.LifecycleState))
        {
            throw new AuthorSavedViewValidationException("saved_view_execution_source_tampered");
        }
    }

    internal static void ValidateResolution(
        AuthorSavedView source,
        AuthorSavedViewQueryValidationResult validation)
    {
        AuthorSavedViewContract.ValidateQueryShape(validation.Query);
        if (validation.QueryDigest != source.QueryDigest
            || AuthorSavedViewContract.ComputeQueryDigest(validation.Query) != source.QueryDigest
            || validation.Resolutions.Count != source.Query.Conditions.Count + source.Query.Projection.Count + 1
            || validation.DependencyDigest != AuthorSavedViewContract.ComputeDependencyDigest(validation.Resolutions))
        {
            throw new AuthorSavedViewValidationException("saved_view_execution_resolution_tampered");
        }

        var reasons = new List<string>();
        for (int index = 0; index < validation.Resolutions.Count; index++)
        {
            AuthorSavedViewDependencyResolution resolution = validation.Resolutions[index];
            int conditionCount = source.Query.Conditions.Count;
            AuthorSavedViewFieldReference field = index < conditionCount
                ? source.Query.Conditions[index].Field
                : index == conditionCount
                    ? source.Query.Sort.Field
                    : source.Query.Projection[index - conditionCount - 1];
            string operation = index < conditionCount
                ? source.Query.Conditions[index].OperatorId
                : index == conditionCount ? "sort" : "projection";
            if (resolution.Dependency != field || resolution.OperatorId != operation
                || resolution.Operator.Id != operation || !resolution.Operator.FieldKinds.Contains(field.Kind)
                || !Enum.IsDefined(resolution.Status)
                || string.IsNullOrWhiteSpace(resolution.AuthorityRevision)
                || resolution.AuthorityRevision.Length > AuthorSavedViewContract.MaxIdentityLength
                || resolution.AuthorityRevision.Any(static character => char.IsControl(character) || char.IsWhiteSpace(character))
                || (index < conditionCount && !AuthorSavedViewContract.IsRegisteredOperatorDescriptor(resolution.Operator)))
            {
                throw new AuthorSavedViewValidationException("saved_view_execution_resolution_tampered");
            }
            if (index < conditionCount)
            {
                IReadOnlyList<string> values = source.Query.Conditions[index].Values;
                IEnumerable<string> canonical = resolution.Operator.Cardinality == AuthorSavedViewOperatorCardinality.MultipleSet
                    ? resolution.CanonicalValues.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)
                    : resolution.CanonicalValues;
                if (resolution.CanonicalValues.Count > 0 && !canonical.SequenceEqual(values))
                {
                    throw new AuthorSavedViewValidationException("saved_view_execution_resolution_tampered");
                }
            }
            else if (resolution.CanonicalValues.Count != 0
                || !SameOperator(resolution.Operator,
                    AuthorSavedViewDependencyCatalog.Projection(field, operation, resolution.Status, resolution.AuthorityRevision).Operator))
            {
                throw new AuthorSavedViewValidationException("saved_view_execution_resolution_tampered");
            }
            if (resolution.Status is not (AuthorSavedViewDependencyStatus.Current or AuthorSavedViewDependencyStatus.RenamedLabelOnly))
            {
                string prefix = index < conditionCount ? string.Empty : index == conditionCount ? "sort:" : "projection:";
                reasons.Add($"{prefix}{field.Kind}:{field.Identity}:{resolution.Status}");
            }
        }
        if (validation.IsValid != (reasons.Count == 0) || !validation.Reasons.SequenceEqual(reasons))
        {
            throw new AuthorSavedViewValidationException("saved_view_execution_resolution_tampered");
        }
    }

    private static bool SameDependencies(
        IReadOnlyList<AuthorSavedViewDependencyResolution> actual,
        IReadOnlyList<AuthorSavedViewDependencyResolution> expected)
        => actual.Count == expected.Count && actual.Zip(expected).All(static pair =>
            pair.First.Dependency == pair.Second.Dependency
            && pair.First.OperatorId == pair.Second.OperatorId
            && pair.First.Status == pair.Second.Status
            && pair.First.AuthorityRevision == pair.Second.AuthorityRevision
            && pair.First.CanonicalValues.SequenceEqual(pair.Second.CanonicalValues)
            && SameOperator(pair.First.Operator, pair.Second.Operator));

    private static bool SameOperator(AuthorSavedViewOperatorDescriptor actual, AuthorSavedViewOperatorDescriptor expected)
        => (actual with
        {
            FieldKinds = expected.FieldKinds
        }) == expected && actual.FieldKinds.SequenceEqual(expected.FieldKinds);
}
