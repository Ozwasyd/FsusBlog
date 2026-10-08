using System.Data;

using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleScaleWriterDifferentialTests
{
    [Theory]
    [InlineData("PayloadJson")]
    [InlineData("CurrentRevisionId")]
    [InlineData("ContentCanonicalHash")]
    [InlineData("CreatedAt")]
    [InlineData("NewBusinessField")]
    public void EveryPersistedFieldParticipatesInDiff(string field)
    {
        DataScaleArticlePhysicalBatch production = Batch(field, "expected");
        ArticleScaleWriterDifferentialResult result = ArticleScaleWriterDifferential.Compare(production, Batch(field, "tampered"));
        Assert.False(result.PhysicalEquivalent);
        Assert.False(result.QualificationEligible);
        Assert.Equal(field, Assert.Single(result.Differences).Field);
        Assert.NotEqual(result.ProductionDigest, result.BulkDigest);
    }

    [Fact]
    public void EqualPhysicalRowsCannotCertifyMissingLogicalAndRecoveryPostconditions()
    {
        DataScaleArticlePhysicalBatch batch = Batch("PayloadJson", "{}") with
        {
            LogicalReferences = [new(ArticleScaleRowKind.ArticleAuditCoordinate, "article/audit/1", new Dictionary<string, object?>())]
        };
        ArticleScaleWriterDifferentialResult result = ArticleScaleWriterDifferential.Compare(batch, batch);
        Assert.True(result.PhysicalEquivalent);
        Assert.False(result.QualificationEligible);
        Assert.Contains("logical-persistence-unverified:ArticleAuditCoordinate", result.MissingPostconditions);
        Assert.Contains("semantic-orphan-verifier-unavailable", result.MissingPostconditions);
        Assert.Contains("owned-recovery-verifier-unavailable", result.MissingPostconditions);
    }

    [Fact]
    public void MissingAndExtraRowsAreComparedEvenWhenTotalCountsMatch()
    {
        DataScaleArticlePhysicalBatch left = Batch("PayloadJson", "{}", 1);
        DataScaleArticlePhysicalBatch right = Batch("PayloadJson", "{}", 2);
        ArticleScaleWriterDifferentialResult result = ArticleScaleWriterDifferential.Compare(left, right);
        Assert.Contains(result.Differences, difference => difference.Kind == "missing-row");
        Assert.Contains(result.Differences, difference => difference.Kind == "extra-row");
    }

    [Fact]
    public void NewColumnCannotBeSilentlyIgnored()
    {
        ArticleScaleWriterDifferentialResult result = ArticleScaleWriterDifferential.Compare(
            Batch("PayloadJson", "{}"), Batch("NewColumn", "{}"));
        Assert.Equal("schema-mismatch", Assert.Single(result.Differences).Kind);
    }

    [Fact]
    public void DuplicateKeysAndTruncatedRowsAreRefused()
    {
        DataScaleArticlePhysicalBatch batch = Batch("PayloadJson", "{}");
        DataScaleBulkTableRows table = batch.Tables[0];
        Assert.Throws<InvalidOperationException>(() => ArticleScaleWriterDifferential.Compare(batch,
            batch with { Tables = [table with { Rows = [table.Rows[0], table.Rows[0]] }] }));
        Assert.Throws<InvalidOperationException>(() => ArticleScaleWriterDifferential.Compare(batch,
            batch with { Tables = [table with { Rows = [new object?[] { 1L }] }] }));
    }

    private static DataScaleArticlePhysicalBatch Batch(string field, object? value, long id = 1)
        => new([new("article", [new("Id", DbType.Int64), new(field, DbType.String)], [new object?[] { id, value }])],
            new Dictionary<string, int> { ["article"] = 0 }, [], new Dictionary<string, long>());
}
