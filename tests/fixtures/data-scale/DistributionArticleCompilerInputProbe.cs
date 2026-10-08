using System.Text.Json;

using FsusBlog.Server.Services.Fixtures.DataScale;
using FsusBlog.Tools.DataScale;

namespace FsusBlog.Tests.Fixtures.DataScale;

/// <summary>
/// Executes the actual owner builder, validator and projection with explicitly unit-only
/// artifact inputs. Its output is a unit probe and cannot attest producer inventory.
/// </summary>
public static class DistributionArticleCompilerInputProbe
{
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);

    public static int Main(string[] args)
    {
        if (args.Length != 2 || !string.Equals(args[0], "--content-catalog", StringComparison.Ordinal))
        {
            throw new ArgumentException("Expected --content-catalog <exact repository content catalog JSON>.");
        }

        ArticleScaleArtifactBindings artifacts = UnitArtifacts(args[1]);
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-l-nightly", "distribution-unit-only", artifacts);
        string ownerDigest = ArticleScalePlanDigest.Compute(plan);
        DistributionArticlePlanCompilerInput input = DistributionArticlePlanCompilerInput.Export(plan, artifacts, ownerDigest);
        int checksPassed = 0;

        void Check(bool condition, string message)
        {
            if (!condition)
            {
                throw new InvalidOperationException(message);
            }
            checksPassed++;
        }

        void Reject(ArticleScalePlan rejected, ArticleScaleArtifactBindings authorities, string expectedDigest)
        {
            try
            {
                DistributionArticlePlanCompilerInput.Export(rejected, authorities, expectedDigest);
            }
            catch (InvalidOperationException)
            {
                checksPassed++;
                return;
            }
            throw new InvalidOperationException("Projection accepted an invalid owner input.");
        }

        Check(ArticleScalePlanValidator.Validate(plan, artifacts).IsValid, "Original owner validator failed.");
        Check(input.OwnerPlanDigest == ownerDigest, "Original owner digest was not preserved.");
        Check(input.ArticleCount == plan.ArticleCount, "Original article count changed.");
        Check(input.ArticleOrdinalBase == plan.IdAllocation.ArticleOrdinalBase, "Original ordinal base changed.");
        Check(input.ScaleTier == plan.ScaleTier && input.Namespace == plan.Namespace, "Original identity changed.");
        Check(input.VariantAllocations.Sum(static allocation => allocation.Count) == plan.ArticleCount, "Allocation total changed.");
        IReadOnlyDictionary<ArticleScaleVariant, int> canonical = ArticleScaleDistributionCatalog.Create(plan.ScaleTier);
        foreach (DistributionArticleVariantAllocation allocation in input.VariantAllocations)
        {
            ArticleScaleVariant variant = Enum.Parse<ArticleScaleVariant>(allocation.Variant);
            Check(allocation.Count == canonical[variant], "Canonical lifecycle allocation changed.");
        }
        Check(input.ArtifactBindings.Content.SequenceEqual(plan.Artifacts.Content), "Owner content references changed.");
        Check(input.ArtifactBindings.Content.All(static reference => reference.ContentDigest.StartsWith("sha256:", StringComparison.Ordinal)),
            "Content references lost catalog digests.");

        Reject(plan, artifacts, "sha256:" + new string('f', 64));
        ArticleScalePlan invalidCount = Reseal(plan with
        {
            ArticleCount = plan.ArticleCount - 1
        });
        Reject(invalidCount, artifacts, invalidCount.ContentDigest);
        ArticleScalePlan unknownTier = Reseal(plan with
        {
            ScaleTier = "unit-only-unknown-tier"
        });
        Reject(unknownTier, artifacts, unknownTier.ContentDigest);
        ArticleScalePlan negativeBase = Reseal(plan with
        {
            IdAllocation = plan.IdAllocation with
            {
                ArticleOrdinalBase = -1
            }
        });
        Reject(negativeBase, artifacts, negativeBase.ContentDigest);
        ArticleScaleVariantAllocation first = plan.StateDistribution[0];
        ArticleScaleVariantAllocation[] wrongAllocations = plan.StateDistribution.ToArray();
        wrongAllocations[0] = first with
        {
            Count = first.Count - 1
        };
        ArticleScalePlan wrongAllocation = Reseal(plan with
        {
            StateDistribution = wrongAllocations
        });
        Reject(wrongAllocation, artifacts, wrongAllocation.ContentDigest);
        ArticleScalePlan duplicateVariant = Reseal(plan with
        {
            StateDistribution = plan.StateDistribution.Select((allocation, index) => index == 1 ? first : allocation).ToArray()
        });
        Reject(duplicateVariant, artifacts, duplicateVariant.ContentDigest);
        ArticleScalePlan staleDigest = plan with
        {
            ContentDigest = "sha256:" + new string('a', 64)
        };
        Reject(staleDigest, artifacts, ownerDigest);
        ArticleScaleArtifactReference[] staleContent = artifacts.Content.ToArray();
        staleContent[0] = staleContent[0] with
        {
            ContentDigest = "sha256:" + new string('b', 64)
        };
        ArticleScaleArtifactBindings staleAuthorities = artifacts with
        {
            Content = staleContent
        };
        Reject(plan, staleAuthorities, ownerDigest);

        try
        {
            ((IList<DistributionArticleVariantAllocation>)input.VariantAllocations)[0] = new("unit-only-mutation", 0);
            throw new InvalidOperationException("Projection allocations are mutable.");
        }
        catch (NotSupportedException)
        {
            checksPassed++;
        }
        try
        {
            ((IList<ArticleScaleArtifactReference>)input.ArtifactBindings.Content)[0] = staleContent[0];
            throw new InvalidOperationException("Projection artifact references are mutable.");
        }
        catch (NotSupportedException)
        {
            checksPassed++;
        }
        ArticleScaleArtifactReference originalContent = input.ArtifactBindings.Content[0];
        ((ArticleScaleArtifactReference[])artifacts.Content)[0] = staleContent[0];
        Check(input.ArtifactBindings.Content[0] == originalContent, "Caller mutation changed the exported snapshot.");

        Console.WriteLine(JsonSerializer.Serialize(new
        {
            Kind = "actual-owner-plan-projection-unit-probe-not-production-receipt",
            ChecksPassed = checksPassed,
            ArtifactValidityClass = "unit-only-unqualified-production-inventory",
            Input = input,
            NativeAllocationInvoked = false,
            DatabaseWriterInvoked = false,
            ReleaseEvidenceEligible = false
        }, s_jsonOptions));
        return 0;
    }

    private static ArticleScalePlan Reseal(ArticleScalePlan plan)
        => plan with
        {
            ContentDigest = ArticleScalePlanDigest.Compute(plan)
        };

    private static ArticleScaleArtifactBindings UnitArtifacts(string contentCatalogPath)
    {
        using JsonDocument catalog = JsonDocument.Parse(File.ReadAllText(contentCatalogPath));
        string schema = catalog.RootElement.GetProperty("schema").GetString()
            ?? throw new InvalidOperationException("Content catalog schema is missing.");
        if (!string.Equals(schema, ArticleScaleContractIds.ContentShapeCatalogSchema, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Content catalog schema is not the original owner authority.");
        }
        ArticleScaleArtifactReference[] content = catalog.RootElement.GetProperty("shapes").EnumerateArray()
            .Where(static shape => shape.GetProperty("eligibility").GetString() == "positive")
            .Select(shape => new ArticleScaleArtifactReference(
                schema,
                "config/testing/content-shape-catalog",
                shape.GetProperty("id").GetString() ?? throw new InvalidOperationException("Content shape ID is missing."),
                shape.GetProperty("contentDigest").GetString() ?? throw new InvalidOperationException("Content shape digest is missing.")))
            .ToArray();
        return new ArticleScaleArtifactBindings(
            new(ArticleScaleContractIds.TemporalArtifactSchema, "unit-only:temporal", "unit-only:temporal-roles", UnitDigest('1')),
            new(ArticleScaleContractIds.FixtureVariantCatalogSchema, "unit-only:distribution", ArticleScaleContractIds.DistributionShape, UnitDigest('2')),
            content,
            [new(ArticleScaleContractIds.MediaShapeCatalogSchema, "unit-only:media", "unit-only:unqualified-media", UnitDigest('3'))],
            [new(ArticleScaleContractIds.FixtureVariantCatalogSchema, "unit-only:taxonomy", ArticleScaleContractIds.TaxonomyShape, UnitDigest('4'))]);
    }

    private static string UnitDigest(char marker) => "sha256:" + new string(marker, 64);
}
