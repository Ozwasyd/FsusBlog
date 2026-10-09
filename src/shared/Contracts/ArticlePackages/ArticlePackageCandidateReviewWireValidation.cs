using System.Globalization;
using System.Text;
using System.Text.Json;

using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>
/// Closed JSON payload validation for the reserved, inactive 288/289 AEDS pair.
/// Structural validity and readonly correlation confer no site or execution authority.
/// </summary>
public static class ArticlePackageCandidateReviewWireValidation
{
    public const ushort ReservedRequestFrame = 288;
    public const ushort ReservedResponseFrame = 289;
    public const string InvalidRequest = "article_package_candidate_review_read_invalid";
    public const string InvalidResponse = "article_package_candidate_review_response_invalid";
    public const string ExecutionRefusal = "article_package_import_authority_unavailable";

    private static readonly JsonSerializerOptions s_options = new(JsonSerializerDefaults.Web);
    private static readonly string[] s_authorities =
    [
        "archive_intake", "complete_package_schema", "canonical_source_and_property_provenance",
        "fsusui_syntax_dependencies", "persisted_relation_and_embed_plan", "frozen_public_projection_retention",
        "asset_and_dependency_resolution", "rights_responsibility_taxonomy_privacy",
        "current_actor_site_target_permissions", "current_target_revision_and_identity", "execution_qualification"
    ];

    /// <summary>Validates the complete closed request before typed deserialization or service invocation.</summary>
    public static bool TryReadRequest(ReadOnlyMemory<byte> payload, out ArticlePackageCandidateReviewReadRequest? request)
    {
        request = null;
        if (!TryDocument(payload, out JsonDocument? document))
        {
            return false;
        }
        using (document)
        {
            try
            {
                JsonElement root = document!.RootElement;
                if (!RequestShape(root))
                {
                    return false;
                }
                request = root.Deserialize<ArticlePackageCandidateReviewReadRequest>(s_options);
                return request is not null;
            }
            catch (Exception exception) when (exception is JsonException or InvalidOperationException or DecoderFallbackException)
            {
                return false;
            }
        }
    }

    /// <summary>Rejects open, unsafe or executable projections before exposing a typed response.</summary>
    public static bool TryReadResponse(ReadOnlyMemory<byte> payload, out ArticlePackageCandidateReviewReadResponse? response)
    {
        response = null;
        if (!TryDocument(payload, out JsonDocument? document))
        {
            return false;
        }
        using (document)
        {
            try
            {
                JsonElement root = document!.RootElement;
                if (!Closed(root, "requestId", "review", "context") || !RequestId(root.GetProperty("requestId"))
                    || !Context(root.GetProperty("context")) || !Review(root.GetProperty("review")))
                {
                    return false;
                }
                response = root.Deserialize<ArticlePackageCandidateReviewReadResponse>(s_options);
                return response is not null;
            }
            catch (Exception exception) when (exception is JsonException or InvalidOperationException or DecoderFallbackException)
            {
                return false;
            }
        }
    }

    /// <summary>Compares the original request and expectations; never refreshes a stale binding.</summary>
    public static bool IsCorrelated(ArticlePackageCandidateReviewReadRequest request, ArticlePackageCandidateReviewReadResponse response)
    {
        ArticlePackageCandidateReview review = response.Review;
        if (response.RequestId != request.RequestId || review.RequestedMode != request.RequestedMode
            || review.PolicyDigest != request.CallerPolicyDigest || review.PageIndex != request.PageIndex
            || review.PageSize != request.PageSize || !review.ExecuteDisabled || review.ExecutionReasonCode != ExecutionRefusal
            || !TryUtc(review.CreatedAtUtc, out DateTime created) || created != request.CreatedAtUtc
            || !TryUtc(review.ExpiresAtUtc, out DateTime expires) || expires != request.ExpiresAtUtc
            || request.ExpectedPlanDigest is not null && review.PlanDigest != request.ExpectedPlanDigest
            || request.ExpectedContext is not null && response.Context != request.ExpectedContext)
        {
            return false;
        }
        if (request.RequestedMode == "CreateNew")
        {
            return review.Targets.All(target => target.RequiresNewIdentity && target.RequestedTargetArticleId is null
                && target.ExpectedTargetRevision is null);
        }
        IReadOnlyList<ArticlePackageCandidateReviewRequestedTarget>? hints = request.RequestedTargets;
        if (hints is null || hints.Count is < 1 or > 1000 || hints.Count != review.TotalTargets
            || request.PageIndex is < 0 or > 999 || request.PageSize is < 1 or > 50)
        {
            return false;
        }
        int start = request.PageIndex * request.PageSize;
        if (start >= hints.Count || review.Targets.Count != Math.Min(request.PageSize, hints.Count - start))
        {
            return false;
        }
        // The original manifest sorts portable identities ordinally, and the original
        // planner/projection retain that order. Compare its exact page without replanning.
        ArticlePackageCandidateReviewRequestedTarget[] ordered = hints.OrderBy(hint => hint.PortableArticle, StringComparer.Ordinal).ToArray();
        for (int index = 0; index < review.Targets.Count; index++)
        {
            ArticlePackageCandidateReviewRequestedTarget hint = ordered[start + index];
            ArticlePackageCandidateReviewTarget target = review.Targets[index];
            if (target.RequiresNewIdentity || hint.PortableArticle != target.PortableArticle
                || hint.RequestedTargetArticleId != target.RequestedTargetArticleId || hint.ExpectedTargetRevision != target.ExpectedTargetRevision)
            {
                return false;
            }
        }
        return true;
    }

    private static bool TryDocument(ReadOnlyMemory<byte> payload, out JsonDocument? document)
    {
        document = null;
        if (payload.Length is < 1 or > ArticlePackageCandidateReviewReadLimits.MaxRequestBytes - AedsFrameHeader.Size)
        {
            return false;
        }
        try
        {
            _ = new UTF8Encoding(false, true).GetCharCount(payload.Span);
            document = JsonDocument.Parse(payload, new JsonDocumentOptions { MaxDepth = 6 });
            return true;
        }
        catch (Exception exception) when (exception is JsonException or InvalidOperationException or DecoderFallbackException)
        {
            return false;
        }
    }

    private static bool RequestShape(JsonElement root)
    {
        if (!Closed(root, "requestId", "archiveBytes", "requestedMode", "callerPolicyDigest", "callerPermissionContextDigest",
                "createdAtUtc", "expiresAtUtc", "requestedTargets", "pageIndex", "pageSize", "expectedPlanDigest", "expectedContext")
            || !RequestId(root.GetProperty("requestId")) || !Archive(root.GetProperty("archiveBytes"))
            || !Mode(root.GetProperty("requestedMode")) || !Digest(root.GetProperty("callerPolicyDigest"))
            || !Digest(root.GetProperty("callerPermissionContextDigest")) || !Interval(root)
            || !Integer(root.GetProperty("pageIndex"), 0, 999) || !Integer(root.GetProperty("pageSize"), 1, 50))
        {
            return false;
        }
        JsonElement digest = root.GetProperty("expectedPlanDigest");
        JsonElement context = root.GetProperty("expectedContext");
        bool seed = digest.ValueKind == JsonValueKind.Null && context.ValueKind == JsonValueKind.Null;
        if (seed ? root.GetProperty("pageIndex").GetInt32() != 0 : !Digest(digest) || !Context(context))
        {
            return false;
        }
        JsonElement targets = root.GetProperty("requestedTargets");
        if (targets.ValueKind == JsonValueKind.Null)
        {
            return root.GetProperty("requestedMode").GetString() == "CreateNew";
        }
        if (targets.ValueKind != JsonValueKind.Array || targets.GetArrayLength() > 1000)
        {
            return false;
        }
        var portable = new HashSet<string>(StringComparer.Ordinal);
        var ids = new HashSet<int>();
        foreach (JsonElement target in targets.EnumerateArray())
        {
            if (!Closed(target, "portableArticle", "requestedTargetArticleId", "expectedTargetRevision")
                || !Portable(target.GetProperty("portableArticle")) || !Integer(target.GetProperty("requestedTargetArticleId"), 1, int.MaxValue)
                || !Revision(target.GetProperty("expectedTargetRevision"))
                || !portable.Add(target.GetProperty("portableArticle").GetString()!) || !ids.Add(target.GetProperty("requestedTargetArticleId").GetInt32()))
            {
                return false;
            }
        }
        return root.GetProperty("requestedMode").GetString() == "CreateNew" ? targets.GetArrayLength() == 0 : targets.GetArrayLength() > 0;
    }

    private static bool Review(JsonElement root)
    {
        if (!Closed(root, "candidateStatus", "summary", "requestedMode", "policyDigest", "createdAtUtc", "expiresAtUtc",
                "intervalStatus", "planDigest", "pageIndex", "pageSize", "totalTargets", "targets", "requiredAuthorities", "executeDisabled", "executionReasonCode")
            || !Literal(root.GetProperty("candidateStatus"), "finite_bytes_validated") || !Summary(root.GetProperty("summary"))
            || !Mode(root.GetProperty("requestedMode")) || !Digest(root.GetProperty("policyDigest")) || !Interval(root)
            || !OneOf(root.GetProperty("intervalStatus"), "caller_interval_not_started", "caller_interval_current", "caller_interval_expired")
            || !Digest(root.GetProperty("planDigest")) || !Integer(root.GetProperty("pageIndex"), 0, 999)
            || !Integer(root.GetProperty("pageSize"), 1, 50) || !Integer(root.GetProperty("totalTargets"), 1, 1000)
            || root.GetProperty("executeDisabled").ValueKind != JsonValueKind.True
            || !Literal(root.GetProperty("executionReasonCode"), ExecutionRefusal))
        {
            return false;
        }
        int count = root.GetProperty("totalTargets").GetInt32();
        int start = root.GetProperty("pageIndex").GetInt32() * root.GetProperty("pageSize").GetInt32();
        JsonElement targets = root.GetProperty("targets");
        if (count != root.GetProperty("summary").GetProperty("articleCount").GetInt32() || start >= count
            || targets.ValueKind != JsonValueKind.Array || targets.GetArrayLength() != Math.Min(root.GetProperty("pageSize").GetInt32(), count - start))
        {
            return false;
        }
        bool create = root.GetProperty("requestedMode").GetString() == "CreateNew";
        var portable = new HashSet<string>(StringComparer.Ordinal);
        var ids = new HashSet<int>();
        string? previous = null;
        foreach (JsonElement target in targets.EnumerateArray())
        {
            if (!Closed(target, "portableArticle", "requiresNewIdentity", "requestedTargetArticleId", "expectedTargetRevision")
                || !Portable(target.GetProperty("portableArticle")) || !portable.Add(target.GetProperty("portableArticle").GetString()!)
                || target.GetProperty("requiresNewIdentity").ValueKind != (create ? JsonValueKind.True : JsonValueKind.False))
            {
                return false;
            }
            string identity = target.GetProperty("portableArticle").GetString()!;
            if (previous is not null && string.CompareOrdinal(previous, identity) >= 0)
            {
                return false;
            }
            previous = identity;
            JsonElement id = target.GetProperty("requestedTargetArticleId");
            JsonElement revision = target.GetProperty("expectedTargetRevision");
            if (create ? id.ValueKind != JsonValueKind.Null || revision.ValueKind != JsonValueKind.Null
                : !Integer(id, 1, int.MaxValue) || !Revision(revision) || !ids.Add(id.GetInt32()))
            {
                return false;
            }
        }
        JsonElement authorities = root.GetProperty("requiredAuthorities");
        return authorities.ValueKind == JsonValueKind.Array && authorities.GetArrayLength() == s_authorities.Length
            && authorities.EnumerateArray().Select((value, index) => Literal(value, s_authorities[index])).All(valid => valid);
    }

    private static bool Summary(JsonElement root)
        => Closed(root, "articleCount", "fileCount", "schemaVersion", "canonicalHashVersion", "propertySchemaVersion",
                "packageBytesDigest", "manifestSemanticDigest", "checksumComponentDigest")
            && Integer(root.GetProperty("articleCount"), 1, 1000) && Integer(root.GetProperty("fileCount"), 3, 1002)
            && root.GetProperty("fileCount").GetInt32() == root.GetProperty("articleCount").GetInt32() + 2
            && Integer(root.GetProperty("schemaVersion"), 1, 1) && Integer(root.GetProperty("canonicalHashVersion"), 1, 1)
            && Integer(root.GetProperty("propertySchemaVersion"), 1, 1) && Digest(root.GetProperty("packageBytesDigest"))
            && Digest(root.GetProperty("manifestSemanticDigest")) && Digest(root.GetProperty("checksumComponentDigest"));

    private static bool Context(JsonElement root)
        => Closed(root, "identity", "lifecycleVersion", "generation", "mappingRevision", "scopeRevision")
            && Text(root.GetProperty("identity")) && root.GetProperty("identity").GetString() is string identity
            && identity.StartsWith("fsus-site:", StringComparison.Ordinal) && ArticleRelationDigest.IsSha256(identity[10..])
            && Integer(root.GetProperty("lifecycleVersion"), 1, 1) && Integer(root.GetProperty("generation"), 1, 16)
            && Integer(root.GetProperty("mappingRevision"), 1, 1024)
            && Integer(root.GetProperty("scopeRevision"), 1, root.GetProperty("mappingRevision").GetInt32());

    private static bool Closed(JsonElement root, params string[] names)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            return false;
        }
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonProperty property in root.EnumerateObject())
        {
            if (!names.Contains(property.Name, StringComparer.Ordinal) || !seen.Add(property.Name))
            {
                return false;
            }
        }
        return seen.Count == names.Length;
    }

    private static bool Integer(JsonElement value, int minimum, int maximum)
        => value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out int parsed)
            && value.GetRawText().All(char.IsAsciiDigit) && parsed >= minimum && parsed <= maximum;

    private static bool Text(JsonElement value) => value.ValueKind == JsonValueKind.String;
    private static bool Literal(JsonElement value, string expected) => Text(value) && value.GetString() == expected;
    private static bool OneOf(JsonElement value, params string[] expected) => Text(value) && expected.Contains(value.GetString(), StringComparer.Ordinal);
    private static bool Mode(JsonElement value) => OneOf(value, "CreateNew", "UpdateRequested");
    private static bool Digest(JsonElement value) => Text(value) && ArticleRelationDigest.IsSha256(value.GetString());
    private static bool Portable(JsonElement value)
        => Text(value) && ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article, value.GetString(), out _).IsValid;
    private static bool RequestId(JsonElement value)
        => Text(value) && value.GetString() is string id && !string.IsNullOrWhiteSpace(id) && id.Length <= 128 && ValidUnicode(id);

    private static bool ValidUnicode(string value)
    {
        for (int index = 0; index < value.Length; index++)
        {
            if (char.IsSurrogate(value[index]) && (!char.IsHighSurrogate(value[index]) || ++index >= value.Length || !char.IsLowSurrogate(value[index])))
            {
                return false;
            }
        }
        return true;
    }

    private static bool Revision(JsonElement value)
        => Text(value) && long.TryParse(value.GetString(), NumberStyles.None, CultureInfo.InvariantCulture, out long revision)
            && revision > 0 && value.GetString() == revision.ToString(CultureInfo.InvariantCulture);

    private static bool Archive(JsonElement value)
    {
        if (!Text(value) || value.GetString() is not string encoded || encoded.Length is < 4 or > 699052 || encoded.Length % 4 != 0)
        {
            return false;
        }
        try
        {
            byte[] bytes = Convert.FromBase64String(encoded);
            return bytes.Length is > 0 and <= ArticlePackageCandidateReviewReadLimits.MaxArchiveBytes && Convert.ToBase64String(bytes) == encoded;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static bool Interval(JsonElement root)
        => Text(root.GetProperty("createdAtUtc")) && Text(root.GetProperty("expiresAtUtc"))
            && TryUtc(root.GetProperty("createdAtUtc").GetString()!, out DateTime created)
            && TryUtc(root.GetProperty("expiresAtUtc").GetString()!, out DateTime expires) && expires > created;

    private static bool TryUtc(string value, out DateTime parsed)
    {
        parsed = default;
        if (value.Length != 20 && (value.Length is < 22 or > 28 || value[19] != '.')
            || !value.EndsWith('Z'))
        {
            return false;
        }
        return DateTime.TryParseExact(value, ["yyyy-MM-dd'T'HH:mm:ss'Z'", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'"],
            CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out parsed);
    }
}
