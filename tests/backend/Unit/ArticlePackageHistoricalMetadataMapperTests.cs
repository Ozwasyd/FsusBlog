using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Tests.Unit;

public sealed class ArticlePackageHistoricalMetadataMapperTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("https://example.org/Selected%2FRevision?x=1#stored")]
    public void SelectedSnapshot_PreservesNullableUrlAndStoredHashesWithoutGrantingAuthority(string? url)
    {
        var (revision, article) = Input(url);
        var result = ArticlePackageHistoricalMetadataMapper.TryMapCandidate(revision, article, out var projection);
        Assert.True(result.IsValid, result.ReasonCode);
        Assert.NotNull(projection);
        Assert.Equal(11, projection.ArticleRevisionId);
        Assert.Equal(22, projection.RightsSnapshotId);
        Assert.Equal(33, projection.ResponsibilitySnapshotId);
        Assert.Equal(url, projection.Metadata.Input.CanonicalRights.CanonicalUrl);
        Assert.Equal(revision.Rights!.PolicyHash, projection.Metadata.Input.RightsPolicyHash);
        Assert.Equal(revision.Rights.ContentCanonicalHash, projection.Metadata.Input.CanonicalRights.ContentCanonicalHash);
        Assert.False(projection.Metadata.Input.Rights.Enabled);
        Assert.False(projection.Metadata.Input.Rights.ProofBindingEnabled);
        Assert.Equal(revision.Responsibility!.UpdateSummary, projection.Metadata.Input.Responsibility.UpdateSummary);
        Assert.Equal(revision.Responsibility.Authors, projection.Metadata.Input.Responsibility.Authors);
        Assert.Equal(article.Lifecycle, projection.Metadata.Input.Article.Lifecycle);
        Assert.False(projection.Metadata.RequireMetadataAuthority().IsValid);
        Assert.True(ArticlePackageHistoricalMetadataMapper.TryMapCandidate(revision, article, out var repeated).IsValid);
        Assert.Equal(projection.Metadata.ComponentDigest, repeated!.Metadata.ComponentDigest);
    }

    [Theory]
    [InlineData("article")]
    [InlineData("revision")]
    [InlineData("number")]
    [InlineData("title")]
    [InlineData("summary")]
    [InlineData("content")]
    [InlineData("newlines")]
    [InlineData("unicode")]
    [InlineData("leading-zero")]
    [InlineData("overflow")]
    [InlineData("null-revision")]
    [InlineData("null-article")]
    public void CrossedSelection_RejectsWithoutProjection(string change)
    {
        var (revision, article) = Input();
        ArticleRevisionDetailResponse? selected = change switch
        {
            "article" => revision with { ArticleId = 2 },
            "revision" => revision with { Id = "12" },
            "number" => revision with { RevisionNo = 3 },
            "title" => revision with { Title = "Other" },
            "summary" => revision with { Summary = "Other" },
            "content" => revision with { Content = "Other" },
            "newlines" => revision with { Content = "line\n" },
            "unicode" => revision with { Content = "\uD800" },
            "leading-zero" => revision with { Id = "011" },
            "overflow" => revision with { Id = "9223372036854775808" },
            "null-revision" => null,
            _ => revision
        };
        Reject(selected, change == "null-article" ? null : article, "article_package_historical_metadata_source_mismatch");
    }

    [Theory]
    [InlineData("rights", "article_package_historical_rights_snapshot_missing")]
    [InlineData("responsibility", "article_package_historical_responsibility_snapshot_missing")]
    [InlineData("incomplete", "article_package_historical_metadata_snapshot_invalid")]
    [InlineData("rights-id", "article_package_historical_metadata_snapshot_invalid")]
    [InlineData("responsibility-id", "article_package_historical_metadata_snapshot_invalid")]
    public void MissingSnapshot_IsDistinctFromPresentSnapshotWithNullUrl(string change, string reason)
    {
        var (revision, article) = Input(null);
        revision = change switch
        {
            "rights" => revision with { Rights = null },
            "responsibility" => revision with { Responsibility = null },
            "incomplete" => revision with { PackageComplete = false },
            "rights-id" => revision with { Rights = revision.Rights! with { Id = "022" } },
            _ => revision with { Responsibility = revision.Responsibility! with { Id = "0" } }
        };
        Reject(revision, article, reason);
    }

    [Theory]
    [InlineData("url")]
    [InlineData("policy-hash")]
    [InlineData("content-hash")]
    [InlineData("holder")]
    [InlineData("license")]
    public void StoredPolicyMismatch_UsesOriginalCodecAndDoesNotRepairHashes(string change)
    {
        var (revision, article) = Input();
        var rights = revision.Rights!;
        rights = change switch
        {
            "url" => rights with { CanonicalUrl = "https://example.org/other" },
            "policy-hash" => rights with { PolicyHash = "sha256:" + new string('f', 64) },
            "content-hash" => rights with { ContentCanonicalHash = "sha256:" + new string('f', 64) },
            "holder" => rights with { CopyrightHolder = "Other" },
            _ => rights with { LicenseType = "unrecognized" }
        };
        Reject(revision with
        {
            Rights = rights
        }, article);
    }

    [Theory]
    [InlineData("http://127.0.0.1/private")]
    [InlineData("https://user:secret@example.org/private")]
    public void EvenSelfConsistentStoredPolicy_DoesNotBypassPublicUrlRules(string url)
    {
        var (revision, article) = Input(url);
        Reject(revision, article);
    }

    [Fact]
    public void ResponsibilityProjection_IsFrozenAndPrivateEvidenceStillRefuses()
    {
        var (revision, article) = Input();
        var authors = new[] { new ArticleResponsiblePerson("Selected", null) };
        revision = revision with
        {
            Responsibility = revision.Responsibility! with
            {
                Authors = authors
            }
        };
        Assert.True(ArticlePackageHistoricalMetadataMapper.TryMapCandidate(revision, article, out var projection).IsValid);
        authors[0] = new("Changed", null);
        Assert.Equal("Selected", projection!.Metadata.Input.Responsibility.Authors[0].Name);
        revision = revision with
        {
            Responsibility = revision.Responsibility! with
            {
                Sources = [new("Private", "https://example.org/evidence", "paper", null, null, null, false)]
            }
        };
        Reject(revision, article);
    }

    private static void Reject(ArticleRevisionDetailResponse? revision, ArticlePackageManifestArticle? article, string? reason = null)
    {
        var result = ArticlePackageHistoricalMetadataMapper.TryMapCandidate(revision, article, out var projection);
        Assert.False(result.IsValid);
        Assert.Null(projection);
        Assert.NotNull(result.ReasonCode);
        if (reason is not null)
        {
            Assert.Equal(reason, result.ReasonCode);
        }
    }

    private static (ArticleRevisionDetailResponse Revision, ArticlePackageManifestArticle Article) Input(string? url = "https://example.org/selected")
    {
        Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article, "article:00000001-0000-4000-8000-000000000001", out var identity).IsValid);
        Assert.True(ArticlePackageSourceBytes.Inspect("line\r\n"u8, out var bytes).IsValid);
        var canonicalArticle = new ArticleCanonicalInput(1, 11, 2, null, "Title", null, null, 1, [], 0, null, null, "line\r\n");
        string hash = ArticleCanonicalHashV1.ComputeHashHex(canonicalArticle);
        var article = new ArticlePackageManifestArticle(identity, new(1, 11, 2, hash, "site", 4, null, null, null),
            "Title", null, new string('b', 64), new string('c', 64), new string('d', 64), bytes!, new(0, null, null));
        var canonicalRights = new ArticleRightsCanonicalInput(1, 11, 2, "all-rights-reserved", "Holder", 2026,
            "exact\r\n", "{title}", "append-attribution", 0, true, true, url, "sha256:" + hash);
        var rights = new ArticleRevisionRightsSnapshotResponse("22", false, canonicalRights.LicenseType,
            canonicalRights.CopyrightHolder, canonicalRights.CopyrightYear, canonicalRights.RightsStatement,
            canonicalRights.AttributionTemplate, canonicalRights.CopyPolicy, canonicalRights.MaxExcerptChars,
            canonicalRights.AllowCodeCopy, canonicalRights.ShowPublicBadge, false, url,
            ArticleRightsCanonicalHashV1.ComputeHashHex(canonicalRights), canonicalRights.ContentCanonicalHash, DateTime.UnixEpoch);
        var responsibility = new ArticleRevisionResponsibilitySnapshotResponse("33", 3, null, false,
            [new("Ada", "https://example.org/author")], new("Reviewer", null),
            [new("Evidence", "https://example.org/evidence", "paper", new(2026, 10, 8), "v1", "exact note", true)],
            "  exact\r\n", "reason", new(2026, 10, 8, 1, 2, 3, DateTimeKind.Utc), "changed", "method", "scope", "limits", false, DateTime.UnixEpoch);
        return (new("11", 1, 2, "Title", "line\r\n", null, null, 1, [], "diff", "99", DateTime.UnixEpoch,
            null, null, true, rights, responsibility, null), article);
    }
}
