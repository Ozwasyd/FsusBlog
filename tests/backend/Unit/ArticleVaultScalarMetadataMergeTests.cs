using System.Text;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultScalarMetadataMergeTests
{
    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    [Fact]
    public void ActualClosedBytes_DisjointScalarChangesProduceIndependentlyRecomputedCandidate()
    {
        ArticleVaultMetadataManifest baseline = Metadata();
        ArticleVaultScalarMetadataInput input = Input(baseline,
            Seal(baseline with
            {
                Title = "local title"
            }), Seal(baseline with
            {
                Summary = "server summary"
            }));
        ArticleVaultScalarMetadataResult result = ArticleVaultScalarMetadataMerge.Build(input);
        ArticleVaultScalarMetadataCandidate candidate = Assert.IsType<ArticleVaultScalarMetadataCandidate>(result.Candidate);
        Assert.Null(result.Conflict);
        Assert.Equal("local title", candidate.Metadata.Title);
        Assert.Equal("server summary", candidate.Metadata.Summary);
        Assert.Equal(baseline.Slug, candidate.Metadata.Slug);
        Assert.Equal(baseline.PortableArticleIdentity, candidate.Metadata.PortableArticleIdentity);
        Assert.Collection(candidate.AppliedFields,
            field => Assert.Equal(VaultConflictMetadataField.Title, field),
            field => Assert.Equal(VaultConflictMetadataField.Summary, field));
        Assert.True(ArticleVaultScalarMetadataMerge.VerifyCurrentCandidate(input, candidate).IsValid);
        Assert.Equal(VaultSyncPlanStatus.Blocked, input.Plan.Status);
        Assert.Empty(input.Plan.OperationOrder);
    }

    [Fact]
    public void SameFieldDifferentValues_RetainsTypedManualConflictAndNeverChoosesWinner()
    {
        ArticleVaultMetadataManifest baseline = Metadata();
        ArticleVaultScalarMetadataResult result = ArticleVaultScalarMetadataMerge.Build(Input(baseline,
            Seal(baseline with
            {
                Title = "local title"
            }), Seal(baseline with
            {
                Title = "server title"
            })));
        Assert.Null(result.Candidate);
        Assert.Equal("article_vault_scalar_metadata_overlap", result.ReasonCode);
        Assert.Equal(VaultConflictType.MetadataOverlap, result.Conflict!.Type);
        Assert.Collection(result.ConflictingFields,
            field => Assert.Equal(VaultConflictMetadataField.Title, field));
        Assert.Single(result.Conflict.Metadata!.Changes);
    }

    [Fact]
    public void EqualThreeWayValuesAndOneSidedNullableChanges_AreNoOpOrDeterministicEffects()
    {
        ArticleVaultMetadataManifest baseline = Metadata();
        ArticleVaultScalarMetadataInput noOp = Input(baseline, baseline, baseline);
        ArticleVaultScalarMetadataCandidate unchanged = Assert.IsType<ArticleVaultScalarMetadataCandidate>(
            ArticleVaultScalarMetadataMerge.Build(noOp).Candidate);
        Assert.Empty(unchanged.AppliedFields);
        Assert.Empty(unchanged.Facts.Changes);
        Assert.Equal(baseline.ContentSha256, unchanged.Metadata.ContentSha256);
        Assert.True(ArticleVaultScalarMetadataMerge.VerifyCurrentCandidate(noOp, unchanged).IsValid);

        ArticleVaultMetadataManifest equal = Seal(baseline with
        {
            Title = "same new title",
            Summary = null
        });
        ArticleVaultScalarMetadataInput equivalent = Input(baseline, equal, equal);
        ArticleVaultScalarMetadataCandidate combined = Assert.IsType<ArticleVaultScalarMetadataCandidate>(
            ArticleVaultScalarMetadataMerge.Build(equivalent).Candidate);
        Assert.Null(combined.Metadata.Summary);
        Assert.Equal("same new title", combined.Metadata.Title);
        Assert.True(ArticleVaultScalarMetadataMerge.VerifyCurrentCandidate(equivalent, combined).IsValid);

        ArticleVaultScalarMetadataInput oneSided = Input(baseline, Seal(baseline with
        {
            Summary = null
        }), baseline);
        ArticleVaultScalarMetadataCandidate one = Assert.IsType<ArticleVaultScalarMetadataCandidate>(
            ArticleVaultScalarMetadataMerge.Build(oneSided).Candidate);
        Assert.Null(one.Metadata.Summary);
        Assert.True(ArticleVaultScalarMetadataMerge.VerifyCurrentCandidate(oneSided, one).IsValid);
    }

    [Theory]
    [InlineData("lifecycle")]
    [InlineData("publication")]
    [InlineData("owner")]
    [InlineData("categoryId")]
    [InlineData("tagIds")]
    [InlineData("propertyOptions")]
    public void UnknownYamlAuthorityOrInventedMappingFields_AreRejectedByOriginalClosedCodec(string field)
    {
        ArticleVaultMetadataManifest baseline = Metadata();
        ArticleVaultScalarMetadataInput input = Input(baseline, baseline, baseline);
        string json = Encoding.UTF8.GetString(input.LocalBytes.Span);
        byte[] unrecognized = Encoding.UTF8.GetBytes(json[..^1] + $",\"{field}\":\"untrusted\"}}");
        Assert.Equal("article_vault_scalar_metadata_source_invalid", ArticleVaultScalarMetadataMerge.Build(
            input with
            {
                LocalBytes = unrecognized
            }).ReasonCode);
    }

    [Fact]
    public void MalformedUnknownSchemaAndTamperedRawMetadata_FailBeforeFieldDecisions()
    {
        ArticleVaultMetadataManifest baseline = Metadata();
        ArticleVaultScalarMetadataInput input = Input(baseline, baseline, baseline);
        byte[][] invalid =
        [
            Encoding.UTF8.GetBytes("{bad json"),
            Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(input.BaseBytes.Span).Replace("\"schemaVersion\":1", "\"schemaVersion\":2", StringComparison.Ordinal)),
            Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(input.BaseBytes.Span).Replace("base title", "tampered title", StringComparison.Ordinal))
        ];
        foreach (byte[] bytes in invalid)
        {
            Assert.Equal("article_vault_scalar_metadata_source_invalid", ArticleVaultScalarMetadataMerge.Build(
                input with
                {
                    BaseBytes = bytes
                }).ReasonCode);
        }
    }

    [Fact]
    public void MissingOriginalBaseBytes_NeverDegradesToTwoWayMerge()
    {
        ArticleVaultMetadataManifest baseline = Metadata();
        ArticleVaultScalarMetadataInput input = Input(baseline,
            Seal(baseline with
            {
                Title = "local title"
            }), Seal(baseline with
            {
                Summary = "server summary"
            }));
        ArticleVaultScalarMetadataResult result = ArticleVaultScalarMetadataMerge.Build(input with
        {
            BaseBytes = ReadOnlyMemory<byte>.Empty
        });
        Assert.Null(result.Candidate);
        Assert.Equal("article_vault_scalar_metadata_source_invalid", result.ReasonCode);
    }

    [Fact]
    public void StaleDigestOrCrossSiteVaultDevicePortableServerMetadata_IsRejected()
    {
        ArticleVaultMetadataManifest baseline = Metadata();
        ArticleVaultScalarMetadataInput input = Input(baseline, baseline, baseline);
        ArticleVaultMetadataManifest[] substituted =
        [
            Seal(baseline with { Title = "unplanned bytes" }),
            Seal(baseline with { SiteIdentity = "site-other" }),
            Seal(baseline with { VaultIdentity = "vault-other" }),
            Seal(baseline with { DeviceIdentity = "device-other" }),
            Seal(baseline with { PortableArticleIdentity = "article-other" }),
            Seal(baseline with { ServerArticleIdentity = "server-other" })
        ];
        foreach (ArticleVaultMetadataManifest metadata in substituted)
        {
            Assert.Equal("article_vault_scalar_metadata_source_binding_mismatch", ArticleVaultScalarMetadataMerge.Build(
                input with
                {
                    ServerBytes = ArticleVaultManifestCodec.Serialize(metadata)
                }).ReasonCode);
        }
    }

    [Fact]
    public void TaxonomyAndPropertyDrift_RefuseOpaqueDigestsInsteadOfGuessingStableOptionIds()
    {
        ArticleVaultMetadataManifest baseline = Metadata();
        Assert.Equal("article_vault_scalar_metadata_taxonomy_mapping_missing", ArticleVaultScalarMetadataMerge.Build(Input(
            baseline, Seal(baseline with
            {
                TaxonomySha256 = DigestB
            }), baseline)).ReasonCode);
        Assert.Equal("article_vault_scalar_metadata_property_mapping_missing", ArticleVaultScalarMetadataMerge.Build(Input(
            baseline, baseline, Seal(baseline with
            {
                PropertiesSha256 = DigestB
            }))).ReasonCode);
    }

    [Fact]
    public void SlugProjectionNeverChangesPortableIdentityOrWriterAndCannotOverrideServerAuthority()
    {
        ArticleVaultMetadataManifest baseline = Metadata();
        ArticleVaultScalarMetadataInput rename = Input(baseline, Seal(baseline with
        {
            Slug = "renamed-slug"
        }), baseline);
        byte[] originalPlanBytes = ArticleVaultSyncPlanCodec.Serialize(rename.Plan);
        byte[] originalArticleBytes = ArticleVaultManifestCodec.Serialize(rename.Articles[0]);
        ArticleVaultScalarMetadataCandidate candidate = Assert.IsType<ArticleVaultScalarMetadataCandidate>(
            ArticleVaultScalarMetadataMerge.Build(rename).Candidate);
        Assert.Equal("renamed-slug", candidate.Metadata.Slug);
        Assert.Equal(baseline.PortableArticleIdentity, candidate.Metadata.PortableArticleIdentity);
        Assert.Equal(originalPlanBytes, ArticleVaultSyncPlanCodec.Serialize(rename.Plan));
        Assert.Equal(originalArticleBytes, ArticleVaultManifestCodec.Serialize(rename.Articles[0]));
        Assert.DoesNotContain(typeof(ArticleVaultScalarMetadataCandidate).GetProperties(), static property =>
            property.Name.Contains("Writer", StringComparison.OrdinalIgnoreCase)
            || property.Name.Contains("PathProjection", StringComparison.OrdinalIgnoreCase)
            || property.Name.Contains("Lifecycle", StringComparison.OrdinalIgnoreCase));
        foreach (string authority in new[] { "lifecycle", "permission", "dependency" })
        {
            ArticleVaultScalarMetadataInput altered = Input(baseline, baseline, baseline, authority);
            Assert.Equal("article_vault_scalar_metadata_server_authority_drift", ArticleVaultScalarMetadataMerge.Build(altered).ReasonCode);
        }
    }

    [Fact]
    public void OriginalPlanCurrentCoordinateDrift_IsNotHiddenByMatchingCallerCandidate()
    {
        ArticleVaultMetadataManifest baseline = Metadata();
        ArticleVaultScalarMetadataInput input = Input(baseline, Seal(baseline with
        {
            Title = "local title"
        }), baseline);
        ArticleVaultScalarMetadataCandidate candidate = Assert.IsType<ArticleVaultScalarMetadataCandidate>(
            ArticleVaultScalarMetadataMerge.Build(input).Candidate);
        ArticleVaultServerObservation drifted = input.Observations[0] with
        {
            ServerCoordinate = Seal(input.Observations[0].ServerCoordinate with
            {
                ServerRevision = 6
            })
        };
        drifted = drifted with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(drifted)
        };
        Assert.Equal("article_vault_plan_coordinate_drift", ArticleVaultScalarMetadataMerge.VerifyCurrentCandidate(
            input with
            {
                Observations = [drifted]
            }, candidate).ReasonCode);
        Assert.Null(ArticleVaultScalarMetadataMerge.Build(input with
        {
            Binding = input.Binding with
            {
                OperationIdentity = "operation-other"
            }
        }).Candidate);
    }

    [Fact]
    public void IndependentVerifier_RejectsResealedValuesAppliedFieldsAndFacts()
    {
        ArticleVaultMetadataManifest baseline = Metadata();
        ArticleVaultScalarMetadataInput input = Input(baseline,
            Seal(baseline with
            {
                Title = "local title"
            }), Seal(baseline with
            {
                Summary = "server summary"
            }));
        ArticleVaultScalarMetadataCandidate original = Assert.IsType<ArticleVaultScalarMetadataCandidate>(
            ArticleVaultScalarMetadataMerge.Build(input).Candidate);
        ArticleVaultScalarMetadataCandidate[] altered =
        [
            original with { Metadata = Seal(original.Metadata with { Title = "overwritten title" }) },
            original with { AppliedFields = [VaultConflictMetadataField.Title] },
            original with { Facts = original.Facts with { Changes = [] } },
            original with { FieldRegistrySha256 = DigestA },
            original with { Metadata = Seal(original.Metadata with { PortableArticleIdentity = "article-other" }) }
        ];
        foreach (ArticleVaultScalarMetadataCandidate candidate in altered)
        {
            ArticleVaultScalarMetadataCandidate resealed = candidate with
            {
                ContentSha256 = ArticleVaultScalarMetadataMerge.ComputeContentSha256(candidate)
            };
            Assert.False(ArticleVaultScalarMetadataMerge.VerifyCurrentCandidate(input, resealed).IsValid);
        }
    }

    private static ArticleVaultMetadataManifest Metadata()
        => Seal(new ArticleVaultMetadataManifest(ArticleVaultSchemas.MetadataManifest, 1, "site-primary", "vault-primary", "device-primary",
            "article-primary", "server-primary", "base title", "base summary", "base-slug", DigestA, DigestA, string.Empty));

    private static ArticleVaultScalarMetadataInput Input(
        ArticleVaultMetadataManifest baseline,
        ArticleVaultMetadataManifest local,
        ArticleVaultMetadataManifest server,
        string? authority = null)
    {
        VaultSourceByteIdentity source = ArticleVaultManifestCodec.CaptureSourceBytes(Encoding.UTF8.GetBytes("source\n"));
        VaultArticleCoordinate baseCoordinate = Seal(new VaultArticleCoordinate(ArticleVaultSchemas.Coordinate, 1, true, false, 4, source,
            baseline.ContentSha256, DigestA, "draft", DigestA, string.Empty));
        VaultArticleCoordinate localCoordinate = Seal(baseCoordinate with
        {
            MetadataManifestSha256 = local.ContentSha256
        });
        VaultArticleCoordinate serverCoordinate = Seal(baseCoordinate with
        {
            ServerRevision = 5,
            MetadataManifestSha256 = server.ContentSha256,
            Lifecycle = authority == "lifecycle" ? "published" : "draft",
            PermissionSha256 = authority == "permission" ? DigestB : DigestA,
            DependencySha256 = authority == "dependency" ? DigestB : DigestA
        });
        const string Path = "articles/article-primary.md";
        ArticleVaultArticleManifest article = new(ArticleVaultSchemas.ArticleManifest, 1, baseline.SiteIdentity,
            baseline.VaultIdentity, baseline.DeviceIdentity, baseline.PortableArticleIdentity, baseline.ServerArticleIdentity,
            new(Path, ArticleVaultManifestCodec.ComputeProjectionSha256(Path)), new(baseCoordinate, localCoordinate, baseCoordinate),
            new(0, null, null, null, null, null, null), VaultArticleState.Clean, string.Empty);
        article = article with
        {
            State = ArticleVaultStateMachine.Derive(article)
        };
        article = article with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
        };
        ArticleVaultServerObservation observation = new(ArticleVaultPlanSchemas.ServerObservation, 1, baseline.SiteIdentity,
            baseline.VaultIdentity, baseline.DeviceIdentity, baseline.PortableArticleIdentity, baseline.ServerArticleIdentity,
            serverCoordinate, string.Empty);
        observation = observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
        ArticleVaultRootManifest root = new(ArticleVaultSchemas.RootManifest, 1, ArticleVaultSchemas.ControlTreeVersion,
            new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
            baseline.SiteIdentity, baseline.VaultIdentity, baseline.DeviceIdentity,
            [new(baseline.PortableArticleIdentity, ".fsus/articles/article-primary.json", article.ContentSha256, Path)], [], string.Empty);
        root = root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
        ArticleVaultPlanBuildResult built = ArticleVaultSyncPlanner.Build(new(root, [article], [observation],
            [new("group-primary", [baseline.PortableArticleIdentity], [])], VaultSyncDirection.Sync,
            1_800_000_000_000, 1_800_000_060_000, false));
        Assert.True(built.IsSuccess, string.Join(',', built.Errors));
        ArticleVaultSyncPlan plan = built.Plan!;
        VaultSyncPlanItem item = plan.Groups[0].Items[0];
        VaultConflictBinding binding = new(plan.SiteIdentity, plan.VaultIdentity, plan.DeviceIdentity, item.PortableArticleIdentity,
            item.ServerArticleIdentity, plan.PlanCandidateIdentity, plan.ContentSha256, item.GroupIdentity, item.OperationIdentity,
            article.ContentSha256, observation.ContentSha256, new(item.Base, item.Local, item.Server));
        return new(plan, root, [article], [observation], new(1_800_000_000_000, VaultSyncDirection.Sync, false), binding,
            ArticleVaultManifestCodec.Serialize(baseline), ArticleVaultManifestCodec.Serialize(local), ArticleVaultManifestCodec.Serialize(server));
    }

    private static ArticleVaultMetadataManifest Seal(ArticleVaultMetadataManifest metadata)
        => metadata with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(metadata)
        };

    private static VaultArticleCoordinate Seal(VaultArticleCoordinate coordinate)
        => coordinate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
        };
}
