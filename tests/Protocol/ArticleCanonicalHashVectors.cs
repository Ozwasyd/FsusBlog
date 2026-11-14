using System.Text;
using System.Text.Json;
using FsusBlog.V2.Contracts;

internal static class ArticleCanonicalHashVectors
{
    internal static void Run(string fixtures)
    {
        // Exact payloads and hashes from frozen v1, including the standalone content hash's raw hex.
        using var golden = JsonDocument.Parse(File.ReadAllText(Path.Combine(fixtures, "canonical-hash-golden-vectors.json")));
        var vectors = golden.RootElement.GetProperty("vectors");
        var json = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        var article = vectors[0].GetProperty("input").Deserialize<CanonicalArticleV1>(json)!;
        var rights = vectors[1].GetProperty("input").Deserialize<CanonicalArticleRightsV1>(json)!;

        var contentPayload = ArticleCanonicalHashesV1.ContentPayload(article);
        var policyPayload = ArticleCanonicalHashesV1.PolicyPayload(rights);
        EqualVector(vectors[0], contentPayload, ArticleCanonicalHashesV1.ContentDigest(article), persistedPrefix: "sha256:");
        EqualVector(vectors[1], policyPayload, ArticleCanonicalHashesV1.PolicyDigest(rights));

        var sameContent = article with { TagIds = [5, 2, 9, 5], MarkdownContent = "# 标题\r\rCafé 中文 😀\n" };
        if (!ArticleCanonicalHashesV1.ContentPayload(sameContent).AsSpan().SequenceEqual(contentPayload))
            throw new InvalidOperationException("Equivalent normalized article facts changed the v1 payload.");
        if (ArticleCanonicalHashesV1.ContentDigest(article with { Summary = "" }) == ArticleCanonicalHashesV1.ContentDigest(article) ||
            ArticleCanonicalHashesV1.ContentDigest(article with { MarkdownContent = article.MarkdownContent.TrimEnd('\r', '\n') }) ==
                ArticleCanonicalHashesV1.ContentDigest(article))
            throw new InvalidOperationException("Distinct article facts produced the same v1 digest.");

        var scheduled = article with
        {
            ArticleRevisionId = null, RevisionNo = null, PublicRouteKey = null, TagIds = [], Status = 1, PublishedAt = null,
            ScheduledPublishAt = new DateTimeOffset(2026, 6, 1, 16, 30, 0, TimeSpan.FromHours(8)).AddTicks(1234567)
        };
        var scheduledPayload = Encoding.UTF8.GetString(ArticleCanonicalHashesV1.ContentPayload(scheduled));
        if (!scheduledPayload.Contains("articleRevisionId:n\nrevisionNo:n\npublicRouteKey:n\n", StringComparison.Ordinal) ||
            !scheduledPayload.Contains("categoryId:i:7\ntagIds:i:\nstatus:i:1\npublishedAt:n\n" +
                "scheduledPublishAt:t:2026-06-01T08:30:00.1234567Z\n", StringComparison.Ordinal))
            throw new InvalidOperationException("Optional and scheduled v1 content coordinates changed.");

        var noHolder = rights with { CopyrightHolder = null, CopyrightYear = null, CanonicalUrl = null, ShowPublicBadge = false };
        var noHolderPayload = Encoding.UTF8.GetString(ArticleCanonicalHashesV1.PolicyPayload(noHolder));
        if (!noHolderPayload.Contains("copyrightHolder:n\ncopyrightYear:n\n", StringComparison.Ordinal) ||
            !noHolderPayload.Contains("showPublicBadge:b:0\ncanonicalUrl:n\n", StringComparison.Ordinal) ||
            ArticleCanonicalHashesV1.PolicyDigest(noHolder with { CopyrightHolder = "" }) == ArticleCanonicalHashesV1.PolicyDigest(noHolder))
            throw new InvalidOperationException("Optional v1 policy facts changed or collapsed.");
        if (!ArticleCanonicalHashesV1.PolicyPayload(rights with { ContentCanonicalHash = " " + rights.ContentCanonicalHash[7..] + " " })
                .AsSpan().SequenceEqual(policyPayload))
            throw new InvalidOperationException("V1 policy did not canonicalize the content digest spelling.");

        Reject(() => ArticleCanonicalHashesV1.ContentDigest(article with { CategoryId = 0 }));
        Reject(() => ArticleCanonicalHashesV1.ContentDigest(article with { ArticleRevisionId = 0 }));
        Reject(() => ArticleCanonicalHashesV1.ContentDigest(article with { RevisionNo = 0 }));
        Reject(() => ArticleCanonicalHashesV1.ContentDigest(article with { TagIds = [0, 1] }));
        Reject(() => ArticleCanonicalHashesV1.PolicyDigest(rights with { ArticleRevisionId = 0 }));
        Reject(() => ArticleCanonicalHashesV1.PolicyDigest(rights with { ContentCanonicalHash = "sha256:recompute" }));
    }

    private static void EqualVector(JsonElement vector, byte[] payload, string hash, string persistedPrefix = "")
    {
        var expectedPayload = vector.GetProperty("payloadBase64").GetBytesFromBase64();
        if (!payload.AsSpan().SequenceEqual(expectedPayload) || hash != persistedPrefix + vector.GetProperty("hash").GetString())
            throw new InvalidOperationException($"V1 canonical bytes or hash differ for {vector.GetProperty("id").GetString()}.");
    }

    private static void Reject(Action compute)
    {
        try { compute(); }
        catch (ArgumentException) { return; }
        throw new InvalidOperationException("An invalid v1 canonical input was accepted.");
    }
}
