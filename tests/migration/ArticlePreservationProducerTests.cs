using System.Collections.Immutable;

using FsusBlog.Contracts.Articles;
using FsusBlog.Contracts.Migration;

using Xunit;

namespace FsusBlog.Migration.Tests;

// Pure allocation/configuration controls only. No retained tool/native source capability
// is fabricated, and these fixtures cannot qualify publication, registration or a provider.
public sealed class ArticlePreservationProducerTests
{
    [Fact]
    public void Taxonomy_Preserves_Original_Ids_Names_And_Ordinal_Order_Without_First_Match_Collapse()
    {
        ImmutableArray<ArticlePreservationTaxonomyMap> mapped = ArticlePreservationProducer.PreserveTaxonomy(
            [new(9, "same case"), new(3, "Same case")]);
        Assert.Equal(new[] { 3, 9 }, mapped.Select(static map => map.SourceId));
        Assert.All(mapped, static map =>
        {
            Assert.Equal(map.SourceId, map.TargetId);
            Assert.Equal(map.SourceName, map.TargetName);
        });
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("duplicate-id")]
    [InlineData("duplicate-name")]
    [InlineData("nonpositive-id")]
    [InlineData("blank-name")]
    public void Unknown_Or_Collapsing_Taxonomy_Is_Rejected_Before_Package_Publication(string invalid)
    {
        ImmutableArray<LegacyArticlePreservationTaxonomy> rows = invalid switch
        {
            "missing" => default,
            "duplicate-id" => [new(1, "one"), new(1, "two")],
            "duplicate-name" => [new(1, "same"), new(2, "same")],
            "nonpositive-id" => [new(0, "one")],
            _ => [new(1, " ")]
        };
        Assert.Throws<InvalidOperationException>(() => ArticlePreservationProducer.PreserveTaxonomy(rows));
    }

    [Fact]
    public void Packages_Allocate_Stable_Coordinates_And_Share_Only_The_Identical_Raw_Markdown_Block()
    {
        ArticlePreservationSourceExport source = Source(
            Row(9, "body\n"), Row(3, "body\n"), Row(12, "body"));
        ImmutableArray<ArticlePreservationCurrentPackage> packages = Packages(source);
        Assert.Equal(new[] { 3, 9, 12 }, packages.Select(static package => package.Data.SourceArticleId));
        Assert.Equal(new long[] { 3, 3, 12 }, packages.Select(static package => package.Data.Coordinates.ContentBlockId));
        Assert.Equal(new long[] { 3, 9, 12 }, packages.Select(static package => package.Data.Coordinates.PublicationId));
        Assert.All(packages, package =>
        {
            LegacyArticlePreservationRow row = source.Data.Articles.Single(value => value.Id == package.Data.SourceArticleId);
            Assert.Equal(row.Markdown, package.Data.Article.MarkdownContent);
            Assert.Equal(row.CreateTime, package.Data.Coordinates.PublicationTime);
            Assert.Equal(row.CreateTime, package.Data.Article.PublishedAt);
            Assert.Equal(ArticleCurrentPolicyDefaults.UnattributedCreatorId, package.Data.Coordinates.CreatedByAdminPrincipalId);
            Assert.Equal(ArticleCurrentPolicyDefaults.ResponsibilityVersion, package.Data.Coordinates.ResponsibilityVersion);
            Assert.False(package.Data.Responsibility.ResponsiblePersonConfirmed);
            Assert.NotNull(package.Data.DefaultPolicyArtifact);
            Assert.Equal(Inputs().PublicationTransitionKind, package.Data.Coordinates.PublicationTransitionKind);
            Assert.Equal(Inputs().RevisionDiffSummary, package.Data.Coordinates.DiffSummary);
        });
        Assert.All(source.Data.Articles, static row => Assert.Equal(37, row.Views));
    }

    [Fact]
    public void Source_Order_Does_Not_Change_Allocated_Coordinates_Or_Article_Metadata()
    {
        ArticlePreservationSourceExport source = Source(Row(3, "same"), Row(9, "same"));
        // Both source envelopes have their own valid byte binding. Allocation is by
        // source ID, not reader order; policy correctly retains the distinct source SHA.
        ImmutableArray<ArticlePreservationCurrentPackage> first = Packages(source);
        ArticlePreservationSourceExport reversed = Source(Row(9, "same"), Row(3, "same"));
        ImmutableArray<ArticlePreservationCurrentPackage> second = Packages(reversed);
        Assert.Equal(first.Select(static package => package.Data.Coordinates),
            second.Select(static package => package.Data.Coordinates));
        for (int index = 0; index < first.Length; index++)
            Assert.True(ArticlePreservationSemanticReceipt.Serialize(first[index].Data.Article).AsSpan().SequenceEqual(
                ArticlePreservationSemanticReceipt.Serialize(second[index].Data.Article)));
    }

    [Fact]
    public void Deleted_Rows_Keep_The_Current_Default_Policy_Without_Forging_Historical_Administrator_Approval()
    {
        ArticlePreservationCurrentPackage package = Assert.Single(Packages(Source(Row(4, "raw") with
        {
            IsDeleted = true
        })));
        Assert.Equal(ArticleStatusValues.Deleted, package.Data.Article.Status);
        Assert.Equal(ArticleCurrentPolicyDefaults.UnattributedCreatorId, package.Data.Coordinates.CreatedByAdminPrincipalId);
        Assert.False(package.Data.Responsibility.ResponsiblePersonConfirmed);
    }

    [Theory]
    [InlineData("missing-category")]
    [InlineData("missing-tag")]
    [InlineData("duplicate-tag")]
    [InlineData("missing-markdown")]
    [InlineData("duplicate-article")]
    public void Partial_Source_Graph_Is_Rejected_In_The_Same_Package_Builder(string invalid)
    {
        LegacyArticlePreservationRow row = invalid switch
        {
            "missing-category" => Row(3, "raw") with { CategoryId = 99 },
            "missing-tag" => Row(3, "raw") with { TagIds = [99] },
            "duplicate-tag" => Row(3, "raw") with { TagIds = [7, 7] },
            "missing-markdown" => Row(3, "raw") with { Markdown = null },
            _ => Row(3, "raw")
        };
        ArticlePreservationSourceExport source = invalid == "duplicate-article" ? Source(row, row) : Source(row);
        Assert.Throws<InvalidOperationException>(() => Packages(source));
    }

    [Fact]
    public async Task Missing_Real_Provider_Owners_Refuse_Whole_Route_Before_Any_Native_Or_File_Access()
    {
        await Assert.ThrowsAsync<InvalidOperationException>(() => ArticlePreservationProducer.CreateMatchedRouteAsync(
            Inputs(), null!, null!, null!, null!, [], null!, null!, default));
        Assert.Throws<InvalidOperationException>(() => ArticlePreservationProducer.RequireProviderOwners(default));
    }

    [Theory]
    [InlineData("same-source")]
    [InlineData("source-descendant")]
    [InlineData("source-ancestor")]
    [InlineData("same-target")]
    public void Output_Cannot_Mutate_The_Original_Media_Readset_Or_Published_Generation(string overlap)
    {
        string source = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "original-media-root"));
        string target = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "published-media-root"));
        string output = overlap switch
        {
            "same-source" => source,
            "source-descendant" => Path.Combine(source, "output"),
            "source-ancestor" => Path.GetDirectoryName(source)!,
            _ => target
        };
        Assert.Throws<InvalidOperationException>(() => ArticlePreservationProducer.RequireSeparateOutput(output, source, target));
    }

    [Theory]
    [InlineData("missing-origin")]
    [InlineData("relative-origin")]
    [InlineData("missing-budget")]
    [InlineData("relative-output")]
    [InlineData("latest-output")]
    [InlineData("userinfo")]
    [InlineData("missing-transition")]
    [InlineData("missing-audit")]
    public void Missing_Original_Inputs_Cannot_Be_Supplied_By_A_Plan_Or_Current_Facts(string invalid)
    {
        ArticlePreservationProducerInputs valid = Inputs();
        ArticlePreservationProducer.RequireInputs(valid);
        ArticlePreservationProducerInputs changed = invalid switch
        {
            "missing-origin" => valid with { OriginArtifact = null! },
            "relative-origin" => valid with { OriginArtifact = valid.OriginArtifact with { Reference = "source.json" } },
            "missing-budget" => valid with { MaximumOriginBytes = 0 },
            "relative-output" => valid with { OutputDirectory = "output" },
            "latest-output" => valid with { OutputDirectory = Path.Combine(valid.OutputDirectory, "latest") },
            "userinfo" => valid with { DocumentBase = new("https://user@example.test/articles/") },
            "missing-transition" => valid with { PublicationTransitionKind = "" },
            _ => valid with { RevisionDiffSummary = "" }
        };
        Assert.Throws<InvalidOperationException>(() => ArticlePreservationProducer.RequireInputs(changed));
    }

    private static ImmutableArray<ArticlePreservationCurrentPackage> Packages(ArticlePreservationSourceExport source)
    {
        ArticlePreservationDefaultPolicyExport policy = ArticlePreservationPolicyExporter.PrepareDefaultPolicy(
            source, Path.Combine(Inputs().OutputDirectory, "policy.json"), default);
        return ArticlePreservationProducer.PreparePackages(source, policy,
            ArticlePreservationProducer.PreserveTaxonomy(source.Data.Categories),
            ArticlePreservationProducer.PreserveTaxonomy(source.Data.Tags), Inputs(), default);
    }

    private static ArticlePreservationProducerInputs Inputs()
        => new(new(Path.GetFullPath(Path.Combine(Path.GetTempPath(), "original-backup.artifact")), new string('b', 64)),
            new("https://example.test/articles/"), Path.GetFullPath(Path.Combine(Path.GetTempPath(), "article-producer-original-run")),
            1024, "fixture-current-transition", "fixture migration audit");

    private static LegacyArticlePreservationRow Row(int id, string markdown)
        => new(id, "title", markdown, "summary", 5, [7], 37, new DateTime(2026, 5, 17, 12, 0, 0), false);

    private static ArticlePreservationSourceExport Source(params LegacyArticlePreservationRow[] rows)
    {
        var data = new ArticlePreservationSourceData(OfflineMigrationSourceFingerprints.LegacyId,
            new string('c', 64), Inputs().OriginArtifact, Inputs().DocumentBase, rows.Length, 1, 1,
            rows.ToImmutableArray(), [new(5, "original category")], [new(7, "original tag")], "source site author", []);
        byte[] bytes = ArticlePreservationSemanticReceipt.Serialize(data);
        return new(new(Path.Combine(Inputs().OutputDirectory, "source.json"), ArticlePreservationSemanticReceipt.HashBytes(bytes)),
            bytes.ToImmutableArray(), data);
    }
}
