using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.DecisionPrototype;

internal static class Program
{
    private const string AuthorityCommit = "cb6f4e4a174ac65735707c7e44286352803e742b";
    private const string ArticleA = "article:11111111-1111-4111-8111-111111111111";
    private const string ArticleB = "article:22222222-2222-4222-8222-222222222222";
    private const long CreatedAt = 1_800_000_000_000;
    private static readonly byte[] s_baseBytes = Encoding.UTF8.GetBytes("# Synthetic private draft\n\nFirst paragraph.\n\nSecond paragraph.\n");
    private static readonly byte[] s_localBytes = Encoding.UTF8.GetBytes("# Synthetic private draft\n\nLocal first paragraph.\n\nSecond paragraph.\n");
    private static readonly byte[] s_disjointServerBytes = Encoding.UTF8.GetBytes("# Synthetic private draft\n\nFirst paragraph.\n\nServer second paragraph.\n");
    private static readonly byte[] s_overlapServerBytes = Encoding.UTF8.GetBytes("# Synthetic private draft\n\nServer first paragraph.\n\nSecond paragraph.\n");
    private static readonly JsonSerializerOptions s_reportOptions = new()
    {
        WriteIndented = true,
        IndentSize = 4,
        Converters = { new JsonStringEnumConverter() }
    };
    private static SortedDictionary<string, object?> s_artifacts = new(StringComparer.Ordinal);

    private static int Main(string[] args)
    {
        if (!args.SequenceEqual(["--non-production"]))
        {
            Console.Error.WriteLine("NON-PRODUCTION only: pass --non-production. No executor or production connection exists.");
            return 2;
        }

        ScenarioResult[] scenarios =
        [
            Run("path-rename", Rename),
            Run("independent-articles-local-server-edit", IndependentArticles),
            Run("same-article-disjoint-edit-conservative-refusal", () => ConcurrentEdit(s_disjointServerBytes)),
            Run("same-article-overlapping-edit-conflict", () => ConcurrentEdit(s_overlapServerBytes)),
            Run("source-and-manifest-byte-round-trip", SourceRoundTrip),
            Run("asset-link-anchor-target-round-trip", ReferenceRoundTrip),
            Run("git-conflict-fixture-admission-gap", GitConflictFixture),
            Run("current-server-permission-drift", PermissionDrift),
            Run("missing-base-refusal", MissingBase),
            Run("opt-out-isolation", OptOut)
        ];
        byte[] report = JsonSerializer.SerializeToUtf8Bytes(new
        {
            schema = "fsusblog.article-vault.non-production-decision-prototype.v1",
            nonProduction = true,
            syntheticOnly = true,
            architectureChoice = "C",
            authorityCommit = AuthorityCommit,
            canonicalSourceBindings = File.ReadAllText("canonical-sources.sha256.txt"),
            executionBoundary = "in-memory plans and finite codecs; no executor, watcher, DB, network, receipt or base writes",
            nativeQualification = new
            {
                windowsNtfs = false,
                macOsApfs = false,
                linuxFileSystem = false
            },
            scenarios,
            failedScenarios = scenarios.Count(static result => result.Outcome == "failed")
        }, s_reportOptions);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            reportSha256 = ArticleVaultManifestCodec.ComputeSha256(report),
            report = JsonDocument.Parse(report).RootElement
        }, s_reportOptions));
        return scenarios.Any(static result => result.Outcome == "failed") ? 1 : 0;
    }

    private static ScenarioResult Run(string name, Action scenario)
    {
        s_artifacts = new(StringComparer.Ordinal);
        try
        {
            scenario();
            return new(name, "passed", s_artifacts, null);
        }
        catch (Exception exception)
        {
            return new(name, "failed", s_artifacts, $"{exception.GetType().Name}: {exception.Message}");
        }
    }

    private static void Rename()
    {
        ArticleVaultArticleManifest original = Article(ArticleA);
        const string RenamedPath = "renamed/unrelated-title.md";
        ArticleVaultArticleManifest renamed = Seal(original with
        {
            PathProjection = new(RenamedPath, ArticleVaultManifestCodec.ComputeProjectionSha256(RenamedPath))
        });
        s_artifacts["originalArticle"] = Canonical(ArticleVaultManifestCodec.Serialize(original));
        ArticleVaultSyncPlan plan = Plan(Request([renamed], [Observation(renamed)]));
        Require(original.PortableArticleIdentity == renamed.PortableArticleIdentity, "rename changed identity");
        Require(original.Coordinates == renamed.Coordinates, "rename changed coordinates");
        Require(plan.Status == VaultSyncPlanStatus.NoOp && plan.Groups[0].Items[0].Decision == VaultSyncDecision.NoOp, "rename became a mutation");
        Require(original.PathProjection.ProjectionSha256 != renamed.PathProjection.ProjectionSha256, "projection did not change");
        s_artifacts["nativeRenameExecuted"] = false;
    }

    private static void IndependentArticles()
    {
        ArticleVaultArticleManifest local = LocalEdit(Article(ArticleA), s_localBytes);
        ArticleVaultArticleManifest server = Article(ArticleB);
        ArticleVaultPlanRequest request = Request([local, server],
            [Observation(local), Observation(server, Coordinate(s_disjointServerBytes, 5, ArticleB))]);
        CaptureBytes("local", s_localBytes);
        CaptureBytes("server", s_disjointServerBytes);
        ArticleVaultSyncPlan plan = Plan(request);
        Require(plan.Status == VaultSyncPlanStatus.Ready, "independent article edits not ready");
        Require(plan.Groups[0].Items[0].Decision == VaultSyncDecision.PushUpdate, "local edit decision");
        Require(plan.Groups[0].Items[1].Decision == VaultSyncDecision.PullUpdate, "server edit decision");
        ArticleVaultPlanBuildResult reordered = ArticleVaultSyncPlanner.Build(request with
        {
            ArticleManifests = request.ArticleManifests.Reverse().ToArray(),
            ServerObservations = request.ServerObservations.Reverse().ToArray()
        });
        Require(reordered.IsSuccess && ArticleVaultSyncPlanCodec.Serialize(plan).SequenceEqual(
            ArticleVaultSyncPlanCodec.Serialize(reordered.Plan!)), "input order changed canonical plan");
        s_artifacts["reorderedPlanSha256"] = reordered.Plan!.ContentSha256;
    }

    private static void ConcurrentEdit(byte[] serverBytes)
    {
        ArticleVaultArticleManifest article = LocalEdit(Article(ArticleA), s_localBytes);
        CaptureBytes("base", s_baseBytes);
        CaptureBytes("local", s_localBytes);
        CaptureBytes("server", serverBytes);
        ArticleVaultSyncPlan plan = Plan(Request([article], [Observation(article, Coordinate(serverBytes, 5))]));
        Require(plan.Status == VaultSyncPlanStatus.Blocked, "both edits must block");
        Require(plan.Groups[0].Items[0].DerivedState == VaultArticleState.BothModified, "three-way state");
        Require(plan.Conflicts.Single().ReasonCode == "both_modified", "exact conflict reason");
        Require(plan.OperationOrder.Count == 0, "blocked plan offers operations");
        s_artifacts["resolutionExecution"] = "not-executable: #1911 source resolution API absent from frozen master";
    }

    private static void SourceRoundTrip()
    {
        byte[] bytes = [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes("Synthetic line  \r\nSecond line\t\r\n")];
        CaptureBytes("source", bytes);
        VaultSourceByteIdentity identity = ArticleVaultManifestCodec.CaptureSourceBytes(bytes);
        Require(ArticleVaultManifestValidator.ValidateSourceBytes(identity, bytes).IsValid, "source identity");
        Require(identity.HasUtf8Bom && identity.NewlineStyle == VaultNewlineStyle.CrLf
            && identity.TrailingWhitespaceLineCount == 2 && identity.HasFinalNewline, "byte facts changed");
        ArticleVaultMetadataManifest metadata = Metadata(ArticleA);
        ArticleVaultArticleManifest article = Article(ArticleA, bytes);
        ArticleVaultPlanRequest request = Request([article], [Observation(article)]);
        byte[] articleBytes = ArticleVaultManifestCodec.Serialize(article);
        byte[] rootBytes = ArticleVaultManifestCodec.Serialize(request.RootManifest);
        byte[] metadataBytes = ArticleVaultManifestCodec.Serialize(metadata);
        Require(articleBytes.SequenceEqual(ArticleVaultManifestCodec.Serialize(ArticleVaultManifestCodec.DeserializeArticle(articleBytes))), "article round-trip");
        Require(rootBytes.SequenceEqual(ArticleVaultManifestCodec.Serialize(ArticleVaultManifestCodec.DeserializeRoot(rootBytes))), "root round-trip");
        Require(metadataBytes.SequenceEqual(ArticleVaultManifestCodec.Serialize(ArticleVaultManifestCodec.DeserializeMetadata(metadataBytes))), "metadata round-trip");
        Require(ArticleVaultManifestValidator.ValidateBinding(article, metadata).IsValid, "metadata binding");
        s_artifacts["canonicalMetadata"] = Canonical(metadataBytes);
        _ = Plan(request);
    }

    private static void ReferenceRoundTrip()
    {
        const string AssetIdentity = "33333333-3333-4333-8333-333333333333";
        byte[] assetBytes = Encoding.UTF8.GetBytes("SYNTHETIC ASSET BYTES; not a media upload\n");
        AssetId asset = AssetId.Parse(AssetIdentity);
        Require(AssetId.Parse(asset.ToString()) == asset, "AssetId round-trip");
        byte[] transportedAsset = Convert.FromBase64String(Convert.ToBase64String(assetBytes));
        Require(assetBytes.SequenceEqual(transportedAsset), "synthetic asset bytes changed");
        ArticleBlockTarget target = ArticleBlockTarget.Create(ArticleB, BlockAnchorId.Create("synthetic-anchor"));
        string marker = BlockAnchorCodec.BuildSourceMarker(target.AnchorId);
        Require(BlockAnchorCodec.TryParseSourceMarker(marker, out BlockAnchorId parsed).IsValid
            && parsed == target.AnchorId, "canonical source marker round-trip");
        string markdown = BlockAnchorMarkdownBuilder.Build("Synthetic target", "synthetic-slug", target);
        Require(BlockAnchorMarkdownParser.TryParse(markdown, out BlockAnchorMarkdownLink? link).IsValid
            && link!.AnchorId == target.AnchorId, "canonical link round-trip");
        string renamedProjection = BlockAnchorMarkdownBuilder.Build("Synthetic target", "renamed-slug", target);
        Require(BlockAnchorContractDigest.ComputeTarget(target) == BlockAnchorContractDigest.ComputeTarget(
            ArticleBlockTarget.Create(ArticleB, parsed)), "target identity changed");
        ArticleEmbedTargetIdentity embed = new(ArticleB, ArticleEmbedTargetKind.Block, null, parsed.Value);
        string token = ArticleEmbedTargetCodec.Encode(embed);
        Require(ArticleEmbedTargetCodec.TryDecode(token, ArticleEmbedTargetKind.Block, out ArticleEmbedTargetIdentity? decoded).IsValid
            && decoded == embed, "canonical embed target round-trip");
        byte[] source = Encoding.UTF8.GetBytes($"# Synthetic references\n\n{marker}\n\n{markdown}\n\nAssetId: {asset}\n");
        ArticleVaultArticleManifest article = Article(ArticleA, source);
        _ = Plan(Request([article], [Observation(article)]));
        Require(ArticleVaultManifestValidator.ValidateSourceBytes(article.Coordinates.Local.Source!, source).IsValid, "reference source bytes");
        CaptureBytes("source", source);
        CaptureBytes("asset", assetBytes);
        s_artifacts["assetId"] = asset.ToString();
        s_artifacts["linkTarget"] = target;
        s_artifacts["targetDigest"] = BlockAnchorContractDigest.ComputeTarget(target);
        s_artifacts["linkMarkdown"] = markdown;
        s_artifacts["renamedLinkProjection"] = renamedProjection;
        s_artifacts["embedTargetToken"] = token;
        s_artifacts["portableDependencySync"] = "not-executable: PortableDependencyCodec and canonical package portable mapping absent from frozen master; no asset/link sync authority";
        s_artifacts["assetTransportQualification"] = "memory bytes only; no MIME, ledger, upload or filesystem materialization";
        s_artifacts["embedDirectiveParsing"] = "not-executable: FsusUI parser not imported; target token only, no frozen publication resolution";
    }

    private static void PermissionDrift()
    {
        ArticleVaultArticleManifest article = LocalEdit(Article(ArticleA), s_localBytes);
        ArticleVaultPlanRequest request = Request([article], [Observation(article)]);
        ArticleVaultSyncPlan plan = Plan(request);
        VaultArticleCoordinate changed = Seal(article.Coordinates.Server with
        {
            PermissionSha256 = Digest("synthetic-permission-denied")
        });
        ArticleVaultServerObservation observation = Observation(article, changed);
        ArticleVaultValidationResult result = ArticleVaultSyncPlanVerifier.VerifyCurrent(plan, request.RootManifest,
            request.ArticleManifests, [observation], Context());
        s_artifacts["driftedObservation"] = observation;
        s_artifacts["currentVerification"] = result;
        Require(!result.IsValid && result.ReasonCode == "article_vault_plan_coordinate_drift", "permission drift accepted");
    }

    private static void GitConflictFixture()
    {
        byte[] markerBytes = Encoding.UTF8.GetBytes("# Synthetic Git fixture\n<<<<<<< local\nLocal text\n=======\nServer text\n>>>>>>> server\n");
        CaptureBytes("local", markerBytes);
        ArticleVaultArticleManifest article = LocalEdit(Article(ArticleA), markerBytes);
        ArticleVaultSyncPlan plan = Plan(Request([article], [Observation(article)]));
        Require(plan.Groups[0].Items[0].Decision == VaultSyncDecision.PushUpdate, "frozen planner behavior changed");
        s_artifacts["execution"] = "not-executable: planner alone has no Git marker admission authority; canonical source-admission integration required before any writer";
        s_artifacts["gitProcessInvoked"] = false;
    }

    private static void MissingBase()
    {
        ArticleVaultArticleManifest article = Article(ArticleA);
        VaultArticleCoordinate absent = Seal(new VaultArticleCoordinate(ArticleVaultSchemas.Coordinate, 1, false, false,
            null, null, null, null, null, null, string.Empty));
        article = Seal(article with
        {
            Coordinates = article.Coordinates with
            {
                Base = absent
            }
        });
        ArticleVaultPlanRequest request = Request([article], [Observation(article)]);
        s_artifacts["input"] = request;
        ArticleVaultPlanBuildResult result = ArticleVaultSyncPlanner.Build(request);
        s_artifacts["canonicalBuildResult"] = new
        {
            result.IsSuccess,
            result.Errors
        };
        Require(result.Plan is null && result.Errors.Contains("article_vault_base_coordinate_missing"), "missing base accepted");
    }

    private static void OptOut()
    {
        s_artifacts["vaultConnected"] = false;
        s_artifacts["plannerInvoked"] = false;
        s_artifacts["watcherMounted"] = false;
        s_artifacts["productionWrites"] = 0;
        s_artifacts["serverAuthoringEvidence"] = "structural isolation only: no production project references, routes or wiring changed; actual server workflow E2E remains #1913";
        Require(typeof(Program).Assembly.GetReferencedAssemblies().All(static assembly =>
            !assembly.Name!.StartsWith("FsusBlog.Server", StringComparison.Ordinal)), "server assembly referenced");
    }

    private static ArticleVaultSyncPlan Plan(ArticleVaultPlanRequest request)
    {
        s_artifacts["input"] = request;
        ArticleVaultPlanBuildResult result = ArticleVaultSyncPlanner.Build(request);
        s_artifacts["canonicalBuildResult"] = new
        {
            result.IsSuccess,
            result.Errors
        };
        Require(result.IsSuccess, string.Join(',', result.Errors));
        ArticleVaultSyncPlan plan = result.Plan!;
        byte[] planBytes = ArticleVaultSyncPlanCodec.Serialize(plan);
        s_artifacts["canonicalPlan"] = Canonical(planBytes);
        s_artifacts["planSummary"] = new
        {
            plan.Status,
            plan.ContentSha256,
            plan.Conflicts,
            items = plan.Groups.SelectMany(static group => group.Items).Select(static item => new
            {
                item.PortableArticleIdentity,
                item.DerivedState,
                item.Decision
            }).ToArray()
        };
        s_artifacts["canonicalRoot"] = Canonical(ArticleVaultManifestCodec.Serialize(request.RootManifest));
        s_artifacts["canonicalArticles"] = request.ArticleManifests.Select(static article =>
            Canonical(ArticleVaultManifestCodec.Serialize(article))).ToArray();
        Require(ArticleVaultSyncPlanVerifier.ValidateStructure(plan).IsValid, "plan structure");
        Require(ArticleVaultSyncPlanVerifier.VerifyCurrent(plan, request.RootManifest, request.ArticleManifests,
            request.ServerObservations, Context()).IsValid, "current plan verification");
        Require(planBytes.SequenceEqual(ArticleVaultSyncPlanCodec.Serialize(ArticleVaultSyncPlanCodec.Deserialize(planBytes))), "plan codec round-trip");
        Require(planBytes.SequenceEqual(ArticleVaultSyncPlanCodec.Serialize(ArticleVaultSyncPlanner.Build(request).Plan!)), "repeated plan determinism");
        return plan;
    }

    private static ArticleVaultPlanVerificationContext Context() => new(CreatedAt, VaultSyncDirection.Sync, false);

    private static ArticleVaultPlanRequest Request(ArticleVaultArticleManifest[] articles, ArticleVaultServerObservation[] observations)
    {
        ArticleVaultRootManifest root = new(ArticleVaultSchemas.RootManifest, 1, ArticleVaultSchemas.ControlTreeVersion,
            new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
            "synthetic-site", "synthetic-vault", "synthetic-device",
            articles.OrderBy(static article => article.PortableArticleIdentity, StringComparer.Ordinal)
                .Select(static article => new VaultArticleReference(article.PortableArticleIdentity,
                    $"{ArticleVaultSchemas.ArticleManifestDirectory}/{article.PortableArticleIdentity}.json",
                    article.ContentSha256, article.PathProjection.RelativePath)).ToArray(), [], string.Empty);
        root = root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
        return new(root, articles, observations, [new("synthetic-group",
            articles.Select(static article => article.PortableArticleIdentity).ToArray(), [])],
            VaultSyncDirection.Sync, CreatedAt, CreatedAt + 60_000, false);
    }

    private static ArticleVaultMetadataManifest Metadata(string identity)
    {
        ArticleVaultMetadataManifest metadata = new(ArticleVaultSchemas.MetadataManifest, 1, "synthetic-site",
            "synthetic-vault", "synthetic-device", identity, $"server-{identity}", "Synthetic title", null,
            "synthetic-slug", Digest("synthetic-taxonomy"), Digest("synthetic-properties"), string.Empty);
        return metadata with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(metadata)
        };
    }

    private static VaultArticleCoordinate Coordinate(byte[] bytes, long revision = 4, string identity = ArticleA)
        => Seal(new VaultArticleCoordinate(ArticleVaultSchemas.Coordinate, 1, true, false, revision,
            ArticleVaultManifestCodec.CaptureSourceBytes(bytes), Metadata(identity).ContentSha256,
            Digest("synthetic-dependency-placeholder-not-accepted-authority"), "draft", Digest("synthetic-permission"), string.Empty));

    private static ArticleVaultArticleManifest Article(string identity, byte[]? bytes = null)
    {
        VaultArticleCoordinate coordinate = Coordinate(bytes ?? s_baseBytes, identity: identity);
        string path = identity == ArticleA ? "articles/synthetic-a.md" : "articles/synthetic-b.md";
        return Seal(new ArticleVaultArticleManifest(ArticleVaultSchemas.ArticleManifest, 1, "synthetic-site", "synthetic-vault", "synthetic-device",
            identity, $"server-{identity}", new(path, ArticleVaultManifestCodec.ComputeProjectionSha256(path)),
            new(coordinate, coordinate, coordinate), new(0, null, null, null, null, null, null), VaultArticleState.Clean, string.Empty));
    }

    private static ArticleVaultArticleManifest LocalEdit(ArticleVaultArticleManifest article, byte[] bytes)
        => Seal(article with
        {
            Coordinates = article.Coordinates with
            {
                Local = Seal(article.Coordinates.Local with
                {
                    Source = ArticleVaultManifestCodec.CaptureSourceBytes(bytes)
                })
            }
        });

    private static ArticleVaultArticleManifest Seal(ArticleVaultArticleManifest article)
    {
        article = article with
        {
            State = ArticleVaultStateMachine.Derive(article),
            ContentSha256 = string.Empty
        };
        return article with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
        };
    }

    private static VaultArticleCoordinate Seal(VaultArticleCoordinate coordinate)
        => coordinate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
        };

    private static ArticleVaultServerObservation Observation(ArticleVaultArticleManifest article, VaultArticleCoordinate? coordinate = null)
    {
        ArticleVaultServerObservation observation = new(ArticleVaultPlanSchemas.ServerObservation, 1,
            article.SiteIdentity, article.VaultIdentity, article.DeviceIdentity, article.PortableArticleIdentity,
            article.ServerArticleIdentity, coordinate ?? article.Coordinates.Server, string.Empty);
        return observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
    }

    private static string Digest(string text) => ArticleVaultManifestCodec.ComputeSha256(Encoding.UTF8.GetBytes(text));

    private static object Canonical(byte[] bytes) => new
    {
        utf8Base64 = Convert.ToBase64String(bytes),
        sha256 = ArticleVaultManifestCodec.ComputeSha256(bytes)
    };

    private static void CaptureBytes(string name, byte[] bytes)
        => s_artifacts[$"{name}Bytes"] = new
        {
            base64 = Convert.ToBase64String(bytes),
            identity = ArticleVaultManifestCodec.CaptureSourceBytes(bytes)
        };

    private static void Require(bool condition, string reason)
    {
        if (!condition)
        {
            throw new InvalidOperationException(reason);
        }
    }

    private sealed record ScenarioResult(string Name, string Outcome, SortedDictionary<string, object?> Artifacts, string? Error);
}
