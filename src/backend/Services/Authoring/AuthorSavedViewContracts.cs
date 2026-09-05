using System.Collections.ObjectModel;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Owns the only current Author Saved View query contract. The contract is a closed,
/// versioned AND of typed conditions; it never contains executable expressions,
/// result snapshots, authorization snapshots, or client functions.
/// </summary>
public static class AuthorSavedViewContract
{
    public const int SchemaVersion = 1;
    public const int MaxViewsPerOwner = 1_000;
    public const int MaxConditions = 64;
    public const int MaxValuesPerCondition = 64;
    public const int MaxProjectionFields = 32;
    public const int MaxPageSize = 100;
    public const int MaxNameCharacters = 128;
    public const int MaxNameUtf8Bytes = 512;
    public const int MaxNameKeyCharacters = 256;
    public const int MaxIdentityLength = 128;
    public const int MaxValueLength = 512;
    public const int MaxTimeZoneLength = 64;

    public const string ArticleIdentityTieBreaker = "article.id";
    public const string LifecycleStatusField = "article.lifecycle.status";
    public const string CreatedAtField = "article.created-at";
    public const string UpdatedAtField = "article.updated-at";
    public const string PublishedAtField = "article.published-at";
    public const string AuthorSearchField = "author-search.current";

    private static readonly ReadOnlyDictionary<string, AuthorSavedViewOperatorDescriptor> s_operators =
        new(new Dictionary<string, AuthorSavedViewOperatorDescriptor>(StringComparer.Ordinal)
        {
            ["identity.equals"] = new(
                "identity.equals",
                FieldKinds(
                    AuthorSavedViewFieldKind.LifecycleStatus,
                    AuthorSavedViewFieldKind.Category,
                    AuthorSavedViewFieldKind.Tag,
                    AuthorSavedViewFieldKind.RelationState,
                    AuthorSavedViewFieldKind.ContentCheckState),
                AuthorSavedViewValueKind.StableIdentity,
                AuthorSavedViewOperatorCardinality.Single,
                AuthorSavedViewNullSemantics.NullNeverMatches,
                AuthorSavedViewCaseSemantics.StableIdentityOrdinal,
                AuthorSavedViewDateBoundary.NotApplicable,
                "owning-domain",
                "canonical-article-query"),
            ["identity.any-of"] = new(
                "identity.any-of",
                FieldKinds(
                    AuthorSavedViewFieldKind.LifecycleStatus,
                    AuthorSavedViewFieldKind.Category,
                    AuthorSavedViewFieldKind.Tag,
                    AuthorSavedViewFieldKind.RelationState,
                    AuthorSavedViewFieldKind.ContentCheckState),
                AuthorSavedViewValueKind.StableIdentity,
                AuthorSavedViewOperatorCardinality.MultipleSet,
                AuthorSavedViewNullSemantics.NullNeverMatches,
                AuthorSavedViewCaseSemantics.StableIdentityOrdinal,
                AuthorSavedViewDateBoundary.NotApplicable,
                "owning-domain",
                "canonical-article-query"),
            ["value.is-missing"] = new(
                "value.is-missing",
                FieldKinds(AuthorSavedViewFieldKind.Property, AuthorSavedViewFieldKind.Date),
                AuthorSavedViewValueKind.None,
                AuthorSavedViewOperatorCardinality.None,
                AuthorSavedViewNullSemantics.MissingOnly,
                AuthorSavedViewCaseSemantics.NotApplicable,
                AuthorSavedViewDateBoundary.NotApplicable,
                "owning-domain",
                "canonical-article-query"),
            ["value.is-present"] = new(
                "value.is-present",
                FieldKinds(AuthorSavedViewFieldKind.Property, AuthorSavedViewFieldKind.Date),
                AuthorSavedViewValueKind.None,
                AuthorSavedViewOperatorCardinality.None,
                AuthorSavedViewNullSemantics.PresentOnly,
                AuthorSavedViewCaseSemantics.NotApplicable,
                AuthorSavedViewDateBoundary.NotApplicable,
                "owning-domain",
                "canonical-article-query"),
            ["date.before"] = DateOperator("date.before", AuthorSavedViewOperatorCardinality.Single,
                AuthorSavedViewDateBoundary.ExclusiveUpper),
            ["date.on-or-before"] = DateOperator("date.on-or-before", AuthorSavedViewOperatorCardinality.Single,
                AuthorSavedViewDateBoundary.InclusiveUpper),
            ["date.after"] = DateOperator("date.after", AuthorSavedViewOperatorCardinality.Single,
                AuthorSavedViewDateBoundary.ExclusiveLower),
            ["date.on-or-after"] = DateOperator("date.on-or-after", AuthorSavedViewOperatorCardinality.Single,
                AuthorSavedViewDateBoundary.InclusiveLower),
            ["date.between"] = DateOperator("date.between", AuthorSavedViewOperatorCardinality.OrderedPair,
                AuthorSavedViewDateBoundary.InclusiveRange),
            ["author-search.match"] = new(
                "author-search.match",
                FieldKinds(AuthorSavedViewFieldKind.FullText),
                AuthorSavedViewValueKind.Text,
                AuthorSavedViewOperatorCardinality.Single,
                AuthorSavedViewNullSemantics.NullNeverMatches,
                AuthorSavedViewCaseSemantics.AuthorSearchOwned,
                AuthorSavedViewDateBoundary.NotApplicable,
                "author-search-contract",
                "author-search-query")
        });

    private static readonly HashSet<string> s_lifecycleStatuses = new(StringComparer.Ordinal)
    {
        "inbox",
        "draft",
        "scheduled",
        "published",
        "archived"
    };

    public static IReadOnlyDictionary<string, AuthorSavedViewOperatorDescriptor> Operators => s_operators;

    public static void ValidateOwner(AuthorSavedViewOwner owner)
    {
        if (owner.AdminPrincipalId <= 0)
        {
            throw new AuthorSavedViewValidationException("saved_view_owner_invalid");
        }

        ValidateIdentity(owner.SiteScope, "saved_view_site_scope_invalid");
    }

    public static string NormalizeName(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            throw new AuthorSavedViewValidationException("saved_view_name_invalid");
        }

        string normalized = name.Trim().Normalize(NormalizationForm.FormC);
        if (normalized.Length > MaxNameCharacters
            || Encoding.UTF8.GetByteCount(normalized) > MaxNameUtf8Bytes
            || normalized.Any(char.IsControl))
        {
            throw new AuthorSavedViewValidationException("saved_view_name_invalid");
        }

        return normalized;
    }

    public static string NormalizeNameKey(string name)
    {
        string key = NormalizeName(name).ToUpperInvariant();
        if (key.Length > MaxNameKeyCharacters)
        {
            throw new AuthorSavedViewValidationException("saved_view_name_invalid");
        }
        return key;
    }

    public static void ValidateQueryShape(AuthorSavedViewQuery query)
    {
        ArgumentNullException.ThrowIfNull(query);
        if (query.SchemaVersion != SchemaVersion)
        {
            throw new AuthorSavedViewValidationException(
                query.SchemaVersion > SchemaVersion
                    ? "saved_view_query_future_schema"
                    : "saved_view_query_old_schema");
        }

        if (query.Conditions.Count > MaxConditions)
        {
            throw new AuthorSavedViewValidationException("saved_view_condition_budget_exceeded");
        }

        foreach (AuthorSavedViewCondition condition in query.Conditions)
        {
            ValidateConditionShape(condition);
        }

        string[] duplicateConditions =
        [
            .. query.Conditions
                .GroupBy(
                    static condition => $"{(int)condition.Field.Kind}:{condition.Field.Identity}:{condition.OperatorId}",
                    StringComparer.Ordinal)
                .Where(static group => group.Count() > 1)
                .Select(static group => group.Key)
        ];
        if (duplicateConditions.Length > 0)
        {
            throw new AuthorSavedViewValidationException("saved_view_condition_duplicate");
        }

        ValidateSort(query.Sort);
        ValidateProjection(query.Projection);
        if (query.PageSize is < 1 or > MaxPageSize)
        {
            throw new AuthorSavedViewValidationException("saved_view_page_size_invalid");
        }
    }

    public static AuthorSavedViewQuery NormalizeQuery(
        AuthorSavedViewQuery query,
        IReadOnlyDictionary<int, IReadOnlyList<string>> canonicalValues)
    {
        ValidateQueryShape(query);
        if (canonicalValues.Count != query.Conditions.Count)
        {
            throw new AuthorSavedViewValidationException("saved_view_canonical_values_incomplete");
        }

        AuthorSavedViewCondition[] conditions =
        [
            .. query.Conditions.Select((condition, index) => condition with
                {
                    Values = Array.AsReadOnly(canonicalValues[index].ToArray())
                })
                .OrderBy(static condition => condition.Field.Kind)
                .ThenBy(static condition => condition.Field.Identity, StringComparer.Ordinal)
                .ThenBy(static condition => condition.OperatorId, StringComparer.Ordinal)
                .ThenBy(static condition => string.Join('\u001f', condition.Values), StringComparer.Ordinal)
        ];

        return query with
        {
            Conditions = Array.AsReadOnly(conditions),
            Projection = Array.AsReadOnly(query.Projection.ToArray())
        };
    }

    public static string ComputeQueryDigest(AuthorSavedViewQuery query)
    {
        ValidateQueryShape(query);
        var canonical = new CanonicalDigestBuilder();
        canonical.Append(query.SchemaVersion);
        canonical.Append(query.Conditions.Count);
        foreach (AuthorSavedViewCondition condition in query.Conditions)
        {
            canonical.Append((int)condition.Field.Kind);
            canonical.Append(condition.Field.Identity);
            canonical.Append(condition.OperatorId);
            canonical.Append(condition.TimeZoneId);
            canonical.Append(condition.Values.Count);
            foreach (string value in condition.Values)
            {
                canonical.Append(value);
            }
        }

        canonical.Append((int)query.Sort.Field.Kind);
        canonical.Append(query.Sort.Field.Identity);
        canonical.Append((int)query.Sort.Direction);
        canonical.Append((int)query.Sort.NullPlacement);
        canonical.Append(query.Sort.Collation);
        canonical.Append(query.Sort.TimeZoneId);
        canonical.Append(query.Sort.StableTieBreaker);
        canonical.Append(query.Projection.Count);
        foreach (AuthorSavedViewFieldReference field in query.Projection)
        {
            canonical.Append((int)field.Kind);
            canonical.Append(field.Identity);
        }
        canonical.Append(query.PageSize);
        return canonical.Finish();
    }

    public static string ComputeDependencyDigest(
        IReadOnlyList<AuthorSavedViewDependencyResolution> resolutions)
    {
        var canonical = new CanonicalDigestBuilder();
        foreach (AuthorSavedViewDependencyResolution resolution in resolutions
            .OrderBy(static item => item.Dependency.Kind)
            .ThenBy(static item => item.Dependency.Identity, StringComparer.Ordinal)
            .ThenBy(static item => item.OperatorId, StringComparer.Ordinal))
        {
            canonical.Append((int)resolution.Dependency.Kind);
            canonical.Append(resolution.Dependency.Identity);
            canonical.Append(resolution.OperatorId);
            canonical.Append((int)resolution.Status);
            canonical.Append(resolution.AuthorityRevision);
        }
        return canonical.Finish();
    }

    public static string ComputeViewDigest(
        AuthorSavedViewOwner owner,
        Guid viewId,
        long revision,
        string name,
        string queryDigest,
        string dependencyDigest,
        bool pinned,
        long orderKey,
        AuthorSavedViewLifecycleState lifecycleState)
    {
        var canonical = new CanonicalDigestBuilder();
        canonical.Append(SchemaVersion);
        canonical.Append(owner.AdminPrincipalId);
        canonical.Append(owner.SiteScope);
        canonical.Append(viewId);
        canonical.Append(revision);
        canonical.Append(name);
        canonical.Append(queryDigest);
        canonical.Append(dependencyDigest);
        canonical.Append(pinned);
        canonical.Append(orderKey);
        canonical.Append((int)lifecycleState);
        return canonical.Finish();
    }

    public static string ComputeCommandDigest(params object?[] values)
    {
        var canonical = new CanonicalDigestBuilder();
        foreach (object? value in values)
        {
            canonical.Append(value);
        }
        return canonical.Finish();
    }

    public static string ComputeCollectionDigest(
        AuthorSavedViewOwner owner,
        long revision,
        Guid? defaultViewId,
        int activeViewCount,
        string commandDigest)
    {
        var canonical = new CanonicalDigestBuilder();
        canonical.Append(SchemaVersion);
        canonical.Append(owner.AdminPrincipalId);
        canonical.Append(owner.SiteScope);
        canonical.Append(revision);
        canonical.Append(defaultViewId);
        canonical.Append(activeViewCount);
        canonical.Append(commandDigest);
        return canonical.Finish();
    }

    public static AuthorSavedViewOperatorDescriptor? FindBuiltInOperator(string operatorId)
        => s_operators.GetValueOrDefault(operatorId);

    public static bool IsBuiltInField(AuthorSavedViewFieldReference field)
        => field.Kind switch
        {
            AuthorSavedViewFieldKind.LifecycleStatus => field.Identity == LifecycleStatusField,
            AuthorSavedViewFieldKind.Date => field.Identity is CreatedAtField or UpdatedAtField or PublishedAtField,
            AuthorSavedViewFieldKind.FullText => field.Identity == AuthorSearchField,
            _ => false
        };

    internal static bool IsLifecycleStatus(string value)
        => s_lifecycleStatuses.Contains(value);

    private static AuthorSavedViewOperatorDescriptor DateOperator(
        string id,
        AuthorSavedViewOperatorCardinality cardinality,
        AuthorSavedViewDateBoundary boundary)
        => new(
            id,
            FieldKinds(AuthorSavedViewFieldKind.Date),
            AuthorSavedViewValueKind.LocalDate,
            cardinality,
            AuthorSavedViewNullSemantics.NullNeverMatches,
            AuthorSavedViewCaseSemantics.NotApplicable,
            boundary,
            "article-date-contract",
            "canonical-article-query");

    private static IReadOnlyList<AuthorSavedViewFieldKind> FieldKinds(
        params AuthorSavedViewFieldKind[] values)
        => Array.AsReadOnly(values);

    private static void ValidateConditionShape(AuthorSavedViewCondition condition)
    {
        ArgumentNullException.ThrowIfNull(condition);
        if (!Enum.IsDefined(condition.Field.Kind))
        {
            throw new AuthorSavedViewValidationException("saved_view_field_kind_unknown");
        }

        ValidateIdentity(condition.Field.Identity, "saved_view_field_identity_invalid");
        ValidateIdentity(condition.OperatorId, "saved_view_operator_identity_invalid");
        if (condition.Values.Count > MaxValuesPerCondition)
        {
            throw new AuthorSavedViewValidationException("saved_view_condition_value_budget_exceeded");
        }

        foreach (string value in condition.Values)
        {
            if (string.IsNullOrWhiteSpace(value)
                || value.Length > MaxValueLength
                || value.Any(char.IsControl))
            {
                throw new AuthorSavedViewValidationException("saved_view_condition_value_invalid");
            }
        }

        if (condition.TimeZoneId is not null)
        {
            ValidateTimeZone(condition.TimeZoneId);
        }
    }

    private static void ValidateSort(AuthorSavedViewSort sort)
    {
        ArgumentNullException.ThrowIfNull(sort);
        if (!Enum.IsDefined(sort.Field.Kind)
            || !Enum.IsDefined(sort.Direction)
            || !Enum.IsDefined(sort.NullPlacement))
        {
            throw new AuthorSavedViewValidationException("saved_view_sort_unknown");
        }

        ValidateIdentity(sort.Field.Identity, "saved_view_sort_field_invalid");
        if (!string.Equals(sort.StableTieBreaker, ArticleIdentityTieBreaker, StringComparison.Ordinal))
        {
            throw new AuthorSavedViewValidationException("saved_view_sort_tie_breaker_invalid");
        }

        if (sort.Collation is not ("ordinal" or "author-search" or "numeric" or "temporal"))
        {
            throw new AuthorSavedViewValidationException("saved_view_sort_collation_invalid");
        }

        if (sort.TimeZoneId is not null)
        {
            ValidateTimeZone(sort.TimeZoneId);
        }

        if (sort.Field.Kind == AuthorSavedViewFieldKind.Date && sort.TimeZoneId is null)
        {
            throw new AuthorSavedViewValidationException("saved_view_sort_timezone_required");
        }
        if (sort.Field.Kind != AuthorSavedViewFieldKind.Date && sort.TimeZoneId is not null)
        {
            throw new AuthorSavedViewValidationException("saved_view_sort_timezone_not_applicable");
        }

        string requiredCollation = sort.Field.Kind switch
        {
            AuthorSavedViewFieldKind.Date => "temporal",
            AuthorSavedViewFieldKind.FullText => "author-search",
            AuthorSavedViewFieldKind.Property => sort.Collation,
            _ => "ordinal"
        };
        if (!string.Equals(sort.Collation, requiredCollation, StringComparison.Ordinal))
        {
            throw new AuthorSavedViewValidationException("saved_view_sort_collation_incompatible");
        }
    }

    private static void ValidateProjection(IReadOnlyList<AuthorSavedViewFieldReference> projection)
    {
        if (projection.Count is < 1 or > MaxProjectionFields)
        {
            throw new AuthorSavedViewValidationException("saved_view_projection_budget_invalid");
        }

        foreach (AuthorSavedViewFieldReference field in projection)
        {
            if (!Enum.IsDefined(field.Kind))
            {
                throw new AuthorSavedViewValidationException("saved_view_projection_field_kind_unknown");
            }
            ValidateIdentity(field.Identity, "saved_view_projection_field_invalid");
        }

        if (projection.Distinct().Count() != projection.Count)
        {
            throw new AuthorSavedViewValidationException("saved_view_projection_field_duplicate");
        }
    }

    private static void ValidateIdentity(string value, string code)
    {
        if (string.IsNullOrWhiteSpace(value)
            || value.Length > MaxIdentityLength
            || value.Any(static character => char.IsControl(character) || char.IsWhiteSpace(character)))
        {
            throw new AuthorSavedViewValidationException(code);
        }
    }

    private static void ValidateTimeZone(string timeZoneId)
    {
        if (string.IsNullOrWhiteSpace(timeZoneId)
            || timeZoneId.Length > MaxTimeZoneLength
            || timeZoneId.Any(char.IsControl))
        {
            throw new AuthorSavedViewValidationException("saved_view_timezone_invalid");
        }

        try
        {
            _ = TimeZoneInfo.FindSystemTimeZoneById(timeZoneId);
        }
        catch (TimeZoneNotFoundException)
        {
            throw new AuthorSavedViewValidationException("saved_view_timezone_invalid");
        }
        catch (InvalidTimeZoneException)
        {
            throw new AuthorSavedViewValidationException("saved_view_timezone_invalid");
        }
    }

    internal sealed class CanonicalDigestBuilder
    {
        private readonly StringBuilder _value = new();

        internal void Append(object? value)
        {
            string text = value switch
            {
                null => "null",
                bool flag => flag ? "true" : "false",
                DateOnly date => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
                _ => value.ToString() ?? string.Empty
            };
            _value.Append(Encoding.UTF8.GetByteCount(text)).Append(':').Append(text).Append(';');
        }

        internal string Finish()
            => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(_value.ToString())));
    }
}

public interface IAuthorSavedViewQueryValidator
{
    Task<AuthorSavedViewQueryValidationResult> ValidateAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewQuery query,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Validates structural rules locally and delegates external dependency facts to their
/// production interfaces. It never evaluates the query or copies search/property parsers.
/// </summary>
public sealed class AuthorSavedViewQueryValidator(
    IAuthorSavedViewDependencyCatalog dependencyCatalog) : IAuthorSavedViewQueryValidator
{
    public async Task<AuthorSavedViewQueryValidationResult> ValidateAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewQuery query,
        CancellationToken cancellationToken = default)
    {
        AuthorSavedViewContract.ValidateOwner(owner);
        AuthorSavedViewContract.ValidateQueryShape(query);
        var resolutions = new List<AuthorSavedViewDependencyResolution>();
        var canonicalValues = new Dictionary<int, IReadOnlyList<string>>();
        var reasons = new List<string>();

        for (int index = 0; index < query.Conditions.Count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AuthorSavedViewCondition condition = query.Conditions[index];
            AuthorSavedViewDependencyResolution resolution = await dependencyCatalog.ResolveConditionAsync(
                owner,
                condition,
                cancellationToken).ConfigureAwait(false);
            ValidateResolution(condition, resolution);
            resolutions.Add(resolution);
            canonicalValues.Add(index, NormalizeValues(condition, resolution));
            if (resolution.Status is not AuthorSavedViewDependencyStatus.Current
                and not AuthorSavedViewDependencyStatus.RenamedLabelOnly)
            {
                reasons.Add($"{condition.Field.Kind}:{condition.Field.Identity}:{resolution.Status}");
            }
        }

        AuthorSavedViewDependencyResolution sortResolution = await dependencyCatalog.ResolveSortAsync(
            owner,
            query.Sort,
            cancellationToken).ConfigureAwait(false);
        ValidateProjectionResolution(query.Sort.Field, "sort", sortResolution);
        resolutions.Add(sortResolution);
        if (sortResolution.Status is not AuthorSavedViewDependencyStatus.Current
            and not AuthorSavedViewDependencyStatus.RenamedLabelOnly)
        {
            reasons.Add($"sort:{query.Sort.Field.Kind}:{query.Sort.Field.Identity}:{sortResolution.Status}");
        }

        foreach (AuthorSavedViewFieldReference projectionField in query.Projection)
        {
            AuthorSavedViewDependencyResolution projectionResolution =
                await dependencyCatalog.ResolveProjectionAsync(
                    owner,
                    projectionField,
                    cancellationToken).ConfigureAwait(false);
            ValidateProjectionResolution(projectionField, "projection", projectionResolution);
            resolutions.Add(projectionResolution);
            if (projectionResolution.Status is not AuthorSavedViewDependencyStatus.Current
                and not AuthorSavedViewDependencyStatus.RenamedLabelOnly)
            {
                reasons.Add($"projection:{projectionField.Kind}:{projectionField.Identity}:{projectionResolution.Status}");
            }
        }

        AuthorSavedViewQuery normalized = AuthorSavedViewContract.NormalizeQuery(query, canonicalValues);
        AuthorSavedViewDependencyResolution[] frozenResolutions =
        [
            .. resolutions.Select(static resolution => resolution with
            {
                Operator = resolution.Operator with
                {
                    FieldKinds = Array.AsReadOnly(resolution.Operator.FieldKinds.ToArray())
                },
                CanonicalValues = Array.AsReadOnly(resolution.CanonicalValues.ToArray())
            })
        ];
        return new AuthorSavedViewQueryValidationResult(
            reasons.Count == 0,
            normalized,
            AuthorSavedViewContract.ComputeQueryDigest(normalized),
            AuthorSavedViewContract.ComputeDependencyDigest(frozenResolutions),
            Array.AsReadOnly(frozenResolutions),
            Array.AsReadOnly(reasons.ToArray()));
    }

    private static void ValidateResolution(
        AuthorSavedViewCondition condition,
        AuthorSavedViewDependencyResolution resolution)
    {
        if (resolution.Dependency != condition.Field
            || !string.Equals(resolution.OperatorId, condition.OperatorId, StringComparison.Ordinal))
        {
            throw new AuthorSavedViewValidationException("saved_view_dependency_resolution_tampered");
        }

        AuthorSavedViewOperatorDescriptor descriptor = resolution.Operator;
        if (!string.Equals(descriptor.Id, condition.OperatorId, StringComparison.Ordinal)
            || !descriptor.FieldKinds.Contains(condition.Field.Kind))
        {
            throw new AuthorSavedViewValidationException("saved_view_operator_field_incompatible");
        }

        int expectedCount = descriptor.Cardinality switch
        {
            AuthorSavedViewOperatorCardinality.None => 0,
            AuthorSavedViewOperatorCardinality.Single => 1,
            AuthorSavedViewOperatorCardinality.OrderedPair => 2,
            AuthorSavedViewOperatorCardinality.MultipleSet => condition.Values.Count,
            _ => throw new AuthorSavedViewValidationException("saved_view_operator_cardinality_unknown")
        };
        if (condition.Values.Count != expectedCount
            || (descriptor.Cardinality == AuthorSavedViewOperatorCardinality.MultipleSet
                && condition.Values.Count == 0))
        {
            throw new AuthorSavedViewValidationException("saved_view_operator_cardinality_invalid");
        }

        if (descriptor.ValueKind == AuthorSavedViewValueKind.LocalDate)
        {
            var dates = new List<DateOnly>(condition.Values.Count);
            foreach (string value in condition.Values)
            {
                if (!DateOnly.TryParseExact(
                    value,
                    "yyyy-MM-dd",
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.None,
                    out _))
                {
                    throw new AuthorSavedViewValidationException("saved_view_date_value_invalid");
                }
                dates.Add(DateOnly.ParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture));
            }

            if (descriptor.Cardinality == AuthorSavedViewOperatorCardinality.OrderedPair
                && dates[0] > dates[1])
            {
                throw new AuthorSavedViewValidationException("saved_view_date_range_invalid");
            }

            if (condition.TimeZoneId is null)
            {
                throw new AuthorSavedViewValidationException("saved_view_date_timezone_required");
            }
        }
        else if (condition.TimeZoneId is not null)
        {
            throw new AuthorSavedViewValidationException("saved_view_timezone_not_applicable");
        }

        else if (descriptor.ValueKind == AuthorSavedViewValueKind.Number
            && condition.Values.Any(static value => !decimal.TryParse(
                value,
                NumberStyles.Number,
                CultureInfo.InvariantCulture,
                out _)))
        {
            throw new AuthorSavedViewValidationException("saved_view_number_value_invalid");
        }
        else if (descriptor.ValueKind == AuthorSavedViewValueKind.Boolean
            && condition.Values.Any(static value => !bool.TryParse(value, out _)))
        {
            throw new AuthorSavedViewValidationException("saved_view_boolean_value_invalid");
        }
        else if (descriptor.ValueKind == AuthorSavedViewValueKind.StableIdentity
            && condition.Values.Any(static value => value.Any(char.IsWhiteSpace)))
        {
            throw new AuthorSavedViewValidationException("saved_view_stable_identity_value_invalid");
        }
    }

    private static IReadOnlyList<string> NormalizeValues(
        AuthorSavedViewCondition condition,
        AuthorSavedViewDependencyResolution resolution)
    {
        string[] values = resolution.CanonicalValues.Count == 0
            ? [.. condition.Values]
            : [.. resolution.CanonicalValues];
        if (values.Length != condition.Values.Count)
        {
            throw new AuthorSavedViewValidationException("saved_view_dependency_values_tampered");
        }

        return resolution.Operator.Cardinality == AuthorSavedViewOperatorCardinality.MultipleSet
            ? Array.AsReadOnly(values.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray())
            : Array.AsReadOnly(values);
    }

    private static void ValidateProjectionResolution(
        AuthorSavedViewFieldReference field,
        string operation,
        AuthorSavedViewDependencyResolution resolution)
    {
        if (resolution.Dependency != field
            || !string.Equals(resolution.OperatorId, operation, StringComparison.Ordinal)
            || !string.Equals(resolution.Operator.Id, operation, StringComparison.Ordinal)
            || !resolution.Operator.FieldKinds.Contains(field.Kind))
        {
            throw new AuthorSavedViewValidationException("saved_view_dependency_resolution_tampered");
        }
    }
}

/// <summary>
/// Aggregate dependency boundary. Current upstream authorities implement providers; absence,
/// retirement, permission loss, or version drift remains an explicit fail-closed status.
/// </summary>
public sealed class AuthorSavedViewDependencyCatalog(
    IEnumerable<IAuthorSavedViewDependencyProvider> providers) : IAuthorSavedViewDependencyCatalog
{
    private readonly IReadOnlyList<IAuthorSavedViewDependencyProvider> _providers = [.. providers];

    public async ValueTask<AuthorSavedViewDependencyResolution> ResolveConditionAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewCondition condition,
        CancellationToken cancellationToken = default)
    {
        AuthorSavedViewOperatorDescriptor? builtIn = AuthorSavedViewContract.FindBuiltInOperator(condition.OperatorId);
        if (AuthorSavedViewContract.IsBuiltInField(condition.Field))
        {
            if (builtIn is null || !builtIn.FieldKinds.Contains(condition.Field.Kind))
            {
                return Unknown(condition.Field, condition.OperatorId, AuthorSavedViewDependencyStatus.TypeOrOperatorIncompatible);
            }

            if (condition.Field.Kind == AuthorSavedViewFieldKind.FullText)
            {
                return await ResolveFromProvidersAsync(owner, condition, cancellationToken).ConfigureAwait(false)
                    ?? Unknown(condition.Field, condition.OperatorId, AuthorSavedViewDependencyStatus.MigrationRequired, builtIn);
            }

            if (condition.Field.Kind == AuthorSavedViewFieldKind.LifecycleStatus
                && condition.Values.Any(value => !AuthorSavedViewContract.IsLifecycleStatus(value)))
            {
                return Unknown(
                    condition.Field,
                    condition.OperatorId,
                    AuthorSavedViewDependencyStatus.TypeOrOperatorIncompatible,
                    builtIn);
            }

            return new AuthorSavedViewDependencyResolution(
                condition.Field,
                condition.OperatorId,
                AuthorSavedViewDependencyStatus.Current,
                "saved-view-contract-v1",
                builtIn,
                [.. condition.Values]);
        }

        return await ResolveFromProvidersAsync(owner, condition, cancellationToken).ConfigureAwait(false)
            ?? Unknown(condition.Field, condition.OperatorId, AuthorSavedViewDependencyStatus.Unknown, builtIn);
    }

    public async ValueTask<AuthorSavedViewDependencyResolution> ResolveSortAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewSort sort,
        CancellationToken cancellationToken = default)
    {
        if (AuthorSavedViewContract.IsBuiltInField(sort.Field)
            && sort.Field.Kind is AuthorSavedViewFieldKind.LifecycleStatus or AuthorSavedViewFieldKind.Date)
        {
            return Projection(sort.Field, "sort", AuthorSavedViewDependencyStatus.Current, "saved-view-contract-v1");
        }

        var resolutions = new List<AuthorSavedViewDependencyResolution>();
        foreach (IAuthorSavedViewDependencyProvider provider in _providers)
        {
            AuthorSavedViewDependencyResolution? resolution = await provider.ResolveSortAsync(
                owner,
                sort,
                cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (resolution is not null)
            {
                resolutions.Add(resolution);
            }
        }
        if (resolutions.Count > 1)
        {
            return resolutions[0] with
            {
                Status = AuthorSavedViewDependencyStatus.DuplicateAuthority
            };
        }
        if (resolutions.Count == 1)
        {
            return resolutions[0];
        }
        return Projection(sort.Field, "sort", AuthorSavedViewDependencyStatus.Unknown, "unavailable");
    }

    public async ValueTask<AuthorSavedViewDependencyResolution> ResolveProjectionAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewFieldReference field,
        CancellationToken cancellationToken = default)
    {
        if (AuthorSavedViewContract.IsBuiltInField(field)
            && field.Kind is AuthorSavedViewFieldKind.LifecycleStatus or AuthorSavedViewFieldKind.Date)
        {
            return Projection(field, "projection", AuthorSavedViewDependencyStatus.Current, "saved-view-contract-v1");
        }

        var resolutions = new List<AuthorSavedViewDependencyResolution>();
        foreach (IAuthorSavedViewDependencyProvider provider in _providers)
        {
            AuthorSavedViewDependencyResolution? resolution = await provider.ResolveProjectionAsync(
                owner,
                field,
                cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (resolution is not null)
            {
                resolutions.Add(resolution);
            }
        }
        if (resolutions.Count > 1)
        {
            return resolutions[0] with
            {
                Status = AuthorSavedViewDependencyStatus.DuplicateAuthority
            };
        }
        if (resolutions.Count == 1)
        {
            return resolutions[0];
        }
        return Projection(field, "projection", AuthorSavedViewDependencyStatus.Unknown, "unavailable");
    }

    private async ValueTask<AuthorSavedViewDependencyResolution?> ResolveFromProvidersAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewCondition condition,
        CancellationToken cancellationToken)
    {
        var resolutions = new List<AuthorSavedViewDependencyResolution>();
        foreach (IAuthorSavedViewDependencyProvider provider in _providers)
        {
            AuthorSavedViewDependencyResolution? resolution = await provider.ResolveConditionAsync(
                owner,
                condition,
                cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (resolution is not null)
            {
                resolutions.Add(resolution);
            }
        }
        return resolutions.Count switch
        {
            0 => null,
            1 => resolutions[0],
            _ => resolutions[0] with { Status = AuthorSavedViewDependencyStatus.DuplicateAuthority }
        };
    }

    private static AuthorSavedViewDependencyResolution Unknown(
        AuthorSavedViewFieldReference field,
        string operatorId,
        AuthorSavedViewDependencyStatus status,
        AuthorSavedViewOperatorDescriptor? descriptor = null)
        => new(
            field,
            operatorId,
            status,
            "unavailable",
            descriptor ?? new AuthorSavedViewOperatorDescriptor(
                operatorId,
                [field.Kind],
                AuthorSavedViewValueKind.Text,
                AuthorSavedViewOperatorCardinality.MultipleSet,
                AuthorSavedViewNullSemantics.AuthorityOwned,
                AuthorSavedViewCaseSemantics.AuthorityOwned,
                AuthorSavedViewDateBoundary.AuthorityOwned,
                "unavailable",
                "unavailable"),
            []);

    private static AuthorSavedViewDependencyResolution Projection(
        AuthorSavedViewFieldReference field,
        string operation,
        AuthorSavedViewDependencyStatus status,
        string authorityRevision)
        => new(
            field,
            operation,
            status,
            authorityRevision,
            new AuthorSavedViewOperatorDescriptor(
                operation,
                [field.Kind],
                AuthorSavedViewValueKind.None,
                AuthorSavedViewOperatorCardinality.None,
                AuthorSavedViewNullSemantics.AuthorityOwned,
                AuthorSavedViewCaseSemantics.AuthorityOwned,
                AuthorSavedViewDateBoundary.AuthorityOwned,
                "owning-domain",
                "canonical-article-query"),
            []);
}

public interface IAuthorSavedViewDependencyCatalog
{
    ValueTask<AuthorSavedViewDependencyResolution> ResolveConditionAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewCondition condition,
        CancellationToken cancellationToken = default);

    ValueTask<AuthorSavedViewDependencyResolution> ResolveSortAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewSort sort,
        CancellationToken cancellationToken = default);

    ValueTask<AuthorSavedViewDependencyResolution> ResolveProjectionAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewFieldReference field,
        CancellationToken cancellationToken = default);
}

public interface IAuthorSavedViewDependencyProvider
{
    ValueTask<AuthorSavedViewDependencyResolution?> ResolveConditionAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewCondition condition,
        CancellationToken cancellationToken = default);

    ValueTask<AuthorSavedViewDependencyResolution?> ResolveSortAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewSort sort,
        CancellationToken cancellationToken = default);

    ValueTask<AuthorSavedViewDependencyResolution?> ResolveProjectionAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewFieldReference field,
        CancellationToken cancellationToken = default);
}

public readonly record struct AuthorSavedViewOwner(long AdminPrincipalId, string SiteScope);

public enum AuthorSavedViewFieldKind
{
    LifecycleStatus = 0,
    Category = 1,
    Tag = 2,
    FullText = 3,
    Property = 4,
    RelationState = 5,
    ContentCheckState = 6,
    Date = 7
}

public enum AuthorSavedViewValueKind
{
    None = 0,
    StableIdentity = 1,
    Text = 2,
    LocalDate = 3,
    Number = 4,
    Boolean = 5
}

public enum AuthorSavedViewOperatorCardinality
{
    None = 0,
    Single = 1,
    MultipleSet = 2,
    OrderedPair = 3
}

public enum AuthorSavedViewNullSemantics
{
    NullNeverMatches = 0,
    MissingOnly = 1,
    PresentOnly = 2,
    AuthorityOwned = 3
}

public enum AuthorSavedViewCaseSemantics
{
    NotApplicable = 0,
    StableIdentityOrdinal = 1,
    AuthorSearchOwned = 2,
    AuthorityOwned = 3
}

public enum AuthorSavedViewDateBoundary
{
    NotApplicable = 0,
    ExclusiveUpper = 1,
    InclusiveUpper = 2,
    ExclusiveLower = 3,
    InclusiveLower = 4,
    InclusiveRange = 5,
    AuthorityOwned = 6
}

public enum AuthorSavedViewDependencyStatus
{
    Current = 0,
    RenamedLabelOnly = 1,
    Retired = 2,
    Deleted = 3,
    PermissionRevoked = 4,
    TypeOrOperatorIncompatible = 5,
    MigrationRequired = 6,
    Unknown = 7,
    DuplicateAuthority = 8
}

public enum AuthorSavedViewSortDirection
{
    Ascending = 0,
    Descending = 1
}

public enum AuthorSavedViewNullPlacement
{
    First = 0,
    Last = 1
}

public enum AuthorSavedViewLifecycleState
{
    Active = 0,
    Retired = 1
}

public enum AuthorSavedViewDefaultDisposition
{
    NotApplicable = 0,
    ClearToSystem = 1,
    ReplaceWithView = 2
}

public sealed record AuthorSavedViewFieldReference(
    AuthorSavedViewFieldKind Kind,
    string Identity);

public sealed record AuthorSavedViewCondition(
    AuthorSavedViewFieldReference Field,
    string OperatorId,
    IReadOnlyList<string> Values,
    string? TimeZoneId = null);

public sealed record AuthorSavedViewSort(
    AuthorSavedViewFieldReference Field,
    AuthorSavedViewSortDirection Direction,
    AuthorSavedViewNullPlacement NullPlacement,
    string Collation,
    string StableTieBreaker = AuthorSavedViewContract.ArticleIdentityTieBreaker,
    string? TimeZoneId = null);

public sealed record AuthorSavedViewQuery(
    int SchemaVersion,
    IReadOnlyList<AuthorSavedViewCondition> Conditions,
    AuthorSavedViewSort Sort,
    IReadOnlyList<AuthorSavedViewFieldReference> Projection,
    int PageSize);

public sealed record AuthorSavedViewOperatorDescriptor(
    string Id,
    IReadOnlyList<AuthorSavedViewFieldKind> FieldKinds,
    AuthorSavedViewValueKind ValueKind,
    AuthorSavedViewOperatorCardinality Cardinality,
    AuthorSavedViewNullSemantics NullSemantics,
    AuthorSavedViewCaseSemantics CaseSemantics,
    AuthorSavedViewDateBoundary DateBoundary,
    string PermissionOwner,
    string QueryOwner);

public sealed record AuthorSavedViewDependencyResolution(
    AuthorSavedViewFieldReference Dependency,
    string OperatorId,
    AuthorSavedViewDependencyStatus Status,
    string AuthorityRevision,
    AuthorSavedViewOperatorDescriptor Operator,
    IReadOnlyList<string> CanonicalValues);

public sealed record AuthorSavedViewQueryValidationResult(
    bool IsValid,
    AuthorSavedViewQuery Query,
    string QueryDigest,
    string DependencyDigest,
    IReadOnlyList<AuthorSavedViewDependencyResolution> Resolutions,
    IReadOnlyList<string> Reasons);

public sealed class AuthorSavedViewValidationException(string code) : Exception(code)
{
    public string Code { get; } = code;
}

public sealed class AuthorSavedViewDependencyException(IReadOnlyList<string> reasons)
    : Exception("saved_view_dependency_invalid")
{
    public IReadOnlyList<string> Reasons { get; } = reasons;
}
