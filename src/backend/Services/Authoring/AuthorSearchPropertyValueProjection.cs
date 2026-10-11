using System.Globalization;

using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Pure, definition-bound value projection/comparison. No index, source reader, query execution,
/// authorization, reference resolution, facet, sort, tokenizer or persistence authority lives here.
/// </summary>
public static class AuthorSearchPropertyValueProjection
{
    /// <summary>
    /// Retains already normalized presence/default provenance and definition flags. Never applies
    /// a default or silently converts a value. The caller still needs the actual article/value,
    /// permission, reference, source, generation and lifecycle authorities before querying.
    /// </summary>
    public static AuthorSearchProjectedPropertyValue Project(
        ArticlePropertyDefinition definition,
        ArticlePropertyValueEntry entry)
    {
        ValidateEntry(definition, entry);
        return new(AuthorFullTextSearchContract.QuerySchema, AuthorFullTextSearchContract.TokenizerVersion,
            definition.ValueType, definition.SearchEligible, definition.Filterable, definition.Sortable, entry);
    }

    /// <summary>
    /// Compares only supplied values. Missing/null scalar comparisons refuse explicitly; presence
    /// operators test the exact Presence variant. Between boundaries, text collation, URL host/scheme
    /// operand syntax and collection equals are not defined by the current operator authority.
    /// Those operations refuse instead of inventing semantics. This method never admits a query.
    /// </summary>
    public static bool Matches(
        ArticlePropertyDefinition definition,
        AuthorSearchProjectedPropertyValue projection,
        AuthorSearchPropertyOperand operand)
    {
        ArgumentNullException.ThrowIfNull(projection);
        AuthorFullTextSearchContract.ValidatePropertyOperand(operand, definition);
        ValidateEntry(definition, projection.Entry);
        Require(projection.QuerySchema == AuthorFullTextSearchContract.QuerySchema
            && projection.TokenizerVersion == AuthorFullTextSearchContract.TokenizerVersion
            && projection.ValueType == definition.ValueType
            && projection.SearchEligible == definition.SearchEligible
            && projection.Filterable == definition.Filterable
            && projection.Sortable == definition.Sortable,
            "author_search_property_projection_stale");
        ArticlePropertyValueEntry entry = projection.Entry;
        if (operand.OperatorId == "value.is-missing")
        {
            return entry.Presence == ArticlePropertyValuePresence.Missing;
        }
        if (operand.OperatorId == "value.is-present")
        {
            return entry.Presence == ArticlePropertyValuePresence.Present;
        }
        Require(entry.Presence == ArticlePropertyValuePresence.Present,
            "author_search_property_comparison_value_absent");
        ArticlePropertyTypedValue expected = operand.Values[0];
        return operand.OperatorId switch
        {
            "number.equals" => Number(entry) == ((ArticlePropertyNumberValue)expected).Number,
            "number.less-than" => Number(entry) < ((ArticlePropertyNumberValue)expected).Number,
            "number.less-than-or-equal" => Number(entry) <= ((ArticlePropertyNumberValue)expected).Number,
            "number.greater-than" => Number(entry) > ((ArticlePropertyNumberValue)expected).Number,
            "number.greater-than-or-equal" => Number(entry) >= ((ArticlePropertyNumberValue)expected).Number,
            "date.before" => Date(entry) < ((ArticlePropertyDateValue)expected).Utc,
            "date.on-or-before" => Date(entry) <= ((ArticlePropertyDateValue)expected).Utc,
            "date.after" => Date(entry) > ((ArticlePropertyDateValue)expected).Utc,
            "date.on-or-after" => Date(entry) >= ((ArticlePropertyDateValue)expected).Utc,
            "boolean.equals" => ((ArticlePropertyBooleanValue)entry.Value!).Boolean
                == ((ArticlePropertyBooleanValue)expected).Boolean,
            "select.equals" when entry.Value is ArticlePropertySingleSelectValue single =>
                single.OptionId == ((ArticlePropertySingleSelectValue)expected).OptionId,
            "select.any-of" when entry.Value is ArticlePropertySingleSelectValue single =>
                operand.Values.Any(value => ((ArticlePropertySingleSelectValue)value).OptionId == single.OptionId),
            "select.any-of" => Intersects(((ArticlePropertyMultiSelectValue)entry.Value!).OptionIds,
                ((ArticlePropertyMultiSelectValue)expected).OptionIds),
            "reference.any-of" => Intersects(((ArticlePropertyArticleReferenceValue)entry.Value!).ArticleIds,
                ((ArticlePropertyArticleReferenceValue)expected).ArticleIds),
            "reference.equals" when definition.Cardinality == ArticlePropertyCardinality.Single =>
                ((ArticlePropertyArticleReferenceValue)entry.Value!).ArticleIds[0]
                    == ((ArticlePropertyArticleReferenceValue)expected).ArticleIds[0],
            "url.equals" => string.Equals(((ArticlePropertyUrlValue)entry.Value!).Url,
                ((ArticlePropertyUrlValue)expected).Url, StringComparison.Ordinal),
            _ => throw new AuthorSearchContractException("author_search_property_comparison_semantics_unavailable")
        };
    }

    private static decimal Number(ArticlePropertyValueEntry entry)
        => ((ArticlePropertyNumberValue)entry.Value!).Number;

    private static DateTime Date(ArticlePropertyValueEntry entry)
        => ((ArticlePropertyDateValue)entry.Value!).Utc;

    private static bool Intersects<T>(IReadOnlyList<T> actual, IReadOnlyList<T> expected)
    {
        var identities = expected.ToHashSet();
        return actual.Any(identities.Contains);
    }

    private static void ValidateEntry(ArticlePropertyDefinition definition, ArticlePropertyValueEntry entry)
    {
        ArgumentNullException.ThrowIfNull(definition);
        ArgumentNullException.ThrowIfNull(entry);
        ArticlePropertyDefinitionContract.ValidateDefinition(definition);
        Require(definition.Status == ArticlePropertyDefinitionStatus.Active,
            "author_search_property_definition_inactive");
        Require(entry.DefinitionId == definition.DefinitionId
            && entry.DefinitionSchemaRevision == definition.SchemaRevision
            && entry.DefinitionDigest == definition.ContentDigest,
            "author_search_property_value_definition_stale");
        Require(Enum.IsDefined(entry.Presence)
            && (entry.Presence == ArticlePropertyValuePresence.Present) == (entry.Value is not null)
            && (!entry.DefaultApplied || entry.Presence != ArticlePropertyValuePresence.Missing),
            "author_search_property_value_shape_invalid");
        if (entry.Value is not null)
        {
            ValidateTypedShape(definition, entry.Value);
            ArticlePropertyDefaultValue payload = Payload(entry.Value);
            ArticlePropertyDefinitionContract.ValidateArticleValuePayload(definition, payload);
            bool empty = payload.Kind switch
            {
                ArticlePropertyDefaultKind.Scalar => payload.Scalar == string.Empty,
                ArticlePropertyDefaultKind.OptionIds => payload.OptionIds.Count == 0,
                ArticlePropertyDefaultKind.ArticleIds => payload.ArticleIds.Count == 0,
                _ => false
            };
            Require(!empty || definition.Presence.Empty == ArticlePropertyEmptyBehavior.PreserveEmpty,
                "author_search_property_value_not_normalized");
        }
        else
        {
            Require(!definition.Required && (entry.Presence != ArticlePropertyValuePresence.Null
                    || definition.Presence.Null == ArticlePropertyNullBehavior.AllowNull)
                && (entry.Presence != ArticlePropertyValuePresence.Missing
                    || definition.Presence.Missing == ArticlePropertyMissingBehavior.PreserveMissing),
                "author_search_property_value_not_normalized");
        }
        if (entry.DefaultApplied)
        {
            Require(definition.Presence.Missing == ArticlePropertyMissingBehavior.ApplyDefault
                && definition.DefaultValue is not null
                && (entry.Value is null ? definition.DefaultValue.Kind == ArticlePropertyDefaultKind.Null
                    : ArticlePropertyDefinitionContract.ComputeDefaultDigest(Payload(entry.Value))
                        == ArticlePropertyDefinitionContract.ComputeDefaultDigest(definition.DefaultValue)),
                "author_search_property_default_origin_invalid");
        }
        var input = new ArticlePropertyValueInput(entry.DefinitionId, entry.DefinitionSchemaRevision,
            entry.DefinitionDigest, entry.Presence, entry.Value);
        Require(entry.ValueDigest == ArticlePropertyValueDigest.ComputeValue(input, entry.DefaultApplied),
            "author_search_property_value_digest_invalid");
    }

    internal static void ValidateTypedShape(ArticlePropertyDefinition definition, ArticlePropertyTypedValue value)
    {
        bool valid = (definition.ValueType, value) switch
        {
            (ArticlePropertyValueType.Text, ArticlePropertyTextValue text) => text.Text is not null
                && text.Text == ArticlePropertyDefinitionContract.NormalizeScalar(definition.ValueType, text.Text),
            (ArticlePropertyValueType.Number, ArticlePropertyNumberValue) => true,
            (ArticlePropertyValueType.Boolean, ArticlePropertyBooleanValue) => true,
            (ArticlePropertyValueType.Date, ArticlePropertyDateValue date) => date.Utc.Kind == DateTimeKind.Utc,
            (ArticlePropertyValueType.SingleSelect, ArticlePropertySingleSelectValue single) =>
                ActiveOption(definition, single.OptionId),
            (ArticlePropertyValueType.MultiSelect, ArticlePropertyMultiSelectValue multiple) =>
                ValidSet(multiple.OptionIds, ArticlePropertyDefinitionContract.MaxOptionsPerDefinition)
                && multiple.OptionIds.All(id => ActiveOption(definition, id)),
            (ArticlePropertyValueType.ArticleReference, ArticlePropertyArticleReferenceValue references) =>
                ValidSet(references.ArticleIds, ArticlePropertyDefinitionContract.MaxReferenceIdsPerDefault)
                && references.ArticleIds.All(static id => id > 0)
                && (definition.Cardinality == ArticlePropertyCardinality.Multiple || references.ArticleIds.Count == 1),
            (ArticlePropertyValueType.Url, ArticlePropertyUrlValue url) => url.Url is not null
                && url.Url == ArticlePropertyDefinitionContract.NormalizeUrl(url.Url, definition.UrlPolicy!),
            _ => false
        };
        Require(valid, "author_search_property_typed_value_invalid");
    }

    private static bool ActiveOption(ArticlePropertyDefinition definition, Guid identity)
        => identity != Guid.Empty && definition.Options.Any(option => option.OptionId == identity
            && option.Status == ArticlePropertyOptionStatus.Active);

    private static bool ValidSet<T>(IReadOnlyList<T> identities, int limit)
        => identities.Count <= limit && identities.SequenceEqual(identities.Distinct().Order());

    private static ArticlePropertyDefaultValue Payload(ArticlePropertyTypedValue value)
        => value switch
        {
            ArticlePropertyTextValue text => Scalar(text.Text),
            ArticlePropertyNumberValue number => Scalar(number.Number.ToString("0.############################", CultureInfo.InvariantCulture)),
            ArticlePropertyBooleanValue boolean => Scalar(boolean.Boolean ? "true" : "false"),
            ArticlePropertyDateValue date => Scalar(date.Utc.ToString("O", CultureInfo.InvariantCulture)),
            ArticlePropertySingleSelectValue single => new(ArticlePropertyDefaultKind.OptionIds, OptionIds: [single.OptionId]),
            ArticlePropertyMultiSelectValue multiple => new(ArticlePropertyDefaultKind.OptionIds, OptionIds: multiple.OptionIds),
            ArticlePropertyArticleReferenceValue references => new(ArticlePropertyDefaultKind.ArticleIds, ArticleIds: references.ArticleIds),
            ArticlePropertyUrlValue url => Scalar(url.Url),
            _ => throw new AuthorSearchContractException("author_search_property_typed_value_invalid")
        };

    private static ArticlePropertyDefaultValue Scalar(string value)
        => new(ArticlePropertyDefaultKind.Scalar, Scalar: value);

    private static void Require(bool condition, string reason)
    {
        if (!condition)
        {
            throw new AuthorSearchContractException(reason);
        }
    }
}

/// <summary>Pure value candidate; definition flags do not prove query, index or permission eligibility.</summary>
public sealed record AuthorSearchProjectedPropertyValue(
    string QuerySchema,
    string TokenizerVersion,
    ArticlePropertyValueType ValueType,
    bool SearchEligible,
    bool Filterable,
    bool Sortable,
    ArticlePropertyValueEntry Entry);
