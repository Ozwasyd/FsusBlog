using System.Collections.ObjectModel;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Owns the only current Author Saved View query contract. The contract is a closed,
/// versioned AND of typed conditions; it never contains executable expressions,
/// result snapshots, authorization snapshots, or client functions.
/// </summary>
public static class AuthorSavedViewContract
{
    public const int SchemaVersion = 1;
    public const int MinimumSupportedSchemaVersion = 1;
    public const int MaxConditions = 64;
    public const int MaxValuesPerCondition = 64;
    public const int MaxProjectionFields = 32;
    public const int MaxPageSize = 100;
    public const int MaxIdentityLength = 128;
    public const int MaxValueLength = 512;
    public const int MaxTimeZoneLength = 64;

    public const string ArticleIdentityTieBreaker = "article.id";
    public const string LifecycleStatusField = "article.lifecycle.status";
    public const string CreatedAtField = "article.created-at";
    public const string UpdatedAtField = "article.updated-at";
    public const string PublishedAtField = "article.published-at";
    public const string AuthorSearchField = "author-search.current";

    private static readonly ReadOnlyDictionary<AuthorSavedViewFieldKind, AuthorSavedViewFieldDescriptor> s_fields =
        new(new Dictionary<AuthorSavedViewFieldKind, AuthorSavedViewFieldDescriptor>
        {
            [AuthorSavedViewFieldKind.LifecycleStatus] = ExactField(
                AuthorSavedViewFieldKind.LifecycleStatus,
                [LifecycleStatusField],
                ["identity.equals", "identity.any-of"],
                requiresDependencyProvider: false),
            [AuthorSavedViewFieldKind.Category] = AuthorityField(
                AuthorSavedViewFieldKind.Category,
                "category:",
                ["identity.equals", "identity.any-of"]),
            [AuthorSavedViewFieldKind.Tag] = AuthorityField(
                AuthorSavedViewFieldKind.Tag,
                "tag:",
                ["identity.equals", "identity.any-of"]),
            [AuthorSavedViewFieldKind.FullText] = ExactField(
                AuthorSavedViewFieldKind.FullText,
                [AuthorSearchField],
                ["author-search.match"],
                requiresDependencyProvider: true),
            [AuthorSavedViewFieldKind.Property] = AuthorityField(
                AuthorSavedViewFieldKind.Property,
                "property:",
                ["property.equals", "property.any-of", "value.is-missing", "value.is-present"]),
            [AuthorSavedViewFieldKind.RelationState] = AuthorityField(
                AuthorSavedViewFieldKind.RelationState,
                "relation:",
                ["identity.equals", "identity.any-of"]),
            [AuthorSavedViewFieldKind.ContentCheckState] = AuthorityField(
                AuthorSavedViewFieldKind.ContentCheckState,
                "content-check:",
                ["identity.equals", "identity.any-of"]),
            [AuthorSavedViewFieldKind.Date] = ExactField(
                AuthorSavedViewFieldKind.Date,
                [CreatedAtField, UpdatedAtField, PublishedAtField],
                [
                    "value.is-missing",
                    "value.is-present",
                    "date.before",
                    "date.on-or-before",
                    "date.after",
                    "date.on-or-after",
                    "date.between"
                ],
                requiresDependencyProvider: false)
        });

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
                AuthorSavedViewNullSemantic.NullNeverMatches,
                AuthorSavedViewDefaultSemantic.NotApplicable,
                AuthorSavedViewCaseSemantic.StableIdentityOrdinal,
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
                AuthorSavedViewNullSemantic.NullNeverMatches,
                AuthorSavedViewDefaultSemantic.NotApplicable,
                AuthorSavedViewCaseSemantic.StableIdentityOrdinal,
                AuthorSavedViewDateBoundary.NotApplicable,
                "owning-domain",
                "canonical-article-query"),
            ["value.is-missing"] = new(
                "value.is-missing",
                FieldKinds(AuthorSavedViewFieldKind.Property, AuthorSavedViewFieldKind.Date),
                AuthorSavedViewValueKind.None,
                AuthorSavedViewOperatorCardinality.None,
                AuthorSavedViewNullSemantic.MissingOnly,
                AuthorSavedViewDefaultSemantic.DistinctFromMissing,
                AuthorSavedViewCaseSemantic.NotApplicable,
                AuthorSavedViewDateBoundary.NotApplicable,
                "owning-domain",
                "canonical-article-query"),
            ["value.is-present"] = new(
                "value.is-present",
                FieldKinds(AuthorSavedViewFieldKind.Property, AuthorSavedViewFieldKind.Date),
                AuthorSavedViewValueKind.None,
                AuthorSavedViewOperatorCardinality.None,
                AuthorSavedViewNullSemantic.PresentOnly,
                AuthorSavedViewDefaultSemantic.DistinctFromMissing,
                AuthorSavedViewCaseSemantic.NotApplicable,
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
                AuthorSavedViewNullSemantic.NullNeverMatches,
                AuthorSavedViewDefaultSemantic.NotApplicable,
                AuthorSavedViewCaseSemantic.AuthorSearchOwned,
                AuthorSavedViewDateBoundary.NotApplicable,
                "author-search-contract",
                "author-search-query"),
            ["property.equals"] = PropertyOperator(
                "property.equals",
                AuthorSavedViewOperatorCardinality.Single),
            ["property.any-of"] = PropertyOperator(
                "property.any-of",
                AuthorSavedViewOperatorCardinality.MultipleSet)
        });

    private static readonly ReadOnlyDictionary<string, string> s_lifecycleStatuses =
        new(Enum.GetValues<ArticleStatus>().ToDictionary(
            static status => status.ToString(),
            static status => ArticleStatusValues.Token((int)status),
            StringComparer.OrdinalIgnoreCase));

    public static AuthorSavedViewSchemaVersionPolicy SchemaPolicy
    {
        get;
    } = new(
        SchemaVersion,
        MinimumSupportedSchemaVersion,
        AuthorSavedViewOldSchemaDisposition.ExplicitMigrationRequired,
        AuthorSavedViewFutureSchemaDisposition.Reject);

    public static IReadOnlyDictionary<AuthorSavedViewFieldKind, AuthorSavedViewFieldDescriptor> Fields => s_fields;

    public static IReadOnlyDictionary<string, AuthorSavedViewOperatorDescriptor> Operators => s_operators;

    public static AuthorSavedViewSchemaVersionStatus ClassifySchemaVersion(int schemaVersion)
        => schemaVersion switch
        {
            SchemaVersion => AuthorSavedViewSchemaVersionStatus.Current,
            < MinimumSupportedSchemaVersion => AuthorSavedViewSchemaVersionStatus.MigrationRequired,
            _ => AuthorSavedViewSchemaVersionStatus.FutureUnsupported
        };

    public static void ValidateOwner(AuthorSavedViewOwner owner)
    {
        if (owner.AdminPrincipalId <= 0)
        {
            throw new AuthorSavedViewValidationException("saved_view_owner_invalid");
        }

        ValidateIdentity(owner.SiteScope, "saved_view_site_scope_invalid");
    }

    public static void ValidateQueryShape(AuthorSavedViewQuery query)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentNullException.ThrowIfNull(query.Conditions);
        ArgumentNullException.ThrowIfNull(query.Projection);
        AuthorSavedViewSchemaVersionStatus schemaStatus = ClassifySchemaVersion(query.SchemaVersion);
        if (schemaStatus != AuthorSavedViewSchemaVersionStatus.Current)
        {
            throw new AuthorSavedViewValidationException(
                schemaStatus == AuthorSavedViewSchemaVersionStatus.FutureUnsupported
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

        if (query.Conditions
            .GroupBy(static condition => (
                condition.Field.Kind,
                condition.Field.Identity,
                condition.OperatorId))
            .Any(static group => group.Skip(1).Any()))
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
        ArgumentNullException.ThrowIfNull(canonicalValues);
        ValidateQueryShape(query);
        if (canonicalValues.Count != query.Conditions.Count
            || Enumerable.Range(0, query.Conditions.Count).Any(index =>
                !canonicalValues.TryGetValue(index, out IReadOnlyList<string>? values) || values is null))
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
        ArgumentNullException.ThrowIfNull(resolutions);
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

    public static AuthorSavedViewOperatorDescriptor? FindBuiltInOperator(string operatorId)
        => s_operators.GetValueOrDefault(operatorId);

    public static bool IsRegisteredOperatorDescriptor(AuthorSavedViewOperatorDescriptor descriptor)
    {
        AuthorSavedViewOperatorDescriptor? registered = FindBuiltInOperator(descriptor.Id);
        return registered is not null
            && registered.ValueKind == descriptor.ValueKind
            && registered.Cardinality == descriptor.Cardinality
            && registered.NullSemantics == descriptor.NullSemantics
            && registered.DefaultSemantics == descriptor.DefaultSemantics
            && registered.CaseSemantics == descriptor.CaseSemantics
            && registered.DateBoundary == descriptor.DateBoundary
            && string.Equals(registered.PermissionOwner, descriptor.PermissionOwner, StringComparison.Ordinal)
            && string.Equals(registered.QueryOwner, descriptor.QueryOwner, StringComparison.Ordinal)
            && registered.FieldKinds.SequenceEqual(descriptor.FieldKinds);
    }

    public static AuthorSavedViewFieldDescriptor? FindField(AuthorSavedViewFieldKind kind)
        => s_fields.GetValueOrDefault(kind);

    public static bool IsBuiltInField(AuthorSavedViewFieldReference field)
        => FindField(field.Kind) is { RequiresDependencyProvider: false } descriptor
            && descriptor.AcceptsIdentity(field.Identity);

    internal static bool IsLifecycleStatus(string value)
        => CanonicalizeLifecycleStatus(value) is not null;

    internal static string? CanonicalizeLifecycleStatus(string value)
        => s_lifecycleStatuses.GetValueOrDefault(value);

    private static AuthorSavedViewOperatorDescriptor DateOperator(
        string id,
        AuthorSavedViewOperatorCardinality cardinality,
        AuthorSavedViewDateBoundary boundary)
        => new(
            id,
            FieldKinds(AuthorSavedViewFieldKind.Date),
            AuthorSavedViewValueKind.LocalDate,
            cardinality,
            AuthorSavedViewNullSemantic.NullNeverMatches,
            AuthorSavedViewDefaultSemantic.NotApplicable,
            AuthorSavedViewCaseSemantic.NotApplicable,
            boundary,
            "article-date-contract",
            "canonical-article-query");

    private static AuthorSavedViewOperatorDescriptor PropertyOperator(
        string id,
        AuthorSavedViewOperatorCardinality cardinality)
        => new(
            id,
            FieldKinds(AuthorSavedViewFieldKind.Property),
            AuthorSavedViewValueKind.AuthorityOwned,
            cardinality,
            AuthorSavedViewNullSemantic.AuthorityOwned,
            AuthorSavedViewDefaultSemantic.AuthorityOwned,
            AuthorSavedViewCaseSemantic.AuthorityOwned,
            AuthorSavedViewDateBoundary.AuthorityOwned,
            "typed-property-authority",
            "author-search-query");

    private static AuthorSavedViewFieldDescriptor ExactField(
        AuthorSavedViewFieldKind kind,
        IReadOnlyList<string> exactIdentities,
        IReadOnlyList<string> operatorIds,
        bool requiresDependencyProvider)
        => new(
            kind,
            AuthorSavedViewFieldIdentityKind.Exact,
            Array.AsReadOnly(exactIdentities.ToArray()),
            null,
            Array.AsReadOnly(operatorIds.ToArray()),
            requiresDependencyProvider);

    private static AuthorSavedViewFieldDescriptor AuthorityField(
        AuthorSavedViewFieldKind kind,
        string stableIdentityPrefix,
        IReadOnlyList<string> operatorIds)
        => new(
            kind,
            AuthorSavedViewFieldIdentityKind.AuthorityStableIdentity,
            Array.Empty<string>(),
            stableIdentityPrefix,
            Array.AsReadOnly(operatorIds.ToArray()),
            RequiresDependencyProvider: true);

    private static IReadOnlyList<AuthorSavedViewFieldKind> FieldKinds(
        params AuthorSavedViewFieldKind[] values)
        => Array.AsReadOnly(values);

    internal static void ValidateConditionShape(AuthorSavedViewCondition condition)
    {
        ArgumentNullException.ThrowIfNull(condition);
        ArgumentNullException.ThrowIfNull(condition.Field);
        ArgumentNullException.ThrowIfNull(condition.Values);
        AuthorSavedViewFieldDescriptor? field = FindField(condition.Field.Kind);
        if (field is null)
        {
            throw new AuthorSavedViewValidationException("saved_view_field_kind_unknown");
        }

        ValidateIdentity(condition.Field.Identity, "saved_view_field_identity_invalid");
        ValidateIdentity(condition.OperatorId, "saved_view_operator_identity_invalid");
        if (!field.AcceptsIdentity(condition.Field.Identity))
        {
            throw new AuthorSavedViewValidationException("saved_view_field_identity_unknown");
        }

        AuthorSavedViewOperatorDescriptor? descriptor = FindBuiltInOperator(condition.OperatorId);
        if (descriptor is null)
        {
            throw new AuthorSavedViewValidationException("saved_view_operator_unknown");
        }
        if (!field.OperatorIds.Contains(condition.OperatorId, StringComparer.Ordinal)
            || !descriptor.FieldKinds.Contains(condition.Field.Kind))
        {
            throw new AuthorSavedViewValidationException("saved_view_operator_field_incompatible");
        }
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
        ArgumentNullException.ThrowIfNull(sort.Field);
        AuthorSavedViewFieldDescriptor? field = FindField(sort.Field.Kind);
        if (field is null
            || !Enum.IsDefined(sort.Direction)
            || !Enum.IsDefined(sort.NullPlacement))
        {
            throw new AuthorSavedViewValidationException("saved_view_sort_unknown");
        }

        ValidateIdentity(sort.Field.Identity, "saved_view_sort_field_invalid");
        if (!field.AcceptsIdentity(sort.Field.Identity))
        {
            throw new AuthorSavedViewValidationException("saved_view_sort_field_unknown");
        }
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
            ArgumentNullException.ThrowIfNull(field);
            AuthorSavedViewFieldDescriptor? descriptor = FindField(field.Kind);
            if (descriptor is null)
            {
                throw new AuthorSavedViewValidationException("saved_view_projection_field_kind_unknown");
            }
            ValidateIdentity(field.Identity, "saved_view_projection_field_invalid");
            if (!descriptor.AcceptsIdentity(field.Identity))
            {
                throw new AuthorSavedViewValidationException("saved_view_projection_field_unknown");
            }
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
            || !descriptor.FieldKinds.Contains(condition.Field.Kind)
            || !AuthorSavedViewContract.IsRegisteredOperatorDescriptor(descriptor))
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

        AuthorSavedViewCondition canonicalCondition = condition with
        {
            Values = Array.AsReadOnly(values)
        };
        AuthorSavedViewContract.ValidateConditionShape(canonicalCondition);
        ValidateResolution(canonicalCondition, resolution);

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
        AuthorSavedViewOperatorDescriptor descriptor = AuthorSavedViewContract.FindBuiltInOperator(condition.OperatorId)
            ?? throw new AuthorSavedViewValidationException("saved_view_operator_unknown");
        AuthorSavedViewFieldDescriptor field = AuthorSavedViewContract.FindField(condition.Field.Kind)
            ?? throw new AuthorSavedViewValidationException("saved_view_field_kind_unknown");
        if (!field.AcceptsIdentity(condition.Field.Identity)
            || !field.OperatorIds.Contains(condition.OperatorId, StringComparer.Ordinal)
            || !descriptor.FieldKinds.Contains(condition.Field.Kind))
        {
            throw new AuthorSavedViewValidationException("saved_view_operator_field_incompatible");
        }

        if (!field.RequiresDependencyProvider)
        {
            if (condition.Field.Kind == AuthorSavedViewFieldKind.LifecycleStatus
                && condition.Values.Any(value => !AuthorSavedViewContract.IsLifecycleStatus(value)))
            {
                return Unknown(
                    condition.Field,
                    condition.OperatorId,
                    AuthorSavedViewDependencyStatus.TypeOrOperatorIncompatible,
                    descriptor);
            }

            return new AuthorSavedViewDependencyResolution(
                condition.Field,
                condition.OperatorId,
                AuthorSavedViewDependencyStatus.Current,
                "saved-view-contract-v1",
                descriptor,
                condition.Field.Kind == AuthorSavedViewFieldKind.LifecycleStatus
                    ? [.. condition.Values.Select(value =>
                        AuthorSavedViewContract.CanonicalizeLifecycleStatus(value)!)]
                    : [.. condition.Values]);
        }

        AuthorSavedViewDependencyFact? fact = await ResolveFromProvidersAsync(
            owner,
            condition,
            cancellationToken).ConfigureAwait(false);
        if (fact is null)
        {
            AuthorSavedViewDependencyStatus missingStatus = condition.Field.Kind == AuthorSavedViewFieldKind.FullText
                ? AuthorSavedViewDependencyStatus.MigrationRequired
                : AuthorSavedViewDependencyStatus.Unknown;
            return Unknown(condition.Field, condition.OperatorId, missingStatus, descriptor);
        }

        return ResolutionFromFact(condition.Field, condition.OperatorId, descriptor, fact);
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

        var facts = new List<AuthorSavedViewDependencyFact>();
        foreach (IAuthorSavedViewDependencyProvider provider in _providers)
        {
            AuthorSavedViewDependencyFact? fact = await provider.ResolveSortAsync(
                owner,
                sort,
                cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (fact is not null)
            {
                facts.Add(fact);
            }
        }
        if (facts.Count == 0)
        {
            return Projection(sort.Field, "sort", AuthorSavedViewDependencyStatus.Unknown, "unavailable");
        }
        AuthorSavedViewDependencyFact selected = facts.Count == 1
            ? facts[0]
            : facts[0] with
            {
                Status = AuthorSavedViewDependencyStatus.DuplicateAuthority
            };
        return ProjectionFromFact(sort.Field, "sort", selected);
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

        var facts = new List<AuthorSavedViewDependencyFact>();
        foreach (IAuthorSavedViewDependencyProvider provider in _providers)
        {
            AuthorSavedViewDependencyFact? fact = await provider.ResolveProjectionAsync(
                owner,
                field,
                cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (fact is not null)
            {
                facts.Add(fact);
            }
        }
        if (facts.Count == 0)
        {
            return Projection(field, "projection", AuthorSavedViewDependencyStatus.Unknown, "unavailable");
        }
        AuthorSavedViewDependencyFact selected = facts.Count == 1
            ? facts[0]
            : facts[0] with
            {
                Status = AuthorSavedViewDependencyStatus.DuplicateAuthority
            };
        return ProjectionFromFact(field, "projection", selected);
    }

    private async ValueTask<AuthorSavedViewDependencyFact?> ResolveFromProvidersAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewCondition condition,
        CancellationToken cancellationToken)
    {
        var facts = new List<AuthorSavedViewDependencyFact>();
        foreach (IAuthorSavedViewDependencyProvider provider in _providers)
        {
            AuthorSavedViewDependencyFact? fact = await provider.ResolveConditionAsync(
                owner,
                condition,
                cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (fact is not null)
            {
                facts.Add(fact);
            }
        }
        return facts.Count switch
        {
            0 => null,
            1 => facts[0],
            _ => facts[0] with { Status = AuthorSavedViewDependencyStatus.DuplicateAuthority }
        };
    }

    private static AuthorSavedViewDependencyResolution ResolutionFromFact(
        AuthorSavedViewFieldReference expectedField,
        string expectedOperatorId,
        AuthorSavedViewOperatorDescriptor descriptor,
        AuthorSavedViewDependencyFact fact)
    {
        ValidateFact(expectedField, expectedOperatorId, fact, allowCanonicalValues: true);
        return new AuthorSavedViewDependencyResolution(
            fact.Dependency,
            fact.OperatorId,
            fact.Status,
            fact.AuthorityRevision,
            descriptor,
            fact.CanonicalValues);
    }

    private static AuthorSavedViewDependencyResolution ProjectionFromFact(
        AuthorSavedViewFieldReference expectedField,
        string expectedOperation,
        AuthorSavedViewDependencyFact fact)
    {
        ValidateFact(expectedField, expectedOperation, fact, allowCanonicalValues: false);
        return Projection(expectedField, expectedOperation, fact.Status, fact.AuthorityRevision);
    }

    private static void ValidateFact(
        AuthorSavedViewFieldReference expectedField,
        string expectedOperatorId,
        AuthorSavedViewDependencyFact fact,
        bool allowCanonicalValues)
    {
        ArgumentNullException.ThrowIfNull(fact);
        ArgumentNullException.ThrowIfNull(fact.Dependency);
        ArgumentNullException.ThrowIfNull(fact.CanonicalValues);
        if (fact.Dependency != expectedField
            || !string.Equals(fact.OperatorId, expectedOperatorId, StringComparison.Ordinal)
            || !Enum.IsDefined(fact.Status)
            || string.IsNullOrWhiteSpace(fact.AuthorityRevision)
            || fact.AuthorityRevision.Length > AuthorSavedViewContract.MaxIdentityLength
            || fact.AuthorityRevision.Any(static character => char.IsControl(character) || char.IsWhiteSpace(character))
            || (!allowCanonicalValues && fact.CanonicalValues.Count != 0))
        {
            throw new AuthorSavedViewValidationException("saved_view_dependency_fact_tampered");
        }
    }

    private static AuthorSavedViewDependencyResolution Unknown(
        AuthorSavedViewFieldReference field,
        string operatorId,
        AuthorSavedViewDependencyStatus status,
        AuthorSavedViewOperatorDescriptor descriptor)
        => new(
            field,
            operatorId,
            status,
            "unavailable",
            descriptor,
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
                AuthorSavedViewNullSemantic.AuthorityOwned,
                AuthorSavedViewDefaultSemantic.AuthorityOwned,
                AuthorSavedViewCaseSemantic.AuthorityOwned,
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
    ValueTask<AuthorSavedViewDependencyFact?> ResolveConditionAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewCondition condition,
        CancellationToken cancellationToken = default);

    ValueTask<AuthorSavedViewDependencyFact?> ResolveSortAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewSort sort,
        CancellationToken cancellationToken = default);

    ValueTask<AuthorSavedViewDependencyFact?> ResolveProjectionAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewFieldReference field,
        CancellationToken cancellationToken = default);
}

public readonly record struct AuthorSavedViewOwner(long AdminPrincipalId, string SiteScope);

public enum AuthorSavedViewSchemaVersionStatus
{
    Current = 0,
    MigrationRequired = 1,
    FutureUnsupported = 2
}

public enum AuthorSavedViewOldSchemaDisposition
{
    ExplicitMigrationRequired = 0
}

public enum AuthorSavedViewFutureSchemaDisposition
{
    Reject = 0
}

public sealed record AuthorSavedViewSchemaVersionPolicy(
    int CurrentVersion,
    int MinimumSupportedVersion,
    AuthorSavedViewOldSchemaDisposition OldSchemaDisposition,
    AuthorSavedViewFutureSchemaDisposition FutureSchemaDisposition);

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
    Boolean = 5,
    AuthorityOwned = 6
}

public enum AuthorSavedViewFieldIdentityKind
{
    Exact = 0,
    AuthorityStableIdentity = 1
}

public enum AuthorSavedViewOperatorCardinality
{
    None = 0,
    Single = 1,
    MultipleSet = 2,
    OrderedPair = 3
}

public enum AuthorSavedViewNullSemantic
{
    NullNeverMatches = 0,
    MissingOnly = 1,
    PresentOnly = 2,
    AuthorityOwned = 3
}

public enum AuthorSavedViewDefaultSemantic
{
    NotApplicable = 0,
    DistinctFromMissing = 1,
    AuthorityOwned = 2
}

public enum AuthorSavedViewCaseSemantic
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

public sealed record AuthorSavedViewFieldReference(
    AuthorSavedViewFieldKind Kind,
    string Identity);

public sealed record AuthorSavedViewFieldDescriptor(
    AuthorSavedViewFieldKind Kind,
    AuthorSavedViewFieldIdentityKind IdentityKind,
    IReadOnlyList<string> ExactIdentities,
    string? StableIdentityPrefix,
    IReadOnlyList<string> OperatorIds,
    bool RequiresDependencyProvider)
{
    public bool AcceptsIdentity(string identity)
        => IdentityKind switch
        {
            AuthorSavedViewFieldIdentityKind.Exact => ExactIdentities.Contains(identity, StringComparer.Ordinal),
            AuthorSavedViewFieldIdentityKind.AuthorityStableIdentity => StableIdentityPrefix is not null
                && identity.StartsWith(StableIdentityPrefix, StringComparison.Ordinal)
                && identity.Length > StableIdentityPrefix.Length,
            _ => false
        };
}

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
    AuthorSavedViewNullSemantic NullSemantics,
    AuthorSavedViewDefaultSemantic DefaultSemantics,
    AuthorSavedViewCaseSemantic CaseSemantics,
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

public sealed record AuthorSavedViewDependencyFact(
    AuthorSavedViewFieldReference Dependency,
    string OperatorId,
    AuthorSavedViewDependencyStatus Status,
    string AuthorityRevision,
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
