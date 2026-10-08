using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Closed projection of existing authorized DTOs, never a JSON blob diff or snapshot store.
/// Responsibility authors and sources are ordered lists; their display names are values,
/// not invented stable entity IDs. Private-source values are marked sensitive.
/// </summary>
internal static class RevisionMetadataSnapshotProjection
{
    private static readonly JsonSerializerOptions s_json = new()
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    private const string DraftRightsProperties = "Mode Enabled LicenseType CopyrightHolder CopyrightYear RightsStatement AttributionTemplate CopyPolicy MaxExcerptChars AllowCodeCopy ShowPublicBadge ProofBindingEnabled";
    private const string RightsProperties = "Id Enabled LicenseType CopyrightHolder CopyrightYear RightsStatement AttributionTemplate CopyPolicy MaxExcerptChars AllowCodeCopy ShowPublicBadge ProofBindingEnabled PolicyHash ContentCanonicalHash CreatedAt";
    private const string ResponsibilityProperties = "Id ResponsibilityVersion PreviousSnapshotId InheritSiteAuthor Authors Reviewer Sources UpdateSummary UpdateReason EffectiveAt ConclusionImpact Methodology Applicability Limitations ResponsiblePersonConfirmed CreatedAt";
    private const string ReleaseProperties = "Id PublicationNo TransitionKind PublishedAt";
    private const string PersonProperties = "Name ProfileUrl";
    private const string SourceProperties = "Title Url SourceType AccessedOn Version CitationNote IsPublic";

    internal static void Project(RevisionComparePackage package,
        SortedDictionary<string, ProjectedMetadataField> fields, CancellationToken token)
    {
        foreach (RevisionCompareSnapshot snapshot in package.Snapshots.OrderBy(static item => item.Kind))
        {
            token.ThrowIfCancellationRequested();
            string prefix = snapshot.Kind switch
            {
                RevisionCompareSnapshotKind.Rights => "rights",
                RevisionCompareSnapshotKind.Responsibility => "responsibility",
                RevisionCompareSnapshotKind.Release => "release",
                _ => throw Invalid()
            };
            Add(fields, prefix + ".state", new(RevisionMetadataDiffValueKind.Integer, Number: (int)snapshot.State));
            if (snapshot.State == RevisionCompareSnapshotState.Missing)
                throw Invalid();
            if (snapshot.State == RevisionCompareSnapshotState.NotApplicable)
            {
                Add(fields, prefix + ".identity", new(RevisionMetadataDiffValueKind.NotApplicable));
                continue;
            }
            if (snapshot.Payload.Length > 1_048_576 || snapshot.SchemaVersion <= 0)
                throw new MetadataDiffRefusal(RevisionMetadataDiffStatus.BudgetExceeded, "metadata_diff_snapshot_budget");
            using JsonDocument document = JsonDocument.Parse(snapshot.Payload.ToArray(), new JsonDocumentOptions { MaxDepth = 16 });
            CheckDuplicates(document.RootElement, token);
            switch (snapshot.Kind)
            {
                case RevisionCompareSnapshotKind.Rights when package.SourceKind == RevisionCompareSourceKind.CurrentDraft:
                    if (snapshot.SchemaVersion != 1)
                        throw Invalid();
                    // A null draft rights input is explicitly unobserved; production
                    // normalizer defaults are not authority for this comparison.
                    if (document.RootElement.ValueKind == JsonValueKind.Null)
                    {
                        Add(fields, "rights.identity", new(RevisionMetadataDiffValueKind.NotObserved));
                        break;
                    }
                    CheckClosed(document.RootElement, DraftRightsProperties);
                    ArticleRightsRequest draft = document.Deserialize<ArticleRightsRequest>(s_json) ?? throw Invalid();
                    Rights(fields, draft.Enabled, draft.LicenseType, draft.CopyrightHolder, draft.CopyrightYear,
                        draft.RightsStatement, draft.AttributionTemplate, draft.CopyPolicy, draft.MaxExcerptChars,
                        draft.AllowCodeCopy, draft.ShowPublicBadge, draft.ProofBindingEnabled);
                    Text(fields, "rights.mode", draft.Mode);
                    Add(fields, "rights.identity", new(RevisionMetadataDiffValueKind.NotObserved));
                    break;
                case RevisionCompareSnapshotKind.Rights:
                    if (snapshot.SchemaVersion != 1)
                        throw Invalid();
                    CheckClosed(document.RootElement, RightsProperties);
                    ArticleRevisionRightsSnapshotResponse rights = document.Deserialize<ArticleRevisionRightsSnapshotResponse>(s_json) ?? throw Invalid();
                    Identity(rights.Id);
                    if (snapshot.Reference != $"rights:{rights.Id}")
                        throw Invalid();
                    Rights(fields, rights.Enabled, Required(rights.LicenseType), rights.CopyrightHolder, rights.CopyrightYear,
                        rights.RightsStatement, rights.AttributionTemplate, Required(rights.CopyPolicy), rights.MaxExcerptChars,
                        rights.AllowCodeCopy, rights.ShowPublicBadge, rights.ProofBindingEnabled);
                    Text(fields, "rights.identity", rights.Id);
                    Text(fields, "rights.policy-hash", Digest(rights.PolicyHash));
                    Text(fields, "rights.content-hash", Digest(rights.ContentCanonicalHash));
                    Instant(fields, "rights.created-at", rights.CreatedAt);
                    break;
                case RevisionCompareSnapshotKind.Responsibility:
                    CheckClosed(document.RootElement, ResponsibilityProperties);
                    CheckNestedResponsibility(document.RootElement, token);
                    ArticleRevisionResponsibilitySnapshotResponse responsibility = document.Deserialize<ArticleRevisionResponsibilitySnapshotResponse>(s_json) ?? throw Invalid();
                    Identity(responsibility.Id);
                    if (responsibility.ResponsibilityVersion <= 0 || snapshot.SchemaVersion != responsibility.ResponsibilityVersion
                        || snapshot.Reference != $"responsibility:{responsibility.Id}:{responsibility.ResponsibilityVersion}")
                        throw Invalid();
                    Responsibility(fields, responsibility, token);
                    break;
                case RevisionCompareSnapshotKind.Release:
                    if (snapshot.SchemaVersion != 1)
                        throw Invalid();
                    CheckClosed(document.RootElement, ReleaseProperties);
                    ArticleRevisionReleaseResponse release = document.Deserialize<ArticleRevisionReleaseResponse>(s_json) ?? throw Invalid();
                    Identity(release.Id);
                    if (release.PublicationNo <= 0 || snapshot.Reference != $"release:{release.Id}:{release.PublicationNo}")
                        throw Invalid();
                    Text(fields, "release.identity", release.Id);
                    Number(fields, "release.publication-no", release.PublicationNo);
                    Text(fields, "release.transition-kind", Required(release.TransitionKind));
                    Instant(fields, "release.published-at", release.PublishedAt);
                    break;
                default:
                    throw Invalid();
            }
        }
    }

    private static void Rights(SortedDictionary<string, ProjectedMetadataField> fields,
        bool enabled, string? licenseType, string? holder, int? year, string? statement, string? attribution,
        string? copyPolicy, int excerpt, bool allowCodeCopy, bool badge, bool proofBinding)
    {
        if (excerpt < 0 || year is < 1 or > 9999)
            throw Invalid();
        Boolean(fields, "rights.enabled", enabled);
        Text(fields, "rights.license-type", licenseType);
        Text(fields, "rights.copyright-holder", holder);
        Number(fields, "rights.copyright-year", year);
        Text(fields, "rights.statement", statement);
        Text(fields, "rights.attribution-template", attribution);
        Text(fields, "rights.copy-policy", copyPolicy);
        Number(fields, "rights.max-excerpt-chars", excerpt);
        Boolean(fields, "rights.allow-code-copy", allowCodeCopy);
        Boolean(fields, "rights.show-public-badge", badge);
        Boolean(fields, "rights.proof-binding-enabled", proofBinding);
    }

    private static void Responsibility(SortedDictionary<string, ProjectedMetadataField> fields,
        ArticleRevisionResponsibilitySnapshotResponse value, CancellationToken token)
    {
        Text(fields, "responsibility.identity", value.Id);
        Number(fields, "responsibility.version", value.ResponsibilityVersion);
        if (value.PreviousSnapshotId is not null)
            Identity(value.PreviousSnapshotId);
        Text(fields, "responsibility.previous-snapshot-id", value.PreviousSnapshotId);
        Boolean(fields, "responsibility.inherit-site-author", value.InheritSiteAuthor);
        Number(fields, "responsibility.authors.length", value.Authors.Count);
        for (int index = 0; index < value.Authors.Count; index++)
        {
            token.ThrowIfCancellationRequested();
            Person(fields, $"responsibility.authors.{index}", value.Authors[index]);
        }
        Boolean(fields, "responsibility.reviewer.present", value.Reviewer is not null);
        if (value.Reviewer is not null)
            Person(fields, "responsibility.reviewer", value.Reviewer);
        Number(fields, "responsibility.sources.length", value.Sources.Count);
        for (int index = 0; index < value.Sources.Count; index++)
        {
            token.ThrowIfCancellationRequested();
            ArticleEvidenceSource source = value.Sources[index];
            string prefix = $"responsibility.sources.{index}";
            Text(fields, prefix + ".title", Required(source.Title));
            Text(fields, prefix + ".url", Required(source.Url));
            Text(fields, prefix + ".source-type", Required(source.SourceType));
            Add(fields, prefix + ".accessed-on", source.AccessedOn.HasValue
                ? new(RevisionMetadataDiffValueKind.DateDayNumber, Number: source.AccessedOn.Value.DayNumber)
                : new(RevisionMetadataDiffValueKind.Null));
            Text(fields, prefix + ".version", source.Version);
            Text(fields, prefix + ".citation-note", source.CitationNote);
            Boolean(fields, prefix + ".is-public", source.IsPublic);
        }
        Text(fields, "responsibility.update-summary", value.UpdateSummary);
        Text(fields, "responsibility.update-reason", value.UpdateReason);
        Instant(fields, "responsibility.effective-at", value.EffectiveAt);
        Text(fields, "responsibility.conclusion-impact", value.ConclusionImpact);
        Text(fields, "responsibility.methodology", value.Methodology);
        Text(fields, "responsibility.applicability", value.Applicability);
        Text(fields, "responsibility.limitations", value.Limitations);
        Boolean(fields, "responsibility.confirmed", value.ResponsiblePersonConfirmed);
        Instant(fields, "responsibility.created-at", value.CreatedAt);
    }

    private static void Person(SortedDictionary<string, ProjectedMetadataField> fields,
        string prefix, ArticleResponsiblePerson person)
    {
        Text(fields, prefix + ".name", Required(person.Name));
        Text(fields, prefix + ".profile-url", person.ProfileUrl);
    }

    private static void CheckNestedResponsibility(JsonElement root, CancellationToken token)
    {
        foreach (string list in new[] { "Authors", "Sources" })
        {
            JsonElement array = root.GetProperty(list);
            if (array.ValueKind != JsonValueKind.Array || array.GetArrayLength() > 4_096)
                throw Invalid();
            foreach (JsonElement entry in array.EnumerateArray())
            {
                token.ThrowIfCancellationRequested();
                CheckClosed(entry, list == "Authors" ? PersonProperties : SourceProperties);
            }
        }
        JsonElement reviewer = root.GetProperty("Reviewer");
        if (reviewer.ValueKind != JsonValueKind.Null)
            CheckClosed(reviewer, PersonProperties);
    }

    private static void CheckClosed(JsonElement value, string properties)
    {
        if (value.ValueKind != JsonValueKind.Object)
            throw Invalid();
        string[] expected = properties.Split(' ');
        string[] actual = value.EnumerateObject().Select(static property => property.Name).ToArray();
        if (actual.Length != expected.Length || !actual.Order(StringComparer.Ordinal).SequenceEqual(expected.Order(StringComparer.Ordinal)))
            throw Invalid();
    }

    private static void CheckDuplicates(JsonElement value, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in value.EnumerateObject())
            {
                if (!names.Add(property.Name))
                    throw Invalid();
                CheckDuplicates(property.Value, token);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in value.EnumerateArray())
                CheckDuplicates(item, token);
        }
    }

    private static string Required(string? value)
        => value is null ? throw Invalid() : value;

    private static string Digest(string value)
    {
        string prefix = ArticleRightsCanonicalHashV1.HashAlgorithm + ":";
        if (value is null || !value.StartsWith(prefix, StringComparison.Ordinal) || value.Length != prefix.Length + 64
            || value.AsSpan(prefix.Length).IndexOfAnyExcept("0123456789abcdef") >= 0)
            throw Invalid();
        return value;
    }

    private static void Identity(string value)
    {
        if (!long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out long number)
            || number <= 0 || number.ToString(CultureInfo.InvariantCulture) != value)
            throw Invalid();
    }

    private static void Text(SortedDictionary<string, ProjectedMetadataField> fields, string id, string? value)
        => Add(fields, id, RevisionMetadataDiffEngine.StringValue(value));

    private static void Number(SortedDictionary<string, ProjectedMetadataField> fields, string id, long? value)
        => Add(fields, id, value.HasValue ? new(RevisionMetadataDiffValueKind.Integer, Number: value) : new(RevisionMetadataDiffValueKind.Null));

    private static void Boolean(SortedDictionary<string, ProjectedMetadataField> fields, string id, bool value)
        => Add(fields, id, new(RevisionMetadataDiffValueKind.Boolean, Boolean: value));

    private static void Instant(SortedDictionary<string, ProjectedMetadataField> fields, string id, DateTime? value)
        => Add(fields, id, value.HasValue
            ? new(RevisionMetadataDiffValueKind.UtcTicks, Number: (value.Value.Kind == DateTimeKind.Unspecified
                ? DateTime.SpecifyKind(value.Value, DateTimeKind.Utc) : value.Value.ToUniversalTime()).Ticks)
            : new(RevisionMetadataDiffValueKind.Null));

    private static void Add(SortedDictionary<string, ProjectedMetadataField> fields, string id, RevisionMetadataDiffValue value)
        => fields.Add(id, new("authoring-revision-snapshot." + id, "typed-exact-v1",
            value.Kind == RevisionMetadataDiffValueKind.UtcTicks ? "utc-instant" : "typed-value", true, value));

    private static MetadataDiffRefusal Invalid()
        => new(RevisionMetadataDiffStatus.Invalid, "metadata_diff_snapshot_invalid");
}
