using System.Collections.Immutable;
using System.Runtime.InteropServices;
using System.Text;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;
using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Publication;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class DocumentExportFrozenEmbedSourceBridgeTests
{
    [Fact]
    public async Task ControlledPorts_AssembleOwnedSlotAndRetainTaskMaterializerDenial()
    {
        var ports = new ControlledPorts();
        ArticleEmbedPublicationEdge[] edges = ports.Publication.Plan.Edges.ToArray();
        ArticleEmbedPublicationTargetFacts[] targets = ports.Publication.Authority.Targets.ToArray();
        byte[] bytes = ports.Projection.Bytes.ToArray();
        ports.Publication = ports.Publication with
        {
            Authority = ports.Publication.Authority with
            {
                Targets = targets
            },
            Plan = ports.Publication.Plan with
            {
                Edges = edges
            }
        };
        ports.Projection = ports.Projection with
        {
            Bytes = ImmutableCollectionsMarshal.AsImmutableArray(bytes)
        };
        ports.OnProjectionRead = () =>
        {
            edges[0] = edges[0] with
            {
                OwnerRevision = 999
            };
            targets[0] = targets[0] with
            {
                Permission = ArticleEmbedPermissionStatus.Denied
            };
        };
        ports.OnVerify = () => bytes[0] ^= 1;

        DocumentExportFrozenInput frozen = await ports.FreezeAsync();

        DocumentExportContractValidator.Validate(frozen);
        Assert.Equal(2, ports.AuthorizationCalls);
        Assert.Equal(1, ports.VerificationCalls);
        Assert.Equal(ports.ExpectedPlanDigest, frozen.FrozenEmbeds!.ExpectedPlanDigest);
        Assert.Equal("retained controlled projection", Encoding.UTF8.GetString(frozen.FrozenEmbeds.Projections[0].Bytes.AsSpan()));
        InvalidOperationException refusal = Assert.Throws<InvalidOperationException>(() =>
            DocumentExportContractValidator.Validate(DocumentExportContractTests.ValidTask(frozen), frozen));
        Assert.Equal("document-export-frozen-embed-materializer-unavailable", refusal.Message);
    }

    [Theory]
    [InlineData("actor")]
    [InlineData("context-site")]
    [InlineData("selector")]
    [InlineData("expected-source")]
    [InlineData("publication-coordinate")]
    [InlineData("publication-package")]
    [InlineData("publication-host")]
    [InlineData("persisted-plan")]
    public async Task RefusesSourceOrStoredPublicationBindingDrift(string mutation)
    {
        var ports = new ControlledPorts();
        switch (mutation)
        {
            case "actor":
                ports.Actor = ports.Actor with
                {
                    UserId = 999
                };
                break;
            case "context-site":
                ports.Context = ports.Context with
                {
                    SiteScope = "primary"
                };
                break;
            case "selector":
                ports.Selector = ports.Selector with
                {
                    ExpectedServerRevision = 999
                };
                break;
            case "expected-source":
                ports.Selector = ports.Selector with
                {
                    ExpectedSourceDigest = new string('f', 64)
                };
                break;
            case "publication-coordinate":
                ports.Publication = ports.Publication with
                {
                    Coordinate = ports.Input.Coordinate with
                    {
                        ArticleId = 999
                    }
                };
                break;
            case "publication-package":
                ports.Publication = ports.Publication with
                {
                    SourcePackageDigest = new string('f', 64)
                };
                break;
            case "publication-host":
                ports.Publication = ports.Publication with
                {
                    HostDocument = ports.Publication.HostDocument with
                    {
                        Epoch = 999
                    }
                };
                break;
            case "persisted-plan":
                ports.Publication = ports.Publication with
                {
                    ExpectedPlanDigest = new string('f', 64)
                };
                break;
        }

        await Assert.ThrowsAsync<InvalidDataException>(() => ports.FreezeAsync());
        Assert.Equal(0, ports.VerificationCalls);
    }

    [Fact]
    public async Task ExistingRevisionPackageWithoutDocumentEpochCannotReplaceStoredPublicationAuthority()
    {
        var ports = new ControlledPorts { MissingPublication = true };
        ports.Input = DocumentExportContractTests.ValidInput();
        ports.Selector = new RevisionCompareSourceSelector(RevisionCompareSourceKind.CurrentRevision,
            RevisionId: ports.Input.Coordinate.RevisionId);
        ports.Package = RevisionComparePackageSeal.Create(42, RevisionCompareSourceKind.CurrentRevision,
            "revision:101:3", 101, 3, null, null, ports.Input.MarkdownUtf8.AsSpan(),
            [RevisionCompareMetadataRegistry.String("title", "Controlled title")], Snapshots());
        Assert.True(RevisionComparePackageSeal.Verify(ports.Package));

        await Assert.ThrowsAsync<InvalidDataException>(() => ports.FreezeAsync());
        Assert.Equal(1, ports.PublicationReads);
        Assert.Equal(0, ports.ProjectionReads);
    }

    [Fact]
    public async Task IndependentCodecRefusalCannotBecomeFrozenInput()
    {
        var ports = new ControlledPorts { RejectProjection = true };
        await Assert.ThrowsAsync<InvalidDataException>(() => ports.FreezeAsync());
        Assert.Equal(1, ports.VerificationCalls);
    }

    [Fact]
    public async Task PermissionRevokedDuringProjectionReadPreventsReturn()
    {
        var ports = new ControlledPorts { RevokeAfterAdmission = true };
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() => ports.FreezeAsync());
        Assert.Equal(2, ports.AuthorizationCalls);
    }

    [Fact]
    public async Task CancellationDuringProjectionReadPreventsVerifierAndReturn()
    {
        using var cancellation = new CancellationTokenSource();
        var ports = new ControlledPorts { OnProjectionRead = cancellation.Cancel };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ports.FreezeAsync(cancellation.Token));
        Assert.Equal(0, ports.VerificationCalls);
    }

    [Fact]
    public async Task ReaderByteSealDriftIsRejectedBeforeIndependentVerifier()
    {
        var ports = new ControlledPorts();
        ports.Projection = ports.Projection with
        {
            ByteDigest = "sha256:" + new string('f', 64)
        };
        await Assert.ThrowsAsync<InvalidDataException>(() => ports.FreezeAsync());
        Assert.Equal(0, ports.VerificationCalls);
    }

    [Fact]
    public async Task MissingStoredPublicationDoesNotReplanOrReturnAnEmptySlot()
    {
        var ports = new ControlledPorts { MissingPublication = true };
        await Assert.ThrowsAsync<InvalidDataException>(() => ports.FreezeAsync());
        Assert.Equal(0, ports.ProjectionReads);
    }

    private static IEnumerable<RevisionCompareSnapshot> Snapshots()
        => Enum.GetValues<RevisionCompareSnapshotKind>().Select(RevisionCompareSnapshot.NotApplicable);

    // These controlled ports verify bridge behavior only. They do not qualify a
    // production reader, parser, codec, configured site mapping or retention store.
    private sealed class ControlledPorts : IRevisionComparePackageReader,
        IDocumentExportJobAuthorization, IDocumentExportFrozenEmbedPublicationReader,
        IDocumentExportFrozenEmbedProjectionReader, IDocumentExportFrozenEmbedProjectionVerifier
    {
        public ControlledPorts()
        {
            Input = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidInput() with
            {
                Coordinate = new DocumentExportArticleCoordinate(DocumentExportCoordinateKind.Draft, 42,
                    "draft:controlled", null, null, 3)
            });
            Actor = new DocumentExportJobActor(Input.UserId, Input.SiteScope, "session:controlled");
            Context = new RevisionCompareReadContext(Input.UserId, Input.SiteScope, Guid.NewGuid());
            Selector = new RevisionCompareSourceSelector(RevisionCompareSourceKind.CurrentDraft,
                DraftKey: Input.Coordinate.DraftKey, ExpectedServerRevision: 3, DocumentEpoch: "draft-epoch:controlled");
            Package = RevisionComparePackageSeal.Create(42, RevisionCompareSourceKind.CurrentDraft,
                "draft:controlled:3", null, null, 3, Selector.DocumentEpoch, Input.MarkdownUtf8.AsSpan(),
                [RevisionCompareMetadataRegistry.String("title", "Controlled title")], Snapshots());
            const string Host = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
            const string Target = "article:01991e72-a611-7d16-9fd4-38f7d2e65498";
            string digest = new('a', 64);
            var embedActor = new ArticleEmbedActorContext("actor:01991e72-dbed-74bd-a467-027699b78ad8", "site:primary", digest);
            var runtime = new ArticleEmbedRuntimeContext("article-embed", 1, ArticleEmbedSchemas.ProviderRuntime, digest);
            var document = new ArticleEmbedDocumentIdentity("document:host-1", 3);
            var reference = new ArticleEmbedSafeProjectionReference(ArticleEmbedProjectionKind.SafeProjection,
                "projection:public-body", digest);
            var budgets = new ArticleEmbedResolutionBudgetLimits(8, 64, 1_048_576, 60_000, 128);
            var facts = new ArticleEmbedPublicationTargetFacts(Target, embedActor.SiteIdentity, 1, 4, 4,
                ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Published,
                ArticleEmbedPermissionStatus.Allowed, true, digest, "version:4", digest, 128,
                "Controlled target", reference, [], [], []);
            ArticleEmbedPublicationAuthority authority = ArticleEmbedPublicationContractValidator.Seal(
                new ArticleEmbedPublicationAuthority(ArticleEmbedPublicationSchemas.Authority,
                    ArticleEmbedPublicationSchemas.Version, Host, document, 3, digest, "publication:controlled",
                    4, 1, embedActor, runtime, "zh-CN", "light", true, [facts], string.Empty));
            ArticleEmbedProviderRequest request = ArticleEmbedContractValidator.Seal(new ArticleEmbedProviderRequest(
                ArticleEmbedSchemas.ProviderRequest, ArticleEmbedSchemas.Version, "request:controlled", Host,
                document, 3, new ArticleEmbedDirectiveProjection(ArticleEmbedSchemas.ParserContract, Target,
                    ArticleEmbedTargetKind.Article, new ArticleEmbedSourceRange(0, 32)),
                new ArticleEmbedTargetIdentity(Target, ArticleEmbedTargetKind.Article, null, null),
                ArticleEmbedRequestedScope.PublicationPlan, embedActor, runtime, digest, string.Empty, CancellationToken.None));
            ArticleEmbedProviderRequest[] requests = [request];
            ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, budgets);
            ArticleEmbedRelationDerivation derivation = ArticleEmbedRelationDeriver.DeriveFromPlan(requests, authority, budgets, plan);
            ExpectedPlanDigest = plan.PlanDigest;
            Publication = new DocumentExportFrozenEmbedPublicationSource(Input.UserId, Input.SiteScope,
                Input.Coordinate, Package.PackageDigest, Package.DocumentEpoch!, Host, document, ExpectedPlanDigest,
                requests, authority, budgets, plan, derivation);
            byte[] bytes = Encoding.UTF8.GetBytes("retained controlled projection");
            Projection = new DocumentExportFrozenEmbedProjection(Assert.Single(derivation.DependencyReceipts),
                reference, bytes.ToImmutableArray(), DocumentExportDigest.ComputeBytes(bytes));
        }

        public DocumentExportFrozenInput Input
        {
            get; set;
        }
        public DocumentExportJobActor Actor
        {
            get; set;
        }
        public RevisionCompareReadContext Context
        {
            get; set;
        }
        public RevisionCompareSourceSelector Selector
        {
            get; set;
        }
        public RevisionComparePackage Package
        {
            get; set;
        }
        public DocumentExportFrozenEmbedPublicationSource Publication
        {
            get; set;
        }
        public DocumentExportFrozenEmbedProjection Projection
        {
            get; set;
        }
        public string ExpectedPlanDigest
        {
            get;
        }
        public int AuthorizationCalls
        {
            get; private set;
        }
        public int PublicationReads
        {
            get; private set;
        }
        public int ProjectionReads
        {
            get; private set;
        }
        public int VerificationCalls
        {
            get; private set;
        }
        public bool RejectProjection
        {
            get; init;
        }
        public bool RevokeAfterAdmission
        {
            get; init;
        }
        public bool MissingPublication
        {
            get; init;
        }
        public Action? OnProjectionRead
        {
            get; set;
        }
        public Action? OnVerify
        {
            get; set;
        }

        public Task<DocumentExportFrozenInput> FreezeAsync(CancellationToken cancellationToken = default)
            => new DocumentExportFrozenEmbedSourceBridge(this, this, this, this, this)
                .FreezeAsync(Actor, Context, Selector, Input, cancellationToken);

        public Task<RevisionComparePackageReadResult> ReadAuthorizedAsync(RevisionCompareReadContext context,
            int articleId, RevisionCompareSourceSelector selector, CancellationToken cancellationToken)
            => Task.FromResult(RevisionComparePackageReadResult.Available(Package));

        public ValueTask<bool> IsAllowedAsync(DocumentExportJobActor actor, DocumentExportArticleCoordinate coordinate,
            DocumentExportJobOperation operation, CancellationToken cancellationToken)
        {
            AuthorizationCalls++;
            Assert.Equal(DocumentExportJobOperation.Create, operation);
            return ValueTask.FromResult(!RevokeAfterAdmission || AuthorizationCalls == 1);
        }

        public Task<DocumentExportFrozenEmbedPublicationSource?> ReadAsync(DocumentExportJobActor actor,
            DocumentExportArticleCoordinate coordinate, RevisionComparePackage package, CancellationToken cancellationToken)
        {
            PublicationReads++;
            return Task.FromResult(MissingPublication ? null : Publication);
        }

        public Task<DocumentExportFrozenEmbedProjection?> ReadAsync(DocumentExportJobActor actor,
            ArticleEmbedDependencyReceipt dependency, CancellationToken cancellationToken)
        {
            ProjectionReads++;
            Assert.Equal(Projection.Dependency, dependency);
            OnProjectionRead?.Invoke();
            return Task.FromResult<DocumentExportFrozenEmbedProjection?>(Projection);
        }

        public Task VerifyAsync(DocumentExportJobActor actor, DocumentExportFrozenEmbedPublicationSource publication,
            DocumentExportFrozenEmbedProjection projection, CancellationToken cancellationToken)
        {
            VerificationCalls++;
            OnVerify?.Invoke();
            return RejectProjection ? Task.FromException(new InvalidDataException("controlled-codec-refusal")) : Task.CompletedTask;
        }
    }
}
