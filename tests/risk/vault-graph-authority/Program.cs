using System.Text;
using System.Text.Json;

using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;
using FsusBlog.Shared.Contracts.BlockLinks;

internal static partial class Program
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string OtherDigest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string Host = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private const string Target = "article:01991e72-a611-7d16-9fd4-38f7d2e65498";
    private const string OtherTarget = "article:cccccccc-cccc-cccc-cccc-cccccccccccc";
    private static readonly VaultDependencyBinding s_binding = new("site:primary", "vault:primary", Host);
    private static readonly VaultDependencyAdmission s_admission = new(ArticleEmbedPermissionStatus.Allowed,
        VaultDependencyRight.Read | VaultDependencyRight.Reference | VaultDependencyRight.Materialize | VaultDependencyRight.Upload,
        VaultDependencyRight.Read | VaultDependencyRight.Reference | VaultDependencyRight.Materialize | VaultDependencyRight.Upload,
        Digest, Digest, Digest);
    private static readonly ArticleEmbedResolutionBudgetLimits s_budgets = new(8, 128, 1_048_576, 60_000, 256);
    private static readonly byte[] s_bytes = Encoding.UTF8.GetBytes("hello  \r\n");
    private static int s_failures;
    private static bool s_occurrenceOnly;

    private static int Main(string[] args)
    {
        s_occurrenceOnly = args.Contains("--occurrence-only", StringComparer.Ordinal);
#if !COMPOSE
        if (s_occurrenceOnly)
        {
            Console.Error.WriteLine("--occurrence-only requires -p:Compose=true");
            return 2;
        }
#endif
#if COMPOSE
        CompositeChecks();
#else
        GraphChecks();
#endif
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            summary = true,
            failures = s_failures
        }));
        return s_failures > 0 ? 1 : 0;
    }

    private static void Check(string name, bool expected, Func<(bool Accepted, string? Reason)> action)
    {
        if (s_occurrenceOnly && name is not "forged_code_fence_occurrence_with_live_link_authority"
            and not "two_portable_identities_collide_on_one_route_projection")
        {
            return;
        }
        try
        {
            (bool accepted, string? reason) = action();
            bool passed = accepted == expected;
            if (!passed)
                s_failures++;
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                name,
                expectedAccepted = expected,
                observedAccepted = accepted,
                reason,
                passed
            }));
        }
        catch (Exception exception)
        {
            s_failures++;
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                name,
                expectedAccepted = expected,
                exception = exception.ToString(),
                passed = false
            }));
        }
    }

    private static (bool, string?) Result(ArticleVaultValidationResult result) => (result.IsValid, result.ReasonCode);

    private static VaultAssetDependency Asset() => new(s_binding, s_admission,
        Guid.Parse("11111111-1111-1111-1111-111111111111"), Digest, "image/png", ".png", 24, 1, 1, 1, 4);

    private static VaultLinkDependency Link(string target = Target) => new(s_binding, s_admission,
        new(target, ArticleEmbedTargetKind.Block, null, "stable"),
#if !COMPOSE || STRICT_API
        s_binding with
        {
            PortableArticleIdentity = target
        },
#endif
        Digest);

    private static VaultFrozenEmbedDependency Embed(long revision = 17) => new(s_binding, s_admission, Coordinate(revision),
#if !COMPOSE || STRICT_API
        s_binding with
        {
            PortableArticleIdentity = Target
        },
#endif
        Digest, 128);

    private static ArticleEmbedDependencyCoordinate Coordinate(long revision) => ArticleEmbedContractValidator.Seal(new ArticleEmbedDependencyCoordinate(
        ArticleEmbedSchemas.DependencyCoordinate, ArticleEmbedSchemas.Version,
        new(Target, ArticleEmbedTargetKind.Article, null, null), revision, $"revision:{revision}", "projection:target", Digest, ""));

    private static PortableDependencyManifest Manifest(IReadOnlyList<VaultDependencyNode> nodes,
        IReadOnlyList<VaultDependencyEdge>? edges = null, byte[]? bytes = null,
        VaultDependencySourceSide side = VaultDependencySourceSide.Local, string lifecycle = "draft")
    {
        VaultSourceByteIdentity source = ArticleVaultManifestCodec.CaptureSourceBytes(bytes ?? s_bytes);
        VaultArticleCoordinate coordinate = new(ArticleVaultSchemas.Coordinate, ArticleVaultSchemas.Version,
            true, false, 8, source, Digest, Digest, lifecycle, Digest, "");
        PortableDependencyManifest manifest = new(PortableDependencySchemas.Manifest, 1, s_binding, "server:42",
            new(coordinate, coordinate, coordinate), side, source, Digest, nodes, edges ?? [], "", "");
        string graph = PortableDependencyCodec.GraphDigest(manifest);
        coordinate = coordinate with
        {
            DependencySha256 = graph
        };
        coordinate = coordinate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
        };
        return PortableDependencyCodec.Seal(manifest with
        {
            GraphSha256 = graph,
            Coordinates = new(coordinate, coordinate, coordinate)
        });
    }

    private static ArticleVaultArticleManifest Article(PortableDependencyManifest manifest)
    {
        const string Path = "articles/source.md";
        var article = new ArticleVaultArticleManifest(ArticleVaultSchemas.ArticleManifest, 1, s_binding.SiteIdentity,
            s_binding.VaultIdentity, "device:primary", Host, "server:42",
            new(Path, ArticleVaultManifestCodec.ComputeProjectionSha256(Path)), manifest.Coordinates,
            new(0, null, null, null, null, null, null), VaultArticleState.Clean, "");
        return article with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
        };
    }

    private static ArticleVaultPlanRequest Request(ArticleVaultArticleManifest article)
    {
        var root = new ArticleVaultRootManifest(ArticleVaultSchemas.RootManifest, 1, ArticleVaultSchemas.ControlTreeVersion,
            new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
            s_binding.SiteIdentity, s_binding.VaultIdentity, "device:primary",
            [new(Host, $".fsus/articles/{Host}.json", article.ContentSha256, article.PathProjection.RelativePath)], [], "");
        root = root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
        var observation = new ArticleVaultServerObservation(ArticleVaultPlanSchemas.ServerObservation, 1,
            s_binding.SiteIdentity, s_binding.VaultIdentity, "device:primary", Host, article.ServerArticleIdentity, article.Coordinates.Server, "");
        observation = observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
        return new(root, [article], [observation], [new("atomic-group", [Host], [])], VaultSyncDirection.Sync, 1000, 2000, false);
    }

#if !COMPOSE
    private static void GraphChecks()
    {
        VaultDependencyNode[] nodes = [Asset(), Link(), Embed(), new VaultAnchorDependency(s_binding, s_admission,
            ArticleBlockTarget.Create(Host, BlockAnchorId.Create("stable")), BlockAnchorSchemas.ContractDigest)];
        VaultDependencyEdge[] edges = [new(PortableDependencyCodec.NodeKey(nodes[0]), PortableDependencyCodec.NodeKey(nodes[1]), VaultDependencyEdgeKind.Requires),
            new(PortableDependencyCodec.NodeKey(nodes[1]), PortableDependencyCodec.NodeKey(nodes[2]), VaultDependencyEdgeKind.FrozenRequires)];
        PortableDependencyManifest manifest = Manifest(nodes, edges);
        ArticleVaultArticleManifest article = Article(manifest);
        ArticleVaultValidationResult Verify(IReadOnlyList<VaultDependencyNode> currentNodes, IReadOnlyList<VaultDependencyEdge>? currentEdges = null)
            => PortableDependencyVerifier.VerifyCurrent(manifest, article, s_bytes, currentNodes, currentEdges ?? edges, Digest, s_budgets);
        Check("mixed_asset_link_anchor_frozen_graph", true, () => Result(Verify(nodes)));
        Check("asset_id_substitution_between_plan_and_use", false, () => Result(Verify([((VaultAssetDependency)nodes[0]) with { AssetIdentity = Guid.NewGuid() }, .. nodes.Skip(1)])));
        Check("asset_owner_substitution_between_plan_and_use", false, () => Result(Verify([((VaultAssetDependency)nodes[0]) with { OwnerAdminPrincipalId = 2 }, .. nodes.Skip(1)])));
        Check("rights_revocation_between_plan_and_use", false, () => Result(Verify([nodes[0] with { Admission = s_admission with { GrantedRights = VaultDependencyRight.Read } }, .. nodes.Skip(1)])));
        Check("cached_frozen_revision_refresh_between_plan_and_use", false, () => Result(Verify([nodes[0], nodes[1], Embed(18), nodes[3]])));
        Check("cross_vault_target_substitution", false, () => Result(Verify([nodes[0], ((VaultLinkDependency)nodes[1]) with { TargetBinding = s_binding with { VaultIdentity = "vault:other", PortableArticleIdentity = Target } }, nodes[2], nodes[3]])));
        Check("partial_current_edge_set", false, () => Result(Verify(nodes, [edges[0]])));
        Check("mixed_graph_cycle", false, () => Result(PortableDependencyVerifier.VerifyBudgets(Manifest(nodes,
            [.. edges, new(PortableDependencyCodec.NodeKey(nodes[2]), PortableDependencyCodec.NodeKey(nodes[0]), VaultDependencyEdgeKind.Requires)]), s_budgets, out _)));
        Check("mixed_graph_combined_bytes_over_budget", false, () => Result(PortableDependencyVerifier.VerifyBudgets(manifest, s_budgets with { MaxSourceBytes = 128 }, out _)));
        Check("same_target_different_frozen_revisions_remain_distinct", true, () => Result(PortableDependencyVerifier.ValidateStructure(Manifest([Embed(17), Embed(18)]))));
        Check("two_distinct_link_targets_same_anchor_remain_distinct", true, () => Result(PortableDependencyVerifier.ValidateStructure(Manifest([Link(), Link(OtherTarget)]))));

        ArticleVaultPlanRequest request = Request(article);
        ArticleVaultSyncPlan sync = ArticleVaultSyncPlanner.Build(request).Plan!;
        ArticleVaultPlanVerificationContext context = new(1000, request.Direction, false);
        VaultDependencyPlanInput[] inputs = [new(manifest, s_bytes, nodes, edges, Digest)];
        ArticleVaultDependencyPlan extension = ArticleVaultDependencyPlanner.Build(sync, request, context, inputs, s_budgets).Plan!;
        Check("mixed_plan_current_authority", true, () => Result(ArticleVaultDependencyPlanner.VerifyCurrent(extension, sync, request, context, inputs, s_budgets)));
        FreshPullChecks(manifest, article, request);
        Check("sealed_plan_mutable_backing_array_tamper", false, () =>
        {
            VaultDependencyNode[] frozenNodes = (VaultDependencyNode[])extension.Items[0].Manifest.Nodes;
            frozenNodes[0] = frozenNodes[0] with
            {
                Admission = s_admission with
                {
                    AuthoritySha256 = OtherDigest
                }
            };
            return Result(ArticleVaultDependencyPlanner.VerifyCurrent(extension, sync, request, context, inputs, s_budgets));
        });
        Check("unsealed_input_collection_mutation_does_not_mutate_frozen_plan", true, () =>
        {
            extension = ArticleVaultDependencyPlanner.Build(sync, request, context, inputs, s_budgets).Plan!;
            string digest = PortableDependencyCodec.PlanDigest(extension);
            nodes[0] = nodes[0] with
            {
                Admission = s_admission with
                {
                    RightsSha256 = OtherDigest
                }
            };
            return (digest == PortableDependencyCodec.PlanDigest(extension), null);
        });
        Check("authority_drift_after_freeze_refuses_whole_extension", false, () => Result(ArticleVaultDependencyPlanner.VerifyCurrent(extension, sync, request, context, inputs, s_budgets)));
    }

    private static void FreshPullChecks(PortableDependencyManifest stored, ArticleVaultArticleManifest article,
        ArticleVaultPlanRequest original)
    {
        byte[] freshBytes = Encoding.UTF8.GetBytes("fresh server source\r\n");
        PortableDependencyManifest fresh = stored with
        {
            SourceSide = VaultDependencySourceSide.Server,
            Source = ArticleVaultManifestCodec.CaptureSourceBytes(freshBytes)
        };
        string graph = PortableDependencyCodec.GraphDigest(fresh);
        VaultArticleCoordinate freshCoordinate = stored.Coordinates.Server with
        {
            Source = fresh.Source,
            ServerRevision = 9,
            DependencySha256 = graph
        };
        freshCoordinate = freshCoordinate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(freshCoordinate)
        };
        fresh = PortableDependencyCodec.Seal(fresh with
        {
            Coordinates = stored.Coordinates with
            {
                Server = freshCoordinate
            },
            GraphSha256 = graph
        });
        ArticleVaultServerObservation observation = original.ServerObservations[0] with
        {
            ServerCoordinate = freshCoordinate
        };
        observation = observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
        ArticleVaultPlanRequest request = original with
        {
            Direction = VaultSyncDirection.Pull,
            ServerObservations = [observation]
        };
        ArticleVaultSyncPlan sync = ArticleVaultSyncPlanner.Build(request).Plan!;
        ArticleVaultPlanVerificationContext context = new(1000, request.Direction, false);
        VaultDependencyPlanInput[] freshInputs = [new(fresh, freshBytes, fresh.Nodes, fresh.Edges, Digest)];
        VaultDependencyPlanBuildResult built = ArticleVaultDependencyPlanner.Build(sync, request, context, freshInputs, s_budgets);
        Check("fresh_server_pullupdate_freezes_fresh_mixed_graph", true, () =>
        {
            return (sync.Status == VaultSyncPlanStatus.Ready
                && sync.Groups[0].Items[0].Decision == VaultSyncDecision.PullUpdate && built.Plan is not null, built.ReasonCode);
        });
        Check("fresh_server_pullupdate_frozen_extension_verifies", true, () => Result(
            ArticleVaultDependencyPlanner.VerifyCurrent(built.Plan, sync, request, context, freshInputs, s_budgets)));
        Check("fresh_server_pullupdate_refuses_old_saved_server_graph_and_bytes", false, () =>
        {
            PortableDependencyManifest stale = PortableDependencyCodec.Seal(stored with
            {
                SourceSide = VaultDependencySourceSide.Server
            });
            VaultDependencyPlanInput[] staleInputs = [new(stale, s_bytes, stale.Nodes, stale.Edges, Digest)];
            VaultDependencyPlanBuildResult staleBuild = ArticleVaultDependencyPlanner.Build(sync, request, context, staleInputs, s_budgets);
            ArticleVaultValidationResult staleVerify = ArticleVaultDependencyPlanner.VerifyCurrent(built.Plan, sync, request, context, staleInputs, s_budgets);
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                trace = "fresh-pullupdate-stale-input",
                status = sync.Status.ToString(),
                decision = sync.Groups[0].Items[0].Decision.ToString(),
                storedRevision = article.Coordinates.Server.ServerRevision,
                observedRevision = observation.ServerCoordinate.ServerRevision,
                buildAccepted = staleBuild.Plan is not null,
                buildReason = staleBuild.ReasonCode,
                verifyAccepted = staleVerify.IsValid,
                verifyReason = staleVerify.ReasonCode
            }));
            return (staleBuild.Plan is not null || staleVerify.IsValid, staleVerify.ReasonCode ?? staleBuild.ReasonCode);
        });
    }
#endif
}
