using System.Collections.Immutable;
using System.Text;

using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

[Trait("Category", "ArticleVaultResolutionPlan")]
public sealed class ArticleVaultResolutionPlanTests
{
    [Fact]
    public void ActualScalarCandidate_SealsImmutableIdempotentProposalAndRetainsOriginalBlockedPlan()
    {
        ArticleVaultResolutionPlanInput input = VaultResolutionTestInputs.Create();
        string original = input.Metadata.Plan.ContentSha256;
        ArticleVaultResolutionPlan first = Assert.IsType<ArticleVaultResolutionPlan>(ArticleVaultResolutionPlanner.Build(input).Plan);
        ArticleVaultResolutionPlan second = Assert.IsType<ArticleVaultResolutionPlan>(ArticleVaultResolutionPlanner.Build(input).Plan);
        Assert.Equal(first.ContentSha256, second.ContentSha256);
        Assert.Equal(first.ResolutionOperationIdentity, second.ResolutionOperationIdentity);
        Assert.Equal(original, input.Metadata.Plan.ContentSha256);
        Assert.Equal(VaultSyncPlanStatus.Blocked, input.Metadata.Plan.Status);
        Assert.Equal(VaultResolutionPlanState.Prepared, first.State);
        Assert.Equal(input.MetadataCandidate!.Metadata.ContentSha256, first.ExpectedOutput!.MetadataManifestSha256);
        Assert.True(ArticleVaultResolutionPlanner.VerifyCurrent(first, input).IsValid);
        Assert.Equal("article_vault_resolution_canonical_execution_admission_missing",
            ArticleVaultResolutionPlanner.RequireExecutionAdmission(first, input).ReasonCode);
        byte[] bytes = ArticleVaultResolutionPlanner.Serialize(first);
        Assert.Equal(first.ContentSha256, ArticleVaultResolutionPlanner.Deserialize(bytes).ContentSha256);
        Assert.DoesNotContain("local title", Encoding.UTF8.GetString(bytes), StringComparison.Ordinal);
    }

    [Fact]
    public void PerItemCancellation_CreatesNewProposalWithoutOverwritingHistoryOrPromotingRights()
    {
        ArticleVaultResolutionPlanInput input = VaultResolutionTestInputs.Create();
        ArticleVaultResolutionPlan first = ArticleVaultResolutionPlanner.Build(input).Plan!;
        ArticleVaultResolutionPlanInput cancelled = input with
        {
            Decisions = [new(VaultConflictType.MetadataDisjoint, VaultConflictAction.CancelOperation,
                VaultConflictDisposition.Automatic, null)]
        };
        ArticleVaultResolutionPlan second = ArticleVaultResolutionPlanner.Build(cancelled).Plan!;
        Assert.NotEqual(first.ResolutionOperationIdentity, second.ResolutionOperationIdentity);
        Assert.Equal(VaultResolutionPlanState.Cancelled, second.State);
        Assert.Null(second.ExpectedOutput);
        Assert.True(ArticleVaultResolutionPlanner.VerifyCurrent(first, input).IsValid);
        Assert.Equal("article_vault_resolution_cancelled", ArticleVaultResolutionPlanner.RequireExecutionAdmission(second, cancelled).ReasonCode);
    }

    [Fact]
    public void MissingDuplicateUnknownAndWildcardDecisions_AreRejected()
    {
        ArticleVaultResolutionPlanInput input = VaultResolutionTestInputs.Create();
        ImmutableArray<VaultResolutionDecision>[] invalid =
        [
            [],
            [input.Decisions[0], input.Decisions[0]],
            [input.Decisions[0] with { Type = (VaultConflictType)99 }],
            [input.Decisions[0] with { Action = (VaultConflictAction)99 }],
            [input.Decisions[0] with { Action = VaultConflictAction.ProposeSourceReplacement }],
            [input.Decisions[0] with { Provenance = VaultConflictDisposition.Manual }],
            [input.Decisions[0] with { ResultCandidateSha256 = VaultResolutionTestInputs.Digest }]
        ];
        foreach (ImmutableArray<VaultResolutionDecision> decisions in invalid)
        {
            Assert.Null(ArticleVaultResolutionPlanner.Build(input with
            {
                Decisions = decisions
            }).Plan);
        }

        Assert.Null(ArticleVaultResolutionPlanner.Build(input with
        {
            MetadataCandidate = null
        }).Plan);
    }

    [Theory]
    [InlineData("revision")]
    [InlineData("source")]
    [InlineData("permission")]
    [InlineData("lifecycle")]
    [InlineData("dependency")]
    public void CurrentServerCoordinateDrift_InvalidatesProposalBeforeAnyAdmission(string field)
    {
        ArticleVaultResolutionPlanInput input = VaultResolutionTestInputs.Create();
        ArticleVaultResolutionPlan plan = ArticleVaultResolutionPlanner.Build(input).Plan!;
        VaultArticleCoordinate coordinate = input.Metadata.Observations[0].ServerCoordinate;
        coordinate = field switch
        {
            "revision" => coordinate with { ServerRevision = 7 },
            "source" => coordinate with { Source = ArticleVaultManifestCodec.CaptureSourceBytes("changed\n"u8) },
            "permission" => coordinate with { PermissionSha256 = new string('b', 64) },
            "lifecycle" => coordinate with { Lifecycle = "published" },
            _ => coordinate with { DependencySha256 = new string('b', 64) }
        };
        coordinate = VaultResolutionTestInputs.Seal(coordinate);
        ArticleVaultServerObservation observation = input.Metadata.Observations[0] with
        {
            ServerCoordinate = coordinate
        };
        observation = observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
        ArticleVaultResolutionPlanInput current = input with
        {
            Metadata = input.Metadata with
            {
                Observations = [observation]
            }
        };
        Assert.False(ArticleVaultResolutionPlanner.VerifyCurrent(plan, current).IsValid);
        Assert.False(ArticleVaultResolutionPlanner.RequireExecutionAdmission(plan, current).IsValid);
    }

    [Fact]
    public void LocalBytesSchemaExpiryAndGitDrift_RejectInsteadOfReplanning()
    {
        ArticleVaultResolutionPlanInput input = VaultResolutionTestInputs.Create();
        ArticleVaultResolutionPlan plan = ArticleVaultResolutionPlanner.Build(input).Plan!;
        ArticleVaultResolutionPlanInput[] changed =
        [
            input with { Metadata = input.Metadata with { LocalBytes = "{}"u8.ToArray() } },
            input with { Metadata = input.Metadata with { Context = input.Metadata.Context with { NowUnixMs = input.ExpiresAtUnixMs + 1 } } },
            input with { Git = input.Git with { HeadFactsSha256 = VaultResolutionTestInputs.Digest } },
            input with { Git = input.Git with { Scope = input.Git.Scope with { VaultIdentity = "other-vault" } } },
            input with { Confirmation = input.Confirmation with { ActorIdentity = "https://untrusted" } }
        ];
        foreach (ArticleVaultResolutionPlanInput current in changed)
        {
            Assert.False(ArticleVaultResolutionPlanner.VerifyCurrent(plan, current).IsValid);
            Assert.Null(ArticleVaultResolutionPlanner.Build(current).Plan);
        }
    }

    [Fact]
    public void ResealedCandidateResultOrderAndGroupTamper_FailIndependentVerification()
    {
        ArticleVaultResolutionPlanInput input = VaultResolutionTestInputs.Create();
        ArticleVaultResolutionPlan plan = ArticleVaultResolutionPlanner.Build(input).Plan!;
        ArticleVaultResolutionPlan[] changed =
        [
            plan with { ExpectedOutput = plan.ExpectedOutput! with { MetadataManifestSha256 = VaultResolutionTestInputs.Digest } },
            plan with { ResolutionOperationIdentity = "resolution-other" },
            plan with { Groups = [plan.Groups[0] with { PortableArticleIdentities = ["other-article"] }] },
            plan with { ActionOrder = [] }
        ];
        foreach (ArticleVaultResolutionPlan altered in changed)
        {
            ArticleVaultResolutionPlan resealed = altered with
            {
                ContentSha256 = ArticleVaultResolutionPlanner.ComputeContentSha256(altered)
            };
            Assert.False(ArticleVaultResolutionPlanner.VerifyCurrent(resealed, input).IsValid);
        }

        ArticleVaultScalarMetadataCandidate candidate = input.MetadataCandidate!;
        ArticleVaultMetadataManifest metadata = VaultResolutionTestInputs.Seal(candidate.Metadata with
        {
            Title = "forged result"
        });
        candidate = candidate with
        {
            Metadata = metadata
        };
        candidate = candidate with
        {
            ContentSha256 = ArticleVaultScalarMetadataMerge.ComputeContentSha256(candidate)
        };
        Assert.Null(ArticleVaultResolutionPlanner.Build(input with
        {
            MetadataCandidate = candidate,
            Decisions = [input.Decisions[0] with { ResultCandidateSha256 = candidate.ContentSha256 }]
        }).Plan);
    }

    [Theory]
    [InlineData("shell")]
    [InlineData("path")]
    [InlineData("sourceCode")]
    [InlineData("acceptAllLocal")]
    [InlineData("writer")]
    public void ClosedCodec_RejectsExecutablePayloadAndGlobalBypassFields(string field)
    {
        ArticleVaultResolutionPlan plan = ArticleVaultResolutionPlanner.Build(VaultResolutionTestInputs.Create()).Plan!;
        string json = Encoding.UTF8.GetString(ArticleVaultResolutionPlanner.Serialize(plan));
        byte[] unknown = Encoding.UTF8.GetBytes(json[..^1] + $",\"{field}\":\"arbitrary\"}}");
        Assert.Throws<InvalidDataException>(() => ArticleVaultResolutionPlanner.Deserialize(unknown));
    }
}

internal static class VaultResolutionTestInputs
{
    internal const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    internal const long Now = 1_800_000_000_000;

    internal static ArticleVaultResolutionPlanInput Create()
    {
        ArticleVaultMetadataManifest baseline = Seal(new ArticleVaultMetadataManifest(ArticleVaultSchemas.MetadataManifest, 1, "site-one", "vault-one", "device-one",
            "article-one", "server-one", "base title", "base summary", "base-slug", Digest, Digest, string.Empty));
        ArticleVaultMetadataManifest local = Seal(baseline with
        {
            Title = "local title"
        });
        ArticleVaultMetadataManifest server = Seal(baseline with
        {
            Summary = "server summary"
        });
        VaultSourceByteIdentity source = ArticleVaultManifestCodec.CaptureSourceBytes("source\n"u8);
        VaultArticleCoordinate ancestor = Seal(new VaultArticleCoordinate(ArticleVaultSchemas.Coordinate, 1, true, false, 4, source,
            baseline.ContentSha256, Digest, "draft", Digest, string.Empty));
        VaultArticleCoordinate localCoordinate = Seal(ancestor with
        {
            MetadataManifestSha256 = local.ContentSha256
        });
        VaultArticleCoordinate serverCoordinate = Seal(ancestor with
        {
            ServerRevision = 5,
            MetadataManifestSha256 = server.ContentSha256
        });
        const string Path = "articles/article-one.md";
        ArticleVaultArticleManifest article = new(ArticleVaultSchemas.ArticleManifest, 1, "site-one", "vault-one", "device-one",
            "article-one", "server-one", new(Path, ArticleVaultManifestCodec.ComputeProjectionSha256(Path)),
            new(ancestor, localCoordinate, ancestor), new(0, null, null, null, null, null, null), VaultArticleState.Clean, string.Empty);
        article = article with
        {
            State = ArticleVaultStateMachine.Derive(article)
        };
        article = article with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
        };
        ArticleVaultServerObservation observation = new(ArticleVaultPlanSchemas.ServerObservation, 1, "site-one", "vault-one", "device-one",
            "article-one", "server-one", serverCoordinate, string.Empty);
        observation = observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
        ArticleVaultRootManifest root = new(ArticleVaultSchemas.RootManifest, 1, ArticleVaultSchemas.ControlTreeVersion,
            new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
            "site-one", "vault-one", "device-one", [new("article-one", ".fsus/articles/article-one.json", article.ContentSha256, Path)], [], string.Empty);
        root = root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
        ArticleVaultSyncPlan plan = ArticleVaultSyncPlanner.Build(new(root, [article], [observation],
            [new("group-one", ["article-one"], [])], VaultSyncDirection.Sync, Now, Now + 60_000, false)).Plan!;
        VaultSyncPlanItem item = plan.Groups[0].Items[0];
        VaultConflictBinding binding = new(plan.SiteIdentity, plan.VaultIdentity, plan.DeviceIdentity, item.PortableArticleIdentity,
            item.ServerArticleIdentity, plan.PlanCandidateIdentity, plan.ContentSha256, item.GroupIdentity, item.OperationIdentity,
            article.ContentSha256, observation.ContentSha256, new(item.Base, item.Local, item.Server));
        ArticleVaultScalarMetadataInput metadata = new(plan, root, [article], [observation], new(Now, VaultSyncDirection.Sync, false), binding,
            ArticleVaultManifestCodec.Serialize(baseline), ArticleVaultManifestCodec.Serialize(local), ArticleVaultManifestCodec.Serialize(server));
        ArticleVaultScalarMetadataCandidate candidate = ArticleVaultScalarMetadataMerge.Build(metadata).Candidate!;
        VaultConflictRegistryEntry entry = ArticleVaultConflictRegistry.Find(VaultConflictType.MetadataDisjoint)!;
        ArticleVaultConflictEvidence evidence = new(ArticleVaultConflictSchemas.Evidence, 1, ArticleVaultConflictRegistry.ContentSha256,
            binding, [new(entry.Type, entry.Disposition, entry.AllowedActions, new(entry.Type, null, candidate.Facts, null))], string.Empty);
        evidence = evidence with
        {
            ContentSha256 = ArticleVaultConflictCodec.ComputeContentSha256(evidence)
        };
        ArticleVaultGitFacts git = ArticleVaultGitFactsTests.Facts("source\n"u8);
        git = git with
        {
            Scope = git.Scope with
            {
                RootManifestSha256 = root.ContentSha256
            }
        };
        git = git with
        {
            ContentSha256 = ArticleVaultGitFactDecoder.ComputeContentSha256(git)
        };
        return new(metadata, evidence, git,
            [new(entry.Type, VaultConflictAction.PrepareMetadataCandidate, entry.Disposition, candidate.ContentSha256)],
            candidate, new("confirmation-one", "actor-one", Now), Now + 30_000);
    }

    internal static VaultArticleCoordinate Seal(VaultArticleCoordinate coordinate)
        => coordinate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
        };

    internal static ArticleVaultMetadataManifest Seal(ArticleVaultMetadataManifest metadata)
        => metadata with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(metadata)
        };
}
