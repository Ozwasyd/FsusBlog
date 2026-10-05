using System.Collections.ObjectModel;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Closed, versioned definition facts for article properties. This contract deliberately
/// contains no article value, query, UI, or migration state.
/// </summary>
public static partial class ArticlePropertyDefinitionContract
{
    public const int SchemaVersion = 1;
    public const int MaxDefinitionsPerOwner = 1_000;
    public const int MaxOptionsPerDefinition = 1_000;
    public const int MaxReferenceIdsPerDefault = 1_000;
    public const int MaxDisplayNames = 16;
    public const int MaxLocalizedLabelLength = 256;
    public const int MaxLocaleLength = 32;
    public const int MaxMachineKeyLength = 64;
    public const int MaxSiteScopeLength = 128;
    public const int MaxPageSize = 100;
    public const int MaxStringConstraintLength = 16_384;
    public const int MaxUrlLength = 2_048;
    public const int MaxAllowedSchemes = 8;
    public const int MaxSchemaBytes = 512 * 1_024;
    public const int MaxVerificationReceipts = 10_000;
    // Independent verification admission, not a definition/write schema limit.
    // SQL checks this aggregate before hydrating owner facts, command payloads or audits.
    public const int MaxVerificationResourceBytes = 32 * 1_024 * 1_024;

    private static readonly ReadOnlyDictionary<ArticlePropertyValueType, string> s_typeNames =
        new(new Dictionary<ArticlePropertyValueType, string>
        {
            [ArticlePropertyValueType.Text] = "text",
            [ArticlePropertyValueType.Number] = "number",
            [ArticlePropertyValueType.Boolean] = "boolean",
            [ArticlePropertyValueType.Date] = "date",
            [ArticlePropertyValueType.SingleSelect] = "single-select",
            [ArticlePropertyValueType.MultiSelect] = "multi-select",
            [ArticlePropertyValueType.ArticleReference] = "article-reference",
            [ArticlePropertyValueType.Url] = "url"
        });

    private static readonly ReadOnlyDictionary<string, ArticlePropertyValueType> s_typesByName =
        new(s_typeNames.ToDictionary(static pair => pair.Value, static pair => pair.Key, StringComparer.Ordinal));

    private static readonly ReadOnlyDictionary<string, ArticlePropertyOperatorDescriptor> s_operators =
        new(new Dictionary<string, ArticlePropertyOperatorDescriptor>(StringComparer.Ordinal)
        {
            ["value.is-missing"] = Descriptor("value.is-missing", false),
            ["value.is-present"] = Descriptor("value.is-present", false),
            ["text.equals"] = Descriptor("text.equals", true, ArticlePropertyValueType.Text),
            ["text.contains"] = Descriptor("text.contains", true, ArticlePropertyValueType.Text),
            ["number.equals"] = Descriptor("number.equals", true, ArticlePropertyValueType.Number),
            ["number.less-than"] = Descriptor("number.less-than", true, ArticlePropertyValueType.Number),
            ["number.less-than-or-equal"] = Descriptor("number.less-than-or-equal", true, ArticlePropertyValueType.Number),
            ["number.greater-than"] = Descriptor("number.greater-than", true, ArticlePropertyValueType.Number),
            ["number.greater-than-or-equal"] = Descriptor("number.greater-than-or-equal", true, ArticlePropertyValueType.Number),
            ["number.between"] = Descriptor("number.between", true, ArticlePropertyValueType.Number),
            ["boolean.equals"] = Descriptor("boolean.equals", true, ArticlePropertyValueType.Boolean),
            ["date.before"] = Descriptor("date.before", true, ArticlePropertyValueType.Date),
            ["date.on-or-before"] = Descriptor("date.on-or-before", true, ArticlePropertyValueType.Date),
            ["date.after"] = Descriptor("date.after", true, ArticlePropertyValueType.Date),
            ["date.on-or-after"] = Descriptor("date.on-or-after", true, ArticlePropertyValueType.Date),
            ["date.between"] = Descriptor("date.between", true, ArticlePropertyValueType.Date),
            ["select.equals"] = Descriptor("select.equals", true,
                ArticlePropertyValueType.SingleSelect, ArticlePropertyValueType.MultiSelect),
            ["select.any-of"] = Descriptor("select.any-of", true,
                ArticlePropertyValueType.SingleSelect, ArticlePropertyValueType.MultiSelect),
            ["reference.equals"] = Descriptor("reference.equals", true, ArticlePropertyValueType.ArticleReference),
            ["reference.any-of"] = Descriptor("reference.any-of", true, ArticlePropertyValueType.ArticleReference),
            ["url.equals"] = Descriptor("url.equals", true, ArticlePropertyValueType.Url),
            ["url.host"] = Descriptor("url.host", true, ArticlePropertyValueType.Url),
            ["url.scheme"] = Descriptor("url.scheme", true, ArticlePropertyValueType.Url)
        });

    [GeneratedRegex("^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$", RegexOptions.CultureInvariant)]
    private static partial Regex MachineKeyPattern();

    public static IReadOnlyDictionary<ArticlePropertyValueType, string> TypeNames => s_typeNames;

    public static IReadOnlyDictionary<string, ArticlePropertyOperatorDescriptor> Operators => s_operators;

    public static ArticlePropertyValueType ParseType(string value)
    {
        if (value is null || !s_typesByName.TryGetValue(value, out ArticlePropertyValueType result))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_type_unknown");
        }

        return result;
    }

    public static string TypeName(ArticlePropertyValueType value)
        => s_typeNames.TryGetValue(value, out string? name)
            ? name
            : throw new ArticlePropertyDefinitionValidationException("article_property_type_unknown");

    public static void ValidateActor(ArticlePropertyDefinitionActor actor)
    {
        ArgumentNullException.ThrowIfNull(actor);
        if (actor.AdminPrincipalId <= 0 || actor.Permissions.Count > 64)
        {
            throw new ArticlePropertyDefinitionAccessDeniedException();
        }

        foreach (string permission in actor.Permissions)
        {
            ValidateText(permission, 128, "article_property_actor_permission_invalid");
        }
    }

    public static void ValidateOwner(ArticlePropertyDefinitionOwner owner)
    {
        if (owner.UserId is <= 0
            || string.IsNullOrWhiteSpace(owner.SiteScope)
            || owner.SiteScope.Length > MaxSiteScopeLength
            || !string.Equals(owner.SiteScope, owner.SiteScope.Trim(), StringComparison.Ordinal)
            || owner.SiteScope.Any(char.IsControl))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_owner_invalid");
        }
    }

    public static void ValidateRequestId(Guid requestId)
    {
        if (requestId == Guid.Empty)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_request_identity_invalid");
        }
    }

    public static void ValidateExpectedRevision(long revision, string code)
    {
        if (revision < 0)
        {
            throw new ArticlePropertyDefinitionValidationException(code);
        }
    }

    public static string NormalizeMachineKey(string machineKey)
    {
        if (string.IsNullOrWhiteSpace(machineKey))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_machine_key_invalid");
        }

        string normalized = machineKey.Trim().Normalize(NormalizationForm.FormC).ToLowerInvariant();
        if (normalized.Length > MaxMachineKeyLength || !MachineKeyPattern().IsMatch(normalized))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_machine_key_invalid");
        }

        return normalized;
    }

    public static IReadOnlyList<ArticlePropertyLocalizedName> NormalizeDisplayNames(
        IReadOnlyList<ArticlePropertyLocalizedName> displayNames)
    {
        ArgumentNullException.ThrowIfNull(displayNames);
        if (displayNames.Count is < 1 or > MaxDisplayNames)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_display_names_budget_exceeded");
        }

        var result = new List<ArticlePropertyLocalizedName>(displayNames.Count);
        var locales = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (ArticlePropertyLocalizedName name in displayNames)
        {
            ArgumentNullException.ThrowIfNull(name);
            string locale = NormalizeLocale(name.Locale);
            string value = NormalizeText(name.Value, MaxLocalizedLabelLength, "article_property_display_name_invalid");
            if (!locales.Add(locale))
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_display_name_locale_duplicate");
            }

            result.Add(new(locale, value));
        }

        result.Sort(static (left, right) => StringComparer.Ordinal.Compare(left.Locale, right.Locale));
        return Array.AsReadOnly(result.ToArray());
    }

    public static void ValidateDefinition(ArticlePropertyDefinition definition)
    {
        ArgumentNullException.ThrowIfNull(definition);
        if (definition.SchemaVersion != SchemaVersion || definition.DefinitionId == Guid.Empty)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_definition_identity_invalid");
        }
        if (definition.DisplayNames is null
            || definition.Presence is null
            || definition.Constraints is null
            || definition.Options is null)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_definition_shape_invalid");
        }

        ValidateOwner(definition.Owner);
        if (!string.Equals(definition.MachineKey, NormalizeMachineKey(definition.MachineKey), StringComparison.Ordinal))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_machine_key_not_canonical");
        }

        IReadOnlyList<ArticlePropertyLocalizedName> names = NormalizeDisplayNames(definition.DisplayNames);
        if (!names.SequenceEqual(definition.DisplayNames))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_display_names_not_canonical");
        }

        if (!Enum.IsDefined(definition.ValueType)
            || !Enum.IsDefined(definition.Cardinality)
            || !Enum.IsDefined(definition.DisplayPlacement)
            || !Enum.IsDefined(definition.VisibilityScope)
            || !Enum.IsDefined(definition.Status)
            || definition.SchemaRevision <= 0)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_definition_enum_or_revision_invalid");
        }

        ValidatePresence(definition.Presence, definition.Required, definition.DefaultValue);
        ValidateCardinality(definition.ValueType, definition.Cardinality);
        ValidateConstraints(definition.ValueType, definition.Cardinality, definition.Constraints);
        ValidateOptions(definition.ValueType, definition.Options);
        ValidatePolicies(definition);
        ValidateDefault(definition);
        ValidateSchemaBytes(definition);
        ValidateUtcTimeline(definition.CreatedAtUtc, definition.UpdatedAtUtc);
        ValidateDigest(definition.ContentDigest, ComputeDefinitionDigest(definition), "article_property_definition_digest_invalid");
    }

    public static void ValidateDefinitionShapeForCommand(
        ArticlePropertyValueType valueType,
        ArticlePropertyCardinality cardinality,
        bool required,
        ArticlePropertyPresencePolicy presence,
        ArticlePropertyDefaultValue? defaultValue,
        ArticlePropertyConstraints constraints,
        IReadOnlyList<ArticlePropertyOption> options,
        ArticlePropertyReferencePolicy? referencePolicy,
        ArticlePropertyUrlPolicy? urlPolicy,
        bool searchEligible,
        bool filterable,
        bool sortable,
        ArticlePropertyDisplayPlacement displayPlacement,
        ArticlePropertyVisibilityScope visibilityScope)
    {
        ValidateCommandPayloadShape(
            presence,
            defaultValue,
            constraints,
            options,
            urlPolicy);
        ValidatePresence(presence, required, defaultValue);
        ValidateCardinality(valueType, cardinality);
        ValidateConstraints(valueType, cardinality, constraints);
        ValidateOptions(valueType, options);
        if (referencePolicy is not null)
        {
            if (!Enum.IsDefined(referencePolicy.Cardinality)
                || !Enum.IsDefined(referencePolicy.Permission))
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_reference_policy_invalid");
            }
        }
        if (urlPolicy is not null)
        {
            ValidateUrlPolicy(urlPolicy);
        }
        var definition = new ArticlePropertyDefinition(
            SchemaVersion,
            Guid.CreateVersion7(),
            ArticlePropertyDefinitionOwner.Site("validation"),
            "property",
            [new ArticlePropertyLocalizedName("en", "Property")],
            valueType,
            cardinality,
            required,
            presence,
            defaultValue,
            constraints,
            options,
            referencePolicy,
            urlPolicy,
            searchEligible,
            filterable,
            sortable,
            displayPlacement,
            visibilityScope,
            ArticlePropertyDefinitionStatus.Active,
            1,
            DateTime.UnixEpoch,
            DateTime.UnixEpoch,
            string.Empty);
        definition = definition with
        {
            ContentDigest = ComputeDefinitionDigest(definition)
        };
        ValidateDefinition(definition);
    }

    public static void ValidateOptions(
        ArticlePropertyValueType valueType,
        IReadOnlyList<ArticlePropertyOption> options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (options.Count > MaxOptionsPerDefinition)
        {
            throw new ArticlePropertyDefinitionBudgetExceededException("article_property_options_budget_exceeded");
        }

        bool select = valueType is ArticlePropertyValueType.SingleSelect or ArticlePropertyValueType.MultiSelect;
        if (!select && options.Count != 0)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_options_type_mismatch");
        }
        var optionIds = new HashSet<Guid>();
        var orders = new HashSet<int>();
        foreach (ArticlePropertyOption option in options)
        {
            ArgumentNullException.ThrowIfNull(option);
            if (option.LocalizedLabels is null)
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_option_labels_invalid");
            }
            if (option.OptionId == Guid.Empty || !Enum.IsDefined(option.Status) || option.Order < 0)
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_option_invalid");
            }
            if (!optionIds.Add(option.OptionId))
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_option_duplicate");
            }
            if (!orders.Add(option.Order))
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_option_order_duplicate");
            }

            _ = NormalizeText(option.Label, MaxLocalizedLabelLength, "article_property_option_label_invalid");
            ValidateLocalizedLabels(option.LocalizedLabels);
        }

        if (select && options.Count == 0)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_options_required");
        }
    }

    public static void ValidateOperator(string operatorId, ArticlePropertyValueType valueType)
    {
        if (operatorId is null || !s_operators.TryGetValue(operatorId, out ArticlePropertyOperatorDescriptor? descriptor))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_operator_unknown");
        }
        if (!descriptor.ValueTypes.Contains(valueType)
            && operatorId is not "value.is-missing" and not "value.is-present")
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_operator_type_mismatch");
        }
    }

    public static string NormalizeScalar(ArticlePropertyValueType valueType, string scalar)
    {
        if (scalar is null)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_scalar_missing");
        }
        string value = scalar.Normalize(NormalizationForm.FormC);
        if (value.Length > MaxStringConstraintLength || value.Any(char.IsControl))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_scalar_invalid");
        }

        switch (valueType)
        {
            case ArticlePropertyValueType.Text:
                return value;
            case ArticlePropertyValueType.Number when decimal.TryParse(
                value,
                NumberStyles.Number,
                CultureInfo.InvariantCulture,
                out decimal number):
                return number.ToString("G29", CultureInfo.InvariantCulture);
            case ArticlePropertyValueType.Boolean when bool.TryParse(value, out bool boolean):
                return boolean ? "true" : "false";
            case ArticlePropertyValueType.Date when DateTimeOffset.TryParse(
                value,
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind,
                out DateTimeOffset date):
                return date.UtcDateTime.ToString("O", CultureInfo.InvariantCulture);
            case ArticlePropertyValueType.Url:
                throw new ArticlePropertyDefinitionValidationException("article_property_url_requires_policy");
            default:
                throw new ArticlePropertyDefinitionValidationException("article_property_scalar_type_mismatch");
        }
    }

    public static string NormalizeUrl(string value, ArticlePropertyUrlPolicy policy)
    {
        ValidateUrlPolicy(policy);
        if (string.IsNullOrWhiteSpace(value)
            || value.Length > policy.MaxLength
            || value.Any(character => char.IsControl(character) || char.IsWhiteSpace(character)))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_url_invalid");
        }

        bool absolute = Uri.TryCreate(value, UriKind.Absolute, out Uri? absoluteUri);
        if (!absolute && !policy.AllowRelative)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_url_relative_forbidden");
        }
        if (absolute && !policy.AllowAbsolute)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_url_absolute_forbidden");
        }
        if (!absolute)
        {
            if (value.StartsWith("//", StringComparison.Ordinal))
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_url_network_path_forbidden");
            }
            return value.Normalize(NormalizationForm.FormC);
        }

        string scheme = absoluteUri!.Scheme.ToLowerInvariant();
        if (!policy.AllowedSchemes.Contains(scheme, StringComparer.Ordinal))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_url_scheme_forbidden");
        }
        if (scheme is "javascript" or "data" or "file" or "vbscript" or "blob")
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_url_unsafe_scheme");
        }

        if (policy.Normalization == ArticlePropertyUrlNormalization.PreservePathCase)
        {
            string preserved = absoluteUri.ToString();
            if (preserved.Length > policy.MaxLength)
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_url_invalid");
            }
            return preserved;
        }

        var builder = new UriBuilder(absoluteUri)
        {
            Scheme = scheme,
            Host = absoluteUri.Host.ToLowerInvariant()
        };
        string normalized = builder.Uri.ToString();
        if (normalized.Length > policy.MaxLength)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_url_invalid");
        }
        return normalized;
    }

    public static string ComputeDefinitionDigest(ArticlePropertyDefinition definition)
        => ComputeDigest(
            definition.SchemaVersion,
            definition.DefinitionId,
            definition.Owner.UserId,
            definition.Owner.SiteScope,
            definition.MachineKey,
            ComputeDisplayNamesDigest(definition.DisplayNames),
            (int)definition.ValueType,
            (int)definition.Cardinality,
            definition.Required,
            (int)definition.Presence.Missing,
            (int)definition.Presence.Null,
            (int)definition.Presence.Empty,
            ComputeDefaultDigest(definition.DefaultValue),
            ComputeConstraintDigest(definition.Constraints),
            ComputeOptionsDigest(definition.Options),
            ComputePolicyDigest(definition.ReferencePolicy, definition.UrlPolicy),
            definition.SearchEligible,
            definition.Filterable,
            definition.Sortable,
            (int)definition.DisplayPlacement,
            (int)definition.VisibilityScope,
            (int)definition.Status,
            definition.SchemaRevision,
            definition.CreatedAtUtc,
            definition.UpdatedAtUtc);

    public static string ComputeDisplayNamesDigest(IReadOnlyList<ArticlePropertyLocalizedName> names)
    {
        ArgumentNullException.ThrowIfNull(names);
        return ComputeDigest([names.Count, .. names.OrderBy(static name => name.Locale, StringComparer.Ordinal)
            .SelectMany(static name => new object?[] { name.Locale, name.Value })]);
    }

    public static string ComputeConstraintDigest(ArticlePropertyConstraints constraints)
    {
        ArgumentNullException.ThrowIfNull(constraints);
        return ComputeDigest(
                constraints.MinLength,
                constraints.MaxLength,
                constraints.MinNumber,
                constraints.MaxNumber,
                constraints.MinDateUtc,
                constraints.MaxDateUtc,
                constraints.MinItems,
                constraints.MaxItems);
    }

    public static string ComputeOptionsDigest(IReadOnlyList<ArticlePropertyOption> options)
    {
        ArgumentNullException.ThrowIfNull(options);
        var values = new List<object?> { options.Count };
        foreach (ArticlePropertyOption option in options.OrderBy(static item => item.Order).ThenBy(static item => item.OptionId))
        {
            values.Add(option.OptionId);
            values.Add(option.Label);
            values.Add(option.Order);
            values.Add((int)option.Status);
            values.Add(ComputeDisplayNamesDigest(option.LocalizedLabels));
        }
        return ComputeDigest([.. values]);
    }

    public static string ComputePolicyDigest(
        ArticlePropertyReferencePolicy? referencePolicy,
        ArticlePropertyUrlPolicy? urlPolicy)
    {
        var values = new List<object?>
        {
            referencePolicy?.Cardinality,
            referencePolicy?.Permission,
            referencePolicy?.AllowCrossSite,
            referencePolicy?.AllowDeleted,
            referencePolicy?.AllowArchived,
            referencePolicy?.AllowSelfReference,
            referencePolicy?.AllowCycles,
            urlPolicy?.MaxLength,
            urlPolicy?.AllowRelative,
            urlPolicy?.AllowAbsolute,
            urlPolicy?.Normalization,
            urlPolicy is null ? null : string.Join(',', urlPolicy.AllowedSchemes)
        };
        return ComputeDigest([.. values]);
    }

    public static string ComputeDefaultDigest(ArticlePropertyDefaultValue? value)
    {
        if (value is not null && (value.OptionIds is null || value.ArticleIds is null))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_default_invalid");
        }
        var values = new List<object?>
        {
            value?.Kind,
            value?.Scalar,
            value is null ? null : string.Join(',', value.OptionIds.Order()),
            value is null ? null : string.Join(',', value.ArticleIds.Order())
        };
        return ComputeDigest([.. values]);
    }

    public static string ComputeFlagsDigest(ArticlePropertyDefinition definition)
        => ComputeDigest(
            definition.SearchEligible,
            definition.Filterable,
            definition.Sortable,
            (int)definition.DisplayPlacement,
            (int)definition.VisibilityScope);

    public static string ComputeCommandDigest(string commandKind, params object?[] values)
        => ComputeDigest([commandKind, SchemaVersion, .. values]);

    public static string ComputeReceiptDigest(ArticlePropertyDefinitionWriteReceipt receipt)
        => ComputeDigest(
            receipt.ReceiptId,
            receipt.RequestId,
            receipt.ActorAdminPrincipalId,
            receipt.Owner.UserId,
            receipt.Owner.SiteScope,
            receipt.CommandKind,
            receipt.CommandDigest,
            receipt.DefinitionId,
            receipt.PreviousOwnerRevision,
            receipt.OwnerRevision,
            receipt.PreviousSchemaRevision,
            receipt.SchemaRevision,
            (int)receipt.Status,
            receipt.BeforeDefinitionDigest,
            receipt.AfterDefinitionDigest,
            receipt.ConstraintDigest,
            receipt.OptionsDigest,
            receipt.PolicyDigest,
            receipt.FlagsDigest,
            ComputeObligationsDigest(receipt.Obligations),
            receipt.AuditReference,
            receipt.AuditDigest,
            receipt.OccurredAtUtc);

    /// <summary>
    /// Projects all receipt facts into the existing signed audit event. The public
    /// digest is not a signature; only the persisted audit link supplies that binding.
    /// Audit and content digests are cleared to avoid a recursive hash definition.
    /// </summary>
    public static string ComputeReceiptAuditDigest(ArticlePropertyDefinitionWriteReceipt receipt)
        => ComputeCommandDigest("audit", ComputeReceiptDigest(receipt with
        {
            AuditDigest = string.Empty,
            ContentDigest = string.Empty
        }));

    public static string ComputeObligationsDigest(IReadOnlyList<ArticlePropertyDefinitionObligation> obligations)
    {
        ArgumentNullException.ThrowIfNull(obligations);
        return ComputeDigest([
            obligations.Count,
            .. obligations.OrderBy(static obligation => obligation.Kind, StringComparer.Ordinal)
                .SelectMany(static obligation => new object?[]
                {
                    obligation.Kind,
                    obligation.AffectedValueCount,
                    obligation.RequiresReconciliation,
                    obligation.ReasonCode
                })]);
    }

    internal static void ValidateReceipt(ArticlePropertyDefinitionWriteReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        if (receipt.Obligations is null || receipt.Obligations.Any(static obligation => obligation is null))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_receipt_obligations_invalid");
        }
        ValidateRequestId(receipt.RequestId);
        ValidateOwner(receipt.Owner);
        if (receipt.ReceiptId == Guid.Empty
            || receipt.ActorAdminPrincipalId <= 0
            || receipt.DefinitionId == Guid.Empty
            || receipt.PreviousOwnerRevision < 0
            || receipt.PreviousSchemaRevision < 0
            || receipt.OwnerRevision != receipt.PreviousOwnerRevision + 1
            || receipt.SchemaRevision != receipt.PreviousSchemaRevision + 1
            || receipt.OccurredAtUtc.Kind != DateTimeKind.Utc
            || receipt.AuditReference == Guid.Empty
            || !Enum.IsDefined(receipt.Status))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_receipt_invalid");
        }

        ValidateDigest(receipt.CommandDigest, receipt.CommandDigest, "article_property_command_digest_invalid");
        ValidateDigest(receipt.BeforeDefinitionDigest, receipt.BeforeDefinitionDigest, "article_property_before_digest_invalid");
        ValidateDigest(receipt.AfterDefinitionDigest, receipt.AfterDefinitionDigest, "article_property_after_digest_invalid");
        ValidateDigest(receipt.ConstraintDigest, receipt.ConstraintDigest, "article_property_constraint_digest_invalid");
        ValidateDigest(receipt.OptionsDigest, receipt.OptionsDigest, "article_property_options_digest_invalid");
        ValidateDigest(receipt.PolicyDigest, receipt.PolicyDigest, "article_property_policy_digest_invalid");
        ValidateDigest(receipt.FlagsDigest, receipt.FlagsDigest, "article_property_flags_digest_invalid");
        ValidateDigest(receipt.AuditDigest, receipt.AuditDigest, "article_property_audit_digest_invalid");
        ValidateDigest(receipt.ContentDigest, ComputeReceiptDigest(receipt), "article_property_receipt_digest_invalid");
        foreach (ArticlePropertyDefinitionObligation obligation in receipt.Obligations)
        {
            if (string.IsNullOrWhiteSpace(obligation.Kind)
                || string.IsNullOrWhiteSpace(obligation.ReasonCode)
                || obligation.AffectedValueCount is < 0)
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_obligation_invalid");
            }
        }
    }

    private static ArticlePropertyOperatorDescriptor Descriptor(
        string id,
        bool acceptsValue,
        params ArticlePropertyValueType[] valueTypes)
        => new(
            id,
            new HashSet<ArticlePropertyValueType>(valueTypes),
            valueTypes.Any(static type => type is ArticlePropertyValueType.MultiSelect or ArticlePropertyValueType.ArticleReference)
                ? ArticlePropertyCardinality.Multiple
                : ArticlePropertyCardinality.Single,
            acceptsValue,
            "article-property-definition",
            "author-search-property-projection");

    private static void ValidatePresence(
        ArticlePropertyPresencePolicy presence,
        bool required,
        ArticlePropertyDefaultValue? defaultValue)
    {
        if (presence is null)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_presence_policy_invalid");
        }
        if (!Enum.IsDefined(presence.Missing)
            || !Enum.IsDefined(presence.Null)
            || !Enum.IsDefined(presence.Empty))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_presence_policy_invalid");
        }
        if (presence.Missing == ArticlePropertyMissingBehavior.ApplyDefault
            && (defaultValue is null || defaultValue.Kind == ArticlePropertyDefaultKind.None))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_default_required");
        }
        if (required && presence.Null != ArticlePropertyNullBehavior.RejectNull)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_required_null_policy_invalid");
        }
    }

    private static void ValidateConstraints(
        ArticlePropertyValueType valueType,
        ArticlePropertyCardinality cardinality,
        ArticlePropertyConstraints constraints)
    {
        ArgumentNullException.ThrowIfNull(constraints);
        if (constraints.MinLength is < 0 or > MaxStringConstraintLength
            || constraints.MaxLength is < 0 or > MaxStringConstraintLength
            || constraints.MinLength > constraints.MaxLength
            || constraints.MinItems is < 0 or > MaxOptionsPerDefinition
            || constraints.MaxItems is < 0 or > MaxOptionsPerDefinition
            || constraints.MinItems > constraints.MaxItems)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_constraints_invalid");
        }
        if (constraints.MinNumber > constraints.MaxNumber
            || constraints.MinDateUtc > constraints.MaxDateUtc)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_constraints_range_invalid");
        }
        if (constraints.MinLength.HasValue || constraints.MaxLength.HasValue)
        {
            if (valueType != ArticlePropertyValueType.Text)
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_text_constraints_type_mismatch");
            }
        }
        if (constraints.MinNumber.HasValue || constraints.MaxNumber.HasValue)
        {
            if (valueType != ArticlePropertyValueType.Number)
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_number_constraints_type_mismatch");
            }
        }
        if (constraints.MinDateUtc.HasValue || constraints.MaxDateUtc.HasValue)
        {
            if (valueType != ArticlePropertyValueType.Date
                || constraints.MinDateUtc is { Kind: not DateTimeKind.Utc }
                || constraints.MaxDateUtc is { Kind: not DateTimeKind.Utc })
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_date_constraints_type_mismatch");
            }
        }
        if (constraints.MinItems.HasValue || constraints.MaxItems.HasValue)
        {
            if (valueType is not (ArticlePropertyValueType.MultiSelect or ArticlePropertyValueType.ArticleReference)
                || cardinality != ArticlePropertyCardinality.Multiple)
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_item_constraints_type_mismatch");
            }
        }
    }

    private static void ValidateCardinality(
        ArticlePropertyValueType valueType,
        ArticlePropertyCardinality cardinality)
    {
        ArticlePropertyCardinality expected = valueType switch
        {
            ArticlePropertyValueType.MultiSelect => ArticlePropertyCardinality.Multiple,
            ArticlePropertyValueType.ArticleReference => cardinality,
            _ => ArticlePropertyCardinality.Single
        };
        if (valueType != ArticlePropertyValueType.ArticleReference && cardinality != expected)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_cardinality_type_mismatch");
        }
    }

    private static void ValidatePolicies(ArticlePropertyDefinition definition)
    {
        if (definition.ValueType == ArticlePropertyValueType.ArticleReference)
        {
            ArticlePropertyReferencePolicy policy = definition.ReferencePolicy
                ?? throw new ArticlePropertyDefinitionValidationException("article_property_reference_policy_required");
            if (!Enum.IsDefined(policy.Cardinality)
                || !Enum.IsDefined(policy.Permission)
                || policy.Cardinality != definition.Cardinality)
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_reference_policy_invalid");
            }
        }
        else if (definition.ReferencePolicy is not null)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_reference_policy_type_mismatch");
        }

        if (definition.ValueType == ArticlePropertyValueType.Url)
        {
            ArticlePropertyUrlPolicy policy = definition.UrlPolicy
                ?? throw new ArticlePropertyDefinitionValidationException("article_property_url_policy_required");
            ValidateUrlPolicy(policy);
            ArticlePropertyUrlPolicy normalizedPolicy = NormalizeUrlPolicy(policy);
            if (!normalizedPolicy.AllowedSchemes.SequenceEqual(policy.AllowedSchemes))
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_url_policy_not_canonical");
            }
        }
        else if (definition.UrlPolicy is not null)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_url_policy_type_mismatch");
        }
    }

    private static void ValidateDefault(ArticlePropertyDefinition definition)
    {
        ArticlePropertyDefaultValue? value = definition.DefaultValue;
        ValidateDefaultPayloadShape(value);
        if (value is not null && (value.OptionIds is null || value.ArticleIds is null))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_default_invalid");
        }
        if (value is null || value.Kind == ArticlePropertyDefaultKind.None)
        {
            if (value is not null && (value.Scalar is not null || value.OptionIds.Count != 0 || value.ArticleIds.Count != 0))
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_default_invalid");
            }
            return;
        }
        if (!Enum.IsDefined(value.Kind))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_default_kind_unknown");
        }
        if (value.Kind == ArticlePropertyDefaultKind.Null)
        {
            if (definition.Required
                || definition.Presence.Null == ArticlePropertyNullBehavior.RejectNull
                || value.Scalar is not null
                || value.OptionIds.Count != 0
                || value.ArticleIds.Count != 0)
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_default_null_invalid");
            }
            return;
        }

        bool empty = value.Kind switch
        {
            ArticlePropertyDefaultKind.Scalar => value.Scalar == string.Empty,
            ArticlePropertyDefaultKind.OptionIds => value.OptionIds.Count == 0,
            ArticlePropertyDefaultKind.ArticleIds => value.ArticleIds.Count == 0,
            _ => false
        };
        if (empty && (definition.Presence.Empty == ArticlePropertyEmptyBehavior.RejectEmpty
            || (definition.Presence.Empty == ArticlePropertyEmptyBehavior.TreatAsNull
                && definition.Presence.Null == ArticlePropertyNullBehavior.RejectNull)))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_default_empty_invalid");
        }

        switch (definition.ValueType)
        {
            case ArticlePropertyValueType.Text:
            case ArticlePropertyValueType.Number:
            case ArticlePropertyValueType.Boolean:
            case ArticlePropertyValueType.Date:
                if (value.Kind != ArticlePropertyDefaultKind.Scalar
                    || value.Scalar is null
                    || NormalizeScalar(definition.ValueType, value.Scalar) != value.Scalar)
                {
                    throw new ArticlePropertyDefinitionValidationException("article_property_default_scalar_invalid");
                }
                break;
            case ArticlePropertyValueType.Url:
                if (value.Kind != ArticlePropertyDefaultKind.Scalar
                    || value.Scalar is null
                    || NormalizeUrl(value.Scalar, definition.UrlPolicy!) != value.Scalar)
                {
                    throw new ArticlePropertyDefinitionValidationException("article_property_default_url_invalid");
                }
                break;
            case ArticlePropertyValueType.SingleSelect:
                ValidateDefaultOptionIds(value, definition, 1, 1);
                break;
            case ArticlePropertyValueType.MultiSelect:
                ValidateDefaultOptionIds(value, definition, 0, MaxOptionsPerDefinition);
                break;
            case ArticlePropertyValueType.ArticleReference:
                if (value.Kind != ArticlePropertyDefaultKind.ArticleIds
                    || value.ArticleIds.Count < (definition.Cardinality == ArticlePropertyCardinality.Single ? 1 : 1)
                    || value.ArticleIds.Count > (definition.Cardinality == ArticlePropertyCardinality.Single ? 1 : MaxReferenceIdsPerDefault)
                    || value.ArticleIds.Any(static id => id <= 0)
                    || value.ArticleIds.Distinct().Count() != value.ArticleIds.Count
                    || !value.ArticleIds.SequenceEqual(value.ArticleIds.Order()))
                {
                    throw new ArticlePropertyDefinitionValidationException("article_property_default_reference_invalid");
                }
                break;
            default:
                throw new ArticlePropertyDefinitionValidationException("article_property_type_unknown");
        }

        ValidateDefaultConstraints(definition, value);
    }

    private static void ValidateDefaultOptionIds(
        ArticlePropertyDefaultValue value,
        ArticlePropertyDefinition definition,
        int min,
        int max)
    {
        if (value.Kind != ArticlePropertyDefaultKind.OptionIds
            || value.OptionIds.Count < min
            || value.OptionIds.Count > max
            || value.OptionIds.Any(static id => id == Guid.Empty)
            || value.OptionIds.Distinct().Count() != value.OptionIds.Count
            || !value.OptionIds.SequenceEqual(value.OptionIds.Order()))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_default_options_invalid");
        }
        var activeOptions = definition.Options
            .Where(static option => option.Status != ArticlePropertyOptionStatus.Deleted)
            .Select(static option => option.OptionId)
            .ToHashSet();
        if (value.OptionIds.Any(optionId => !activeOptions.Contains(optionId)))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_default_option_unknown");
        }
    }

    private static void ValidateDefaultConstraints(
        ArticlePropertyDefinition definition,
        ArticlePropertyDefaultValue value)
    {
        ArticlePropertyConstraints constraints = definition.Constraints;
        switch (definition.ValueType)
        {
            case ArticlePropertyValueType.Text:
                int length = value.Scalar!.Length;
                if (constraints.MinLength is not null && length < constraints.MinLength
                    || constraints.MaxLength is not null && length > constraints.MaxLength)
                {
                    throw new ArticlePropertyDefinitionValidationException(
                        "article_property_default_constraint_violation");
                }
                break;
            case ArticlePropertyValueType.Number:
                if (!decimal.TryParse(
                        value.Scalar,
                        NumberStyles.Number,
                        CultureInfo.InvariantCulture,
                        out decimal number)
                    || constraints.MinNumber is not null && number < constraints.MinNumber
                    || constraints.MaxNumber is not null && number > constraints.MaxNumber)
                {
                    throw new ArticlePropertyDefinitionValidationException(
                        "article_property_default_constraint_violation");
                }
                break;
            case ArticlePropertyValueType.Date:
                if (!DateTimeOffset.TryParse(
                        value.Scalar,
                        CultureInfo.InvariantCulture,
                        DateTimeStyles.RoundtripKind,
                        out DateTimeOffset date)
                    || constraints.MinDateUtc is not null && date.UtcDateTime < constraints.MinDateUtc
                    || constraints.MaxDateUtc is not null && date.UtcDateTime > constraints.MaxDateUtc)
                {
                    throw new ArticlePropertyDefinitionValidationException(
                        "article_property_default_constraint_violation");
                }
                break;
            case ArticlePropertyValueType.MultiSelect:
            case ArticlePropertyValueType.ArticleReference:
                int count = definition.ValueType == ArticlePropertyValueType.MultiSelect
                    ? value.OptionIds.Count
                    : value.ArticleIds.Count;
                if (constraints.MinItems is not null && count < constraints.MinItems
                    || constraints.MaxItems is not null && count > constraints.MaxItems)
                {
                    throw new ArticlePropertyDefinitionValidationException(
                        "article_property_default_constraint_violation");
                }
                break;
        }
    }

    private static void ValidateUrlPolicy(ArticlePropertyUrlPolicy policy)
    {
        if (policy is null)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_url_policy_invalid");
        }
        if (!Enum.IsDefined(policy.Normalization)
            || policy.MaxLength is < 1 or > MaxUrlLength
            || policy.AllowedSchemes is null
            || policy.AllowedSchemes.Count > MaxAllowedSchemes
            || (!policy.AllowRelative && !policy.AllowAbsolute))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_url_policy_invalid");
        }
        var schemes = new HashSet<string>(StringComparer.Ordinal);
        foreach (string scheme in policy.AllowedSchemes)
        {
            if (scheme is null)
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_url_scheme_invalid");
            }
            string normalized = scheme.Trim().ToLowerInvariant();
            if (!Uri.CheckSchemeName(normalized)
                || !schemes.Add(normalized)
                || normalized is "javascript" or "data" or "file" or "vbscript" or "blob")
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_url_scheme_invalid");
            }
        }
        if (policy.AllowAbsolute && policy.AllowedSchemes.Count == 0)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_url_scheme_required");
        }
    }

    public static int ComputeDefinitionBytes(ArticlePropertyDefinition definition)
    {
        ArgumentNullException.ThrowIfNull(definition);
        long bytes = 0;
        AddBytes(ref bytes, definition.MachineKey);
        AddBytes(ref bytes, definition.DisplayNames);
        AddBytes(ref bytes, definition.DefaultValue?.Scalar);
        AddBytes(ref bytes, definition.DefaultValue?.OptionIds);
        AddBytes(ref bytes, definition.DefaultValue?.ArticleIds);
        AddBytes(ref bytes, definition.Constraints.MinLength);
        AddBytes(ref bytes, definition.Constraints.MaxLength);
        AddBytes(ref bytes, definition.Constraints.MinNumber);
        AddBytes(ref bytes, definition.Constraints.MaxNumber);
        AddBytes(ref bytes, definition.Constraints.MinDateUtc);
        AddBytes(ref bytes, definition.Constraints.MaxDateUtc);
        AddBytes(ref bytes, definition.Constraints.MinItems);
        AddBytes(ref bytes, definition.Constraints.MaxItems);
        AddBytes(ref bytes, definition.ReferencePolicy?.Permission);
        AddBytes(ref bytes, definition.ReferencePolicy?.AllowCrossSite);
        AddBytes(ref bytes, definition.ReferencePolicy?.AllowDeleted);
        AddBytes(ref bytes, definition.ReferencePolicy?.AllowArchived);
        AddBytes(ref bytes, definition.ReferencePolicy?.AllowSelfReference);
        AddBytes(ref bytes, definition.ReferencePolicy?.AllowCycles);
        AddBytes(ref bytes, definition.UrlPolicy?.AllowedSchemes);
        AddBytes(ref bytes, definition.UrlPolicy?.MaxLength);
        AddBytes(ref bytes, definition.UrlPolicy?.AllowRelative);
        AddBytes(ref bytes, definition.UrlPolicy?.AllowAbsolute);
        foreach (ArticlePropertyOption option in definition.Options)
        {
            AddBytes(ref bytes, option.Label);
            AddBytes(ref bytes, option.Order);
            AddBytes(ref bytes, option.LocalizedLabels);
        }

        return checked((int)Math.Min(bytes, int.MaxValue));
    }

    private static ArticlePropertyUrlPolicy NormalizeUrlPolicy(ArticlePropertyUrlPolicy policy)
        => policy with
        {
            AllowedSchemes = policy.AllowedSchemes
                .Select(static scheme => scheme.Trim().ToLowerInvariant())
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal)
                .ToArray()
        };

    private static void ValidateLocalizedLabels(IReadOnlyList<ArticlePropertyLocalizedName> labels)
    {
        if (labels is null)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_option_labels_invalid");
        }
        if (labels.Count > MaxDisplayNames)
        {
            throw new ArticlePropertyDefinitionBudgetExceededException("article_property_option_labels_budget_exceeded");
        }
        var locales = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (ArticlePropertyLocalizedName label in labels)
        {
            ArgumentNullException.ThrowIfNull(label);
            string locale = NormalizeLocale(label.Locale);
            string value = NormalizeText(label.Value, MaxLocalizedLabelLength, "article_property_option_label_invalid");
            if (!locales.Add(locale)
                || !string.Equals(locale, label.Locale, StringComparison.Ordinal)
                || !string.Equals(value, label.Value, StringComparison.Ordinal))
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_option_labels_invalid");
            }
        }
    }

    private static string NormalizeLocale(string locale)
    {
        if (string.IsNullOrWhiteSpace(locale) || locale.Length > MaxLocaleLength)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_locale_invalid");
        }
        string normalized = locale.Trim().Replace('_', '-').ToLowerInvariant();
        try
        {
            _ = CultureInfo.GetCultureInfo(normalized);
        }
        catch (CultureNotFoundException)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_locale_invalid");
        }
        return normalized;
    }

    private static string NormalizeText(string value, int maxLength, string code)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArticlePropertyDefinitionValidationException(code);
        }
        string normalized = value.Trim().Normalize(NormalizationForm.FormC);
        if (normalized.Length > maxLength || normalized.Any(char.IsControl))
        {
            throw new ArticlePropertyDefinitionValidationException(code);
        }
        return normalized;
    }

    private static void ValidateText(string value, int maxLength, string code)
        => _ = NormalizeText(value, maxLength, code);

    private static void ValidateSchemaBytes(ArticlePropertyDefinition definition)
    {
        if (ComputeDefinitionBytes(definition) > MaxSchemaBytes)
        {
            throw new ArticlePropertyDefinitionBudgetExceededException("article_property_schema_bytes_exceeded");
        }
    }

    public static void ValidateCommandPayloadShape(
        ArticlePropertyPresencePolicy presence,
        ArticlePropertyDefaultValue? defaultValue,
        ArticlePropertyConstraints constraints,
        IReadOnlyList<ArticlePropertyOption> options,
        ArticlePropertyUrlPolicy? urlPolicy)
    {
        if (presence is null
            || constraints is null
            || options is null
            || (defaultValue is not null
                && (defaultValue.OptionIds is null || defaultValue.ArticleIds is null))
            || (urlPolicy is not null && urlPolicy.AllowedSchemes is null))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_definition_shape_invalid");
        }
        if (options.Count > MaxOptionsPerDefinition)
        {
            throw new ArticlePropertyDefinitionBudgetExceededException("article_property_options_budget_exceeded");
        }
        ValidateDefaultPayloadShape(defaultValue);
    }

    private static void ValidateDefaultPayloadShape(ArticlePropertyDefaultValue? value)
    {
        if (value is null)
        {
            return;
        }
        if (value.OptionIds is null || value.ArticleIds is null)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_default_invalid");
        }
        bool valid = value.Kind switch
        {
            ArticlePropertyDefaultKind.None or ArticlePropertyDefaultKind.Null =>
                value.Scalar is null && value.OptionIds.Count == 0 && value.ArticleIds.Count == 0,
            ArticlePropertyDefaultKind.Scalar =>
                value.Scalar is not null && value.OptionIds.Count == 0 && value.ArticleIds.Count == 0,
            ArticlePropertyDefaultKind.OptionIds =>
                value.Scalar is null && value.ArticleIds.Count == 0,
            ArticlePropertyDefaultKind.ArticleIds =>
                value.Scalar is null && value.OptionIds.Count == 0,
            _ => false
        };
        if (!valid)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_default_invalid");
        }
        if (value.OptionIds.Count > MaxOptionsPerDefinition || value.ArticleIds.Count > MaxReferenceIdsPerDefault)
        {
            throw new ArticlePropertyDefinitionBudgetExceededException("article_property_default_budget_exceeded");
        }
    }

    private static void AddBytes(ref long total, string? value)
    {
        if (value is not null)
        {
            total += Encoding.UTF8.GetByteCount(value) + 4;
        }
    }

    private static void AddBytes(ref long total, IEnumerable<ArticlePropertyLocalizedName>? values)
    {
        if (values is null)
        {
            return;
        }
        foreach (ArticlePropertyLocalizedName value in values)
        {
            AddBytes(ref total, value.Locale);
            AddBytes(ref total, value.Value);
        }
    }

    private static void AddBytes(ref long total, IEnumerable<Guid>? values)
    {
        if (values is not null)
        {
            total += values.Count() * 20L;
        }
    }

    private static void AddBytes(ref long total, IEnumerable<long>? values)
    {
        if (values is not null)
        {
            total += values.Count() * 12L;
        }
    }

    private static void AddBytes(ref long total, IReadOnlyList<string>? values)
    {
        if (values is not null)
        {
            foreach (string value in values)
            {
                AddBytes(ref total, value);
            }
        }
    }

    private static void AddBytes(ref long total, object? value)
    {
        if (value is not null)
        {
            total += 12;
        }
    }

    private static void ValidateUtcTimeline(DateTime createdAtUtc, DateTime updatedAtUtc)
    {
        if (createdAtUtc.Kind != DateTimeKind.Utc
            || updatedAtUtc.Kind != DateTimeKind.Utc
            || updatedAtUtc < createdAtUtc)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_timestamp_invalid");
        }
    }

    private static string ComputeDigest(params object?[] values)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Span<byte> length = stackalloc byte[4];
        foreach (object? value in values)
        {
            byte[] bytes = value switch
            {
                null => [],
                byte[] raw => raw,
                Guid guid => guid.ToByteArray(),
                DateTime dateTime => Encoding.UTF8.GetBytes(dateTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture)),
                DateTimeOffset dateTimeOffset => Encoding.UTF8.GetBytes(dateTimeOffset.UtcTicks.ToString(CultureInfo.InvariantCulture)),
                IFormattable formattable => Encoding.UTF8.GetBytes(formattable.ToString(null, CultureInfo.InvariantCulture) ?? string.Empty),
                _ => Encoding.UTF8.GetBytes(value.ToString() ?? string.Empty)
            };
            System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(length, bytes.Length);
            hash.AppendData(length);
            hash.AppendData(bytes);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static void ValidateDigest(string actual, string expected, string code)
    {
        if (actual is null
            || expected is null
            || actual.Length != 64
            || actual.Any(static character => !Uri.IsHexDigit(character) || char.IsUpper(character))
            || !CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(actual),
                Encoding.ASCII.GetBytes(expected)))
        {
            throw new ArticlePropertyDefinitionValidationException(code);
        }
    }
}
