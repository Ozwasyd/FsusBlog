using System.Text;

using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultFrozenEmbedAdmissionTests
{
    private const string Host = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private const string Target = "article:01991e72-a611-7d16-9fd4-38f7d2e65498";
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public void PublishedCoordinateRemainsFrozenWhenLatestTargetChanges()
    {
        using var fixture = new Fixture();
        ArticleVaultFrozenEmbedInput input = fixture.Input("published", latest: 99);
        ArticleVaultFrozenEmbedCandidate candidate = ArticleVaultFrozenEmbedAdmission.Compare(input);

        Assert.True(candidate.Permitted);
        Assert.Equal(17, candidate.After!.ResolvedRevision);
        Assert.Equal(input.Base, candidate.Before);
        Assert.Equal(input.Base, candidate.After);
        Assert.True(ArticleVaultFrozenEmbedAdmission.Verify(input, candidate));
        Assert.Equal(input.Request.Directive.RawRange, candidate.Provenance!.SourceRange);
        Assert.Equal(input.Request.SourceRevision, candidate.Provenance.ExpectedSourceRevision);
        Assert.Equal(input.Request.ContentDigest, candidate.Provenance.SourceSha256);
        Assert.Equal(input.Authority.SnapshotDigest, candidate.Provenance.AuthoritySha256);
        Assert.Equal(input.Resolution.Receipt.Observed, candidate.Provenance.Observed);
    }

    [Fact]
    public void CandidateCannotDropOrSubstituteItsOccurrenceProvenance()
    {
        using var fixture = new Fixture();
        ArticleVaultFrozenEmbedInput input = fixture.Input("published");
        ArticleVaultFrozenEmbedCandidate candidate = ArticleVaultFrozenEmbedAdmission.Compare(input);
        Assert.False(ArticleVaultFrozenEmbedAdmission.Verify(input, candidate with
        {
            Provenance = null
        }));
        Assert.False(ArticleVaultFrozenEmbedAdmission.Verify(input, candidate with
        {
            Provenance = candidate.Provenance! with
            {
                SourceRange = new ArticleEmbedSourceRange(1, 41)
            }
        }));
    }

    [Fact]
    public void RejectedDiagnosticCannotBeUsedAsAnAdmittedCandidate()
    {
        using var fixture = new Fixture();
        ArticleVaultFrozenEmbedInput input = fixture.Input("published") with
        {
            ExplicitDraftRefresh = true
        };
        ArticleVaultFrozenEmbedCandidate candidate = ArticleVaultFrozenEmbedAdmission.Compare(input);
        Assert.False(candidate.Permitted);
        Assert.Null(candidate.Provenance);
        Assert.False(ArticleVaultFrozenEmbedAdmission.Verify(input, candidate));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PublishedHostNeverAdmitsLocalRefresh(bool explicitRefresh)
    {
        using var fixture = new Fixture();
        ArticleVaultFrozenEmbedInput input = fixture.Input("published") with
        {
            Local = Coordinate(18),
            ExplicitDraftRefresh = explicitRefresh
        };

        AssertRejected(input, "vault_embed_published_coordinate_drift");
    }

    [Fact]
    public void DraftRefreshRequiresExplicitActionAndExactNewCoordinate()
    {
        using var fixture = new Fixture();
        ArticleVaultFrozenEmbedInput input = fixture.Input("draft", revision: 18) with
        {
            Base = Coordinate(17),
            Server = Coordinate(17),
            ExplicitDraftRefresh = true
        };
        ArticleVaultFrozenEmbedCandidate candidate = ArticleVaultFrozenEmbedAdmission.Compare(input);

        Assert.True(candidate.Permitted);
        Assert.Equal(17, candidate.Before!.ResolvedRevision);
        Assert.Equal(18, candidate.After!.ResolvedRevision);
        AssertRejected(input with
        {
            ExplicitDraftRefresh = false
        }, "vault_embed_explicit_refresh_required");
        AssertRejected(input with
        {
            Local = Coordinate(19)
        }, "vault_embed_exact_coordinate_unavailable");
    }

    [Fact]
    public void ConcurrentFrozenCoordinateChangesAreAnOverlap()
    {
        using var fixture = new Fixture();
        ArticleVaultFrozenEmbedInput input = fixture.Input("draft", revision: 19) with
        {
            Base = Coordinate(17),
            Local = Coordinate(18),
            ExplicitDraftRefresh = true
        };
        AssertRejected(input, "vault_embed_coordinate_overlap");
    }

    [Fact]
    public void LatestResolutionCannotReplaceAnExactPublishedCoordinate()
    {
        using var fixture = new Fixture();
        ArticleVaultFrozenEmbedInput input = fixture.Input("published", revision: 18) with
        {
            Base = Coordinate(17),
            Local = Coordinate(17),
            Server = Coordinate(17)
        };
        AssertRejected(input, "vault_embed_exact_coordinate_unavailable");
    }

    [Theory]
    [InlineData(ArticleEmbedPermissionStatus.Denied, ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Published)]
    [InlineData(ArticleEmbedPermissionStatus.Unknown, ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Published)]
    [InlineData(ArticleEmbedPermissionStatus.Allowed, ArticleEmbedVisibilityStatus.Private, ArticleEmbedLifecycleStatus.Published)]
    [InlineData(ArticleEmbedPermissionStatus.Allowed, ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Draft)]
    [InlineData(ArticleEmbedPermissionStatus.Allowed, ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Deleted)]
    public void UnavailableTargetsHaveNoCoordinateOrExistenceSpecificReceipt(
        ArticleEmbedPermissionStatus permission,
        ArticleEmbedVisibilityStatus visibility,
        ArticleEmbedLifecycleStatus lifecycle)
    {
        using var fixture = new Fixture();
        ArticleVaultFrozenEmbedInput input = fixture.Input("published", permission: permission, visibility: visibility, lifecycle: lifecycle);
        AssertRejected(input, "vault_embed_target_unavailable");
    }

    [Theory]
    [InlineData("scheduled")]
    [InlineData("archived")]
    [InlineData("deleted")]
    public void NonEditableHostIsBlocked(string lifecycle)
    {
        using var fixture = new Fixture();
        AssertRejected(fixture.Input(lifecycle), "vault_embed_host_not_editable");
    }

    [Fact]
    public void CoordinateAndCandidateTamperAreRejected()
    {
        using var fixture = new Fixture();
        ArticleVaultFrozenEmbedInput input = fixture.Input("published");
        AssertRejected(input with
        {
            Local = input.Local with
            {
                ResolvedRevision = 18
            }
        }, "vault_embed_input_invalid");
        ArticleVaultFrozenEmbedCandidate candidate = ArticleVaultFrozenEmbedAdmission.Compare(input);
        Assert.False(ArticleVaultFrozenEmbedAdmission.Verify(input, candidate with
        {
            After = Coordinate(18)
        }));
        Assert.False(ArticleVaultFrozenEmbedAdmission.Verify(input, candidate with
        {
            ContentSha256 = Digest
        }));
    }

    [Fact]
    public void StaleSourceCrossSiteAndBudgetBypassAreRejected()
    {
        using var fixture = new Fixture();
        ArticleVaultFrozenEmbedInput input = fixture.Input("published");
        AssertRejected(input with
        {
            Request = ArticleEmbedContractValidator.Seal(input.Request with
            {
                SourceRevision = 9
            })
        }, "vault_embed_source_binding_mismatch");
        AssertRejected(input with
        {
            Request = ArticleEmbedContractValidator.Seal(input.Request with
            {
                Actor = input.Request.Actor with
                {
                    SiteIdentity = "site:other"
                }
            })
        }, "vault_embed_source_binding_mismatch");
        AssertRejected(input with
        {
            Budgets = input.Budgets with
            {
                MaxDepth = ArticleEmbedResolutionBudgetLimits.DepthBound + 1
            }
        }, "vault_embed_authority_invalid");
    }

    [Fact]
    public void CanonicalGraphKeepsSameTargetDifferentFrozenRevisionsSeparate()
    {
        using var fixture = new Fixture();
        ArticleVaultFrozenEmbedInput input = fixture.Input("published");
        var binding = new VaultDependencyBinding(input.Manifest.SiteIdentity, input.Manifest.VaultIdentity, Host);
        var admission = new VaultDependencyAdmission(ArticleEmbedPermissionStatus.Allowed,
            VaultDependencyRight.Read | VaultDependencyRight.Reference,
            VaultDependencyRight.Read | VaultDependencyRight.Reference, Digest, Digest, Digest);
        VaultDependencyBinding targetBinding = binding with
        {
            PortableArticleIdentity = Target
        };
        VaultDependencyNode[] nodes =
        [
            new VaultFrozenEmbedDependency(binding, admission, Coordinate(17), targetBinding, Digest, 128),
            new VaultFrozenEmbedDependency(binding, admission, Coordinate(18), targetBinding, Digest, 128)
        ];
        VaultDependencyEdge[] edges = [new(PortableDependencyCodec.NodeKey(nodes[0]),
            PortableDependencyCodec.NodeKey(nodes[1]), VaultDependencyEdgeKind.FrozenRequires)];
        var graph = new PortableDependencyManifest(PortableDependencySchemas.Manifest, PortableDependencySchemas.Version,
            binding, input.Manifest.ServerArticleIdentity, input.Manifest.Coordinates, VaultDependencySourceSide.Server,
            input.Manifest.Coordinates.Server.Source!, Digest, nodes, edges, string.Empty, string.Empty);
        string graphSha256 = PortableDependencyCodec.GraphDigest(graph);
        VaultArticleCoordinate coordinate = input.Manifest.Coordinates.Server with
        {
            DependencySha256 = graphSha256
        };
        coordinate = coordinate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
        };
        ArticleVaultArticleManifest manifest = input.Manifest with
        {
            Coordinates = new VaultArticleCoordinates(coordinate, coordinate, coordinate)
        };
        manifest = manifest with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(manifest)
        };
        input = input with
        {
            Manifest = manifest
        };
        graph = PortableDependencyCodec.Seal(graph with
        {
            Coordinates = manifest.Coordinates,
            GraphSha256 = graphSha256
        });
        ArticleVaultFrozenEmbedCandidate candidate = ArticleVaultFrozenEmbedAdmission.Compare(input);
        Assert.True(candidate.Permitted);
        Assert.NotEqual(PortableDependencyCodec.NodeKey(nodes[0]), PortableDependencyCodec.NodeKey(nodes[1]));
        Assert.True(ArticleVaultFrozenEmbedAdmission.VerifyGraph(input, candidate, graph,
            fixture.SourceBytes, nodes, edges, Digest).IsValid);
        Assert.False(ArticleVaultFrozenEmbedAdmission.VerifyGraph(input, candidate, null!,
            fixture.SourceBytes, nodes, edges, Digest).IsValid);
        Assert.False(ArticleVaultFrozenEmbedAdmission.VerifyGraph(input, candidate, graph,
            fixture.SourceBytes, nodes, [], Digest).IsValid);
        VaultFrozenEmbedDependency crossScope = ((VaultFrozenEmbedDependency)nodes[0]) with
        {
            TargetBinding = targetBinding with
            {
                VaultIdentity = "vault:other"
            }
        };
        Assert.False(ArticleVaultFrozenEmbedAdmission.VerifyGraph(input, candidate, graph,
            fixture.SourceBytes, [crossScope, nodes[1]], edges, Digest).IsValid);
        VaultDependencyNode revoked = nodes[0] with
        {
            Admission = admission with
            {
                Permission = ArticleEmbedPermissionStatus.Denied
            }
        };
        Assert.Equal("vault_embed_graph_unavailable", ArticleVaultFrozenEmbedAdmission.VerifyGraph(
            input, candidate, graph, fixture.SourceBytes, [revoked, nodes[1]], edges, Digest).ReasonCode);
    }

    private static void AssertRejected(ArticleVaultFrozenEmbedInput input, string reasonCode)
    {
        ArticleVaultFrozenEmbedCandidate result = ArticleVaultFrozenEmbedAdmission.Compare(input);
        Assert.False(result.Permitted);
        Assert.Equal(reasonCode, result.ReasonCode);
        Assert.Null(result.Before);
        Assert.Null(result.After);
        Assert.Null(result.InputSha256);
    }

    private static ArticleEmbedDependencyCoordinate Coordinate(long revision)
        => ArticleEmbedContractValidator.Seal(new ArticleEmbedDependencyCoordinate(
            ArticleEmbedSchemas.DependencyCoordinate,
            ArticleEmbedSchemas.Version,
            new ArticleEmbedTargetIdentity(Target, ArticleEmbedTargetKind.Article, null, null),
            revision,
            $"revision:{revision}",
            "projection:target",
            Digest,
            string.Empty));

    private sealed class Fixture : IDisposable
    {
        private readonly CancellationTokenSource _signal = new();

        public byte[] SourceBytes => Encoding.UTF8.GetBytes($"::embed[target=\"{Target}\" mode=\"article\"]\n");

        public ArticleVaultFrozenEmbedInput Input(
            string hostLifecycle,
            long revision = 17,
            long latest = 17,
            ArticleEmbedPermissionStatus permission = ArticleEmbedPermissionStatus.Allowed,
            ArticleEmbedVisibilityStatus visibility = ArticleEmbedVisibilityStatus.Public,
            ArticleEmbedLifecycleStatus lifecycle = ArticleEmbedLifecycleStatus.Published)
        {
            var actor = new ArticleEmbedActorContext("actor:primary", "site:primary", Digest);
            var runtime = new ArticleEmbedRuntimeContext("article-embed", 1, ArticleEmbedSchemas.ProviderRuntime, Digest);
            var document = new ArticleEmbedDocumentIdentity("document:primary", 1);
            var target = new ArticleEmbedTargetIdentity(Target, ArticleEmbedTargetKind.Article, null, null);
            VaultSourceByteIdentity source = ArticleVaultManifestCodec.CaptureSourceBytes(SourceBytes);
            ArticleEmbedProviderRequest request = ArticleEmbedContractValidator.Seal(new ArticleEmbedProviderRequest(
                ArticleEmbedSchemas.ProviderRequest, ArticleEmbedSchemas.Version, "request:embed", Host, document, 8,
                new ArticleEmbedDirectiveProjection(ArticleEmbedSchemas.ParserContract, Target, ArticleEmbedTargetKind.Article, new ArticleEmbedSourceRange(0, 40)),
                target, ArticleEmbedRequestedScope.Authoring, actor, runtime, source.Sha256, string.Empty, _signal.Token));
            var facts = new ArticleEmbedTargetFacts(
                Target, actor.SiteIdentity, 1, revision, revision, Math.Max(latest, revision), visibility, lifecycle, permission,
                Digest, $"revision:{revision}", 128, "Private test target label",
                new ArticleEmbedSafeProjectionReference(ArticleEmbedProjectionKind.SafeProjection, "projection:target", Digest), [], [], []);
            ArticleEmbedAuthoritySnapshot snapshot = ArticleEmbedAuthoringContractValidator.Seal(new ArticleEmbedAuthoritySnapshot(
                ArticleEmbedAuthoringSchemas.AuthoritySnapshot, ArticleEmbedAuthoringSchemas.Version,
                Host, document, 8, source.Sha256, 1, actor, runtime, null, null, [facts], string.Empty));
            var budgets = new ArticleEmbedResolutionBudgetLimits(8, 64, 1_048_576, 60_000, 128);
            ArticleEmbedAuthoringResolution resolution = ArticleEmbedAuthoringResolver.Resolve([request], snapshot, budgets);
            var coordinate = new VaultArticleCoordinate(
                ArticleVaultSchemas.Coordinate, ArticleVaultSchemas.Version, true, false, 8,
                source,
                Digest, Digest, hostLifecycle, Digest, string.Empty);
            coordinate = coordinate with
            {
                ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
            };
            const string Path = "articles/source.md";
            var manifest = new ArticleVaultArticleManifest(
                ArticleVaultSchemas.ArticleManifest, ArticleVaultSchemas.Version,
                actor.SiteIdentity, "vault:primary", "device:primary", Host, "server:42",
                new VaultPathProjection(Path, ArticleVaultManifestCodec.ComputeProjectionSha256(Path)),
                new VaultArticleCoordinates(coordinate, coordinate, coordinate),
                new VaultOperationWatermarks(0, null, null, null, null, null, null), VaultArticleState.Clean, string.Empty);
            manifest = manifest with
            {
                ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(manifest)
            };
            Assert.True(ArticleVaultManifestValidator.Validate(manifest).IsValid);
            Assert.True(ArticleEmbedAuthoringVerifier.Verify([request], snapshot, budgets, resolution).Valid);
            return new ArticleVaultFrozenEmbedInput(manifest, request, snapshot, budgets, resolution,
                Coordinate(revision), Coordinate(revision), Coordinate(revision), false);
        }

        public void Dispose() => _signal.Dispose();
    }
}
