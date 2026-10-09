using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>Closed scalar data; collections and ranges are declared by the parameter schema.</summary>
public enum AuthoringFilterScalarKind
{
    Text = 0,
    StableIdentity = 1,
    Number = 2,
    Boolean = 3,
    LocalDate = 4
}

public enum AuthoringFilterParameterShape
{
    None = 0,
    Scalar = 1,
    Range = 2,
    Set = 3
}

public enum AuthoringFilterPermissionRequirement
{
    AuthorArticleRead = 0
}

public enum AuthoringFilterIndexRequirement
{
    OwningServerIndex = 0
}

public enum AuthoringFilterLifecyclePolicy
{
    RetainConditionsRequireRevalidation = 0
}

/// <summary>Exactly one typed slot must be populated. Null is an operator, never a scalar value.</summary>
public sealed record AuthoringFilterScalar(
    AuthoringFilterScalarKind Kind,
    string? Text,
    decimal? Number,
    bool? Boolean,
    DateOnly? Date);

public sealed record AuthoringFilterParameterSchema(
    AuthoringFilterScalarKind ScalarKind,
    AuthoringFilterParameterShape Shape,
    int MaximumValues,
    int MaximumValueLength);

/// <summary>A declarative reference to an existing operator; it cannot register query semantics.</summary>
public sealed record AuthoringFilterOperatorDeclaration(
    string Id,
    int Version,
    string SavedViewOperatorId,
    AuthorSavedViewFieldReference Field,
    AuthorSavedViewValueKind FieldType,
    AuthorSavedViewNullSemantics NullSemantics,
    AuthoringFilterParameterSchema Parameter);

/// <summary>Requirements are proposals, not permission, index, package or lifecycle facts.</summary>
public sealed record AuthoringFilterContribution(
    int SchemaVersion,
    string PluginId,
    string PluginVersion,
    string PackageSha256,
    string FilterId,
    int FilterVersion,
    int QueryAdapterVersion,
    ImmutableArray<AuthoringFilterOperatorDeclaration> Operators,
    ImmutableArray<AuthoringFilterPermissionRequirement> RequiredPermissions,
    AuthoringFilterIndexRequirement Indexability,
    AuthoringFilterLifecyclePolicy LifecyclePolicy,
    int MaximumConditions,
    int CostPerCondition,
    bool RequestsAsync,
    bool RequestsNetwork,
    bool RequestsFile);

/// <summary>Saved data binds exact identities and versions; drift requires explicit user repair.</summary>
public sealed record AuthoringFilterConfiguration(
    int SchemaVersion,
    string PluginId,
    string PluginVersion,
    string PackageSha256,
    string FilterId,
    int FilterVersion,
    string OperatorId,
    int OperatorVersion,
    ImmutableArray<AuthoringFilterScalar> Values,
    string? TimeZoneId);

public sealed class AuthoringFilterContractException(string code) : InvalidOperationException(code)
{
    public string Code { get; } = code;
}

/// <summary>Owns only closed contribution/configuration shape, never article-query execution.</summary>
public static class AuthoringFilterContributionContracts
{
    public const int SchemaVersion = 1;
    public const int QueryAdapterVersion = 1;
    public const int MaximumContributions = 1000;
    public const int MaximumOperatorsPerContribution = 64;
    public const int MaximumJsonBytes = 1_048_576;
    public const int MaximumQueryCost = 4096;

    private static readonly JsonSerializerOptions s_options = new()
    {
        MaxDepth = 12,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true
    };

    public static AuthoringFilterContribution ParseContribution(ReadOnlySpan<byte> json)
    {
        AuthoringFilterContribution contribution = Parse<AuthoringFilterContribution>(json);
        Validate(contribution);
        return contribution;
    }

    public static AuthoringFilterConfiguration ParseConfiguration(ReadOnlySpan<byte> json)
    {
        AuthoringFilterConfiguration configuration = Parse<AuthoringFilterConfiguration>(json);
        ValidateConfiguration(configuration);
        return configuration;
    }

    public static void Validate(AuthoringFilterContribution contribution)
    {
        ArgumentNullException.ThrowIfNull(contribution);
        Require(contribution.SchemaVersion == SchemaVersion, "filter_schema_unsupported");
        Require(contribution.QueryAdapterVersion == QueryAdapterVersion, "filter_adapter_unsupported");
        ValidateBinding(contribution.PluginId, contribution.PluginVersion, contribution.PackageSha256,
            contribution.FilterId, contribution.FilterVersion);
        Require(!contribution.Operators.IsDefaultOrEmpty
            && contribution.Operators.Length <= MaximumOperatorsPerContribution, "filter_operator_budget_invalid");
        Require(contribution.RequiredPermissions is [AuthoringFilterPermissionRequirement.AuthorArticleRead],
            "filter_permissions_invalid");
        Require(contribution.Indexability == AuthoringFilterIndexRequirement.OwningServerIndex
            && contribution.LifecyclePolicy == AuthoringFilterLifecyclePolicy.RetainConditionsRequireRevalidation,
            "filter_requirements_unknown");
        Require(!contribution.RequestsAsync && !contribution.RequestsNetwork && !contribution.RequestsFile,
            "filter_external_execution_forbidden");
        Require(contribution.MaximumConditions is >= 1 and <= AuthorSavedViewContract.MaxConditions
            && contribution.CostPerCondition is >= 1 and <= MaximumQueryCost, "filter_budget_invalid");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var targets = new HashSet<(AuthorSavedViewFieldReference, string)>();
        foreach (AuthoringFilterOperatorDeclaration declaration in contribution.Operators)
        {
            Require(declaration is not null, "filter_operator_missing");
            ValidateOperatorId(contribution.PluginId, declaration.Id);
            Require(declaration.Version > 0, "filter_operator_version_invalid");
            Require(ids.Add(declaration.Id), "filter_operator_duplicate");
            Require(declaration.Field is not null && declaration.Parameter is not null, "filter_operator_missing");
            Require(!string.IsNullOrEmpty(declaration.SavedViewOperatorId), "filter_operator_unknown");
            Require(!string.IsNullOrEmpty(declaration.Field.Identity)
                && declaration.Field.Identity.Length <= AuthorSavedViewContract.MaxIdentityLength
                && !declaration.Field.Identity.Any(static character => char.IsWhiteSpace(character) || char.IsControl(character)),
                "filter_field_identity_invalid");
            AuthorSavedViewOperatorDescriptor descriptor = AuthorSavedViewContract.FindBuiltInOperator(
                declaration.SavedViewOperatorId) ?? throw new AuthoringFilterContractException("filter_operator_unknown");
            AuthorSavedViewFieldDescriptor? field = AuthorSavedViewContract.FindField(declaration.Field.Kind);
            Require(AuthorSavedViewContract.IsRegisteredOperatorDescriptor(descriptor)
                && field is not null && field.AcceptsIdentity(declaration.Field.Identity)
                && field.OperatorIds.Contains(descriptor.Id, StringComparer.Ordinal)
                && descriptor.FieldKinds.Contains(declaration.Field.Kind), "filter_operator_field_incompatible");
            Require(targets.Add((declaration.Field, descriptor.Id)), "filter_operator_target_duplicate");
            Require(declaration.FieldType == descriptor.ValueKind
                && declaration.NullSemantics == descriptor.NullSemantics, "filter_operator_semantics_conflict");
            ValidateParameter(declaration.Parameter, descriptor);
        }
    }

    public static void ValidateConfiguration(AuthoringFilterConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        Require(configuration.SchemaVersion == SchemaVersion, "filter_config_schema_unsupported");
        ValidateBinding(configuration.PluginId, configuration.PluginVersion, configuration.PackageSha256,
            configuration.FilterId, configuration.FilterVersion);
        ValidateOperatorId(configuration.PluginId, configuration.OperatorId);
        Require(configuration.OperatorVersion > 0, "filter_operator_version_invalid");
        Require(!configuration.Values.IsDefault
            && configuration.Values.Length <= AuthorSavedViewContract.MaxValuesPerCondition, "filter_value_budget_exceeded");
        foreach (AuthoringFilterScalar value in configuration.Values)
        {
            _ = FormatScalar(value, AuthorSavedViewContract.MaxValueLength);
        }
    }

    internal static string FormatScalar(AuthoringFilterScalar scalar, int maximumLength)
    {
        Require(scalar is not null && Enum.IsDefined(scalar.Kind), "filter_scalar_kind_unknown");
        int slots = (scalar.Text is null ? 0 : 1) + (scalar.Number.HasValue ? 1 : 0)
            + (scalar.Boolean.HasValue ? 1 : 0) + (scalar.Date.HasValue ? 1 : 0);
        Require(slots == 1, "filter_scalar_slots_invalid");
        string value = scalar.Kind switch
        {
            AuthoringFilterScalarKind.Text when scalar.Text is not null => scalar.Text,
            AuthoringFilterScalarKind.StableIdentity when scalar.Text is not null
                && !scalar.Text.Any(char.IsWhiteSpace) => scalar.Text,
            AuthoringFilterScalarKind.Number when scalar.Number.HasValue => scalar.Number.Value.ToString(CultureInfo.InvariantCulture),
            AuthoringFilterScalarKind.Boolean when scalar.Boolean.HasValue => scalar.Boolean.Value ? "true" : "false",
            AuthoringFilterScalarKind.LocalDate when scalar.Date.HasValue => scalar.Date.Value.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            _ => throw new AuthoringFilterContractException("filter_scalar_type_invalid")
        };
        Require(value.Length is > 0 && value.Length <= maximumLength && !value.Any(char.IsControl),
            "filter_value_length_invalid");
        return value;
    }

    internal static void Require([DoesNotReturnIf(false)] bool condition, string code)
    {
        if (!condition)
        {
            throw new AuthoringFilterContractException(code);
        }
    }

    private static void ValidateParameter(
        AuthoringFilterParameterSchema parameter, AuthorSavedViewOperatorDescriptor descriptor)
    {
        Require(Enum.IsDefined(parameter.ScalarKind) && Enum.IsDefined(parameter.Shape), "filter_parameter_type_unknown");
        AuthoringFilterParameterShape shape = descriptor.Cardinality switch
        {
            AuthorSavedViewOperatorCardinality.None => AuthoringFilterParameterShape.None,
            AuthorSavedViewOperatorCardinality.Single => AuthoringFilterParameterShape.Scalar,
            AuthorSavedViewOperatorCardinality.OrderedPair => AuthoringFilterParameterShape.Range,
            AuthorSavedViewOperatorCardinality.MultipleSet => AuthoringFilterParameterShape.Set,
            _ => throw new AuthoringFilterContractException("filter_parameter_shape_unknown")
        };
        Require(parameter.Shape == shape, "filter_parameter_shape_conflict");
        bool typeMatches = descriptor.ValueKind switch
        {
            AuthorSavedViewValueKind.None => parameter.ScalarKind == AuthoringFilterScalarKind.Text,
            AuthorSavedViewValueKind.StableIdentity => parameter.ScalarKind == AuthoringFilterScalarKind.StableIdentity,
            AuthorSavedViewValueKind.Text => parameter.ScalarKind == AuthoringFilterScalarKind.Text,
            AuthorSavedViewValueKind.LocalDate => parameter.ScalarKind == AuthoringFilterScalarKind.LocalDate,
            AuthorSavedViewValueKind.Number => parameter.ScalarKind == AuthoringFilterScalarKind.Number,
            AuthorSavedViewValueKind.Boolean => parameter.ScalarKind == AuthoringFilterScalarKind.Boolean,
            // Property authority still owns type compatibility and indexability; this is only typed data.
            AuthorSavedViewValueKind.AuthorityOwned => true,
            _ => false
        };
        Require(typeMatches, "filter_parameter_type_conflict");
        int minimum = shape switch
        {
            AuthoringFilterParameterShape.None => 0,
            AuthoringFilterParameterShape.Range => 2,
            _ => 1
        };
        Require(parameter.MaximumValues >= minimum
            && parameter.MaximumValues <= AuthorSavedViewContract.MaxValuesPerCondition
            && (shape != AuthoringFilterParameterShape.None || parameter.MaximumValues == 0)
            && (shape != AuthoringFilterParameterShape.Scalar || parameter.MaximumValues == 1)
            && (shape != AuthoringFilterParameterShape.Range || parameter.MaximumValues == 2)
            && parameter.MaximumValueLength is >= 1 and <= AuthorSavedViewContract.MaxValueLength,
            "filter_parameter_budget_invalid");
    }

    private static void ValidateBinding(string pluginId, string version, string digest, string filterId, int filterVersion)
    {
        ValidateIdentity(pluginId);
        ValidateIdentity(filterId);
        Require(filterId.StartsWith(pluginId + ".filter.", StringComparison.Ordinal)
            && filterId.Length > pluginId.Length + 8, "filter_core_identity_conflict");
        Require(filterVersion > 0, "filter_version_invalid");
        Require(!string.IsNullOrEmpty(version) && version.Length <= 32
            && version.Split('.').Length is >= 2 and <= 4
            && version.Split('.').All(static part => part.Length > 0 && part.All(char.IsAsciiDigit)),
            "filter_plugin_version_invalid");
        Require(digest is { Length: 64 } && digest.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f'), "filter_package_digest_invalid");
    }

    private static void ValidateOperatorId(string pluginId, string id)
    {
        ValidateIdentity(id);
        Require(id.StartsWith(pluginId + ".operator.", StringComparison.Ordinal)
            && id.Length > pluginId.Length + 10, "filter_core_identity_conflict");
    }

    private static void ValidateIdentity(string identity)
    {
        Require(!string.IsNullOrEmpty(identity) && identity.Length <= AuthorSavedViewContract.MaxIdentityLength
            && identity[0] is >= 'a' and <= 'z'
            && identity.All(static character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '.' or '-')
            && !identity.StartsWith("fsusblog.core", StringComparison.Ordinal)
            && identity.Split('.', '-').All(static part => part.Length > 0), "filter_identity_invalid");
    }

    private static T Parse<T>(ReadOnlySpan<byte> json)
    {
        Require(!json.IsEmpty && json.Length <= MaximumJsonBytes, "filter_json_budget_invalid");
        try
        {
            using JsonDocument document = JsonDocument.Parse(json.ToArray(), new JsonDocumentOptions { MaxDepth = 12 });
            RejectDuplicateProperties(document.RootElement);
            return JsonSerializer.Deserialize<T>(json, s_options)
                ?? throw new AuthoringFilterContractException("filter_json_missing");
        }
        catch (JsonException)
        {
            throw new AuthoringFilterContractException("filter_json_invalid");
        }
    }

    private static void RejectDuplicateProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                Require(names.Add(property.Name), "filter_json_duplicate");
                RejectDuplicateProperties(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in element.EnumerateArray())
            {
                RejectDuplicateProperties(item);
            }
        }
    }
}
