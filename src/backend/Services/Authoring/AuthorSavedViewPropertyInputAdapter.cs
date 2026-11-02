using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Connects a supplied resolved Saved View plan to the sole typed operand/value owners.
/// These are input candidates, not compiled queries or article results. The current plan
/// does not prove how a property field/revision or its canonical strings bind to a typed
/// definition/operand. That missing authority is retained as an explicit refusal.
/// </summary>
public static class AuthorSavedViewPropertyInputAdapter
{
    public const string OperandBindingUnavailable = "saved_view_property_condition_binding_unavailable";
    public const string ProjectionAuthorityUnavailable = "saved_view_property_projection_authority_unavailable";

    /// <summary>
    /// Validates the original plan and creates a typed operand using the existing owner.
    /// operatorId and values are supplied typed inputs; this method never parses Saved View
    /// strings, translates generic operators, drops a condition or admits a property query.
    /// The candidate retains both inputs so a later canonical binding API must reconcile them.
    /// </summary>
    public static AuthorSavedViewPropertyOperandCandidate PrepareOperand(
        AuthorSavedViewResolvedPlan plan,
        AuthorSavedView source,
        AuthorSavedViewQueryValidationResult currentDependencies,
        int expectedLimit,
        int conditionIndex,
        ArticlePropertyDefinition definition,
        string operatorId,
        IEnumerable<ArticlePropertyTypedValue> values)
    {
        ValidatePreparation(plan, source, currentDependencies, expectedLimit);
        if (conditionIndex < 0 || conditionIndex >= plan.Query.Conditions.Count)
        {
            throw new AuthorSavedViewValidationException("saved_view_property_condition_index_invalid");
        }

        AuthorSavedViewCondition condition = plan.Query.Conditions[conditionIndex];
        if (condition.Field.Kind != AuthorSavedViewFieldKind.Property)
        {
            throw new AuthorSavedViewValidationException("saved_view_property_condition_kind_invalid");
        }

        // The definition owner validates flags, type, operator, arity, shape and digest.
        // It retains its own refusals for undefined URL operand representations.
        AuthorSearchPropertyOperand operand = AuthorFullTextSearchContract.CreatePropertyOperand(
            definition, operatorId, values);
        AuthorFullTextSearchContract.ValidatePropertyOperand(operand, definition);
        if ((condition.Values.Count == 0) != (operand.Values.Length == 0)
            || (condition.Values.Count == 0 && condition.OperatorId != operand.OperatorId))
        {
            throw new AuthorSavedViewValidationException("saved_view_property_presence_operand_mismatch");
        }

        return new(plan.ContentDigest, conditionIndex, condition with
        {
            Values = Array.AsReadOnly(condition.Values.ToArray())
        }, plan.Dependencies[conditionIndex].AuthorityRevision, operand);
    }

    /// <summary>
    /// Projects one supplied value through its definition-owned typed projection. It does
    /// not read articles, resolve references, tokenize values, filter results or sort them.
    /// Supplied definition/value facts do not establish current source or target permission,
    /// index freshness, or the Saved View field-to-definition mapping.
    /// </summary>
    public static AuthorSavedViewPropertyProjectionCandidate PrepareProjection(
        AuthorSavedViewResolvedPlan plan,
        AuthorSavedView source,
        AuthorSavedViewQueryValidationResult currentDependencies,
        int expectedLimit,
        int projectionIndex,
        ArticlePropertyDefinition definition,
        ArticlePropertyValueEntry entry)
    {
        ValidatePreparation(plan, source, currentDependencies, expectedLimit);
        if (projectionIndex < 0 || projectionIndex >= plan.Query.Projection.Count)
        {
            throw new AuthorSavedViewValidationException("saved_view_property_projection_index_invalid");
        }

        AuthorSavedViewFieldReference field = plan.Query.Projection[projectionIndex];
        if (field.Kind != AuthorSavedViewFieldKind.Property)
        {
            throw new AuthorSavedViewValidationException("saved_view_property_projection_kind_invalid");
        }

        AuthorSearchProjectedPropertyValue projection = AuthorSearchPropertyValueProjection.Project(
            definition, entry);
        int dependencyIndex = plan.Query.Conditions.Count + 1 + projectionIndex;
        return new(plan.ContentDigest, projectionIndex, field,
            plan.Dependencies[dependencyIndex].AuthorityRevision, projection);
    }

    private static void ValidatePreparation(
        AuthorSavedViewResolvedPlan plan,
        AuthorSavedView source,
        AuthorSavedViewQueryValidationResult currentDependencies,
        int expectedLimit)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(currentDependencies);
        ArgumentNullException.ThrowIfNull(plan.Query);
        ArgumentNullException.ThrowIfNull(plan.Dependencies);
        ArgumentNullException.ThrowIfNull(currentDependencies.Resolutions);
        int dependencyLimit = AuthorSavedViewContract.MaxConditions + AuthorSavedViewContract.MaxProjectionFields + 1;
        if (plan.Dependencies.Count > dependencyLimit || currentDependencies.Resolutions.Count > dependencyLimit)
        {
            throw new AuthorSavedViewValidationException("saved_view_property_dependency_budget_exceeded");
        }

        AuthorSavedViewVerificationResult verification = AuthorSavedViewExecutionPreparationVerifier.VerifyResolvedPlan(
            plan, source, currentDependencies, expectedLimit);
        if (!verification.Valid)
        {
            throw new AuthorSavedViewValidationException("saved_view_property_preparation_invalid");
        }
    }
}

/// <summary>
/// Detached typed operand candidate retaining the exact plan/condition/dependency coordinates.
/// UnavailableReason is constant: a valid owner operand is not a proved translation of the
/// Saved View condition and cannot make the original property query validator available.
/// </summary>
public sealed record AuthorSavedViewPropertyOperandCandidate(
    string PlanContentDigest,
    int ConditionIndex,
    AuthorSavedViewCondition Condition,
    string DependencyAuthorityRevision,
    AuthorSearchPropertyOperand Operand)
{
    public string UnavailableReason => AuthorSavedViewPropertyInputAdapter.OperandBindingUnavailable;
}

/// <summary>
/// Supplied value projection retaining presence, default provenance, flags and owner digests.
/// It is neither an article result nor a permission, freshness or execution receipt.
/// </summary>
public sealed record AuthorSavedViewPropertyProjectionCandidate(
    string PlanContentDigest,
    int ProjectionIndex,
    AuthorSavedViewFieldReference Field,
    string DependencyAuthorityRevision,
    AuthorSearchProjectedPropertyValue Projection)
{
    public string UnavailableReason => AuthorSavedViewPropertyInputAdapter.ProjectionAuthorityUnavailable;
}
