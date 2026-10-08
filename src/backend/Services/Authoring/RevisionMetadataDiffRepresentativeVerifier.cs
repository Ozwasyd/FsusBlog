using System.Globalization;
using System.Text.Json;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Independent typed oracles for representative primitive, set and snapshot fields.
/// These read the original authorized DTO payloads directly, without the engine's
/// projection, normalization or diff helpers. Full result recomputation is additional.
/// </summary>
internal static class RevisionMetadataDiffRepresentativeVerifier
{
    internal static bool Verify(RevisionComparePlanBundle bundle, RevisionMetadataDiffResult result,
        CancellationToken cancellationToken = default)
    {
        foreach (RevisionMetadataDiffField field in result.Fields)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (field.BeforePackageDigest != bundle.BasePackage.PackageDigest
                || field.AfterPackageDigest != bundle.ComparePackage.PackageDigest)
                return false;
            RevisionMetadataDiffValue? before = Observe(bundle.BasePackage, field.FieldId);
            RevisionMetadataDiffValue? after = Observe(bundle.ComparePackage, field.FieldId);
            if (before is not null && !Same(before, field.Before)
                || after is not null && !Same(after, field.After))
                return false;
            if (field.FieldId == "tag-ids" && before is not null && after is not null)
            {
                if (!after.Ids.Except(before.Ids).SequenceEqual(field.AddedIds)
                    || !before.Ids.Except(after.Ids).SequenceEqual(field.RemovedIds))
                    return false;
            }
        }
        return true;
    }

    private static RevisionMetadataDiffValue? Observe(RevisionComparePackage package, string id)
    {
        if (id.StartsWith("rights.", StringComparison.Ordinal)
            && id is not ("rights.enabled" or "rights.max-excerpt-chars" or "rights.identity"
                or "rights.policy-hash" or "rights.content-hash"))
            return null;
        RevisionCompareMetadataValue? primitive = package.Metadata.SingleOrDefault(value => value.FieldId == id);
        if (primitive is not null)
        {
            switch (id)
            {
                case "title":
                    return Text(primitive.CanonicalValue);
                case "summary":
                case "cover-image-url":
                    using (JsonDocument stringDocument = JsonDocument.Parse(primitive.CanonicalValue))
                        return Text(stringDocument.RootElement.ValueKind == JsonValueKind.Null
                            ? null : stringDocument.RootElement.GetString());
                case "category-id":
                case "status":
                    return Integer(int.Parse(primitive.CanonicalValue, CultureInfo.InvariantCulture));
                case "tag-ids":
                    return new(RevisionMetadataDiffValueKind.UnorderedIntegerSet, Ids: primitive.CanonicalValue.Length == 0
                        ? [] : [.. primitive.CanonicalValue.Split(',').Select(static value => int.Parse(value, CultureInfo.InvariantCulture)).Order()]);
                case "scheduled-publish-at":
                    return primitive.CanonicalValue == "null" ? new(RevisionMetadataDiffValueKind.Null)
                        : new(RevisionMetadataDiffValueKind.UtcTicks,
                            Number: DateTimeOffset.Parse(primitive.CanonicalValue, CultureInfo.InvariantCulture).UtcTicks);
            }
        }
        RevisionCompareSnapshotKind? kind = id.StartsWith("rights.", StringComparison.Ordinal)
            ? RevisionCompareSnapshotKind.Rights
            : id == "responsibility.version" ? RevisionCompareSnapshotKind.Responsibility
            : id == "release.publication-no" ? RevisionCompareSnapshotKind.Release : null;
        if (!kind.HasValue)
            return null;
        RevisionCompareSnapshot snapshot = package.Snapshots.Single(value => value.Kind == kind.Value);
        if (snapshot.State == RevisionCompareSnapshotState.NotApplicable)
            return new(RevisionMetadataDiffValueKind.NotApplicable);
        if (snapshot.State != RevisionCompareSnapshotState.Present)
            return new(RevisionMetadataDiffValueKind.NotObserved);
        if (kind == RevisionCompareSnapshotKind.Responsibility)
        {
            ArticleRevisionResponsibilitySnapshotResponse response = JsonSerializer.Deserialize<ArticleRevisionResponsibilitySnapshotResponse>(snapshot.Payload.AsSpan())!;
            return Integer(response.ResponsibilityVersion);
        }
        if (kind == RevisionCompareSnapshotKind.Release)
        {
            ArticleRevisionReleaseResponse response = JsonSerializer.Deserialize<ArticleRevisionReleaseResponse>(snapshot.Payload.AsSpan())!;
            return Integer(response.PublicationNo);
        }
        if (package.SourceKind == RevisionCompareSourceKind.CurrentDraft)
        {
            ArticleRightsRequest? draft = JsonSerializer.Deserialize<ArticleRightsRequest>(snapshot.Payload.AsSpan());
            return id switch
            {
                "rights.enabled" when draft is not null => new(RevisionMetadataDiffValueKind.Boolean, Boolean: draft.Enabled),
                "rights.max-excerpt-chars" when draft is not null => Integer(draft.MaxExcerptChars),
                "rights.identity" or "rights.policy-hash" or "rights.content-hash" => new(RevisionMetadataDiffValueKind.NotObserved),
                _ => null
            };
        }
        ArticleRevisionRightsSnapshotResponse rights = JsonSerializer.Deserialize<ArticleRevisionRightsSnapshotResponse>(snapshot.Payload.AsSpan())!;
        return id switch
        {
            "rights.enabled" => new(RevisionMetadataDiffValueKind.Boolean, Boolean: rights.Enabled),
            "rights.max-excerpt-chars" => Integer(rights.MaxExcerptChars),
            "rights.identity" => Text(rights.Id),
            "rights.policy-hash" => Text(rights.PolicyHash),
            "rights.content-hash" => Text(rights.ContentCanonicalHash),
            _ => null
        };
    }

    private static RevisionMetadataDiffValue Text(string? text)
        => text is null ? new(RevisionMetadataDiffValueKind.Null) : new(RevisionMetadataDiffValueKind.String, Text: text);

    private static RevisionMetadataDiffValue Integer(int value)
        => new(RevisionMetadataDiffValueKind.Integer, Number: value);

    private static bool Same(RevisionMetadataDiffValue observed, RevisionMetadataDiffValue result)
        => observed.Kind == result.Kind && observed.Text == result.Text && observed.Number == result.Number
            && observed.Boolean == result.Boolean && observed.Ids.AsSpan().SequenceEqual(result.Ids.AsSpan());
}
