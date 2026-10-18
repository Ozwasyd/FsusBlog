using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;

using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Consumes the original value snapshot/projection contracts. It does not read a DB,
/// create values, normalize defaults, serialize scalar fields or grant authorization.
/// The canonical adapter must supply coherent source, permission and parse facts.
/// </summary>
internal static class AuthorSearchIndexPropertyBinding
{
    internal static AuthorSearchIndexedArticle Project(
        AuthorSearchIndexArticleSource source, ImmutableArray<AuthorSearchTokenizedDocument> documents,
        int userId, string siteScope)
    {
        var article = new AuthorSearchIndexedArticle(source.ArticleId, source.SourceSequence, source.Deleted, documents);
        ArticlePropertyValueSnapshot? snapshot = source.PropertyValues;
        if (snapshot is null)
        {
            Require(source.Fields.All(static field => field.Document.Field.Kind != AuthorSearchFieldKind.Property
                && field.Document.Field.DefinitionDigest is null
                && field.Document.Field.PropertyValueDigest is null), "author_search_property_snapshot_unavailable");
            return article;
        }
        ArticlePropertySnapshotCoordinates coordinates = snapshot.Coordinates;
        Require(!source.Deleted && snapshot.SchemaVersion == ArticlePropertyValueSnapshot.CurrentSchemaVersion
            && coordinates.ArticleId == source.ArticleId && coordinates.SiteScope == siteScope
            && (coordinates.DefinitionOwnerUserId is null || coordinates.DefinitionOwnerUserId == userId)
            && coordinates.PropertyRevision > 0 && coordinates.ArticleRevisionId > 0
            && coordinates.DraftId is null && coordinates.DraftServerRevision is null
            && coordinates.PublicationId is not <= 0
            && documents.All(document => document.Document.Identity.CurrentRevision == coordinates.ArticleRevisionId)
            && snapshot.Values.Count <= ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner,
            "author_search_property_snapshot_scope_invalid");
        Require(snapshot.ContentDigest == ArticlePropertyValueDigest.ComputeSnapshot(coordinates, snapshot.Values),
            "author_search_property_snapshot_digest_invalid");
        var held = ImmutableSortedDictionary.CreateBuilder<Guid, AuthorSearchProjectedPropertyValue>();
        var seen = new HashSet<Guid>();
        foreach (ArticlePropertyValueEntry entry in snapshot.Values)
        {
            Require(entry is not null && seen.Add(entry.DefinitionId), "author_search_property_entry_duplicate_or_invalid");
            Require(source.Definitions.TryGetValue(entry.DefinitionId, out ArticlePropertyDefinition? definition)
                && definition is not null && definition.DefinitionId == entry.DefinitionId
                && definition.Owner.UserId == coordinates.DefinitionOwnerUserId
                && definition.Owner.SiteScope == coordinates.SiteScope, "author_search_property_definition_scope_invalid");
            AuthorSearchProjectedPropertyValue projection = AuthorSearchPropertyValueProjection.Project(definition, entry);
            if (!definition.SearchEligible)
            {
                continue;
            }
            // The original current-value reader reports nonempty references as
            // ReferenceAuthorityUnavailable. No alternate target authority is made here.
            Require(entry.Value is not ArticlePropertyArticleReferenceValue references || references.ArticleIds.Count == 0,
                "author_search_property_reference_authority_unavailable");
            held.Add(entry.DefinitionId, projection);
        }
        foreach (AuthorSearchIndexFieldSource field in source.Fields.Where(static field =>
            field.Document.Field.Kind == AuthorSearchFieldKind.Property))
        {
            AuthorSearchFieldReference identity = field.Document.Field;
            if (!identity.PropertyDefinitionId.HasValue
                || !held.TryGetValue(identity.PropertyDefinitionId.Value, out AuthorSearchProjectedPropertyValue? value))
            {
                throw new AuthorSearchContractException("author_search_property_field_binding_invalid");
            }
            Require(identity.DefinitionSchemaRevision == value.Entry.DefinitionSchemaRevision
                && identity.DefinitionDigest == value.Entry.DefinitionDigest
                && identity.PropertyValueDigest == value.Entry.ValueDigest
                && identity.PropertyValueType == value.ValueType
                && value.Entry.Presence == ArticlePropertyValuePresence.Present,
                "author_search_property_field_binding_invalid");
            // Only the original canonical string payloads already define their raw
            // field text. Numeric/date/select/reference formatting is not an API.
            string? raw = value.Entry.Value switch
            {
                ArticlePropertyTextValue text => text.Text,
                ArticlePropertyUrlValue url => url.Url,
                _ => null
            };
            Require(raw is not null && raw == field.RawSource,
                "author_search_property_field_serialization_unavailable");
        }
        return article with
        {
            PropertyValues = held.ToImmutable(),
            PropertyCoordinates = coordinates,
            PropertySnapshotDigest = snapshot.ContentDigest
        };
    }

    internal static long SourceCharacters(ArticlePropertyValueSnapshot? snapshot)
    {
        if (snapshot is null)
        {
            return 0;
        }
        Require(snapshot.Values.Count <= ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner,
            "author_search_property_snapshot_scope_invalid");
        return snapshot.Values.Sum(static entry => Characters(entry.Value));
    }

    internal static long StoredCharacters(IEnumerable<AuthorSearchProjectedPropertyValue> values)
        => values.Sum(static value => Characters(value.Entry.Value));

    private static long Characters(ArticlePropertyTypedValue? value)
        => value switch
        {
            ArticlePropertyTextValue text => text.Text.Length,
            ArticlePropertyUrlValue url => url.Url.Length,
            ArticlePropertyMultiSelectValue multiple => multiple.OptionIds.Count * 16L,
            ArticlePropertyArticleReferenceValue references => references.ArticleIds.Count * 8L,
            _ => 32
        };

    private static void Require([DoesNotReturnIf(false)] bool condition, string reason)
    {
        if (!condition)
        {
            throw new AuthorSearchContractException(reason);
        }
    }
}
