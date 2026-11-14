using System.Text;
using System.Text.Json.Nodes;

using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class PortableDependencyManifestTests
{
    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly VaultDependencyBinding s_binding = new("site-primary", "vault-primary", "article:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly byte[] s_source = [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes("hello  \r\n")];
    private static readonly ArticleEmbedResolutionBudgetLimits s_budgets = new(8, 100, 1_000_000, 10_000, 100);
    private static readonly VaultDependencyAdmission s_admission = new(ArticleEmbedPermissionStatus.Allowed,
        VaultDependencyRights.Read | VaultDependencyRights.Reference | VaultDependencyRights.Materialize | VaultDependencyRights.Upload,
        VaultDependencyRights.Read | VaultDependencyRights.Reference | VaultDependencyRights.Materialize | VaultDependencyRights.Upload,
        DigestA, DigestA, DigestA);

    [Fact]
    public void SourceOnly_RoundTripsExactBytesAndOnePortableSchema()
    {
        PortableDependencyManifest manifest = Create([]);
        Assert.True(PortableDependencyVerifier.ValidateStructure(manifest).IsValid);
        byte[] encoded = PortableDependencyCodec.Serialize(manifest);
        PortableDependencyManifest restored = PortableDependencyCodec.Deserialize(encoded);
        Assert.Equal(encoded, PortableDependencyCodec.Serialize(restored));
        Assert.Equal(manifest.Source, restored.Source);
        Assert.True(restored.Source.HasUtf8Bom);
        Assert.Equal(VaultNewlineStyle.CrLf, restored.Source.NewlineStyle);
        Assert.True(Verify(restored, []).IsValid);
    }

    [Fact]
    public void GraphIdentity_IgnoresNodeAndEdgeInputOrder()
    {
        VaultDependencyNode[] nodes = [Asset(), Link(), Anchor(), Embed()];
        VaultDependencyEdge[] edges =
        [
            new(PortableDependencyCodec.NodeKey(nodes[0]), PortableDependencyCodec.NodeKey(nodes[1]), VaultDependencyEdgeKind.Requires),
            new(PortableDependencyCodec.NodeKey(nodes[1]), PortableDependencyCodec.NodeKey(nodes[3]), VaultDependencyEdgeKind.FrozenRequires)
        ];
        PortableDependencyManifest first = Create(nodes, edges);
        PortableDependencyManifest second = Create(nodes.Reverse().ToArray(), edges.Reverse().ToArray());
        Assert.Equal(first.GraphSha256, second.GraphSha256);
        Assert.Equal(first.ContentSha256, second.ContentSha256);
        Assert.Equal(PortableDependencyCodec.Serialize(first), PortableDependencyCodec.Serialize(second));
        Assert.True(Verify(first, nodes).IsValid);
    }

    [Fact]
    public void GraphIdentity_ChangesForTargetBytesPermissionAndOwnership()
    {
        VaultAssetDependency asset = Asset();
        string digest = Create([asset]).GraphSha256;
        Assert.NotEqual(digest, Create([asset with { ContentSha256 = DigestB }]).GraphSha256);
        Assert.NotEqual(digest, Create([asset with { OwnerAdminPrincipalId = 2 }]).GraphSha256);
        Assert.NotEqual(digest, Create([asset with { Admission = s_admission with { RightsSha256 = DigestB } }]).GraphSha256);
        Assert.NotEqual(Create([Link()]).GraphSha256,
            Create([Link() with { Target = new("article:cccccccc-cccc-cccc-cccc-cccccccccccc", ArticleEmbedTargetKind.Article, null, null),
                TargetBinding = s_binding with { PortableArticleIdentity = "article:cccccccc-cccc-cccc-cccc-cccccccccccc" } }]).GraphSha256);
    }

    [Theory]
    [InlineData("asset", "publicUrl", "https://example.test/a.png")]
    [InlineData("asset", "filePath", "../a.png")]
    [InlineData("anchor", "sidecarId", "a")]
    [InlineData("link", "title", "target")]
    [InlineData("link", "slug", "target")]
    [InlineData("link", "path", "target.md")]
    [InlineData("frozen-embed", "latestTarget", "latest")]
    [InlineData("frozen-embed", "renderedHtml", "<p>body</p>")]
    public void Decoder_RejectsAlternateAuthorityFields(string kind, string property, string value)
    {
        VaultDependencyNode node = kind switch
        {
            "asset" => Asset(),
            "anchor" => Anchor(),
            "link" => Link(),
            _ => Embed()
        };
        string json = Encoding.UTF8.GetString(PortableDependencyCodec.Serialize(Create([node])));
        string marker = "\"kind\":\"" + kind + "\"";
        string tampered = json.Replace(marker, marker + ",\"" + property + "\":\"" + value + "\"", StringComparison.Ordinal);
        Assert.NotEqual(json, tampered);
        Assert.Throws<InvalidDataException>(() => PortableDependencyCodec.Deserialize(Encoding.UTF8.GetBytes(tampered)));
    }

    [Theory]
    [InlineData("article-vault.v0")]
    [InlineData("fsusblog.package-dependency.v1")]
    [InlineData("fsusblog.export-dependency.v1")]
    public void Decoder_RejectsIndependentFlowSchemas(string schema)
    {
        Assert.False(PortableDependencyVerifier.ValidateStructure(Create([]) with
        {
            Schema = schema
        }).IsValid);
    }

    [Fact]
    public void Decoder_RejectsUnknownKindsDuplicatePropertiesAndMissingFields()
    {
        string json = Encoding.UTF8.GetString(PortableDependencyCodec.Serialize(Create([Asset()])));
        JsonNode missing = JsonNode.Parse(json)!;
        missing["nodes"]![0]!.AsObject().Remove("serverRevision");
        foreach (string changed in new[]
        {
            json.Replace("\"kind\":\"asset\"", "\"kind\":\"url-asset\"", StringComparison.Ordinal),
            json.Replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"schemaVersion\":1", StringComparison.Ordinal),
            missing.ToJsonString(),
            json.Replace("\"assetIdentity\":\"11111111-1111-1111-1111-111111111111\"", "\"assetIdentity\":\"https://example.test/x\"", StringComparison.Ordinal)
        })
        {
            Assert.NotEqual(json, changed);
            Assert.Throws<InvalidDataException>(() => PortableDependencyCodec.Deserialize(Encoding.UTF8.GetBytes(changed)));
        }
    }

    [Theory]
    [InlineData("permission", "Allowed")]
    [InlineData("permission", "999")]
    [InlineData("sourceSide", "Local")]
    [InlineData("sourceSide", "9")]
    [InlineData("requiredRights", "read, unknown")]
    public void Decoder_RejectsEnumSchemaDrift(string property, string value)
    {
        JsonNode json = JsonNode.Parse(PortableDependencyCodec.Serialize(Create([Asset()])))!;
        if (property == "sourceSide")
        {
            json[property] = value;
        }
        else
        {
            json["nodes"]![0]!["admission"]![property] = value;
        }
        Assert.Throws<InvalidDataException>(() => PortableDependencyCodec.Deserialize(Encoding.UTF8.GetBytes(json.ToJsonString())));
    }

    [Fact]
    public void Verifier_RejectsDuplicateNodeAndEdgeIdentitiesAndUnknownEdges()
    {
        VaultAssetDependency asset = Asset();
        Assert.Equal("portable_dependency_node_duplicate", PortableDependencyVerifier.ValidateStructure(Create([asset, asset])).ReasonCode);
        VaultLinkDependency link = Link();
        VaultDependencyEdge edge = new(PortableDependencyCodec.NodeKey(asset), PortableDependencyCodec.NodeKey(link), VaultDependencyEdgeKind.Requires);
        Assert.Equal("portable_dependency_edge_duplicate", PortableDependencyVerifier.ValidateStructure(Create([asset, link], [edge, edge])).ReasonCode);
        Assert.Equal("portable_dependency_edge_invalid", PortableDependencyVerifier.ValidateStructure(Create([asset, link], [edge]) with
        {
            Edges = [edge with { Kind = (VaultDependencyEdgeKind)999 }]
        }).ReasonCode);
    }

    [Theory]
    [InlineData("site")]
    [InlineData("vault")]
    [InlineData("article")]
    public void Verifier_RejectsCrossScopeHostFacts(string scope)
    {
        VaultDependencyBinding foreign = scope switch
        {
            "site" => s_binding with { SiteIdentity = "site-other" },
            "vault" => s_binding with { VaultIdentity = "vault-other" },
            _ => s_binding with { PortableArticleIdentity = "article:dddddddd-dddd-dddd-dddd-dddddddddddd" }
        };
        Assert.Equal("portable_dependency_binding_mismatch",
            PortableDependencyVerifier.ValidateStructure(Create([Asset() with { Binding = foreign }])).ReasonCode);
    }

    [Fact]
    public void Verifier_RejectsCrossSiteTargetsForeignAnchorsAndLatestEmbeds()
    {
        Assert.False(PortableDependencyVerifier.ValidateStructure(Create([Link() with
        {
            TargetBinding = Link().TargetBinding with { SiteIdentity = "site-other" }
        }])).IsValid);
        Assert.False(PortableDependencyVerifier.ValidateStructure(Create([Anchor() with
        {
            Target = ArticleBlockTarget.Create("article:dddddddd-dddd-dddd-dddd-dddddddddddd", BlockAnchorId.Create("source-anchor"))
        }])).IsValid);
        Assert.False(PortableDependencyVerifier.ValidateStructure(Create([Embed() with
        {
            Coordinate = Embed().Coordinate with { ResolvedRevision = 0 }
        }])).IsValid);
    }

    [Fact]
    public void CurrentVerifier_RejectsMissingCorruptRightsAndPermissionDrift()
    {
        VaultAssetDependency asset = Asset();
        PortableDependencyManifest manifest = Create([asset]);
        Assert.Equal("portable_dependency_authority_missing", Verify(manifest, []).ReasonCode);
        Assert.Equal("portable_dependency_authority_drift", Verify(manifest, [asset with { ContentSha256 = DigestB }]).ReasonCode);
        Assert.Equal("portable_dependency_authority_drift", Verify(manifest, [asset with { Admission = s_admission with { RightsSha256 = DigestB } }]).ReasonCode);
        Assert.Equal("portable_dependency_permission_or_rights_invalid", Verify(manifest, [asset with
        {
            Admission = s_admission with { Permission = ArticleEmbedPermissionStatus.Denied }
        }]).ReasonCode);
        Assert.False(Verify(manifest, [asset with { Admission = s_admission with { GrantedRights = VaultDependencyRights.Read } }]).IsValid);
        Assert.False(Verify(manifest, [asset], source: [.. s_source, 1]).IsValid);
    }

    [Fact]
    public void CurrentVerifier_RejectsResealedGraphAndRelationDrift()
    {
        VaultDependencyNode[] nodes = [Asset(), Link()];
        VaultDependencyEdge edge = new(PortableDependencyCodec.NodeKey(nodes[0]), PortableDependencyCodec.NodeKey(nodes[1]), VaultDependencyEdgeKind.Requires);
        PortableDependencyManifest manifest = Create(nodes, [edge]);
        Assert.Equal("portable_dependency_relation_edges_drift", Verify(manifest, nodes, []).ReasonCode);
        Assert.False(PortableDependencyVerifier.VerifyCurrent(manifest, Article(manifest), s_source, nodes, [edge], DigestB, s_budgets).IsValid);
    }

    [Fact]
    public void Budgets_RejectCycleDepthNodeBytesAndTimeExcess()
    {
        VaultDependencyNode[] nodes = [Asset(), Link()];
        string first = PortableDependencyCodec.NodeKey(nodes[0]);
        string second = PortableDependencyCodec.NodeKey(nodes[1]);
        PortableDependencyManifest chain = Create(nodes, [new(first, second, VaultDependencyEdgeKind.Requires)]);
        PortableDependencyManifest cycle = Create(nodes, [new(first, second, VaultDependencyEdgeKind.Requires), new(second, first, VaultDependencyEdgeKind.Requires)]);
        Assert.Equal("portable_dependency_cycle", PortableDependencyVerifier.VerifyBudgets(cycle, s_budgets, out _).ReasonCode);
        Assert.Equal("portable_dependency_depth_exceeded", PortableDependencyVerifier.VerifyBudgets(chain, s_budgets with
        {
            MaxDepth = 1
        }, out _).ReasonCode);
        Assert.Equal("portable_dependency_size_exceeded", PortableDependencyVerifier.VerifyBudgets(chain, s_budgets with
        {
            MaxExpandedNodes = 1
        }, out _).ReasonCode);
        Assert.Equal("portable_dependency_size_exceeded", PortableDependencyVerifier.VerifyBudgets(chain, s_budgets with
        {
            MaxSourceBytes = 1
        }, out _).ReasonCode);
        Assert.Equal("portable_dependency_time_exceeded", PortableDependencyVerifier.VerifyBudgets(chain, s_budgets with
        {
            MaxElapsedMilliseconds = 1
        }, out _, new AdvancingTime()).ReasonCode);
    }

    [Fact]
    public void Extension_BindsCanonicalAtomicGroupsAndRejectsPlanTamper()
    {
        PortableDependencyManifest manifest = Create([Asset(), Link()]);
        ArticleVaultPlanRequest request = Request(Article(manifest));
        ArticleVaultSyncPlan sync = ArticleVaultSyncPlanner.Build(request).Plan!;
        Assert.NotNull(sync);
        VaultDependencyPlanInput[] inputs = [new(manifest, s_source, manifest.Nodes, manifest.Edges, DigestA)];
        ArticleVaultPlanVerificationContext context = new(request.CreatedAtUnixMs, request.Direction, false);
        VaultDependencyPlanBuildResult built = ArticleVaultDependencyPlanner.Build(sync, request, context, inputs, s_budgets);
        Assert.Null(built.ReasonCode);
        Assert.NotNull(built.Plan);
        ArticleVaultDependencyPlan extension = built.Plan!;
        Assert.Equal(sync.ContentSha256, extension.SyncPlanSha256);
        byte[] encodedExtension = PortableDependencyCodec.Serialize(extension);
        Assert.Equal(encodedExtension, PortableDependencyCodec.Serialize(PortableDependencyCodec.DeserializePlan(encodedExtension)));
        Assert.Equal(sync.OperationOrder, extension.OperationOrder);
        Assert.Equal(2, Assert.Single(extension.Items).DependencyOrder.Count);
        Assert.True(ArticleVaultDependencyPlanner.VerifyCurrent(extension, sync, request, context, inputs, s_budgets).IsValid);
        Assert.False(ArticleVaultDependencyPlanner.VerifyCurrent(extension with
        {
            OperationOrder = []
        }, sync, request, context, inputs, s_budgets).IsValid);
        Assert.Null(ArticleVaultDependencyPlanner.Build(sync, request, context, [], s_budgets).Plan);
        Assert.Null(ArticleVaultDependencyPlanner.Build(sync, request, context, [inputs[0] with { CurrentAuthorityNodes = [] }], s_budgets).Plan);
    }

    [Fact]
    public void PullExtension_BindsFreshObservationInsteadOfStoredServerCoordinate()
    {
        PortableDependencyManifest stored = Create([Asset()]);
        ArticleVaultArticleManifest article = Article(stored);
        ArticleVaultPlanRequest original = Request(article);
        byte[] freshBytes = Encoding.UTF8.GetBytes("new server source\r\n");
        PortableDependencyManifest fresh = stored with
        {
            SourceSide = VaultDependencySourceSide.Server,
            Source = ArticleVaultManifestCodec.CaptureSourceBytes(freshBytes)
        };
        string graph = PortableDependencyCodec.GraphDigest(fresh);
        VaultArticleCoordinate currentServer = stored.Coordinates.Server with
        {
            Source = fresh.Source,
            ServerRevision = 5,
            DependencySha256 = graph,
            ContentSha256 = string.Empty
        };
        currentServer = currentServer with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(currentServer)
        };
        fresh = PortableDependencyCodec.Seal(fresh with
        {
            Coordinates = fresh.Coordinates with
            {
                Server = currentServer
            },
            GraphSha256 = graph
        });
        ArticleVaultServerObservation observation = original.ServerObservations[0] with
        {
            ServerCoordinate = currentServer,
            ContentSha256 = string.Empty
        };
        observation = observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
        ArticleVaultPlanRequest request = original with
        {
            ServerObservations = [observation],
            Direction = VaultSyncDirection.Pull
        };
        ArticleVaultSyncPlan sync = ArticleVaultSyncPlanner.Build(request).Plan!;
        Assert.NotNull(sync);
        Assert.Equal(VaultSyncPlanStatus.Ready, sync.Status);
        Assert.Equal(VaultSyncDecision.PullUpdate, Assert.Single(Assert.Single(sync.Groups).Items).Decision);
        ArticleVaultPlanVerificationContext context = new(request.CreatedAtUnixMs, request.Direction, false);
        VaultDependencyPlanInput input = new(fresh, freshBytes, fresh.Nodes, fresh.Edges, DigestA);
        ArticleVaultDependencyPlan extension = ArticleVaultDependencyPlanner.Build(sync, request, context, [input], s_budgets).Plan!;
        Assert.NotNull(extension);
        Assert.True(ArticleVaultDependencyPlanner.VerifyCurrent(extension, sync, request, context, [input], s_budgets).IsValid);
        PortableDependencyManifest stale = PortableDependencyCodec.Seal(stored with
        {
            SourceSide = VaultDependencySourceSide.Server
        });
        VaultDependencyPlanInput staleInput = new(stale, s_source, stale.Nodes, stale.Edges, DigestA);
        Assert.Null(ArticleVaultDependencyPlanner.Build(sync, request, context, [staleInput], s_budgets).Plan);
        Assert.False(ArticleVaultDependencyPlanner.VerifyCurrent(extension, sync, request, context, [staleInput], s_budgets).IsValid);

        // A legacy extension can have a valid seal while retaining the saved server graph.
        ArticleVaultDependencyPlan staleExtension = extension with
        {
            Items = [Assert.Single(extension.Items) with { Manifest = stale }],
            ContentSha256 = string.Empty
        };
        staleExtension = staleExtension with { ContentSha256 = PortableDependencyCodec.PlanDigest(staleExtension) };
        Assert.True(ArticleVaultDependencyPlanner.ValidateStructure(staleExtension).IsValid);
        Assert.False(ArticleVaultDependencyPlanner.VerifyCurrent(staleExtension, sync, request, context, [input], s_budgets).IsValid);
        Assert.False(ArticleVaultDependencyPlanner.VerifyCurrent(staleExtension, sync, request, context, [staleInput], s_budgets).IsValid);

        Assert.True(PortableDependencyVerifier.VerifyCurrent(fresh, article, freshBytes, fresh.Nodes,
            fresh.Edges, DigestA, s_budgets, currentServerCoordinate: currentServer).IsValid);
        Assert.False(PortableDependencyVerifier.VerifyCurrent(stale, article, s_source, stale.Nodes,
            stale.Edges, DigestA, s_budgets, currentServerCoordinate: currentServer).IsValid);

        foreach (VaultDependencyPlanInput drift in new[]
        {
            input with { SourceBytes = s_source },
            input with { CurrentRelationSha256 = DigestB }
        })
        {
            Assert.Null(ArticleVaultDependencyPlanner.Build(sync, request, context, [drift], s_budgets).Plan);
            Assert.False(ArticleVaultDependencyPlanner.VerifyCurrent(extension, sync, request, context, [drift], s_budgets).IsValid);
        }
    }

    [Fact]
    public void MalformedAuthorityMembers_ReturnBlockers()
    {
        VaultDependencyNode[] nodes = [Asset(), Link()];
        VaultDependencyEdge edge = new(PortableDependencyCodec.NodeKey(nodes[0]), PortableDependencyCodec.NodeKey(nodes[1]), VaultDependencyEdgeKind.Requires);
        PortableDependencyManifest manifest = Create(nodes, [edge]);
        Assert.False(PortableDependencyVerifier.ValidateStructure(manifest with
        {
            Edges = [edge with { PrerequisiteKey = null! }]
        }).IsValid);
        Assert.False(Verify(manifest, nodes, [null!]).IsValid);
        ArticleVaultPlanRequest request = Request(Article(manifest));
        ArticleVaultSyncPlan sync = ArticleVaultSyncPlanner.Build(request).Plan!;
        ArticleVaultPlanVerificationContext context = new(request.CreatedAtUnixMs, request.Direction, false);
        VaultDependencyPlanInput input = new(manifest, s_source, nodes, [edge], DigestA);
        ArticleVaultDependencyPlan extension = ArticleVaultDependencyPlanner.Build(sync, request, context, [input], s_budgets).Plan!;
        Assert.False(ArticleVaultDependencyPlanner.VerifyCurrent(extension with
        {
            Items = [null!]
        }, sync, request, context, [input], s_budgets).IsValid);
        Assert.False(ArticleVaultDependencyPlanner.VerifyCurrent(extension with
        {
            Items = [extension.Items[0] with { Manifest = null! }]
        }, sync, request, context, [input], s_budgets).IsValid);
        Assert.Null(ArticleVaultDependencyPlanner.Build(sync, request, context, [input with
        {
            Manifest = manifest with { Binding = s_binding with { PortableArticleIdentity = null! } }
        }], s_budgets).Plan);
    }

    [Fact]
    public void ManifestAndCoordinateTamper_FailsBeforeAnyExecutionSurface()
    {
        PortableDependencyManifest manifest = Create([Asset()]);
        Assert.False(PortableDependencyVerifier.ValidateStructure(manifest with
        {
            GraphSha256 = DigestB
        }).IsValid);
        Assert.False(PortableDependencyVerifier.ValidateStructure(manifest with
        {
            ContentSha256 = DigestB
        }).IsValid);
        Assert.False(PortableDependencyVerifier.ValidateStructure(manifest with
        {
            Coordinates = manifest.Coordinates with
            {
                Server = manifest.Coordinates.Server with
                {
                    PermissionSha256 = DigestB
                }
            }
        }).IsValid);
    }

    private static ArticleVaultValidationResult Verify(PortableDependencyManifest manifest, IReadOnlyList<VaultDependencyNode> nodes,
        IReadOnlyList<VaultDependencyEdge>? edges = null, byte[]? source = null)
        => PortableDependencyVerifier.VerifyCurrent(manifest, Article(manifest), source ?? s_source, nodes, edges ?? manifest.Edges, DigestA, s_budgets);

    private static VaultAssetDependency Asset() => new(s_binding, s_admission,
        Guid.Parse("11111111-1111-1111-1111-111111111111"), DigestA, "image/png", ".png", 24, 1, 1, 1, 4);

    private static VaultLinkDependency Link() => new(s_binding, s_admission,
        new("article:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", ArticleEmbedTargetKind.Article, null, null),
        s_binding with
        {
            PortableArticleIdentity = "article:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
        }, DigestA);

    private static VaultAnchorDependency Anchor() => new(s_binding, s_admission,
        ArticleBlockTarget.Create(s_binding.PortableArticleIdentity, BlockAnchorId.Create("source-anchor")), BlockAnchorSchemas.ContractDigest);

    private static VaultFrozenEmbedDependency Embed()
    {
        ArticleEmbedDependencyCoordinate coordinate = new(ArticleEmbedSchemas.DependencyCoordinate, ArticleEmbedSchemas.Version,
            new("article:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", ArticleEmbedTargetKind.Block, null, "source-anchor"), 4, "version-four", "projection-four", DigestA, string.Empty);
        coordinate = coordinate with
        {
            DependencyDigest = ArticleEmbedContractDigest.ComputeDependency(coordinate)
        };
        return new(s_binding, s_admission, coordinate, s_binding with
        {
            PortableArticleIdentity = "article:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
        }, DigestA, 12);
    }

    private static PortableDependencyManifest Create(IReadOnlyList<VaultDependencyNode> nodes, IReadOnlyList<VaultDependencyEdge>? edges = null)
    {
        VaultSourceByteIdentity source = ArticleVaultManifestCodec.CaptureSourceBytes(s_source);
        VaultArticleCoordinate coordinate = new(ArticleVaultSchemas.Coordinate, ArticleVaultSchemas.Version,
            true, false, 4, source, DigestA, DigestA, "draft", DigestA, string.Empty);
        PortableDependencyManifest manifest = new(PortableDependencySchemas.Manifest, PortableDependencySchemas.Version,
            s_binding, "server-article-a", new(coordinate, coordinate, coordinate), VaultDependencySourceSide.Local,
            source, DigestA, nodes, edges ?? [], string.Empty, string.Empty);
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
        string path = "articles/source.md";
        ArticleVaultArticleManifest article = new(ArticleVaultSchemas.ArticleManifest, ArticleVaultSchemas.Version,
            s_binding.SiteIdentity, s_binding.VaultIdentity, "device-primary", s_binding.PortableArticleIdentity,
            "server-article-a", new(path, ArticleVaultManifestCodec.ComputeProjectionSha256(path)), manifest.Coordinates,
            new(0, null, null, null, null, null, null), VaultArticleState.Clean, string.Empty);
        return article with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
        };
    }

    private static ArticleVaultPlanRequest Request(ArticleVaultArticleManifest article)
    {
        ArticleVaultRootManifest root = new(ArticleVaultSchemas.RootManifest, ArticleVaultSchemas.Version,
            ArticleVaultSchemas.ControlTreeVersion, new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
            s_binding.SiteIdentity, s_binding.VaultIdentity, "device-primary",
            [new(article.PortableArticleIdentity, ".fsus/articles/article:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json", article.ContentSha256, article.PathProjection.RelativePath)], [], string.Empty);
        root = root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
        ArticleVaultServerObservation observation = new(ArticleVaultPlanSchemas.ServerObservation, ArticleVaultPlanSchemas.Version,
            s_binding.SiteIdentity, s_binding.VaultIdentity, "device-primary", s_binding.PortableArticleIdentity,
            article.ServerArticleIdentity, article.Coordinates.Server, string.Empty);
        observation = observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
        return new(root, [article], [observation], [new("atomic-group", [article.PortableArticleIdentity], [])], VaultSyncDirection.Sync, 1000, 2000, false);
    }

    private sealed class AdvancingTime : TimeProvider
    {
        private long _timestamp;
        public override long GetTimestamp() => _timestamp += TimestampFrequency;
    }
}
