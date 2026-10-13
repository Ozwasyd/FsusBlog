using System.Text.Json;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthoringBulkDraftPreservationTests
{
    [Fact]
    public void DirtySourceMetadataOrCoordinatesCannotAdvanceTheDraft()
    {
        ArticleRevision revision = Revision();
        ArticleDraft clean = Draft();
        Assert.True(AuthoringDraftLifecycleService.BulkDraftMatchesRevision(clean, revision, ArticleStatus.Draft, null));
        Action<ArticleDraft>[] edits =
        [
            draft => draft.MarkdownContent += " private edit",
            draft => draft.Title += " edit",
            draft => draft.Summary = "new summary",
            draft => draft.CoverImageUrl = "new cover",
            draft => draft.CategoryId = 9,
            draft => draft.TagIds = "2,1",
            draft => draft.BaseRevisionId = 99,
            draft => draft.ArticleId = 2,
            draft => draft.Status = ArticleStatus.Scheduled,
            draft => draft.ScheduledPublishAt = DateTime.UnixEpoch
        ];
        foreach (Action<ArticleDraft> edit in edits)
        {
            ArticleDraft dirty = Draft();
            edit(dirty);
            Assert.False(AuthoringDraftLifecycleService.BulkDraftMatchesRevision(dirty, revision, ArticleStatus.Draft, null));
        }
    }

    [Fact]
    public void CanonicalRevisionChangeMustPreserveFullSourceAndMetadata()
    {
        ArticleRevision before = Revision();
        ArticleRevision after = Revision();
        after.Id = 3;
        after.RevisionNo = 2;
        Assert.True(AuthoringDraftLifecycleService.SameBulkDraftContent(before, after));
        after.MarkdownContent += " different body";
        Assert.False(AuthoringDraftLifecycleService.SameBulkDraftContent(before, after));
        after = Revision();
        after.Summary = "different summary";
        Assert.False(AuthoringDraftLifecycleService.SameBulkDraftContent(before, after));
    }

    [Fact]
    public void RightsRequireExactCompleteCustomPolicyAndPreserveOriginalBytes()
    {
        var request = new ArticleRightsRequest { Mode = "custom", LicenseType = "all-rights-reserved", CopyPolicy = "append-attribution" };
        string json = JsonSerializer.Serialize(request, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var rights = new ArticleRightsSnapshot();
        Assert.True(AuthoringDraftLifecycleService.BulkDraftRightsMatch(json, rights));
        Assert.False(AuthoringDraftLifecycleService.BulkDraftRightsMatch(null, rights));
        Assert.False(AuthoringDraftLifecycleService.BulkDraftRightsMatch("{}", rights));
        Assert.False(AuthoringDraftLifecycleService.BulkDraftRightsMatch("broken-json", rights));
        Assert.False(AuthoringDraftLifecycleService.BulkDraftRightsMatch(json.Replace("custom", "site", StringComparison.Ordinal), rights));
        Assert.False(AuthoringDraftLifecycleService.BulkDraftRightsMatch(json.Replace("\"mode\":\"custom\"", "\"mode\":\"custom\",\"mode\":\"custom\"", StringComparison.Ordinal), rights));
        rights.AllowCodeCopy = false;
        Assert.False(AuthoringDraftLifecycleService.BulkDraftRightsMatch(json, rights));
        Assert.Equal(json, JsonSerializer.Serialize(request, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
    }

    private static ArticleRevision Revision()
        => new()
        {
            Id = 1,
            ArticleId = 1,
            RevisionNo = 1,
            Title = "title",
            Summary = "summary",
            CoverImageUrl = "cover",
            CategoryId = 1,
            TagIds = "1,2",
            MarkdownContent = "source-\ud83d\ude80"
        };

    private static ArticleDraft Draft()
        => new()
        {
            Id = 2,
            OwnerAdminPrincipalId = 7,
            ArticleId = 1,
            BaseRevisionId = 1,
            Title = "title",
            Summary = "summary",
            CoverImageUrl = "cover",
            CategoryId = 1,
            TagIds = "1,2",
            MarkdownContent = "source-\ud83d\ude80",
            Status = ArticleStatus.Draft,
            ServerRevision = 4,
            ClientRevision = "client-1"
        };
}
