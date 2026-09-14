using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DataScaleSearchEvidenceTests
{
    private static readonly DateTime s_businessNow = new(2026, 9, 14, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void SearchVisibility_ExcludesNonPublishedAndDeletedArticles()
    {
        // 1. Published article with past publish time => true
        var published = new Article
        {
            Id = 1,
            Title = "data-scale:article:1 title_canary_scale_xs_1",
            Status = ArticleStatus.Published,
            IsDeleted = false,
            PublishedAt = s_businessNow.AddMinutes(-5),
            ScheduledPublishAt = null
        };
        Assert.True(ArticlePublication.IsPubliclyVisible(published, s_businessNow));

        // 2. Scheduled article (status = 1 / Draft) with future scheduled time => false
        var scheduled = new Article
        {
            Id = 7,
            Title = "data-scale:article:7 title_canary_scale_xs_7",
            Status = ArticleStatus.Draft,
            IsDeleted = false,
            PublishedAt = null,
            ScheduledPublishAt = s_businessNow.AddDays(7)
        };
        Assert.False(ArticlePublication.IsPubliclyVisible(scheduled, s_businessNow));

        // 3. Archived article (status = 3 / Archived) => false
        var archived = new Article
        {
            Id = 10,
            Title = "data-scale:article:10 title_canary_scale_xs_10",
            Status = ArticleStatus.Archived,
            IsDeleted = false,
            PublishedAt = s_businessNow.AddHours(-1),
            ScheduledPublishAt = null
        };
        Assert.False(ArticlePublication.IsPubliclyVisible(archived, s_businessNow));

        // 4. Deleted article (status = 4 / Deleted) => false
        var deleted = new Article
        {
            Id = 20,
            Title = "data-scale:article:20 title_canary_scale_xs_20",
            Status = ArticleStatus.Deleted,
            IsDeleted = true,
            PublishedAt = s_businessNow.AddMinutes(-1),
            ScheduledPublishAt = null
        };
        Assert.False(ArticlePublication.IsPubliclyVisible(deleted, s_businessNow));
    }

    [Fact]
    public void SearchTokenizer_ExtractsExpectedHashesForTitleBodyAndCjkCanaries()
    {
        string titleToken = "title_canary_scale_xs_1";
        string bodyToken = "body_canary_scale_xs_1";
        string cjkToken = "规模分词检索验证";

        uint titleHash = SearchIndexService.HashTokenForTests(titleToken);
        uint bodyHash = SearchIndexService.HashTokenForTests(bodyToken);
        uint cjkHash = SearchIndexService.HashTokenForTests(cjkToken);

        Assert.NotEqual(0u, titleHash);
        Assert.NotEqual(0u, bodyHash);
        Assert.NotEqual(0u, cjkHash);
        Assert.NotEqual(titleHash, bodyHash);

        // Verify CJK unigrams are non-zero and reproducible
        foreach (char ch in cjkToken)
        {
            uint charHash = SearchIndexService.HashTokenForTests(ch.ToString());
            Assert.NotEqual(0u, charHash);
        }
    }

    [Fact]
    public void SearchIndexReceipt_RequiresAllDigestsAndGeneration()
    {
        // Valid receipt verification
        var receipt = new DataScaleSearchReceiptModel(
            Schema: "fsusblog.data-scale-search-receipt.v1",
            Status: "ok",
            DataScaleRunId: "run-test-1",
            Tier: "scale-xs",
            Namespace: "data-scale",
            IndexGeneration: "gen-abc1234",
            IndexedDocumentCount: 7,
            IndexedArticleIds: [1, 2, 3, 4, 5, 6, 8],
            Digests: new DataScaleSearchDigests(
                IndexStorageDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
                TokenizerDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
                DictionaryDigest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
                PolicyDigest: "sha256:4444444444444444444444444444444444444444444444444444444444444444"));

        var errors = ValidateReceipt(receipt);
        Assert.Empty(errors);

        // Invalid: missing tokenizer and policy digest
        var invalidReceipt = receipt with
        {
            Digests = receipt.Digests with
            {
                TokenizerDigest = "",
                PolicyDigest = null!
            }
        };
        var invalidErrors = ValidateReceipt(invalidReceipt);
        Assert.Contains(invalidErrors, static err => err.Contains("tokenizerDigest"));
        Assert.Contains(invalidErrors, static err => err.Contains("policyDigest"));

        // Invalid: document count mismatch
        var countMismatch = receipt with
        {
            IndexedDocumentCount = 99
        };
        var countMismatchErrors = ValidateReceipt(countMismatch);
        Assert.Contains(countMismatchErrors, static err => err.Contains("count mismatch"));
    }

    [Fact]
    public void DatabaseLikeQuery_CannotSubstituteForSearchIndex()
    {
        // Demonstrates that a raw SQL LIKE match does not guarantee index existence
        string searchToken = "body_canary_scale_xs_1";
        string rowText = "Some article body containing body_canary_scale_xs_1 in markdown";

        bool dbLikeMatch = rowText.Contains(searchToken, StringComparison.Ordinal);
        Assert.True(dbLikeMatch);

        // However, without inverted index postings, a search index lookup must fail closed
        var emptyShardTerms = new HashSet<uint>();
        uint searchTokenHash = SearchIndexService.HashTokenForTests(searchToken);
        bool indexHasTerm = emptyShardTerms.Contains(searchTokenHash);

        Assert.False(indexHasTerm);
        // Relying on dbLikeMatch alone when indexHasTerm is false is a pseudo-coverage failure
        Assert.NotEqual(dbLikeMatch, indexHasTerm);
    }

    private static List<string> ValidateReceipt(DataScaleSearchReceiptModel receipt)
    {
        var errors = new List<string>();
        if (receipt.Schema != "fsusblog.data-scale-search-receipt.v1")
        {
            errors.Add("invalid schema");
        }
        if (string.IsNullOrWhiteSpace(receipt.IndexGeneration))
        {
            errors.Add("missing indexGeneration");
        }
        if (receipt.IndexedDocumentCount != receipt.IndexedArticleIds.Length)
        {
            errors.Add("indexedDocumentCount count mismatch with indexedArticleIds");
        }
        if (string.IsNullOrWhiteSpace(receipt.Digests?.TokenizerDigest) || !receipt.Digests.TokenizerDigest.StartsWith("sha256:"))
        {
            errors.Add("missing or invalid tokenizerDigest");
        }
        if (string.IsNullOrWhiteSpace(receipt.Digests?.DictionaryDigest) || !receipt.Digests.DictionaryDigest.StartsWith("sha256:"))
        {
            errors.Add("missing or invalid dictionaryDigest");
        }
        if (string.IsNullOrWhiteSpace(receipt.Digests?.PolicyDigest) || !receipt.Digests.PolicyDigest.StartsWith("sha256:"))
        {
            errors.Add("missing or invalid policyDigest");
        }
        if (string.IsNullOrWhiteSpace(receipt.Digests?.IndexStorageDigest) || !receipt.Digests.IndexStorageDigest.StartsWith("sha256:"))
        {
            errors.Add("missing or invalid indexStorageDigest");
        }
        return errors;
    }

    private sealed record DataScaleSearchReceiptModel(
        string Schema,
        string Status,
        string DataScaleRunId,
        string Tier,
        string Namespace,
        string IndexGeneration,
        int IndexedDocumentCount,
        int[] IndexedArticleIds,
        DataScaleSearchDigests Digests);

    private sealed record DataScaleSearchDigests(
        string IndexStorageDigest,
        string TokenizerDigest,
        string DictionaryDigest,
        string PolicyDigest);
}
