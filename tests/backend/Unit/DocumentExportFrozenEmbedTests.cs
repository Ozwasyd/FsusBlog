using System.Collections.Immutable;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;

using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Publication;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class DocumentExportFrozenEmbedTests
{
    [Fact]
    public void Seal_RetainsOwnedPlanReceiptsAndCompleteOpaqueBytes()
    {
        DocumentExportFrozenEmbeds slot = Slot();
        byte[] bytes = slot.Projections[0].Bytes.ToArray();
        ArticleEmbedPublicationEdge[] edges = slot.Plan.Edges.ToArray();
        ArticleEmbedPublicationReceiptItem[] items = slot.Plan.Receipt.Items.ToArray();
        ArticleEmbedRelationEdge[] relations = slot.Derivation.EdgeSet!.Edges.ToArray();
        ArticleEmbedDependencyReceipt[] dependencies = slot.Derivation.DependencyReceipts.ToArray();
        slot = slot with
        {
            Plan = slot.Plan with
            {
                Edges = ImmutableCollectionsMarshal.AsImmutableArray(edges),
                Receipt = slot.Plan.Receipt with
                {
                    Items = ImmutableCollectionsMarshal.AsImmutableArray(items)
                }
            },
            Derivation = slot.Derivation with
            {
                DependencyReceipts = ImmutableCollectionsMarshal.AsImmutableArray(dependencies),
                EdgeSet = slot.Derivation.EdgeSet with
                {
                    Edges = ImmutableCollectionsMarshal.AsImmutableArray(relations)
                }
            },
            Projections =
            [
                slot.Projections[0] with
                {
                    Bytes = ImmutableCollectionsMarshal.AsImmutableArray(bytes)
                }
            ]
        };
        DocumentExportFrozenInput original = DocumentExportContractTests.ValidInput();
        DocumentExportFrozenInput frozen = DocumentExportContractValidator.Seal(original with
        {
            FrozenEmbeds = slot
        });
        bytes[0] ^= 1;
        edges[0] = edges[0] with
        {
            OwnerRevision = 999
        };
        items[0] = items[0] with
        {
            RequestId = "request:changed"
        };
        relations[0] = relations[0] with
        {
            LatestObservedRevision = 999
        };
        dependencies[0] = dependencies[0] with
        {
            PlanDigest = new string('f', 64)
        };

        DocumentExportContractValidator.Validate(frozen);
        Assert.NotEqual(original.ContentDigest, frozen.ContentDigest);
        Assert.Equal(slot.ExpectedPlanDigest, frozen.FrozenEmbeds!.ExpectedPlanDigest);
        Assert.Equal("opaque upstream projection bytes", Encoding.UTF8.GetString(frozen.FrozenEmbeds.Projections[0].Bytes.AsSpan()));
        DocumentExportFrozenInput restored = DocumentExportDigest.Deserialize<DocumentExportFrozenInput>(
            DocumentExportDigest.Serialize(frozen));
        DocumentExportContractValidator.Validate(restored);
        Assert.Equal(frozen.ContentDigest, restored.ContentDigest);
    }

    [Fact]
    public void CandidateCannotReplaceThePersistedExpectedPlanDigest()
    {
        DocumentExportFrozenEmbeds earlier = Slot(revision: 4);
        DocumentExportFrozenEmbeds newer = Slot(revision: 5);
        Assert.NotEqual(earlier.ExpectedPlanDigest, newer.ExpectedPlanDigest);
        Assert.Throws<InvalidDataException>(() => DocumentExportFrozenEmbedContract.Validate(
            newer with
            {
                ExpectedPlanDigest = earlier.ExpectedPlanDigest
            }, sourceBytes: 1));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("null-entry")]
    [InlineData("null-reference")]
    [InlineData("partial")]
    [InlineData("bytes")]
    [InlineData("byte-digest")]
    [InlineData("projection")]
    [InlineData("kind")]
    [InlineData("receipt")]
    [InlineData("plan")]
    public void RefusesIncompleteOrDriftedFrozenProjection(string mutation)
    {
        DocumentExportFrozenEmbeds slot = Slot();
        DocumentExportFrozenEmbedProjection projection = slot.Projections[0];
        projection = mutation switch
        {
            "null-reference" => projection with
            {
                Projection = null!
            },
            "bytes" => projection with
            {
                Bytes = []
            },
            "byte-digest" => projection with
            {
                ByteDigest = "sha256:" + new string('f', 64)
            },
            "projection" => projection with
            {
                Projection = projection.Projection with
                {
                    ProjectionIdentity = "projection:other"
                }
            },
            "kind" => projection with
            {
                Projection = projection.Projection with
                {
                    Kind = (ArticleEmbedProjectionKind)99
                }
            },
            "receipt" => projection with
            {
                Dependency = projection.Dependency with
                {
                    PlanDigest = new string('f', 64)
                }
            },
            _ => projection
        };
        slot = mutation switch
        {
            "missing" => slot with
            {
                Projections = default
            },
            "null-entry" => slot with
            {
                Projections = [null!]
            },
            "partial" => slot with
            {
                Projections = []
            },
            "plan" => slot with
            {
                ExpectedPlanDigest = "sha256:" + slot.ExpectedPlanDigest
            },
            _ => slot with
            {
                Projections = [projection]
            }
        };
        Assert.Throws<InvalidDataException>(() => DocumentExportFrozenEmbedContract.Validate(slot, sourceBytes: 1));
    }

    [Fact]
    public void SourceAndRetainedProjectionShareTheInputByteCeiling()
    {
        Assert.Throws<InvalidDataException>(() => DocumentExportFrozenEmbedContract.Validate(
            Slot(), sourceBytes: 32L * 1024 * 1024));
    }

    [Fact]
    public void CompleteByteSealDoesNotAuthorizeAnUnavailableMaterializer()
    {
        DocumentExportFrozenInput input = DocumentExportContractValidator.Seal(
            DocumentExportContractTests.ValidInput() with
            {
                FrozenEmbeds = Slot()
            });
        DocumentExportContractValidator.Validate(input);
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        InvalidOperationException refused = Assert.Throws<InvalidOperationException>(() =>
            DocumentExportContractValidator.Validate(task, input));
        Assert.Equal("document-export-frozen-embed-materializer-unavailable", refused.Message);
    }

    [Fact]
    public void V4RequiresTheSlotMemberEvenWhenNoEmbedsArePresent()
    {
        JsonObject value = JsonNode.Parse(DocumentExportDigest.Serialize(DocumentExportContractTests.ValidInput()))!.AsObject();
        value.Remove("frozenEmbeds");
        Assert.Throws<InvalidDataException>(() => DocumentExportDigest.Deserialize<DocumentExportFrozenInput>(
            Encoding.UTF8.GetBytes(value.ToJsonString())));
    }

    private static DocumentExportFrozenEmbeds Slot(long revision = 4)
    {
        const string Host = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
        const string TargetId = "article:01991e72-a611-7d16-9fd4-38f7d2e65498";
        string digest = new('a', 64);
        var actor = new ArticleEmbedActorContext("actor:01991e72-dbed-74bd-a467-027699b78ad8", "site:primary", digest);
        var runtime = new ArticleEmbedRuntimeContext("article-embed", 1, ArticleEmbedSchemas.ProviderRuntime, digest);
        var document = new ArticleEmbedDocumentIdentity("document:host-1", 3);
        var reference = new ArticleEmbedSafeProjectionReference(ArticleEmbedProjectionKind.SafeProjection, "projection:public-body", digest);
        var budgets = new ArticleEmbedResolutionBudgetLimits(8, 64, 1_048_576, 60_000, 128);
        var facts = new ArticleEmbedPublicationTargetFacts(
            TargetId, actor.SiteIdentity, 1, revision, revision,
            ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Published,
            ArticleEmbedPermissionStatus.Allowed, true, digest, $"version:{revision}", digest,
            128, "Target display", reference, [], [], []);
        ArticleEmbedPublicationAuthority authority = ArticleEmbedPublicationContractValidator.Seal(
            new ArticleEmbedPublicationAuthority(ArticleEmbedPublicationSchemas.Authority,
                ArticleEmbedPublicationSchemas.Version, Host, document, 8, digest,
                "publication:request-1", 9, 1, actor, runtime, "zh-CN", "light", true, [facts], string.Empty));
        var target = new ArticleEmbedTargetIdentity(TargetId, ArticleEmbedTargetKind.Article, null, null);
        var directive = new ArticleEmbedDirectiveProjection(ArticleEmbedSchemas.ParserContract,
            TargetId, ArticleEmbedTargetKind.Article, new ArticleEmbedSourceRange(0, 32));
        ArticleEmbedProviderRequest request = ArticleEmbedContractValidator.Seal(new ArticleEmbedProviderRequest(
            ArticleEmbedSchemas.ProviderRequest, ArticleEmbedSchemas.Version, "request:embed-1", Host,
            document, 8, directive, target, ArticleEmbedRequestedScope.PublicationPlan,
            actor, runtime, digest, string.Empty, CancellationToken.None));
        ArticleEmbedProviderRequest[] requests = [request];
        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, budgets);
        ArticleEmbedRelationDerivation derivation = ArticleEmbedRelationDeriver.DeriveFromPlan(requests, authority, budgets, plan);
        Assert.True(ArticleEmbedPublicationVerifier.Verify(requests, authority, budgets, plan).Valid);
        Assert.True(ArticleEmbedRelationVerifier.VerifyFromPlan(requests, authority, budgets, plan, derivation).Valid);
        byte[] bytes = Encoding.UTF8.GetBytes("opaque upstream projection bytes");
        return new DocumentExportFrozenEmbeds(plan.PlanDigest, plan, derivation,
            [new DocumentExportFrozenEmbedProjection(Assert.Single(derivation.DependencyReceipts), reference,
                bytes.ToImmutableArray(), DocumentExportDigest.ComputeBytes(bytes))]);
    }
}
