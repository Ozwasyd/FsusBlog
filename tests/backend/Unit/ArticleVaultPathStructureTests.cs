using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultPathStructureTests
{
    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    [Theory]
    [InlineData("/outside/article.md")]
    [InlineData("C:/outside/article.md")]
    [InlineData("C:article.md")]
    [InlineData("\\\\server\\share\\article.md")]
    [InlineData("articles\\article.md")]
    [InlineData("articles/../outside.md")]
    [InlineData("articles/./article.md")]
    [InlineData("articles//article.md")]
    [InlineData("articles/article.md/")]
    [InlineData("articles/%2e%2e%2foutside.md")]
    [InlineData("articles/%5Coutside.md")]
    [InlineData("articles/NUL.md")]
    [InlineData("articles/com1.txt")]
    [InlineData("articles/COM\u00b9.txt")]
    [InlineData("articles/article.md.")]
    [InlineData("articles/article.md ")]
    [InlineData("articles/article\0.md")]
    public void RootedTraversalEncodedAndNonPortableShapes_FailClosed(string path)
    {
        Assert.False(ArticleVaultPathStructureValidator.ValidateRelativePath(path).IsValid);
        ArticleVaultRootManifest root = CreateRoot();
        Assert.Throws<InvalidDataException>(() => ArticleVaultPathStructureValidator.Analyze(
            root, Scope(root), path, []));
    }

    [Fact]
    public void ManifestProjection_RetainsPortableIdentityAndRequiresIndependentNativeAdmission()
    {
        ArticleVaultRootManifest root = CreateRoot();
        VaultPathStructuralAnalysis result = ArticleVaultPathStructureValidator.Analyze(
            root, Scope(root), "articles/first.md", ["articles/first.md"]);

        Assert.Equal(VaultPathStructuralClass.ManifestSourceProjection, result.Classification);
        Assert.Equal("portable-a", result.PortableArticleIdentity);
        Assert.True(result.RequiresNativeAdmission);
        Assert.True(ArticleVaultPathStructureValidator.Verify(
            root, Scope(root), "articles/first.md", ["articles/first.md"], result).IsValid);

        ArticleVaultRootManifest renamed = CreateRoot("articles/renamed.md");
        VaultPathStructuralAnalysis rename = ArticleVaultPathStructureValidator.Analyze(
            renamed, Scope(renamed), "articles/renamed.md", []);
        Assert.Equal(result.PortableArticleIdentity, rename.PortableArticleIdentity);
    }

    [Fact]
    public void CallerSuppliedRootDigest_DoesNotCreateNativeQualification()
    {
        ArticleVaultRootManifest root = CreateRoot();
        VaultPathStructuralScope callerInput = Scope(root) with
        {
            RootIdentitySha256 = DigestB,
            ComparisonPolicy = VaultPathComparisonPolicy.CanonicalUnicodeIgnoreCase
        };
        VaultPathStructuralAnalysis structural = ArticleVaultPathStructureValidator.Analyze(
            root, callerInput, "articles/first.md", []);

        Assert.True(ArticleVaultPathStructureValidator.Verify(
            root, callerInput, "articles/first.md", [], structural).IsValid);
        Assert.True(structural.RequiresNativeAdmission);
        Assert.Equal(VaultPathStructuralClass.ManifestSourceProjection, structural.Classification);
    }

    [Theory]
    [InlineData(".article.md.tmp")]
    [InlineData("articles/first.md.bak")]
    [InlineData("articles/.first.md.swp")]
    [InlineData("articles/first.md.lock")]
    [InlineData("articles/new.md")]
    [InlineData(".fsus/arbitrary.json")]
    public void UnknownEditorAndControlArtifacts_AreBlockedInsteadOfIgnored(string path)
    {
        ArticleVaultRootManifest root = CreateRoot();
        VaultPathStructuralAnalysis result = ArticleVaultPathStructureValidator.Analyze(
            root, Scope(root), path, []);

        Assert.Equal(VaultPathStructuralClass.Blocked, result.Classification);
        Assert.Equal("vault_path_unknown_artifact", result.ReasonCode);
        Assert.Equal(ArticleVaultPathStructureValidator.UnknownRule, result.RuleIdentity);
        Assert.Null(result.PortableArticleIdentity);
        Assert.True(result.RequiresNativeAdmission);
    }

    [Fact]
    public void ExactControlPaths_NeverBecomeArticleSourceOrWritePermission()
    {
        ArticleVaultRootManifest root = CreateRoot();
        foreach (string path in new[]
        {
            ArticleVaultSchemas.RootManifestPath,
            ArticleVaultSchemas.ArticleManifestDirectory,
            ArticleVaultSchemas.ReceiptDirectory,
            root.Articles[0].ManifestPath
        })
        {
            VaultPathStructuralAnalysis result = ArticleVaultPathStructureValidator.Analyze(
                root, Scope(root), path, []);
            Assert.Equal(VaultPathStructuralClass.RegisteredControlPath, result.Classification);
            Assert.Null(result.PortableArticleIdentity);
            Assert.True(result.RequiresNativeAdmission);
        }

        VaultPathStructuralAnalysis alias = ArticleVaultPathStructureValidator.Analyze(
            root, Scope(root), ".FSUS/vault.json", []);
        Assert.Equal("vault_path_control_alias", alias.ReasonCode);
        Assert.Equal(VaultPathStructuralClass.Blocked, alias.Classification);
    }

    [Fact]
    public void CaseCollision_RecordsBothSpellingsWithoutFirstMatch()
    {
        ArticleVaultRootManifest root = CreateRoot();
        VaultPathStructuralScope scope = Scope(root, VaultPathComparisonPolicy.OrdinalIgnoreCase);
        VaultPathStructuralAnalysis result = ArticleVaultPathStructureValidator.Analyze(
            root, scope, "articles/first.md", ["articles/FIRST.md"]);

        Assert.Equal(VaultPathStructuralClass.Blocked, result.Classification);
        VaultPathCollision collision = Assert.Single(result.Collisions);
        Assert.Equal("vault_path_case_collision", collision.ReasonCode);
        Assert.Equal(new[] { "articles/FIRST.md", "articles/first.md" }, collision.RelativePaths);
    }

    [Fact]
    public void UnicodeCollision_PreservesOriginalSourceSpellings()
    {
        ArticleVaultRootManifest root = CreateRoot("articles/caf\u00e9.md");
        VaultPathStructuralScope scope = Scope(root, VaultPathComparisonPolicy.CanonicalUnicode);
        VaultPathStructuralAnalysis result = ArticleVaultPathStructureValidator.Analyze(
            root, scope, "articles/caf\u00e9.md", ["articles/cafe\u0301.md"]);

        Assert.Equal(VaultPathStructuralClass.Blocked, result.Classification);
        Assert.Equal("articles/caf\u00e9.md", result.RelativePath);
        VaultPathCollision collision = Assert.Single(result.Collisions);
        Assert.Equal("vault_path_unicode_collision", collision.ReasonCode);
        Assert.Contains("articles/cafe\u0301.md", collision.RelativePaths);
        Assert.Contains("articles/caf\u00e9.md", collision.RelativePaths);
    }

    [Fact]
    public void AncestorCaseCollision_IsNotHiddenByDifferentLeafNames()
    {
        ArticleVaultRootManifest root = CreateRoot();
        VaultPathStructuralAnalysis result = ArticleVaultPathStructureValidator.Analyze(
            root, Scope(root, VaultPathComparisonPolicy.OrdinalIgnoreCase),
            "articles/first.md", ["Articles/second.md"]);

        Assert.Equal(VaultPathStructuralClass.Blocked, result.Classification);
        Assert.Contains(result.Collisions, static collision => collision.RelativePaths.SequenceEqual(
            new[] { "Articles", "articles" }));
    }

    [Theory]
    [InlineData("articles/first.md/child.md", VaultPathComparisonPolicy.Ordinal)]
    [InlineData("ARTICLES/FIRST.MD/child.md", VaultPathComparisonPolicy.OrdinalIgnoreCase)]
    [InlineData(".fsus/vault.json/child.json", VaultPathComparisonPolicy.Ordinal)]
    public void ManifestLeafFile_CannotAlsoServeAsAncestorDirectory(
        string descendant,
        VaultPathComparisonPolicy comparisonPolicy)
    {
        ArticleVaultRootManifest root = CreateRoot();
        VaultPathStructuralAnalysis result = ArticleVaultPathStructureValidator.Analyze(
            root, Scope(root, comparisonPolicy), "articles/first.md", [descendant]);

        Assert.Equal(VaultPathStructuralClass.Blocked, result.Classification);
        Assert.Null(result.PortableArticleIdentity);
        Assert.Contains(result.Collisions,
            static collision => collision.ReasonCode == "vault_path_file_ancestor_collision");
    }

    [Fact]
    public void TwoPortableIdentitiesForExactSameProjection_AreAmbiguous()
    {
        ArticleVaultRootManifest root = CreateRoot();
        root = Seal(root with
        {
            Articles =
            [
                root.Articles[0],
                root.Articles[0] with
                {
                    PortableArticleIdentity = "portable-b",
                    ManifestPath = ".fsus/articles/portable-b.json"
                }
            ]
        });

        VaultPathStructuralAnalysis result = ArticleVaultPathStructureValidator.Analyze(
            root, Scope(root), "articles/first.md", []);
        Assert.Equal(VaultPathStructuralClass.Blocked, result.Classification);
        Assert.Contains(result.Collisions,
            static collision => collision.ReasonCode == "vault_path_duplicate_projection");
    }

    [Fact]
    public void CrossSiteVaultDeviceAndUnknownComparison_FailBeforeClassification()
    {
        ArticleVaultRootManifest root = CreateRoot();
        VaultPathStructuralScope scope = Scope(root);
        foreach (VaultPathStructuralScope wrong in new[]
        {
            scope with { SiteIdentity = "other-site" },
            scope with { VaultIdentity = "other-vault" },
            scope with { DeviceIdentity = "other-device" },
            scope with { RootManifestSha256 = DigestB },
            scope with { ComparisonPolicy = (VaultPathComparisonPolicy)999 }
        })
        {
            Assert.Throws<InvalidDataException>(() => ArticleVaultPathStructureValidator.Analyze(
                root, wrong, "articles/first.md", []));
        }
    }

    [Fact]
    public void ReorderedDuplicateObservations_HaveSameDigestAndNoTimingInput()
    {
        ArticleVaultRootManifest root = CreateRoot();
        VaultPathStructuralScope scope = Scope(root);
        VaultPathStructuralAnalysis first = ArticleVaultPathStructureValidator.Analyze(
            root, scope, "articles/first.md", ["articles/first.md", ".fsus/vault.json"]);
        VaultPathStructuralAnalysis second = ArticleVaultPathStructureValidator.Analyze(
            root, scope, "articles/first.md", [".fsus/vault.json", "articles/first.md", "articles/first.md"]);
        Assert.Equal(first.ContentSha256, second.ContentSha256);
    }

    [Fact]
    public void ClassificationRuleInventoryAndScopeTamper_AreIndependentlyRejected()
    {
        ArticleVaultRootManifest root = CreateRoot();
        VaultPathStructuralScope scope = Scope(root);
        VaultPathStructuralAnalysis original = ArticleVaultPathStructureValidator.Analyze(
            root, scope, "articles/first.md", []);
        foreach (VaultPathStructuralAnalysis tampered in new[]
        {
            original with { SchemaVersion = 2 },
            original with { RuleRegistrySha256 = DigestB },
            original with { RuleIdentity = ArticleVaultPathStructureValidator.UnknownRule },
            original with { RelativePath = ".fsus/arbitrary.json" },
            original with { Scope = scope with { RootIdentitySha256 = DigestB } },
            original with { Classification = (VaultPathStructuralClass)999 },
            original with { ObservedRelativePaths = ["articles/FIRST.md"] },
            original with { RelativePath = null! }
        })
        {
            if (!Enum.IsDefined(tampered.Classification))
            {
                Assert.False(ArticleVaultPathStructureValidator.Verify(
                    root, scope, "articles/first.md", [], tampered).IsValid);
                Assert.Throws<System.Text.Json.JsonException>(() =>
                    ArticleVaultPathStructureValidator.ComputeContentSha256(tampered));
                continue;
            }

            VaultPathStructuralAnalysis resealed = tampered with
            {
                ContentSha256 = ArticleVaultPathStructureValidator.ComputeContentSha256(tampered)
            };
            Assert.False(ArticleVaultPathStructureValidator.Verify(
                root, scope, "articles/first.md", [], resealed).IsValid);
        }

        Assert.False(ArticleVaultPathStructureValidator.Verify(
            root, scope, "articles/first.md", [], null).IsValid);
    }

    [Fact]
    public void InventoryOverflow_BlocksRatherThanSilentlyDroppingObservations()
    {
        ArticleVaultRootManifest root = CreateRoot();
        string[] observations = Enumerable.Range(0, ArticleVaultPathStructureValidator.MaxObservedPaths + 1)
            .Select(static index => $"files/item-{index}.md").ToArray();
        Assert.Throws<InvalidDataException>(() => ArticleVaultPathStructureValidator.Analyze(
            root, Scope(root), "articles/first.md", observations));
    }

    [Fact]
    public void MalformedAnalysesAndRootEntries_ReturnInvalidRatherThanThrowing()
    {
        ArticleVaultRootManifest root = CreateRoot();
        VaultPathStructuralScope scope = Scope(root);
        VaultPathStructuralAnalysis analysis = ArticleVaultPathStructureValidator.Analyze(
            root, scope, "articles/first.md", []);
        foreach (VaultPathStructuralAnalysis malformed in new[]
        {
            analysis with { Scope = null! },
            analysis with { ObservedRelativePaths = null! },
            analysis with { Collisions = null! },
            analysis with { Collisions = [null!] },
            analysis with { Collisions = [new VaultPathCollision("invalid", null!)] },
            analysis with { Collisions = [new VaultPathCollision("invalid", [null!])] },
            analysis with { ObservedRelativePaths = [null!] }
        })
        {
            Assert.False(ArticleVaultPathStructureValidator.Verify(
                root, scope, "articles/first.md", [], malformed).IsValid);
        }

        Assert.False(ArticleVaultPathStructureValidator.ValidateScope(root with
        {
            Articles = [null!]
        }, scope).IsValid);
        Assert.False(ArticleVaultPathStructureValidator.ValidateScope(root with
        {
            OperationReceipts = [null!]
        }, scope).IsValid);
    }

    private static ArticleVaultRootManifest CreateRoot(string relativePath = "articles/first.md")
        => Seal(new ArticleVaultRootManifest(
            ArticleVaultSchemas.RootManifest,
            ArticleVaultSchemas.Version,
            ArticleVaultSchemas.ControlTreeVersion,
            new VaultControlTree(
                ArticleVaultSchemas.RootManifestPath,
                ArticleVaultSchemas.ArticleManifestDirectory,
                ArticleVaultSchemas.ReceiptDirectory),
            "site-alpha",
            "vault-alpha",
            "device-alpha",
            [new VaultArticleReference("portable-a", ".fsus/articles/portable-a.json", DigestA, relativePath)],
            [],
            string.Empty));

    private static ArticleVaultRootManifest Seal(ArticleVaultRootManifest root)
        => root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };

    private static VaultPathStructuralScope Scope(
        ArticleVaultRootManifest root,
        VaultPathComparisonPolicy comparisonPolicy = VaultPathComparisonPolicy.Ordinal)
        => new(root.SiteIdentity, root.VaultIdentity, root.DeviceIdentity,
            "agent-alpha", DigestA, root.ContentSha256, comparisonPolicy);
}
