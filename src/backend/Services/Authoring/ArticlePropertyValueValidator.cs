using System.Globalization;

using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Read-only typed validation against the existing definition owner. The canonical article writer
/// must revalidate these exact definition coordinates inside its transaction before storing a snapshot.
/// </summary>
public sealed class ArticlePropertyValueValidator(
    IArticlePropertyDefinitionStore definitions,
    IArticlePropertyDefinitionPermissionAuthority permissions,
    IArticlePropertyReferenceValueAuthority references)
{
    public Task<IReadOnlyList<ArticlePropertyValueEntry>> ValidateAsync(
        ArticlePropertyDefinitionActor actor,
        ArticlePropertyDefinitionOwner owner,
        int sourceArticleId,
        IReadOnlyList<ArticlePropertyValueInput> inputs,
        CancellationToken cancellationToken = default)
    {
        if (sourceArticleId <= 0)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_value_source_identity_invalid");
        }
        return ValidateCoreAsync(actor, owner, sourceArticleId, inputs, cancellationToken);
    }

    /// <summary>
    /// Zero-write validation before a new article has an identity. Nonempty references cannot
    /// be accepted here: their canonical source identity/permission/cycle context is unavailable.
    /// </summary>
    public Task<IReadOnlyList<ArticlePropertyValueEntry>> ValidateInputsAsync(
        ArticlePropertyDefinitionActor actor,
        ArticlePropertyDefinitionOwner owner,
        IReadOnlyList<ArticlePropertyValueInput> inputs,
        CancellationToken cancellationToken = default)
        => ValidateCoreAsync(actor, owner, null, inputs, cancellationToken);

    private async Task<IReadOnlyList<ArticlePropertyValueEntry>> ValidateCoreAsync(
        ArticlePropertyDefinitionActor actor,
        ArticlePropertyDefinitionOwner owner,
        int? sourceArticleId,
        IReadOnlyList<ArticlePropertyValueInput> inputs,
        CancellationToken cancellationToken)
    {
        permissions.EnsureAllowed(actor, owner, manage: false);
        ArgumentNullException.ThrowIfNull(inputs);
        if (inputs.Count > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_value_input_invalid");
        }
        ArticlePropertyValueInput[] heldInputs = inputs.Take(ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner + 1).ToArray();
        if (heldInputs.Length > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner
            || heldInputs.Any(static input => input is null || input.DefinitionId == Guid.Empty)
            || heldInputs.Select(static input => input.DefinitionId).Distinct().Count() != heldInputs.Length)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_value_input_invalid");
        }
        cancellationToken.ThrowIfCancellationRequested();
        var result = new List<ArticlePropertyValueEntry>(heldInputs.Length);
        foreach (ArticlePropertyValueInput input in heldInputs.OrderBy(static input => input.DefinitionId))
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticlePropertyDefinition definition = await definitions.GetAsync(actor, owner,
                input.DefinitionId, cancellationToken).ConfigureAwait(false)
                ?? throw new ArticlePropertyDefinitionValidationException("article_property_definition_unavailable");
            cancellationToken.ThrowIfCancellationRequested();
            ArticlePropertyDefinitionContract.ValidateDefinition(definition);
            if (definition.Owner != owner || definition.DefinitionId != input.DefinitionId
                || definition.SchemaRevision != input.DefinitionSchemaRevision
                || !string.Equals(definition.ContentDigest, input.DefinitionDigest, StringComparison.Ordinal)
                || definition.Status != ArticlePropertyDefinitionStatus.Active)
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_definition_stale_or_inactive");
            }
            bool defaultApplied = input.Presence == ArticlePropertyValuePresence.Missing
                && definition.Presence.Missing == ArticlePropertyMissingBehavior.ApplyDefault;
            ArticlePropertyValueInput normalized = Normalize(definition, input);
            if (normalized.Value is ArticlePropertyArticleReferenceValue targets && targets.ArticleIds.Count > 0)
            {
                if (!sourceArticleId.HasValue)
                {
                    throw new ArticlePropertyDefinitionValidationException("article_property_reference_source_identity_unavailable");
                }
                ArticlePropertyReferencePolicy policy = definition.ReferencePolicy!;
                if (!policy.AllowSelfReference && targets.ArticleIds.Contains(sourceArticleId.Value))
                {
                    throw new ArticlePropertyDefinitionValidationException("article_property_reference_rejected");
                }
                await references.RequireAllowedAsync(new ArticlePropertyReferenceValueQuery(actor, owner,
                    sourceArticleId.Value, definition.DefinitionId, definition.SchemaRevision, policy,
                    targets.ArticleIds), cancellationToken).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
            }
            result.Add(new ArticlePropertyValueEntry(normalized.DefinitionId, normalized.DefinitionSchemaRevision,
                normalized.DefinitionDigest, normalized.Presence, normalized.Value,
                ArticlePropertyValueDigest.ComputeValue(normalized, defaultApplied), defaultApplied));
        }
        return result.AsReadOnly();
    }

    /// <summary>Bind observed coordinates to a validated candidate; this method performs no authority writes.</summary>
    public static ArticlePropertyValueSnapshot BindSnapshot(
        ArticlePropertySnapshotCoordinates coordinates,
        IReadOnlyList<ArticlePropertyValueEntry> values)
    {
        ArgumentNullException.ThrowIfNull(coordinates);
        ArgumentNullException.ThrowIfNull(values);
        if (values.Count > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_snapshot_coordinates_invalid");
        }
        ArticlePropertyValueEntry[] heldValues = values.Take(ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner + 1).ToArray();
        ArticlePropertyDefinitionContract.ValidateOwner(new ArticlePropertyDefinitionOwner(
            coordinates.DefinitionOwnerUserId, coordinates.SiteScope));
        if (coordinates.ArticleId <= 0 || coordinates.PropertyRevision <= 0 || coordinates.ArticleRevisionId <= 0
            || coordinates.DraftId.HasValue != coordinates.DraftServerRevision.HasValue
            || coordinates.DraftId is <= 0 || coordinates.DraftServerRevision is <= 0
            || coordinates.PublicationId is <= 0
            || coordinates.DraftId.HasValue && coordinates.PublicationId.HasValue
            || heldValues.Length > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner
            || heldValues.Any(static value => value is null || value.DefinitionId == Guid.Empty
                || value.DefinitionSchemaRevision <= 0 || !Enum.IsDefined(value.Presence)
                || (value.Presence == ArticlePropertyValuePresence.Present) != (value.Value is not null)
                || value.DefaultApplied && value.Presence == ArticlePropertyValuePresence.Missing)
            || !heldValues.Select(static value => value.DefinitionId).SequenceEqual(
                heldValues.Select(static value => value.DefinitionId).Distinct().Order()))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_snapshot_coordinates_invalid");
        }
        foreach (ArticlePropertyValueEntry value in heldValues)
        {
            var input = new ArticlePropertyValueInput(value.DefinitionId, value.DefinitionSchemaRevision,
                value.DefinitionDigest, value.Presence, value.Value);
            if (value.DefinitionDigest is null || value.DefinitionDigest.Length != 64
                || value.DefinitionDigest.Any(static character => character is not (>= 'a' and <= 'f') and not (>= '0' and <= '9'))
                || !string.Equals(value.ValueDigest, ArticlePropertyValueDigest.ComputeValue(input, value.DefaultApplied), StringComparison.Ordinal))
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_value_digest_invalid");
            }
        }
        return new ArticlePropertyValueSnapshot(ArticlePropertyValueSnapshot.CurrentSchemaVersion, coordinates,
            heldValues, ArticlePropertyValueDigest.ComputeSnapshot(coordinates, heldValues));
    }

    /// <summary>Pure schema/coordinate/digest check; it grants no current authorization or durable acceptance.</summary>
    public static void ValidateSnapshotCandidate(ArticlePropertyValueSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        if (snapshot.SchemaVersion != ArticlePropertyValueSnapshot.CurrentSchemaVersion)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_snapshot_schema_invalid");
        }
        ArticlePropertyValueSnapshot canonical = BindSnapshot(snapshot.Coordinates, snapshot.Values);
        if (!string.Equals(snapshot.ContentDigest, canonical.ContentDigest, StringComparison.Ordinal))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_snapshot_digest_invalid");
        }
    }

    private static ArticlePropertyValueInput Normalize(ArticlePropertyDefinition definition, ArticlePropertyValueInput input)
    {
        if (!Enum.IsDefined(input.Presence)
            || (input.Presence == ArticlePropertyValuePresence.Present) != (input.Value is not null))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_value_shape_invalid");
        }
        ArticlePropertyValuePresence presence = input.Presence;
        ArticlePropertyTypedValue? value = input.Value;
        if (presence == ArticlePropertyValuePresence.Missing
            && definition.Presence.Missing == ArticlePropertyMissingBehavior.ApplyDefault)
        {
            ArticlePropertyDefaultValue defaultValue = definition.DefaultValue!;
            presence = defaultValue.Kind == ArticlePropertyDefaultKind.Null
                ? ArticlePropertyValuePresence.Null : ArticlePropertyValuePresence.Present;
            value = presence == ArticlePropertyValuePresence.Present ? FromPayload(definition.ValueType, defaultValue) : null;
        }
        if (presence != ArticlePropertyValuePresence.Present)
        {
            if (definition.Required || presence == ArticlePropertyValuePresence.Null
                && definition.Presence.Null == ArticlePropertyNullBehavior.RejectNull)
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_value_required_or_null_rejected");
            }
            return input with
            {
                Presence = presence,
                Value = null
            };
        }
        ArticlePropertyDefaultValue payload = ToPayload(definition, value!);
        bool empty = payload.Kind switch
        {
            ArticlePropertyDefaultKind.Scalar => payload.Scalar == string.Empty,
            ArticlePropertyDefaultKind.OptionIds => payload.OptionIds.Count == 0,
            ArticlePropertyDefaultKind.ArticleIds => payload.ArticleIds.Count == 0,
            _ => false
        };
        if (empty)
        {
            if (definition.Presence.Empty == ArticlePropertyEmptyBehavior.RejectEmpty)
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_value_empty_rejected");
            }
            if (definition.Presence.Empty == ArticlePropertyEmptyBehavior.TreatAsNull)
            {
                return Normalize(definition, input with
                {
                    Presence = ArticlePropertyValuePresence.Null,
                    Value = null
                });
            }
        }
        ArticlePropertyDefinitionContract.ValidateArticleValuePayload(definition, payload);
        if (payload.OptionIds.Any(id => !definition.Options.Any(option => option.OptionId == id
            && option.Status == ArticlePropertyOptionStatus.Active)))
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_value_option_inactive");
        }
        return input with
        {
            Presence = presence,
            Value = FromPayload(definition.ValueType, payload)
        };
    }

    private static ArticlePropertyDefaultValue ToPayload(ArticlePropertyDefinition definition, ArticlePropertyTypedValue value)
    {
        switch (definition.ValueType, value)
        {
            case (ArticlePropertyValueType.Text, ArticlePropertyTextValue text):
                return Scalar(ArticlePropertyDefinitionContract.NormalizeScalar(definition.ValueType, text.Text));
            case (ArticlePropertyValueType.Number, ArticlePropertyNumberValue number):
                return Scalar(ArticlePropertyDefinitionContract.NormalizeScalar(definition.ValueType,
                    number.Number.ToString(CultureInfo.InvariantCulture)));
            case (ArticlePropertyValueType.Boolean, ArticlePropertyBooleanValue boolean):
                return Scalar(ArticlePropertyDefinitionContract.NormalizeScalar(definition.ValueType,
                    boolean.Boolean ? "true" : "false"));
            case (ArticlePropertyValueType.Date, ArticlePropertyDateValue date) when date.Utc.Kind == DateTimeKind.Utc:
                return Scalar(ArticlePropertyDefinitionContract.NormalizeScalar(definition.ValueType,
                    date.Utc.ToString("O", CultureInfo.InvariantCulture)));
            case (ArticlePropertyValueType.SingleSelect, ArticlePropertySingleSelectValue single):
                return new ArticlePropertyDefaultValue(ArticlePropertyDefaultKind.OptionIds, OptionIds: [single.OptionId]);
            case (ArticlePropertyValueType.MultiSelect, ArticlePropertyMultiSelectValue multiple):
                RequireSet(multiple.OptionIds, ArticlePropertyDefinitionContract.MaxOptionsPerDefinition);
                return new ArticlePropertyDefaultValue(ArticlePropertyDefaultKind.OptionIds, OptionIds: multiple.OptionIds.Order().ToArray());
            case (ArticlePropertyValueType.ArticleReference, ArticlePropertyArticleReferenceValue references):
                RequireSet(references.ArticleIds, ArticlePropertyDefinitionContract.MaxReferenceIdsPerDefault);
                if (references.ArticleIds.Any(static id => id <= 0))
                {
                    throw new ArticlePropertyDefinitionValidationException("article_property_reference_rejected");
                }
                return new ArticlePropertyDefaultValue(ArticlePropertyDefaultKind.ArticleIds, ArticleIds: references.ArticleIds.Order().ToArray());
            case (ArticlePropertyValueType.Url, ArticlePropertyUrlValue url):
                return Scalar(ArticlePropertyDefinitionContract.NormalizeUrl(url.Url, definition.UrlPolicy!));
            default:
                throw new ArticlePropertyDefinitionValidationException("article_property_value_type_mismatch");
        }
    }

    private static ArticlePropertyDefaultValue Scalar(string scalar)
        => new(ArticlePropertyDefaultKind.Scalar, Scalar: scalar);

    private static void RequireSet<T>(IReadOnlyList<T> items, int limit)
    {
        if (items.Count > limit || items.Distinct().Count() != items.Count)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_value_set_invalid");
        }
    }

    private static ArticlePropertyTypedValue FromPayload(ArticlePropertyValueType type, ArticlePropertyDefaultValue value)
        => type switch
        {
            ArticlePropertyValueType.Text => new ArticlePropertyTextValue(value.Scalar!),
            ArticlePropertyValueType.Number => new ArticlePropertyNumberValue(decimal.Parse(value.Scalar!, CultureInfo.InvariantCulture)),
            ArticlePropertyValueType.Boolean => new ArticlePropertyBooleanValue(bool.Parse(value.Scalar!)),
            ArticlePropertyValueType.Date => new ArticlePropertyDateValue(DateTime.Parse(value.Scalar!,
                CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind)),
            ArticlePropertyValueType.SingleSelect => new ArticlePropertySingleSelectValue(value.OptionIds.Single()),
            ArticlePropertyValueType.MultiSelect => new ArticlePropertyMultiSelectValue(value.OptionIds),
            ArticlePropertyValueType.ArticleReference => new ArticlePropertyArticleReferenceValue(value.ArticleIds),
            ArticlePropertyValueType.Url => new ArticlePropertyUrlValue(value.Scalar!),
            _ => throw new ArticlePropertyDefinitionValidationException("article_property_value_type_mismatch")
        };
}
