using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticlePackageInventoryTests
{
    private const string Token = "01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private const string ArticlePath = "articles/" + Token + ".md";
    private const string AssetPath = "assets/" + Token + ".png";

    [Theory]
    [InlineData(ArticlePackageIdentityKind.Article, "article:")]
    [InlineData(ArticlePackageIdentityKind.Asset, "portable-asset:")]
    [InlineData(ArticlePackageIdentityKind.Definition, "portable-definition:")]
    [InlineData(ArticlePackageIdentityKind.Option, "portable-option:")]
    public void Identity_PreservesExplicitPortableNamespaceAndFilenameToken(ArticlePackageIdentityKind kind, string prefix)
    {
        string value = prefix + Token;
        ArticlePackageValidationResult result = ArticlePackageIdentity.TryCreate(kind, value, out ArticlePackageIdentity identity);

        Assert.True(result.IsValid, result.ReasonCode);
        Assert.Equal(kind, identity.Kind);
        Assert.Equal(value, identity.Value);
        Assert.Equal(Token, identity.FileNameToken);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(Token)]
    [InlineData("portable-article:" + Token)]
    [InlineData("portable-asset:" + Token)]
    [InlineData("article:00000000-0000-0000-0000-000000000000")]
    [InlineData("article:01991E72-9A2C-7B60-8F47-B339F58E4A11")]
    [InlineData("article:01991e729a2c7b608f47b339f58e4a11")]
    [InlineData(" article:" + Token)]
    [InlineData("article:" + Token + " ")]
    [InlineData("article:123")]
    [InlineData("my-article-slug")]
    [InlineData("Article title")]
    [InlineData("https://site.example/posts/" + Token)]
    public void Identity_RejectsSourceOrNoncanonicalIdentityWithoutNormalization(string? value)
    {
        ArticlePackageValidationResult result = ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article, value, out ArticlePackageIdentity identity);

        Assert.False(result.IsValid);
        Assert.Equal(ArticlePackageErrorCode.InvalidIdentity, result.ErrorCode);
        Assert.Equal("article_package_identity_invalid", result.ReasonCode);
        Assert.Null(identity.Value);
        Assert.Null(identity.FileNameToken);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(255)]
    public void Identity_RejectsUnknownKind(byte kind)
    {
        Assert.False(ArticlePackageIdentity.TryCreate((ArticlePackageIdentityKind)kind, "article:" + Token, out _).IsValid);
    }

    [Fact]
    public void Inventory_AcceptsSingleArticleAndLargeAssetRegardlessOfInputOrder()
    {
        ArticlePackageInventoryEntry[] entries =
        [
            Entry(AssetPath, ArticlePackageInventory.MaxAssetBytes),
            Entry(ArticlePackageInventory.ChecksumsPath),
            Entry(ArticlePath, ArticlePackageSourceBytes.MaximumByteLength),
            Entry(ArticlePackageInventory.ManifestPath)
        ];

        Assert.True(ArticlePackageInventory.Validate(entries).IsValid);
        Assert.True(ArticlePackageInventory.Validate(entries.Reverse().ToArray()).IsValid);
    }

    [Fact]
    public void Inventory_AcceptsOneThousandAndOneDistinctArticlesWithoutTruncation()
    {
        var entries = MetadataEntries();
        for (int index = 0; index < 1001; index++)
        {
            entries.Add(Entry($"articles/{NumberedToken(index)}.md"));
        }

        Assert.Equal(1003, entries.Count);
        Assert.True(ArticlePackageInventory.Validate(entries).IsValid);
    }

    [Theory]
    [InlineData("/manifest.json")]
    [InlineData("../manifest.json")]
    [InlineData("articles/../manifest.json")]
    [InlineData("articles/./" + Token + ".md")]
    [InlineData("articles//" + Token + ".md")]
    [InlineData("articles/" + Token + ".md/")]
    [InlineData("articles/sub/" + Token + ".md")]
    [InlineData("articles\\" + Token + ".md")]
    [InlineData("articles/%2e%2e/secret.md")]
    [InlineData("articles/" + Token + ".md?x=1")]
    [InlineData("articles/" + Token + ".md#fragment")]
    [InlineData("c:/manifest.json")]
    [InlineData("articles/portable-article:" + Token + ".md")]
    [InlineData("articles/article:" + Token + ".md")]
    [InlineData("Manifest.json")]
    [InlineData("articles/01991E72-9a2c-7b60-8f47-b339f58e4a11.md")]
    [InlineData("manifest.json ")]
    [InlineData("manifest.json\0")]
    [InlineData("articles/caf\u00e9.md")]
    [InlineData("articles/cafe\u0301.md")]
    [InlineData("articles/\uff10" + Token + ".md")]
    [InlineData("assets/" + Token + ".12345678901234567")]
    public void Inventory_RejectsUnsafeOrAliasedPaths(string path)
    {
        var entries = CompleteEntries();
        entries.Add(Entry(path));

        AssertInvalid(entries, ArticlePackageErrorCode.UnsafePath);
    }

    [Theory]
    [InlineData("extra.json")]
    [InlineData("manifest.yaml")]
    [InlineData("articles/" + Token + ".txt")]
    [InlineData("articles/00000000-0000-0000-0000-000000000000.md")]
    [InlineData("articles/123.md")]
    [InlineData("assets/" + Token)]
    [InlineData("assets/" + Token + ".")]
    [InlineData("assets/" + Token + ".png.exe")]
    [InlineData("other/" + Token + ".png")]
    public void Inventory_RejectsUnknownClosedLayoutPath(string path)
    {
        var entries = CompleteEntries();
        entries.Add(Entry(path));

        AssertInvalid(entries, ArticlePackageErrorCode.UnknownPath);
    }

    [Fact]
    public void Inventory_RejectsPathAndFilenameLengthBudgets()
    {
        var entries = CompleteEntries();
        entries.Add(Entry(new string('a', ArticlePackageInventory.MaxPathCharacters + 1)));
        AssertInvalid(entries, ArticlePackageErrorCode.UnsafePath);

        entries[^1] = Entry("assets/" + new string('a', ArticlePackageInventory.MaxFileNameCharacters + 1));
        AssertInvalid(entries, ArticlePackageErrorCode.UnsafePath);
    }

    [Theory]
    [InlineData(ArticlePackageEntryKind.Directory)]
    [InlineData(ArticlePackageEntryKind.SymbolicLink)]
    [InlineData(ArticlePackageEntryKind.HardLink)]
    [InlineData(ArticlePackageEntryKind.Other)]
    [InlineData((ArticlePackageEntryKind)0)]
    [InlineData((ArticlePackageEntryKind)255)]
    public void Inventory_RejectsAllNonregularEntryKinds(ArticlePackageEntryKind kind)
    {
        var entries = CompleteEntries();
        entries[2] = entries[2] with
        {
            Kind = kind
        };

        AssertInvalid(entries, ArticlePackageErrorCode.NonRegularEntry);
    }

    [Fact]
    public void Inventory_RejectsNullEntryAndNullPath()
    {
        var entries = CompleteEntries();
        entries.Add(null!);
        AssertInvalid(entries, ArticlePackageErrorCode.NonRegularEntry);

        entries[^1] = Entry(null!);
        AssertInvalid(entries, ArticlePackageErrorCode.UnsafePath);
    }

    [Theory]
    [InlineData(ArticlePackageInventory.ManifestPath)]
    [InlineData(ArticlePackageInventory.ChecksumsPath)]
    [InlineData(ArticlePath)]
    [InlineData(AssetPath)]
    public void Inventory_RejectsDuplicatePaths(string path)
    {
        var entries = CompleteEntries();
        if (path == AssetPath)
        {
            entries.Add(Entry(path));
        }
        entries.Add(Entry(path));

        AssertInvalid(entries, ArticlePackageErrorCode.DuplicatePath);
    }

    [Fact]
    public void Inventory_RejectsAssetIdentityRepeatedWithAnotherExtension()
    {
        var entries = CompleteEntries();
        entries.Add(Entry(AssetPath));
        entries.Add(Entry("assets/" + Token + ".jpg"));

        AssertInvalid(entries, ArticlePackageErrorCode.DuplicateIdentity);
    }

    [Fact]
    public void Inventory_RejectsMissingManifestChecksumsOrArticle()
    {
        Assert.False(ArticlePackageInventory.Validate(null).IsValid);
        Assert.False(ArticlePackageInventory.Validate([]).IsValid);
        Assert.False(ArticlePackageInventory.Validate(MetadataEntries()).IsValid);
        foreach (string missing in new[] { ArticlePackageInventory.ManifestPath, ArticlePackageInventory.ChecksumsPath, ArticlePath })
        {
            var entries = CompleteEntries();
            entries.RemoveAll(entry => entry.Path == missing);
            entries.Add(Entry(AssetPath));
            AssertInvalid(entries, ArticlePackageErrorCode.MissingRequiredEntry);
        }
    }

    [Theory]
    [InlineData(-1, 1)]
    [InlineData(1, -1)]
    [InlineData(1, 0)]
    public void Inventory_RejectsInvalidDeclaredSizes(long bytes, long compressed)
    {
        var entries = CompleteEntries();
        entries[2] = new(ArticlePath, ArticlePackageEntryKind.RegularFile, bytes, compressed);

        AssertInvalid(entries, ArticlePackageErrorCode.InvalidSize);
    }

    [Fact]
    public void Inventory_EnforcesCompressionRatioExactlyWithoutDivisionRounding()
    {
        var entries = CompleteEntries();
        entries[2] = new(ArticlePath, ArticlePackageEntryKind.RegularFile, 1000, 10);
        Assert.True(ArticlePackageInventory.Validate(entries).IsValid);

        entries[2] = entries[2] with
        {
            UncompressedBytes = 1001
        };
        AssertInvalid(entries, ArticlePackageErrorCode.BudgetExceeded);

        entries[2] = new(ArticlePath, ArticlePackageEntryKind.RegularFile, 0, 0);
        Assert.True(ArticlePackageInventory.Validate(entries).IsValid);
    }

    [Theory]
    [InlineData(ArticlePath, ArticlePackageSourceBytes.MaximumByteLength)]
    [InlineData(AssetPath, ArticlePackageInventory.MaxAssetBytes)]
    [InlineData(ArticlePackageInventory.ManifestPath, ArticlePackageInventory.MaxMetadataBytes)]
    [InlineData(ArticlePackageInventory.ChecksumsPath, ArticlePackageInventory.MaxMetadataBytes)]
    public void Inventory_EnforcesEachRoleByteBudget(string path, long limit)
    {
        var entries = CompleteEntries();
        int index = entries.FindIndex(entry => entry.Path == path);
        if (index < 0)
        {
            entries.Add(Entry(path));
            index = entries.Count - 1;
        }
        entries[index] = Entry(path, limit);
        Assert.True(ArticlePackageInventory.Validate(entries).IsValid);

        entries[index] = Entry(path, limit + 1);
        AssertInvalid(entries, ArticlePackageErrorCode.BudgetExceeded);

        entries[index] = new(path, ArticlePackageEntryKind.RegularFile, 1, long.MaxValue);
        AssertInvalid(entries, ArticlePackageErrorCode.BudgetExceeded);

        entries[index] = new(path, ArticlePackageEntryKind.RegularFile, long.MaxValue, 1);
        AssertInvalid(entries, ArticlePackageErrorCode.BudgetExceeded);
    }

    [Fact]
    public void Inventory_EnforcesTotalByteBudgetAtTheExactBoundary()
    {
        var entries = CompleteEntries();
        for (int index = 0; index < 16; index++)
        {
            long bytes = ArticlePackageInventory.MaxAssetBytes - (index == 15 ? 3 : 0);
            entries.Add(Entry($"assets/{NumberedToken(index)}.png", bytes));
        }
        Assert.True(ArticlePackageInventory.Validate(entries).IsValid);

        entries[^1] = Entry(entries[^1].Path, entries[^1].UncompressedBytes + 1);
        AssertInvalid(entries, ArticlePackageErrorCode.BudgetExceeded);
    }

    [Fact]
    public void Inventory_EnforcesCompressedTotalByteBudgetSeparately()
    {
        var entries = CompleteEntries();
        for (int index = 0; index < 16; index++)
        {
            entries.Add(new($"assets/{NumberedToken(index)}.png", ArticlePackageEntryKind.RegularFile, 1, ArticlePackageInventory.MaxAssetBytes));
        }

        AssertInvalid(entries, ArticlePackageErrorCode.BudgetExceeded);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Inventory_EnforcesDistinctArticleAndAssetCountBudgets(bool articles)
    {
        var entries = articles ? MetadataEntries() : CompleteEntries();
        int limit = articles ? ArticlePackageInventory.MaxArticles : ArticlePackageInventory.MaxAssets;
        for (int index = 0; index < limit; index++)
        {
            entries.Add(Entry(articles ? $"articles/{NumberedToken(index)}.md" : $"assets/{NumberedToken(index)}.png"));
        }
        Assert.True(ArticlePackageInventory.Validate(entries).IsValid);

        entries.Add(Entry(articles ? $"articles/{NumberedToken(limit)}.md" : $"assets/{NumberedToken(limit)}.png"));
        AssertInvalid(entries, ArticlePackageErrorCode.BudgetExceeded);
    }

    [Fact]
    public void Inventory_EnforcesTotalEntryCountBeforeInspectingContent()
    {
        ArticlePackageInventoryEntry[] entries = Enumerable.Repeat(Entry(ArticlePath), ArticlePackageInventory.MaxEntries + 1).ToArray();
        ArticlePackageValidationResult result = ArticlePackageInventory.Validate(entries);

        Assert.Equal("article_package_entry_count_exceeded", result.ReasonCode);
    }

    [Fact]
    public void Inventory_DoesNotDiscloseRejectedPathInReason()
    {
        var entries = CompleteEntries();
        entries.Add(Entry("private/session-secret"));
        ArticlePackageValidationResult result = ArticlePackageInventory.Validate(entries);

        Assert.False(result.IsValid);
        Assert.Equal("article_package_path_unknown", result.ReasonCode);
        Assert.DoesNotContain("secret", result.ReasonCode!);
    }

    [Fact]
    public void Inventory_FreezesOneBoundedIndexCopyWithoutReadingCountAgainOrEnumerating()
    {
        var entries = new BoundedIndexList<ArticlePackageInventoryEntry>(CompleteEntries(), 3);

        Assert.True(ArticlePackageInventory.Validate(entries).IsValid);
        Assert.Equal(1, entries.CountReads);
        Assert.Equal(3, entries.IndexReads);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(ArticlePackageInventory.MaxEntries + 1)]
    public void Inventory_RejectsInvalidCountBeforeAnyIndexRead(int count)
    {
        var entries = new BoundedIndexList<ArticlePackageInventoryEntry>([], count);

        Assert.False(ArticlePackageInventory.Validate(entries).IsValid);
        Assert.Equal(1, entries.CountReads);
        Assert.Equal(0, entries.IndexReads);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public void Inventory_RejectsIndexedCopyFailureWithoutThrowing(int failure)
    {
        var entries = new BoundedIndexList<ArticlePackageInventoryEntry>(CompleteEntries(), 3, failure);

        ArticlePackageValidationResult result = ArticlePackageInventory.Validate(entries);

        Assert.False(result.IsValid);
        Assert.Equal("article_package_inventory_input_invalid", result.ReasonCode);
        Assert.Equal(1, entries.CountReads);
        Assert.Equal(1, entries.IndexReads);
    }

    private sealed class BoundedIndexList<T>(IReadOnlyList<T> values, int firstCount, int failure = 0) : IReadOnlyList<T>
    {
        public int CountReads
        {
            get;
            private set;
        }

        public int IndexReads
        {
            get;
            private set;
        }

        public int Count => ++CountReads == 1 ? firstCount : int.MaxValue;

        public T this[int index]
        {
            get
            {
                IndexReads++;
                if (failure == 1)
                {
                    throw new ArgumentOutOfRangeException(nameof(index));
                }
                if (failure == 2)
                {
                    throw new IndexOutOfRangeException();
                }
                return values[index];
            }
        }

        public IEnumerator<T> GetEnumerator() => throw new InvalidOperationException("Input enumeration is forbidden.");

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private static List<ArticlePackageInventoryEntry> MetadataEntries()
        => [Entry(ArticlePackageInventory.ManifestPath), Entry(ArticlePackageInventory.ChecksumsPath)];

    private static List<ArticlePackageInventoryEntry> CompleteEntries()
        => [Entry(ArticlePackageInventory.ManifestPath), Entry(ArticlePackageInventory.ChecksumsPath), Entry(ArticlePath)];

    private static ArticlePackageInventoryEntry Entry(string path, long bytes = 1)
        => new(path, ArticlePackageEntryKind.RegularFile, bytes, bytes);

    private static string NumberedToken(int index)
        => $"{index:x8}-0000-4000-8000-000000000001";

    private static void AssertInvalid(IReadOnlyList<ArticlePackageInventoryEntry> entries, ArticlePackageErrorCode code)
    {
        ArticlePackageValidationResult result = ArticlePackageInventory.Validate(entries);
        Assert.False(result.IsValid);
        Assert.Equal(code, result.ErrorCode);
    }
}
