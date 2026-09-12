using System.Text;
using System.Text.Json;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultSyncPlannerTests
{
    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string DigestC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    [Fact]
    public void Build_ProducesStableCanonicalPlanAcrossInputOrdering()
    {
        ArticleVaultArticleManifest first = CreateArticle("portable-article-a");
        ArticleVaultArticleManifest second = CreateArticle("portable-article-b");
        ArticleVaultServerObservation firstObservation = CreateObservation(first);
        ArticleVaultServerObservation secondObservation = CreateObservation(second);
        VaultPlanGroupRequest group = new(
            "group-primary",
            [second.PortableArticleIdentity, first.PortableArticleIdentity],
            [new VaultPlanDependency(first.PortableArticleIdentity, second.PortableArticleIdentity)]);
        ArticleVaultPlanRequest request = CreateRequest(
            [second, first],
            [secondObservation, firstObservation],
            [group]);
        ArticleVaultPlanRequest reordered = request with
        {
            ArticleManifests = [first, second],
            ServerObservations = [firstObservation, secondObservation],
            Groups =
            [
                group with
                {
                    PortableArticleIdentities = [first.PortableArticleIdentity, second.PortableArticleIdentity]
                }
            ]
        };

        ArticleVaultSyncPlan firstPlan = AssertPlan(request);
        ArticleVaultSyncPlan secondPlan = AssertPlan(reordered);

        Assert.Equal(ArticleVaultSyncPlanCodec.Serialize(firstPlan), ArticleVaultSyncPlanCodec.Serialize(secondPlan));
        Assert.Equal(firstPlan.IdempotencyKey, secondPlan.IdempotencyKey);
        Assert.Equal(
            [first.PortableArticleIdentity, second.PortableArticleIdentity],
            firstPlan.Groups[0].Items.Select(static item => item.PortableArticleIdentity));
        Assert.Equal(firstPlan.Groups[0].Items.Select(static item => item.OperationIdentity), firstPlan.OperationOrder);
        Assert.True(ArticleVaultSyncPlanVerifier.VerifyCurrent(
            firstPlan,
            request.RootManifest,
            request.ArticleManifests,
            request.ServerObservations,
            VerificationContext(request)).IsValid);
    }

    [Fact]
    public void PullPushAndSync_UseOnePlannerWithDirectionOnlyPolicyDifference()
    {
        ArticleVaultArticleManifest article = WithLocalSource(CreateArticle("portable-article-a"), DigestB);
        ArticleVaultServerObservation observation = CreateObservation(article);
        ArticleVaultPlanRequest request = CreateRequest([article], [observation]);

        ArticleVaultSyncPlan pull = AssertPlan(request with
        {
            Direction = VaultSyncDirection.Pull
        });
        ArticleVaultSyncPlan push = AssertPlan(request with
        {
            Direction = VaultSyncDirection.Push
        });
        ArticleVaultSyncPlan sync = AssertPlan(request with
        {
            Direction = VaultSyncDirection.Sync
        });

        Assert.Equal(VaultSyncPlanStatus.Blocked, pull.Status);
        Assert.Equal("direction_rejects_local_change", Assert.Single(pull.Conflicts).ReasonCode);
        Assert.Empty(pull.OperationOrder);
        Assert.Equal(VaultSyncDecision.PushUpdate, Assert.Single(Assert.Single(push.Groups).Items).Decision);
        Assert.Equal(VaultSyncDecision.PushUpdate, Assert.Single(Assert.Single(sync.Groups).Items).Decision);
        Assert.Single(typeof(ArticleVaultSyncPlanner).GetMethods(), static method => method.Name == "Build");
    }

    [Fact]
    public void Planner_UsesPortableIdentityAndNeverPathTitleMtimeOrImportFallback()
    {
        ArticleVaultArticleManifest article = CreateArticle("portable-article-a");
        string renamedPath = "renamed/unrelated-title.md";
        ArticleVaultArticleManifest renamed = Seal(article with
        {
            PathProjection = new(
                renamedPath,
                ArticleVaultManifestCodec.ComputeProjectionSha256(renamedPath))
        });
        ArticleVaultPlanRequest request = CreateRequest([renamed], [CreateObservation(renamed)]);

        VaultSyncPlanItem item = Assert.Single(Assert.Single(AssertPlan(request).Groups).Items);

        Assert.Equal(article.PortableArticleIdentity, item.PortableArticleIdentity);
        Assert.Equal(VaultSyncDecision.NoOp, item.Decision);
        string[] inputNames = typeof(ArticleVaultPlanRequest).GetProperties()
            .Select(static property => property.Name)
            .Concat(typeof(VaultSyncPlanItem).GetProperties().Select(static property => property.Name))
            .ToArray();
        Assert.DoesNotContain(inputNames, static name =>
            name.Contains("Mtime", StringComparison.OrdinalIgnoreCase)
            || name.Contains("Title", StringComparison.OrdinalIgnoreCase)
            || name.Contains("Import", StringComparison.OrdinalIgnoreCase)
            || name.Contains("Filesystem", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Build_RejectsCrossVaultObservationAndDuplicateArticle()
    {
        ArticleVaultArticleManifest article = CreateArticle("portable-article-a");
        ArticleVaultServerObservation wrongVault = Seal(CreateObservation(article) with
        {
            VaultIdentity = "vault-other"
        });

        ArticleVaultPlanBuildResult crossVault = ArticleVaultSyncPlanner.Build(
            CreateRequest([article], [wrongVault]));
        ArticleVaultPlanBuildResult duplicate = ArticleVaultSyncPlanner.Build(
            CreateRequest([article, article], [CreateObservation(article)]));

        Assert.Null(crossVault.Plan);
        Assert.Contains("article_vault_server_observation_binding_mismatch", crossVault.Errors);
        Assert.Null(duplicate.Plan);
        Assert.Contains("article_vault_plan_duplicate_article", duplicate.Errors);
    }

    [Fact]
    public void Build_RejectsMissingBaseBeforeAnyTwoWayDecision()
    {
        ArticleVaultArticleManifest article = CreateArticle("portable-article-a");
        VaultArticleCoordinate absent = AbsentCoordinate();
        ArticleVaultArticleManifest missingBase = Seal(article with
        {
            Coordinates = article.Coordinates with
            {
                Base = absent
            }
        });

        ArticleVaultPlanBuildResult result = ArticleVaultSyncPlanner.Build(
            CreateRequest([missingBase], [CreateObservation(missingBase)]));

        Assert.Null(result.Plan);
        Assert.Contains("article_vault_base_coordinate_missing", result.Errors);
    }

    [Fact]
    public void BothModified_BlocksWholePlanAndFreezesConflict()
    {
        ArticleVaultArticleManifest article = WithLocalSource(CreateArticle("portable-article-a"), DigestB);
        ArticleVaultServerObservation observation = CreateObservation(
            article,
            Seal(article.Coordinates.Server with
            {
                ServerRevision = 5,
                Source = article.Coordinates.Server.Source! with
                {
                    Sha256 = DigestC
                }
            }));
        ArticleVaultPlanRequest request = CreateRequest([article], [observation]);

        ArticleVaultSyncPlan plan = AssertPlan(request);

        Assert.Equal(VaultSyncPlanStatus.Blocked, plan.Status);
        Assert.Empty(plan.OperationOrder);
        Assert.Equal(VaultSyncDecision.Blocked, Assert.Single(Assert.Single(plan.Groups).Items).Decision);
        Assert.Equal("both_modified", Assert.Single(plan.Conflicts).ReasonCode);
        Assert.True(ArticleVaultSyncPlanVerifier.VerifyCurrent(
            plan,
            request.RootManifest,
            request.ArticleManifests,
            request.ServerObservations,
            VerificationContext(request)).IsValid);
    }

    [Fact]
    public void UnresolvedDependency_ReturnsNoPartialPlan()
    {
        ArticleVaultArticleManifest article = CreateArticle("portable-article-a");
        VaultPlanGroupRequest group = new(
            "group-primary",
            [article.PortableArticleIdentity],
            [new VaultPlanDependency("portable-article-missing", article.PortableArticleIdentity)]);

        ArticleVaultPlanBuildResult result = ArticleVaultSyncPlanner.Build(
            CreateRequest([article], [CreateObservation(article)], [group]));

        Assert.Null(result.Plan);
        Assert.Contains("article_vault_plan_dependency_unresolved", result.Errors);
    }

    [Fact]
    public void VerifyCurrent_RejectsRevisionPermissionAndSchemaDriftAfterSeal()
    {
        ArticleVaultArticleManifest article = CreateArticle("portable-article-a");
        ArticleVaultServerObservation observation = CreateObservation(article);
        ArticleVaultPlanRequest request = CreateRequest([article], [observation]);
        ArticleVaultSyncPlan plan = AssertPlan(request);
        VaultArticleCoordinate driftedCoordinate = Seal(observation.ServerCoordinate with
        {
            ServerRevision = 5
        });
        ArticleVaultServerObservation drifted = CreateObservation(article, driftedCoordinate);
        ArticleVaultServerObservation permissionDrift = CreateObservation(
            article,
            Seal(observation.ServerCoordinate with
            {
                PermissionSha256 = DigestB
            }));
        ArticleVaultServerObservation schemaDrift = Seal(observation with
        {
            SchemaVersion = 2
        });

        Assert.Equal(
            "article_vault_plan_coordinate_drift",
            ArticleVaultSyncPlanVerifier.VerifyCurrent(
                plan,
                request.RootManifest,
                request.ArticleManifests,
                [drifted],
                VerificationContext(request)).ReasonCode);
        Assert.Equal(
            "article_vault_plan_coordinate_drift",
            ArticleVaultSyncPlanVerifier.VerifyCurrent(
                plan,
                request.RootManifest,
                request.ArticleManifests,
                [permissionDrift],
                VerificationContext(request)).ReasonCode);
        Assert.Equal(
            "article_vault_server_observation_schema_unknown",
            ArticleVaultSyncPlanVerifier.VerifyCurrent(
                plan,
                request.RootManifest,
                request.ArticleManifests,
                [schemaDrift],
                VerificationContext(request)).ReasonCode);
    }

    [Fact]
    public void ExpiryCancellationAndIdempotency_AreExplicitAndFailClosed()
    {
        ArticleVaultArticleManifest article = CreateArticle("portable-article-a");
        ArticleVaultServerObservation observation = CreateObservation(article);
        ArticleVaultPlanRequest request = CreateRequest([article], [observation]);
        ArticleVaultSyncPlan first = AssertPlan(request);
        ArticleVaultSyncPlan retry = AssertPlan(request);
        ArticleVaultSyncPlan cancelled = AssertPlan(request with
        {
            CancellationRequested = true
        });

        Assert.Equal(first.IdempotencyKey, retry.IdempotencyKey);
        Assert.Equal(first.PlanCandidateIdentity, retry.PlanCandidateIdentity);
        Assert.Equal(first.ResultCandidateIdentity, retry.ResultCandidateIdentity);
        Assert.Equal(
            "article_vault_plan_expired",
            ArticleVaultSyncPlanVerifier.VerifyCurrent(
                first,
                request.RootManifest,
                request.ArticleManifests,
                request.ServerObservations,
                VerificationContext(request, request.ExpiresAtUnixMs + 1)).ReasonCode);
        Assert.Equal(
            "article_vault_plan_policy_drift",
            ArticleVaultSyncPlanVerifier.VerifyCurrent(
                first,
                request.RootManifest,
                request.ArticleManifests,
                request.ServerObservations,
                VerificationContext(request) with
                {
                    Direction = VaultSyncDirection.Pull
                }).ReasonCode);
        Assert.Equal(VaultSyncPlanStatus.Cancelled, cancelled.Status);
        Assert.True(cancelled.CancellationRequested);
        Assert.Empty(cancelled.OperationOrder);
    }

    [Fact]
    public void ClosedCodec_RejectsUnknownFieldsOrderTamperAndDigestTamper()
    {
        ArticleVaultArticleManifest article = CreateArticle("portable-article-a");
        ArticleVaultPlanRequest request = CreateRequest([article], [CreateObservation(article)]);
        ArticleVaultSyncPlan plan = AssertPlan(request);
        string json = Encoding.UTF8.GetString(ArticleVaultSyncPlanCodec.Serialize(plan));
        string unknown = json[..^1] + ",\"latestReceipt\":true}";
        ArticleVaultSyncPlan orderTamper = plan with
        {
            OperationOrder = ["operation-forged"]
        };
        ArticleVaultSyncPlan digestTamper = plan with
        {
            ExpiresAtUnixMs = plan.ExpiresAtUnixMs + 1
        };

        Assert.Throws<InvalidDataException>(
            () => ArticleVaultSyncPlanCodec.Deserialize(Encoding.UTF8.GetBytes(unknown)));
        Assert.Equal(
            "article_vault_plan_operation_order_invalid",
            ArticleVaultSyncPlanVerifier.ValidateStructure(orderTamper).ReasonCode);
        Assert.Equal(
            "article_vault_plan_idempotency_mismatch",
            ArticleVaultSyncPlanVerifier.ValidateStructure(digestTamper).ReasonCode);
    }

    [Fact]
    public void PlanSchema_IsEmbeddedClosedAndVersioned()
    {
        const string SchemaName = "FsusBlog.Contracts.ArticleVault.article-vault-sync-plan.schema.json";
        Assert.Contains(SchemaName, typeof(ArticleVaultSyncPlan).Assembly.GetManifestResourceNames());
        using Stream stream = typeof(ArticleVaultSyncPlan).Assembly.GetManifestResourceStream(SchemaName)!;
        using JsonDocument schema = JsonDocument.Parse(stream);

        Assert.False(schema.RootElement.GetProperty("additionalProperties").GetBoolean());
        Assert.Equal(
            ArticleVaultPlanSchemas.Plan,
            schema.RootElement.GetProperty("properties").GetProperty("schema").GetProperty("const").GetString());
    }

    private static ArticleVaultSyncPlan AssertPlan(ArticleVaultPlanRequest request)
    {
        ArticleVaultPlanBuildResult result = ArticleVaultSyncPlanner.Build(request);
        Assert.True(result.IsSuccess, string.Join(',', result.Errors));
        return Assert.IsType<ArticleVaultSyncPlan>(result.Plan);
    }

    private static ArticleVaultPlanVerificationContext VerificationContext(
        ArticleVaultPlanRequest request,
        long? nowUnixMs = null)
        => new(
            nowUnixMs ?? request.CreatedAtUnixMs,
            request.Direction,
            request.CancellationRequested);

    private static ArticleVaultPlanRequest CreateRequest(
        IReadOnlyList<ArticleVaultArticleManifest> articles,
        IReadOnlyList<ArticleVaultServerObservation> observations,
        IReadOnlyList<VaultPlanGroupRequest>? groups = null)
    {
        ArticleVaultRootManifest root = SealRoot(articles);
        groups ??=
        [
            new VaultPlanGroupRequest(
                "group-primary",
                articles.Select(static article => article.PortableArticleIdentity).ToArray(),
                [])
        ];
        return new ArticleVaultPlanRequest(
            root,
            articles,
            observations,
            groups,
            VaultSyncDirection.Sync,
            CreatedAtUnixMs: 1_800_000_000_000,
            ExpiresAtUnixMs: 1_800_000_060_000,
            CancellationRequested: false);
    }

    private static ArticleVaultArticleManifest CreateArticle(string portableIdentity)
    {
        VaultArticleCoordinate coordinate = CreateCoordinate(4);
        string path = $"articles/{portableIdentity}.md";
        return Seal(new ArticleVaultArticleManifest(
            ArticleVaultSchemas.ArticleManifest,
            ArticleVaultSchemas.Version,
            "site-primary",
            "vault-primary",
            "device-primary",
            portableIdentity,
            $"server-{portableIdentity}",
            new VaultPathProjection(path, ArticleVaultManifestCodec.ComputeProjectionSha256(path)),
            new VaultArticleCoordinates(coordinate, coordinate, coordinate),
            new VaultOperationWatermarks(0, null, null, null, null, null, null),
            VaultArticleState.Clean,
            string.Empty));
    }

    private static ArticleVaultArticleManifest WithLocalSource(
        ArticleVaultArticleManifest article,
        string sourceSha256)
    {
        VaultArticleCoordinate local = Seal(article.Coordinates.Local with
        {
            Source = article.Coordinates.Local.Source! with
            {
                Sha256 = sourceSha256
            }
        });
        return Seal(article with
        {
            Coordinates = article.Coordinates with
            {
                Local = local
            }
        });
    }

    private static ArticleVaultServerObservation CreateObservation(
        ArticleVaultArticleManifest article,
        VaultArticleCoordinate? server = null)
        => Seal(new ArticleVaultServerObservation(
            ArticleVaultPlanSchemas.ServerObservation,
            ArticleVaultPlanSchemas.Version,
            article.SiteIdentity,
            article.VaultIdentity,
            article.DeviceIdentity,
            article.PortableArticleIdentity,
            article.ServerArticleIdentity,
            server ?? article.Coordinates.Server,
            string.Empty));

    private static VaultArticleCoordinate CreateCoordinate(long revision)
        => Seal(new VaultArticleCoordinate(
            ArticleVaultSchemas.Coordinate,
            ArticleVaultSchemas.Version,
            Present: true,
            Deleted: false,
            ServerRevision: revision,
            Source: new VaultSourceByteIdentity(DigestA, 42, false, VaultNewlineStyle.Lf, 0, true),
            MetadataManifestSha256: DigestB,
            DependencySha256: DigestC,
            Lifecycle: "draft",
            PermissionSha256: DigestC,
            ContentSha256: string.Empty));

    private static VaultArticleCoordinate AbsentCoordinate()
        => Seal(new VaultArticleCoordinate(
            ArticleVaultSchemas.Coordinate,
            ArticleVaultSchemas.Version,
            false,
            false,
            null,
            null,
            null,
            null,
            null,
            null,
            string.Empty));

    private static ArticleVaultArticleManifest Seal(ArticleVaultArticleManifest article)
    {
        ArticleVaultArticleManifest stateBound = article with
        {
            State = ArticleVaultStateMachine.Derive(article),
            ContentSha256 = string.Empty
        };
        return stateBound with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(stateBound)
        };
    }

    private static VaultArticleCoordinate Seal(VaultArticleCoordinate coordinate)
    {
        VaultArticleCoordinate unsealed = coordinate with
        {
            ContentSha256 = string.Empty
        };
        return unsealed with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsealed)
        };
    }

    private static ArticleVaultServerObservation Seal(ArticleVaultServerObservation observation)
    {
        ArticleVaultServerObservation unsealed = observation with
        {
            ContentSha256 = string.Empty
        };
        return unsealed with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(unsealed)
        };
    }

    private static ArticleVaultRootManifest SealRoot(IReadOnlyList<ArticleVaultArticleManifest> articles)
    {
        ArticleVaultRootManifest unsealed = new(
            ArticleVaultSchemas.RootManifest,
            ArticleVaultSchemas.Version,
            ArticleVaultSchemas.ControlTreeVersion,
            new VaultControlTree(
                ArticleVaultSchemas.RootManifestPath,
                ArticleVaultSchemas.ArticleManifestDirectory,
                ArticleVaultSchemas.ReceiptDirectory),
            "site-primary",
            "vault-primary",
            "device-primary",
            articles
                .OrderBy(static article => article.PortableArticleIdentity, StringComparer.Ordinal)
                .Select(static article => new VaultArticleReference(
                    article.PortableArticleIdentity,
                    $"{ArticleVaultSchemas.ArticleManifestDirectory}/{article.PortableArticleIdentity}.json",
                    article.ContentSha256,
                    article.PathProjection.RelativePath))
                .ToArray(),
            [],
            string.Empty);
        return unsealed with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsealed)
        };
    }
}
