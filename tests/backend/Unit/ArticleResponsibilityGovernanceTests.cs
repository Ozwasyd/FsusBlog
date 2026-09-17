using FsusBlog.Server.Infrastructure.Integrity;

namespace FsusBlog.Tests.Unit;

public sealed class ArticleResponsibilityGovernanceTests
{
    [Fact]
    public void Evaluate_AllowsSiteAuthorInheritanceAndOptionalReviewer()
    {
        ArticleResponsibilityDraft draft = ValidDraft() with
        {
            InheritSiteAuthor = true,
            Authors = [],
            Reviewer = null
        };

        Assert.Empty(ArticleResponsibilityGovernance.Evaluate(draft));
    }

    [Fact]
    public void Evaluate_BlocksMissingResponsibilityAndProfileMismatch()
    {
        ArticleResponsibilityDraft draft = ValidDraft() with
        {
            InheritSiteAuthor = false,
            Authors = [new ArticleResponsiblePerson("", "https://example.test/author")],
            ResponsiblePersonConfirmed = false
        };

        string[] codes = ArticleResponsibilityGovernance.Evaluate(draft).Select(static issue => issue.Code).ToArray();

        Assert.Contains("author_profile_mismatch", codes);
        Assert.Contains("responsible_person_unconfirmed", codes);
    }

    [Fact]
    public void Evaluate_WarnsForStrongClaimsBadSourcesAndMissingUpdateNote()
    {
        ArticleResponsibilityDraft draft = ValidDraft() with
        {
            ContainsStrongClaims = true,
            Sources = [new ArticleEvidenceSource("", "javascript:alert(1)", "web", null, null, null)],
            IsSubstantiveUpdate = true,
            UpdateSummary = null,
            UpdateReason = null,
            RequiresMethodsDisclosure = true,
            Methodology = null,
            Limitations = null
        };

        string[] codes = ArticleResponsibilityGovernance.Evaluate(draft).Select(static issue => issue.Code).ToArray();

        Assert.Contains("source_invalid", codes);
        Assert.Contains("update_note_missing", codes);
        Assert.Contains("methods_or_limitations_missing", codes);
        Assert.DoesNotContain(codes, static code => code.Contains("score", StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData("https://example.test/profile", true)]
    [InlineData("http://example.test/source", true)]
    [InlineData("javascript:alert(1)", false)]
    [InlineData("https://user:secret@example.test/private", false)]
    [InlineData("http://127.0.0.1/internal", false)]
    [InlineData("http://192.168.1.20/internal", false)]
    [InlineData("http://localhost/internal", false)]
    [InlineData("/relative", false)]
    public void PublicUrl_OnlyAcceptsSafeAbsoluteHttpLinks(string value, bool accepted)
    {
        Assert.Equal(accepted, ArticleResponsibilityManifestService.PublicUrl(value) is not null);
    }

    [Theory]
    [InlineData("ready", "ready")]
    [InlineData("FAILED", "failed")]
    [InlineData("pending", "unavailable")]
    [InlineData(null, "unavailable")]
    public void NormalizeProofStatus_OnlyExposesStablePublicStates(string? value, string expected)
    {
        Assert.Equal(expected, ArticleResponsibilityManifestService.NormalizeProofStatus(value));
    }

    [Fact]
    public void SiteAuthorFallback_IsDeterministicAndDoesNotInventProfiles()
    {
        IReadOnlyList<ArticleResponsiblePerson> first = ArticleResponsibilityManifestService.BuildSiteAuthorFallback(" Site Author ");
        IReadOnlyList<ArticleResponsiblePerson> second = ArticleResponsibilityManifestService.BuildSiteAuthorFallback(" Site Author ");

        Assert.Equal(first, second);
        Assert.Equal("Site Author", Assert.Single(first).Name);
        Assert.Null(first[0].ProfileUrl);
    }

    [Fact]
    public void PreRevisionLegacyFallback_IsStableAndDoesNotInventRevisionProof()
    {
        ArticleResponsibilityManifestResponse manifest =
            ArticleResponsibilityManifestService.BuildPreRevisionLegacyFallback(42, " Site Author ");

        Assert.Equal(0, manifest.RevisionNo);
        Assert.True(manifest.InheritsSiteAuthor);
        Assert.True(manifest.LegacyFallback);
        Assert.Equal("Site Author", Assert.Single(manifest.Authors).Name);
        Assert.Equal("/integrity/article/42", manifest.Verification.Url);
        Assert.Equal("unavailable", manifest.Verification.ProofStatus);
        Assert.Null(manifest.Verification.ContentHash);
    }

    [Fact]
    public void PublicManifestContract_DoesNotExposePrivateAuditOrFailureDetailFields()
    {
        string[] names = typeof(ArticleResponsibilityManifestResponse).GetProperties()
            .Select(static property => property.Name)
            .Concat(typeof(ArticleVerificationSummary).GetProperties().Select(static property => property.Name))
            .ToArray();

        Assert.DoesNotContain(names, static name => name.Contains("Admin", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(names, static name => name.Contains("Draft", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(names, static name => name.Contains("FailureDetail", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(names, static name => name.Contains("Audit", StringComparison.OrdinalIgnoreCase));
    }

    private static ArticleResponsibilityDraft ValidDraft() => new(
        InheritSiteAuthor: false,
        Authors: [new ArticleResponsiblePerson("Alice", "https://example.test/alice")],
        Reviewer: new ArticleResponsiblePerson("Bob", "https://example.test/bob"),
        Sources: [new ArticleEvidenceSource("Specification", "https://example.test/spec", "primary", new DateOnly(2026, 7, 14), "v1", null)],
        UpdateSummary: "Clarified the result.",
        UpdateReason: "New primary evidence.",
        EffectiveAt: new DateTime(2026, 7, 14, 0, 0, 0, DateTimeKind.Utc),
        ConclusionImpact: "clarified",
        Methodology: "Document review.",
        Applicability: "Public deployment.",
        Limitations: "No production identifiers inspected.",
        ResponsiblePersonConfirmed: true,
        ContainsStrongClaims: false,
        IsSubstantiveUpdate: false,
        RequiresMethodsDisclosure: false,
        ExpectedVersion: 0);
}
