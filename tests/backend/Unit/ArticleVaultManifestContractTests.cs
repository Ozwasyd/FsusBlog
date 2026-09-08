using System.Text;
using System.Text.Json;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultManifestContractTests
{
    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string DigestC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    [Fact]
    public void ClosedCodec_RoundTripsCanonicalRootAndArticleManifests()
    {
        ArticleVaultMetadataManifest metadata = Seal(CreateMetadataManifest());
        ArticleVaultArticleManifest article = Seal(CreateArticleManifest(metadata));
        ArticleVaultRootManifest root = Seal(CreateRootManifest(article));

        byte[] first = ArticleVaultManifestCodec.Serialize(article);
        byte[] second = ArticleVaultManifestCodec.Serialize(ArticleVaultManifestCodec.DeserializeArticle(first));

        Assert.Equal(first, second);
        Assert.Equal(
            ArticleVaultManifestCodec.Serialize(metadata),
            ArticleVaultManifestCodec.Serialize(
                ArticleVaultManifestCodec.DeserializeMetadata(ArticleVaultManifestCodec.Serialize(metadata))));
        Assert.Equal(
            ArticleVaultManifestCodec.Serialize(root),
            ArticleVaultManifestCodec.Serialize(
                ArticleVaultManifestCodec.DeserializeRoot(ArticleVaultManifestCodec.Serialize(root))));
        Assert.True(ArticleVaultManifestValidator.ValidateBinding(root, article).IsValid);
        Assert.True(ArticleVaultManifestValidator.ValidateBinding(article, metadata).IsValid);
    }

    [Fact]
    public void JsonSchemas_AreEmbeddedClosedAndVersioned()
    {
        string[] resources = typeof(ArticleVaultRootManifest).Assembly.GetManifestResourceNames();
        string[] schemaNames =
        [
            "FsusBlog.Contracts.ArticleVault.article-vault-root-manifest.schema.json",
            "FsusBlog.Contracts.ArticleVault.article-vault-article-manifest.schema.json",
            "FsusBlog.Contracts.ArticleVault.article-vault-metadata-manifest.schema.json"
        ];

        foreach (string schemaName in schemaNames)
        {
            Assert.Contains(schemaName, resources);
            using Stream stream = typeof(ArticleVaultRootManifest).Assembly
                .GetManifestResourceStream(schemaName)!;
            using JsonDocument schema = JsonDocument.Parse(stream);
            Assert.False(schema.RootElement.GetProperty("additionalProperties").GetBoolean());
            Assert.Equal("https://json-schema.org/draft/2020-12/schema", schema.RootElement.GetProperty("$schema").GetString());
        }
    }

    [Fact]
    public void ClosedCodec_RejectsUnknownFieldAndSchemaDrift()
    {
        ArticleVaultArticleManifest article = Seal(CreateArticleManifest());
        string json = Encoding.UTF8.GetString(ArticleVaultManifestCodec.Serialize(article));
        string withUnknown = json[..^1] + ",\"winnerMtime\":123}";

        InvalidDataException error = Assert.Throws<InvalidDataException>(
            () => ArticleVaultManifestCodec.DeserializeArticle(Encoding.UTF8.GetBytes(withUnknown)));

        Assert.Contains("could not be mapped", error.InnerException?.Message ?? error.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(
            "article_vault_article_schema_unknown",
            ArticleVaultManifestValidator.Validate(article with
            {
                SchemaVersion = 2
            }).ReasonCode);
    }

    [Fact]
    public void ClosedContract_RejectsExplicitNullAndEmptyRequiredValues()
    {
        ArticleVaultArticleManifest article = Seal(CreateArticleManifest());

        Assert.Equal(
            "article_vault_site_identity_invalid",
            ArticleVaultManifestValidator.Validate(article with
            {
                SiteIdentity = string.Empty
            }).ReasonCode);
        Assert.Equal(
            "article_vault_coordinates_missing",
            ArticleVaultManifestValidator.Validate(article with
            {
                Coordinates = null!
            }).ReasonCode);
        Assert.Equal(
            "article_vault_operation_watermarks_invalid",
            ArticleVaultManifestValidator.Validate(article with
            {
                OperationWatermarks = null!
            }).ReasonCode);
    }

    [Theory]
    [InlineData("../article.md")]
    [InlineData("articles/../../article.md")]
    [InlineData("/articles/article.md")]
    [InlineData("articles\\article.md")]
    [InlineData(".fsus/articles/article.md")]
    [InlineData("articles//article.md")]
    public void PathProjection_RejectsEscapeAndControlTreeCollisions(string relativePath)
    {
        ArticleVaultArticleManifest article = Seal(CreateArticleManifest() with
        {
            PathProjection = new(relativePath, ArticleVaultManifestCodec.ComputeProjectionSha256(relativePath))
        });

        Assert.Equal(
            "article_vault_path_projection_invalid",
            ArticleVaultManifestValidator.Validate(article).ReasonCode);
    }

    [Fact]
    public void IdentityBinding_IsIndependentFromPathAndRejectsCrossVaultReuse()
    {
        ArticleVaultArticleManifest original = Seal(CreateArticleManifest());
        ArticleVaultArticleManifest renamed = Seal(original with
        {
            PathProjection = new(
                "renamed/anything.md",
                ArticleVaultManifestCodec.ComputeProjectionSha256("renamed/anything.md")),
            ContentSha256 = string.Empty
        });
        ArticleVaultRootManifest wrongVault = Seal(CreateRootManifest(original) with
        {
            VaultIdentity = "vault-other",
            ContentSha256 = string.Empty
        });

        Assert.Equal(original.PortableArticleIdentity, renamed.PortableArticleIdentity);
        Assert.Equal(
            "article_vault_cross_binding_mismatch",
            ArticleVaultManifestValidator.ValidateBinding(wrongVault, original).ReasonCode);
    }

    [Fact]
    public void EstablishedArticle_RejectsMissingBaseRevisionAndServerIdentity()
    {
        ArticleVaultArticleManifest source = CreateArticleManifest();
        VaultArticleCoordinate baseWithoutRevision = Seal(source.Coordinates.Base with
        {
            ServerRevision = null
        });
        ArticleVaultArticleManifest missingRevision = Seal(source with
        {
            Coordinates = source.Coordinates with
            {
                Base = baseWithoutRevision
            }
        });
        ArticleVaultArticleManifest missingServerIdentity = Seal(source with
        {
            ServerArticleIdentity = null
        });

        Assert.Equal(
            "article_vault_base_revision_missing",
            ArticleVaultManifestValidator.Validate(missingRevision).ReasonCode);
        Assert.Equal(
            "article_vault_server_identity_missing",
            ArticleVaultManifestValidator.Validate(missingServerIdentity).ReasonCode);
    }

    [Fact]
    public void MetadataContract_IsClosedVersionedAndHasNoLifecycleRightsPublicationOrOwnerFields()
    {
        ArticleVaultMetadataManifest metadata = Seal(CreateMetadataManifest());
        string[] fieldNames = typeof(ArticleVaultMetadataManifest).GetProperties()
            .Select(static property => property.Name)
            .ToArray();

        Assert.DoesNotContain(fieldNames, static name =>
            name.Contains("Lifecycle", StringComparison.Ordinal)
            || name.Contains("Rights", StringComparison.Ordinal)
            || name.Contains("Publication", StringComparison.Ordinal)
            || name.Contains("Owner", StringComparison.Ordinal));
        string json = Encoding.UTF8.GetString(ArticleVaultManifestCodec.Serialize(metadata));
        string yamlAuthority = json[..^1] + ",\"lifecycle\":\"published\"}";
        Assert.Throws<InvalidDataException>(
            () => ArticleVaultManifestCodec.DeserializeMetadata(Encoding.UTF8.GetBytes(yamlAuthority)));
    }

    [Fact]
    public void SourceByteIdentity_PreservesBomNewlineTrailingSpaceAndFinalNewlineFacts()
    {
        byte[] sourceBytes = [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes("first  \r\nsecond\t\r\n")];
        VaultSourceByteIdentity source = ArticleVaultManifestCodec.CaptureSourceBytes(sourceBytes);

        Assert.True(source.HasUtf8Bom);
        Assert.Equal(VaultNewlineStyle.CrLf, source.NewlineStyle);
        Assert.Equal(2, source.TrailingWhitespaceLineCount);
        Assert.True(source.HasFinalNewline);
        Assert.Equal(sourceBytes.Length, source.ByteLength);
        Assert.True(ArticleVaultManifestValidator.ValidateSourceBytes(source, sourceBytes).IsValid);
        Assert.Equal(
            "article_vault_source_bytes_mismatch",
            ArticleVaultManifestValidator.ValidateSourceBytes(source, [.. sourceBytes, (byte)' ']).ReasonCode);
    }

    [Fact]
    public void ContentDigest_RejectsManifestAndCoordinateTampering()
    {
        ArticleVaultArticleManifest article = Seal(CreateArticleManifest());
        ArticleVaultArticleManifest tampered = article with
        {
            Coordinates = article.Coordinates with
            {
                Local = article.Coordinates.Local with
                {
                    Source = article.Coordinates.Local.Source! with
                    {
                        Sha256 = DigestB
                    }
                }
            }
        };

        Assert.Equal(
            "article_vault_local_coordinate_digest_mismatch",
            ArticleVaultManifestValidator.Validate(tampered).ReasonCode);

        ArticleVaultArticleManifest stateAdjusted = tampered with
        {
            Coordinates = tampered.Coordinates with
            {
                Local = Seal(tampered.Coordinates.Local)
            },
            State = VaultArticleState.LocalModified
        };
        Assert.Equal(
            "article_vault_article_digest_mismatch",
            ArticleVaultManifestValidator.Validate(stateAdjusted).ReasonCode);
    }

    [Theory]
    [MemberData(nameof(StateCases))]
    public void StateMachine_DerivesEveryParentState(ArticleVaultArticleManifest manifest, VaultArticleState expected)
    {
        Assert.Equal(expected, ArticleVaultStateMachine.Derive(manifest));
    }

    [Fact]
    public void StateCannotBeSignedFromUiTextOrMtime()
    {
        ArticleVaultArticleManifest article = Seal(CreateArticleManifest());
        ArticleVaultArticleManifest forged = article with
        {
            State = VaultArticleState.ServerModified
        };

        Assert.Equal("article_vault_state_mismatch", ArticleVaultManifestValidator.Validate(forged).ReasonCode);
        Assert.DoesNotContain(typeof(ArticleVaultArticleManifest).GetProperties(), static property =>
            property.Name.Contains("Mtime", StringComparison.OrdinalIgnoreCase)
            || property.Name.Contains("Title", StringComparison.OrdinalIgnoreCase)
            || property.Name.Contains("Slug", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void RootInventories_RejectDuplicateOrNonCanonicalEntries()
    {
        ArticleVaultArticleManifest article = Seal(CreateArticleManifest());
        ArticleVaultRootManifest root = CreateRootManifest(article);
        VaultArticleReference duplicate = root.Articles[0];
        root = Seal(root with
        {
            Articles = [duplicate, duplicate]
        });

        Assert.Equal(
            "article_vault_article_inventory_not_canonical",
            ArticleVaultManifestValidator.Validate(root).ReasonCode);
    }

    public static TheoryData<ArticleVaultArticleManifest, VaultArticleState> StateCases()
    {
        ArticleVaultArticleManifest clean = CreateArticleManifest();
        VaultArticleCoordinate absent = AbsentCoordinate();
        VaultArticleCoordinate baseline = clean.Coordinates.Base;
        VaultArticleCoordinate modified = baseline with
        {
            Source = baseline.Source! with
            {
                Sha256 = DigestB
            }
        };
        VaultArticleCoordinate deleted = baseline with
        {
            Deleted = true,
            Source = null,
            MetadataManifestSha256 = null
        };
        var result = new TheoryData<ArticleVaultArticleManifest, VaultArticleState>
        {
            { clean, VaultArticleState.Clean },
            { clean with { Coordinates = new(absent, absent, absent) }, VaultArticleState.Untracked },
            { clean with { Coordinates = new(absent, modified with { ServerRevision = null }, absent), ServerArticleIdentity = null }, VaultArticleState.LocalCreated },
            { clean with { Coordinates = new(absent, absent, modified) }, VaultArticleState.ServerCreated },
            { clean with { Coordinates = clean.Coordinates with { Local = modified } }, VaultArticleState.LocalModified },
            { clean with { Coordinates = clean.Coordinates with { Server = modified } }, VaultArticleState.ServerModified },
            { clean with { Coordinates = clean.Coordinates with { Local = modified, Server = modified with { Source = modified.Source! with { Sha256 = DigestC } } } }, VaultArticleState.BothModified },
            { clean with { Coordinates = clean.Coordinates with { Local = deleted } }, VaultArticleState.LocalDeleted },
            { clean with { Coordinates = clean.Coordinates with { Server = deleted } }, VaultArticleState.ServerDeleted },
            { clean with { OperationWatermarks = clean.OperationWatermarks with { ConflictOperationIdentity = "operation-conflict" } }, VaultArticleState.Conflicted },
            { clean with { OperationWatermarks = clean.OperationWatermarks with { ApplyingOperationIdentity = "operation-applying" } }, VaultArticleState.Applying },
            { clean with { OperationWatermarks = clean.OperationWatermarks with { LastAppliedOperationIdentity = "operation-applied", LastReceiptSha256 = DigestA } }, VaultArticleState.Synced },
            { clean with { OperationWatermarks = clean.OperationWatermarks with { BlockedReasonCode = "permission-drift" } }, VaultArticleState.Blocked }
        };
        return result;
    }

    private static ArticleVaultArticleManifest CreateArticleManifest()
        => CreateArticleManifest(Seal(CreateMetadataManifest()));

    private static ArticleVaultArticleManifest CreateArticleManifest(ArticleVaultMetadataManifest metadata)
    {
        VaultArticleCoordinate coordinate = CreateCoordinate(4, metadata.ContentSha256);
        string path = "articles/example.md";
        return new ArticleVaultArticleManifest(
            ArticleVaultSchemas.ArticleManifest,
            ArticleVaultSchemas.Version,
            metadata.SiteIdentity,
            metadata.VaultIdentity,
            metadata.DeviceIdentity,
            metadata.PortableArticleIdentity,
            metadata.ServerArticleIdentity,
            new VaultPathProjection(path, ArticleVaultManifestCodec.ComputeProjectionSha256(path)),
            new VaultArticleCoordinates(coordinate, coordinate, coordinate),
            new VaultOperationWatermarks(0, null, null, null, null, null, null),
            VaultArticleState.Clean,
            string.Empty);
    }

    private static ArticleVaultMetadataManifest CreateMetadataManifest()
        => new(
            ArticleVaultSchemas.MetadataManifest,
            ArticleVaultSchemas.Version,
            "site-primary",
            "vault-primary",
            "device-primary",
            "portable-article-primary",
            "server-article-42",
            "Example title",
            null,
            "example-title",
            DigestB,
            DigestC,
            string.Empty);

    private static VaultArticleCoordinate CreateCoordinate(long revision, string? metadataSha256 = null)
        => Seal(new VaultArticleCoordinate(
            Schema: ArticleVaultSchemas.Coordinate,
            SchemaVersion: ArticleVaultSchemas.Version,
            Present: true,
            Deleted: false,
            ServerRevision: revision,
            Source: new VaultSourceByteIdentity(DigestA, 42, true, VaultNewlineStyle.CrLf, 2, true),
            MetadataManifestSha256: metadataSha256 ?? DigestA,
            DependencySha256: DigestB,
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

    private static ArticleVaultRootManifest CreateRootManifest(ArticleVaultArticleManifest article)
        => new(
            ArticleVaultSchemas.RootManifest,
            ArticleVaultSchemas.Version,
            ArticleVaultSchemas.ControlTreeVersion,
            new VaultControlTree(
                ArticleVaultSchemas.RootManifestPath,
                ArticleVaultSchemas.ArticleManifestDirectory,
                ArticleVaultSchemas.ReceiptDirectory),
            article.SiteIdentity,
            article.VaultIdentity,
            "device-primary",
            [new VaultArticleReference(
                article.PortableArticleIdentity,
                $"{ArticleVaultSchemas.ArticleManifestDirectory}/{article.PortableArticleIdentity}.json",
                article.ContentSha256,
                article.PathProjection.RelativePath)],
            [],
            string.Empty);

    private static ArticleVaultArticleManifest Seal(ArticleVaultArticleManifest manifest)
    {
        ArticleVaultArticleManifest stateBound = manifest with
        {
            State = ArticleVaultStateMachine.Derive(manifest),
            ContentSha256 = string.Empty
        };
        return stateBound with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(stateBound)
        };
    }

    private static ArticleVaultRootManifest Seal(ArticleVaultRootManifest manifest)
    {
        ArticleVaultRootManifest unsealed = manifest with
        {
            ContentSha256 = string.Empty
        };
        return unsealed with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsealed)
        };
    }

    private static ArticleVaultMetadataManifest Seal(ArticleVaultMetadataManifest manifest)
    {
        ArticleVaultMetadataManifest unsealed = manifest with
        {
            ContentSha256 = string.Empty
        };
        return unsealed with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsealed)
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
}
