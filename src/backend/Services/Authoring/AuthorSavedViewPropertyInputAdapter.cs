using System.Globalization;

using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Connects a supplied resolved Saved View plan to the sole typed operand/value owners.
/// These are input candidates, not compiled queries or article results. The current plan
/// does not prove how a property field/revision binds to an observed definition. Canonical
/// scalar/identity inputs can map to supported owner operands; missing definition, permission
/// and query admission authorities remain explicit, even after that input mapping succeeds.
/// </summary>
public static class AuthorSavedViewPropertyInputAdapter
{
    public const string OperandBindingUnavailable = "saved_view_property_condition_binding_unavailable";
    public const string ProjectionAuthorityUnavailable = "saved_view_property_projection_authority_unavailable";
    public const string DefinitionBindingUnavailable = "saved_view_property_definition_binding_unavailable";
    public const string OperandSemanticsUnavailable = "saved_view_property_operand_semantics_unavailable";

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
        AuthorSavedViewCondition condition = PropertyCondition(plan, conditionIndex);
        return CreateOperandCandidate(plan, conditionIndex, condition, definition, operatorId, values);
    }

    /// <summary>
    /// Maps canonical Saved View values and generic equals/any-of onto the supplied definition's
    /// existing typed operand contract. Scalars must equal the definition owner's normalization;
    /// identities must round-trip as exact GUID-D/positive decimal IDs, never option labels or
    /// prefixed aliases. Presence has zero payloads and never applies defaults. Text, local dates,
    /// between, collection equality and URL component semantics remain unavailable.
    /// Matching site coordinates is only structural validation: no join between definition
    /// user IDs and administrator principals is inferred. The caller still lacks field/dependency
    /// binding authority and a production query/permission/freshness grant.
    /// </summary>
    public static AuthorSavedViewCanonicalPropertyOperandCandidate PrepareCanonicalOperand(
        AuthorSavedViewResolvedPlan plan,
        AuthorSavedView source,
        AuthorSavedViewQueryValidationResult currentDependencies,
        int expectedLimit,
        int conditionIndex,
        ArticlePropertyDefinition definition)
    {
        ValidatePreparation(plan, source, currentDependencies, expectedLimit);
        AuthorSavedViewCondition condition = PropertyCondition(plan, conditionIndex) with
        {
            Values = Array.AsReadOnly(plan.Query.Conditions[conditionIndex].Values
                .Take(AuthorSavedViewContract.MaxValuesPerCondition + 1).ToArray())
        };
        AuthorSavedViewContract.ValidateConditionShape(condition);
        ArgumentNullException.ThrowIfNull(definition);
        ArticlePropertyDefinitionContract.ValidateDefinition(definition);
        if (definition.Owner.SiteScope != plan.Owner.SiteScope)
        {
            throw new AuthorSavedViewValidationException("saved_view_property_definition_scope_mismatch");
        }

        (string operatorId, ArticlePropertyTypedValue[] values) = BindCanonicalValues(condition, definition);
        AuthorSavedViewPropertyOperandCandidate candidate = CreateOperandCandidate(
            plan, conditionIndex, condition, definition, operatorId, values);
        ValidatePreparation(plan, source, currentDependencies, expectedLimit);
        if (!condition.Values.SequenceEqual(plan.Query.Conditions[conditionIndex].Values))
        {
            throw new AuthorSavedViewValidationException("saved_view_property_preparation_invalid");
        }
        return new(candidate.PlanContentDigest, candidate.ConditionIndex, candidate.Condition,
            candidate.DependencyAuthorityRevision, candidate.Operand);
    }

    private static AuthorSavedViewCondition PropertyCondition(AuthorSavedViewResolvedPlan plan, int conditionIndex)
    {
        if (conditionIndex < 0 || conditionIndex >= plan.Query.Conditions.Count)
        {
            throw new AuthorSavedViewValidationException("saved_view_property_condition_index_invalid");
        }

        AuthorSavedViewCondition condition = plan.Query.Conditions[conditionIndex];
        if (condition.Field.Kind != AuthorSavedViewFieldKind.Property)
        {
            throw new AuthorSavedViewValidationException("saved_view_property_condition_kind_invalid");
        }
        return condition;
    }

    private static AuthorSavedViewPropertyOperandCandidate CreateOperandCandidate(
        AuthorSavedViewResolvedPlan plan,
        int conditionIndex,
        AuthorSavedViewCondition condition,
        ArticlePropertyDefinition definition,
        string operatorId,
        IEnumerable<ArticlePropertyTypedValue> values)
    {
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

    private static (string OperatorId, ArticlePropertyTypedValue[] Values) BindCanonicalValues(
        AuthorSavedViewCondition condition, ArticlePropertyDefinition definition)
    {
        // This is a translation into the sole owner table, never a comparison/operator registry.
        return (condition.OperatorId, definition.ValueType) switch
        {
            ("value.is-missing" or "value.is-present", _) => (condition.OperatorId, []),
            ("property.equals", ArticlePropertyValueType.Number) => ("number.equals",
                [new ArticlePropertyNumberValue(decimal.Parse(CanonicalScalar(definition, condition.Values[0]),
                    NumberStyles.Number, CultureInfo.InvariantCulture))]),
            ("property.equals", ArticlePropertyValueType.Boolean) => ("boolean.equals",
                [new ArticlePropertyBooleanValue(CanonicalScalar(definition, condition.Values[0]) == "true")]),
            ("property.equals", ArticlePropertyValueType.SingleSelect) => ("select.equals",
                [new ArticlePropertySingleSelectValue(CanonicalOptionId(condition.Values[0]))]),
            ("property.any-of", ArticlePropertyValueType.SingleSelect) => ("select.any-of",
                condition.Values.Select(static value => (ArticlePropertyTypedValue)
                    new ArticlePropertySingleSelectValue(CanonicalOptionId(value))).ToArray()),
            ("property.any-of", ArticlePropertyValueType.MultiSelect) => ("select.any-of",
                [new ArticlePropertyMultiSelectValue(condition.Values.Select(CanonicalOptionId).Order())]),
            ("property.equals", ArticlePropertyValueType.ArticleReference)
                when definition.Cardinality == ArticlePropertyCardinality.Single => ("reference.equals",
                    [new ArticlePropertyArticleReferenceValue([CanonicalArticleId(condition.Values[0])])]),
            ("property.any-of", ArticlePropertyValueType.ArticleReference) => ("reference.any-of",
                [new ArticlePropertyArticleReferenceValue(condition.Values.Select(CanonicalArticleId).Order())]),
            ("property.equals", ArticlePropertyValueType.Url) => ("url.equals",
                [new ArticlePropertyUrlValue(CanonicalUrl(definition, condition.Values[0]))]),
            _ => throw new AuthorSavedViewValidationException(OperandSemanticsUnavailable)
        };
    }

    private static string CanonicalScalar(ArticlePropertyDefinition definition, string value)
    {
        string normalized = ArticlePropertyDefinitionContract.NormalizeScalar(definition.ValueType, value);
        RequireCanonical(normalized == value);
        return normalized;
    }

    private static Guid CanonicalOptionId(string value)
    {
        RequireCanonical(Guid.TryParseExact(value, "D", out Guid identity)
            && identity != Guid.Empty && identity.ToString("D") == value);
        return identity;
    }

    private static long CanonicalArticleId(string value)
    {
        RequireCanonical(long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out long identity)
            && identity > 0 && identity.ToString(CultureInfo.InvariantCulture) == value);
        return identity;
    }

    private static string CanonicalUrl(ArticlePropertyDefinition definition, string value)
    {
        string normalized = ArticlePropertyDefinitionContract.NormalizeUrl(value, definition.UrlPolicy!);
        RequireCanonical(normalized == value);
        return normalized;
    }

    private static void RequireCanonical(bool valid)
    {
        if (!valid)
        {
            throw new AuthorSavedViewValidationException("saved_view_property_value_not_canonical");
        }
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
/// Detached, canonical value/operator mapping into the existing owner operand. The exact source
/// condition and opaque dependency revision are retained. No inferred field identity, definition
/// revision, permission/freshness proof or query admission is generated; execution stays unavailable.
/// </summary>
public sealed record AuthorSavedViewCanonicalPropertyOperandCandidate(
    string PlanContentDigest,
    int ConditionIndex,
    AuthorSavedViewCondition Condition,
    string DependencyAuthorityRevision,
    AuthorSearchPropertyOperand Operand)
{
    public string UnavailableReason => AuthorSavedViewPropertyInputAdapter.DefinitionBindingUnavailable;
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
