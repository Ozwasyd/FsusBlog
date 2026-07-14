using System.Text.Json;
using System.Net;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.PublicAot;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Integrity;

public sealed record ArticleResponsiblePerson(string Name, string? ProfileUrl);

public sealed record ArticleEvidenceSource(
    string Title,
    string Url,
    string SourceType,
    DateOnly? AccessedOn,
    string? Version,
    string? CitationNote,
    bool IsPublic = true);

public sealed record ArticleUpdateDisclosure(
    string Summary,
    string Reason,
    DateTime? EffectiveAt,
    string ConclusionImpact);

public sealed record ArticleVerificationSummary(
    string Url,
    int RevisionNo,
    string? ContentHash,
    string ProofStatus);

public sealed record ArticleResponsibilityManifestResponse(
    int SchemaVersion,
    int ArticleId,
    int RevisionNo,
    bool InheritsSiteAuthor,
    bool LegacyFallback,
    IReadOnlyList<ArticleResponsiblePerson> Authors,
    ArticleResponsiblePerson? Reviewer,
    IReadOnlyList<ArticleEvidenceSource> Sources,
    ArticleUpdateDisclosure? Update,
    string? Methodology,
    string? Applicability,
    string? Limitations,
    bool ResponsiblePersonConfirmed,
    ArticleVerificationSummary Verification);

public interface IArticleResponsibilityManifestService
{
    Task<IntegrityManifestResult> GetCurrentAsync(int articleId, CancellationToken cancellationToken = default);
    Task<IntegrityManifestResult> GetRevisionAsync(int articleId, int revisionNo, CancellationToken cancellationToken = default);
}

public sealed class ArticleResponsibilityManifestService(
    ISqlSugarClient db,
    IAotSeoConfigSnapshot seoConfigSnapshot) : IArticleResponsibilityManifestService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public Task<IntegrityManifestResult> GetCurrentAsync(int articleId, CancellationToken cancellationToken = default)
        => BuildAsync(articleId, null, cancellationToken);

    public Task<IntegrityManifestResult> GetRevisionAsync(int articleId, int revisionNo, CancellationToken cancellationToken = default)
        => BuildAsync(articleId, revisionNo, cancellationToken);

    private async Task<IntegrityManifestResult> BuildAsync(int articleId, int? requestedRevisionNo, CancellationToken cancellationToken)
    {
        if (articleId <= 0 || requestedRevisionNo is <= 0)
        {
            return NotFound();
        }

        DateTime utcNow = DateTime.UtcNow;
        bool publiclyVisible = await db.Queryable<Article>()
            .Where(it => it.Id == articleId
                && !it.IsDeleted
                && it.Status == ArticleStatus.Published
                && (it.PublishedAt == null || it.PublishedAt <= utcNow)
                && (it.ScheduledPublishAt == null || it.ScheduledPublishAt <= utcNow))
            .AnyAsync(cancellationToken);
        if (!publiclyVisible)
        {
            return NotFound();
        }

        ArticleRevision? revision = await db.Queryable<ArticleRevision>()
            .Where(it => it.ArticleId == articleId)
            .WhereIF(requestedRevisionNo.HasValue, it => it.RevisionNo == requestedRevisionNo)
            .OrderBy(it => it.RevisionNo, OrderByType.Desc)
            .FirstAsync(cancellationToken);
        if (revision is null)
        {
            return NotFound();
        }

        ArticleResponsibilitySnapshot? snapshot = await db.Queryable<ArticleResponsibilitySnapshot>()
            .Where(it => it.ArticleId == articleId && it.ArticleRevisionId == revision.Id)
            .FirstAsync(cancellationToken);
        PublicAotSeoSnapshot site = await seoConfigSnapshot.GetAsync(cancellationToken);

        bool legacyFallback = snapshot is null;
        bool inheritsSiteAuthor = snapshot?.InheritSiteAuthor ?? true;
        IReadOnlyList<ArticleResponsiblePerson> authors = SanitizePeople(
            DeserializeList<ArticleResponsiblePerson>(snapshot?.AuthorsJson));
        if (authors.Count == 0 && inheritsSiteAuthor && !string.IsNullOrWhiteSpace(site.SiteAuthor))
        {
            authors = BuildSiteAuthorFallback(site.SiteAuthor);
        }

        ArticleResponsiblePerson? reviewer = SanitizePerson(
            Deserialize<ArticleResponsiblePerson>(snapshot?.ReviewerJson));
        IReadOnlyList<ArticleEvidenceSource> sources = SanitizeSources(
            DeserializeList<ArticleEvidenceSource>(snapshot?.SourcesJson));
        ArticleUpdateDisclosure? update = BuildUpdate(snapshot);

        (string? contentHash, string proofStatus) = await LoadVerificationAsync(revision.Id, cancellationToken);
        var response = new ArticleResponsibilityManifestResponse(
            1,
            articleId,
            revision.RevisionNo,
            inheritsSiteAuthor,
            legacyFallback,
            authors,
            reviewer,
            sources,
            update,
            NullIfWhiteSpace(snapshot?.Methodology),
            NullIfWhiteSpace(snapshot?.Applicability),
            NullIfWhiteSpace(snapshot?.Limitations),
            snapshot?.ResponsiblePersonConfirmed ?? false,
            new ArticleVerificationSummary(
                $"/integrity/article/{articleId}/revisions/{revision.RevisionNo}",
                revision.RevisionNo,
                contentHash,
                proofStatus));

        return new IntegrityManifestResult(
            StatusCodes.Status200OK,
            IntegrityVerificationCacheHeaders.PublicManifest,
            response);
    }

    private async Task<(string? ContentHash, string Status)> LoadVerificationAsync(long revisionId, CancellationToken cancellationToken)
    {
        ArticlePublishProof? proof = await db.Queryable<ArticlePublishProof>()
            .Where(it => it.ArticleRevisionId == revisionId)
            .OrderBy(it => it.CreatedAt, OrderByType.Desc)
            .FirstAsync(cancellationToken);
        if (proof is null)
        {
            return (null, "unavailable");
        }

        return (NullIfWhiteSpace(proof.CanonicalHash), NormalizeProofStatus(proof.ProofStatus));
    }

    internal static string NormalizeProofStatus(string? value)
        => value?.Trim().ToLowerInvariant() switch
        {
            "ready" => "ready",
            "failed" => "failed",
            _ => "unavailable"
        };

    internal static IReadOnlyList<ArticleResponsiblePerson> BuildSiteAuthorFallback(string? siteAuthor)
        => string.IsNullOrWhiteSpace(siteAuthor)
            ? []
            : [new ArticleResponsiblePerson(siteAuthor.Trim(), null)];

    private static ArticleUpdateDisclosure? BuildUpdate(ArticleResponsibilitySnapshot? snapshot)
    {
        string? summary = NullIfWhiteSpace(snapshot?.UpdateSummary);
        string? reason = NullIfWhiteSpace(snapshot?.UpdateReason);
        if (summary is null && reason is null && snapshot?.EffectiveAt is null)
        {
            return null;
        }

        return new ArticleUpdateDisclosure(
            summary ?? "未提供变更摘要",
            reason ?? "未提供变更原因",
            snapshot?.EffectiveAt,
            NormalizeConclusionImpact(snapshot?.ConclusionImpact));
    }

    private static string NormalizeConclusionImpact(string? value)
        => value?.Trim().ToLowerInvariant() switch
        {
            "none" => "none",
            "clarified" => "clarified",
            "changed" => "changed",
            _ => "unknown"
        };

    private static IReadOnlyList<ArticleResponsiblePerson> SanitizePeople(IEnumerable<ArticleResponsiblePerson> people)
        => people.Select(SanitizePerson).Where(static person => person is not null).Cast<ArticleResponsiblePerson>().Take(8).ToArray();

    private static ArticleResponsiblePerson? SanitizePerson(ArticleResponsiblePerson? person)
    {
        string? name = NullIfWhiteSpace(person?.Name);
        return name is null ? null : new ArticleResponsiblePerson(name, PublicUrl(person?.ProfileUrl));
    }

    private static IReadOnlyList<ArticleEvidenceSource> SanitizeSources(IEnumerable<ArticleEvidenceSource> sources)
        => sources
            .Where(static source => source.IsPublic)
            .Select(static source => new ArticleEvidenceSource(
                NullIfWhiteSpace(source.Title) ?? string.Empty,
                PublicUrl(source.Url) ?? string.Empty,
                NullIfWhiteSpace(source.SourceType) ?? "other",
                source.AccessedOn,
                NullIfWhiteSpace(source.Version),
                NullIfWhiteSpace(source.CitationNote)))
            .Where(static source => source.Title.Length > 0 && source.Url.Length > 0)
            .Take(100)
            .ToArray();

    internal static string? PublicUrl(string? value)
    {
        if (!Uri.TryCreate(value?.Trim(), UriKind.Absolute, out Uri? uri)
            || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)
            || !string.IsNullOrEmpty(uri.UserInfo)
            || string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        if (IPAddress.TryParse(uri.Host, out IPAddress? address)
            && (IPAddress.IsLoopback(address) || IsPrivateAddress(address)))
        {
            return null;
        }

        return uri.AbsoluteUri;
    }

    private static bool IsPrivateAddress(IPAddress address)
    {
        byte[] bytes = address.GetAddressBytes();
        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            return bytes[0] == 10
                || bytes[0] == 127
                || (bytes[0] == 169 && bytes[1] == 254)
                || (bytes[0] == 172 && bytes[1] is >= 16 and <= 31)
                || (bytes[0] == 192 && bytes[1] == 168);
        }

        return address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || address.Equals(IPAddress.IPv6Loopback);
    }

    private static T? Deserialize<T>(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return default;
        try { return JsonSerializer.Deserialize<T>(json, JsonOptions); }
        catch (JsonException) { return default; }
    }

    private static IReadOnlyList<T> DeserializeList<T>(string? json)
        => Deserialize<List<T>>(json) ?? [];

    private static string? NullIfWhiteSpace(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static IntegrityManifestResult NotFound()
        => new(
            StatusCodes.Status404NotFound,
            IntegrityVerificationCacheHeaders.NoStore,
            IntegrityPublicErrorResponse.NotFound("article_responsibility_not_found"));
}

public sealed record ArticleResponsibilityDraft(
    bool InheritSiteAuthor,
    IReadOnlyList<ArticleResponsiblePerson> Authors,
    ArticleResponsiblePerson? Reviewer,
    IReadOnlyList<ArticleEvidenceSource> Sources,
    string? UpdateSummary,
    string? UpdateReason,
    DateTime? EffectiveAt,
    string? ConclusionImpact,
    string? Methodology,
    string? Applicability,
    string? Limitations,
    bool ResponsiblePersonConfirmed,
    bool ContainsStrongClaims,
    bool IsSubstantiveUpdate,
    bool RequiresMethodsDisclosure);

public sealed record ArticleResponsibilitySaveResponse(
    bool Saved,
    int ArticleId,
    string ArticleRevisionId,
    int RevisionNo,
    IReadOnlyList<Models.Dtos.PrepublishIssue> Issues);

public interface IArticleResponsibilityAuthoringService
{
    Task<ArticleResponsibilitySaveResponse?> SaveAsync(
        int articleId,
        long articleRevisionId,
        ArticleResponsibilityDraft draft,
        CancellationToken cancellationToken = default);
}

public sealed class ArticleResponsibilityAuthoringService(
    ISqlSugarClient db,
    IPublicAotInvalidationService publicAotInvalidation) : IArticleResponsibilityAuthoringService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<ArticleResponsibilitySaveResponse?> SaveAsync(
        int articleId,
        long articleRevisionId,
        ArticleResponsibilityDraft draft,
        CancellationToken cancellationToken = default)
    {
        ArticleRevision? revision = await db.Queryable<ArticleRevision>()
            .Where(it => it.ArticleId == articleId && it.Id == articleRevisionId)
            .FirstAsync(cancellationToken);
        if (revision is null) return null;

        IReadOnlyList<Models.Dtos.PrepublishIssue> issues = ArticleResponsibilityGovernance.Evaluate(draft);
        if (issues.Any(static issue => string.Equals(issue.Severity, "error", StringComparison.OrdinalIgnoreCase)))
        {
            return new ArticleResponsibilitySaveResponse(false, articleId, articleRevisionId.ToString(System.Globalization.CultureInfo.InvariantCulture), revision.RevisionNo, issues);
        }

        string authorsJson = JsonSerializer.Serialize(draft.Authors, JsonOptions);
        string? reviewerJson = draft.Reviewer is null ? null : JsonSerializer.Serialize(draft.Reviewer, JsonOptions);
        string sourcesJson = JsonSerializer.Serialize(draft.Sources, JsonOptions);
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_responsibility_snapshot (
                article_id, article_revision_id, revision_no, inherit_site_author,
                authors_json, reviewer_json, sources_json, update_summary, update_reason,
                effective_at, conclusion_impact, methodology, applicability, limitations,
                responsible_person_confirmed, created_at)
            VALUES (
                @ArticleId, @ArticleRevisionId, @RevisionNo, @InheritSiteAuthor,
                @AuthorsJson, @ReviewerJson, @SourcesJson, @UpdateSummary, @UpdateReason,
                CAST(@EffectiveAt AS timestamp), @ConclusionImpact, @Methodology, @Applicability, @Limitations,
                @ResponsiblePersonConfirmed, @CreatedAt)
            ON CONFLICT (article_revision_id) DO UPDATE SET
                inherit_site_author = EXCLUDED.inherit_site_author,
                authors_json = EXCLUDED.authors_json,
                reviewer_json = EXCLUDED.reviewer_json,
                sources_json = EXCLUDED.sources_json,
                update_summary = EXCLUDED.update_summary,
                update_reason = EXCLUDED.update_reason,
                effective_at = EXCLUDED.effective_at,
                conclusion_impact = EXCLUDED.conclusion_impact,
                methodology = EXCLUDED.methodology,
                applicability = EXCLUDED.applicability,
                limitations = EXCLUDED.limitations,
                responsible_person_confirmed = EXCLUDED.responsible_person_confirmed;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@ArticleRevisionId", articleRevisionId),
            new SugarParameter("@RevisionNo", revision.RevisionNo),
            new SugarParameter("@InheritSiteAuthor", draft.InheritSiteAuthor),
            new SugarParameter("@AuthorsJson", authorsJson),
            new SugarParameter("@ReviewerJson", (object?)reviewerJson ?? DBNull.Value),
            new SugarParameter("@SourcesJson", sourcesJson),
            new SugarParameter("@UpdateSummary", (object?)draft.UpdateSummary?.Trim() ?? DBNull.Value),
            new SugarParameter("@UpdateReason", (object?)draft.UpdateReason?.Trim() ?? DBNull.Value),
            new SugarParameter("@EffectiveAt", (object?)draft.EffectiveAt ?? DBNull.Value),
            new SugarParameter("@ConclusionImpact", (object?)draft.ConclusionImpact?.Trim() ?? DBNull.Value),
            new SugarParameter("@Methodology", (object?)draft.Methodology?.Trim() ?? DBNull.Value),
            new SugarParameter("@Applicability", (object?)draft.Applicability?.Trim() ?? DBNull.Value),
            new SugarParameter("@Limitations", (object?)draft.Limitations?.Trim() ?? DBNull.Value),
            new SugarParameter("@ResponsiblePersonConfirmed", draft.ResponsiblePersonConfirmed),
            new SugarParameter("@CreatedAt", DateTime.UtcNow));

        await publicAotInvalidation.InvalidateArticleMutationAsync(articleId, null, null, cancellationToken);

        return new ArticleResponsibilitySaveResponse(true, articleId, articleRevisionId.ToString(System.Globalization.CultureInfo.InvariantCulture), revision.RevisionNo, issues);
    }
}

public static class ArticleResponsibilityGovernance
{
    public static IReadOnlyList<Models.Dtos.PrepublishIssue> Evaluate(ArticleResponsibilityDraft draft)
    {
        var issues = new List<Models.Dtos.PrepublishIssue>();
        if (!draft.InheritSiteAuthor && draft.Authors.Count == 0)
            issues.Add(Block("responsible_author_missing", "必须指定责任作者或显式继承站点作者。"));
        if (!draft.ResponsiblePersonConfirmed)
            issues.Add(Block("responsible_person_unconfirmed", "AI 辅助内容必须由真实责任人确认。"));
        if (draft.Authors.Any(static author => string.IsNullOrWhiteSpace(author.Name)))
            issues.Add(Block("author_profile_mismatch", "作者公开资料缺少稳定展示名。"));
        if (draft.ContainsStrongClaims && draft.Sources.Count == 0)
            issues.Add(Warn("strong_claim_without_source", "强结论尚未提供可核验来源。"));
        if (draft.Sources.Any(static source => string.IsNullOrWhiteSpace(source.Title) || PublicSourceUrlInvalid(source.Url)))
            issues.Add(Warn("source_invalid", "来源标题缺失，或链接不可公开访问。"));
        if (draft.IsSubstantiveUpdate && (string.IsNullOrWhiteSpace(draft.UpdateSummary) || string.IsNullOrWhiteSpace(draft.UpdateReason)))
            issues.Add(Warn("update_note_missing", "实质更新需要说明改了什么以及为什么修改。"));
        if (draft.RequiresMethodsDisclosure && (string.IsNullOrWhiteSpace(draft.Methodology) || string.IsNullOrWhiteSpace(draft.Limitations)))
            issues.Add(Warn("methods_or_limitations_missing", "此内容类型应人工复核方法与局限说明。"));
        return issues;
    }

    private static bool PublicSourceUrlInvalid(string value)
        => ArticleResponsibilityManifestService.PublicUrl(value) is null;

    private static Models.Dtos.PrepublishIssue Block(string code, string message) => new("error", code, message);
    private static Models.Dtos.PrepublishIssue Warn(string code, string message) => new("warning", code, message);
}
