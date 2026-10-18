using System.Collections.Immutable;
using System.Globalization;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Tests.Unit;

// Adapted from review 5561740754: retain strict refusal oracles and supply a separate expected snapshot.
[Trait("Category", "Unit")]
public sealed class ArticlePackageFrozenExportIndependentReviewTests
{
    private sealed record Case(ArticlePackageManifestCandidateInput Article,
        ArticlePackageFrozenExportCandidateInput Frozen, ArticlePackageAssetCollectionSource Source,
        ArticlePackageManifestCandidatePlan Plan, ArticlePackageManifestCandidatePlan ExpectedPlan);

    private static Case Setup()
    {
        const string site = "https://review.example.test";
        const string md = "# independent e\u0301 😀\r\nexact  \t\r\n";
        byte[] raw = [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes(md)];
        var article = new ArticleCanonicalInput(91, 1091, 3, "review", "Synthetic", null, null, 1, [], 0, null, null, md);
        Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article,
            "article:00000091-0000-4000-8000-000000000001", out var id).IsValid);
        var title = new ArticlePackageTitleSummaryBinding(91, 1091, 3, ArticleCanonicalHashV1.ComputeHashHex(article), id);
        var coords = new ArticlePropertySnapshotCoordinates(7, site, 91, 1, 1091);
        var snapshot = new ArticlePropertyValueSnapshot(1, coords, [], ArticlePropertyValueDigest.ComputeSnapshot(coords, []));
        var input = new ArticlePackageManifestCandidateInput(article, title, snapshot,
            new(coords, snapshot.ContentDigest, [], [], []), raw);
        byte[] png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZgAAAABJRU5ErkJggg==");
        Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Asset,
            "portable-asset:70000000-0000-4000-8000-000000000091", out var assetId).IsValid);
        var source = new ArticlePackageAssetCollectionSource(assetId,
            new(AssetId.Parse("80000000-0000-4000-8000-000000000091"), "public",
                AssetStorageKey.Parse("content/public/review.png"), "image/png", ".png", png.Length,
                Hash(png), 1, 1, 7, ContentAssetState.Active, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch), png);
        DocumentExportAsset[] fonts = DocumentExportReadingStyleAuthority.RequiredFonts.Select((font, i) =>
        {
            byte[] b = Encoding.ASCII.GetBytes($"wOF2-independent-{i}");
            return new DocumentExportAsset($"review-font-{i}", "font/woff2", DocumentExportDigest.ComputeBytes(b),
                b.ToImmutableArray(), "", "font", font.Family, font.Weight, font.Style);
        }).ToArray();
        DocumentExportAsset[] assets = [.. fonts, new(source.Record.Id.ToString(), "image/png",
            DocumentExportDigest.ComputeBytes(png), png.ToImmutableArray(), "synthetic", "image", "", 0, "normal")];
        string digest = DocumentExportDigest.ComputeBytes("synthetic"u8);
        var frozen = new DocumentExportFrozenInput(DocumentExportContractCatalog.InputSchema, "independent-91", 7, site,
            new(DocumentExportCoordinateKind.Revision, 91, null, 1091, null, 3), raw.ToImmutableArray(),
            DocumentExportDigest.ComputeBytes(raw), digest, digest,
            DocumentExportContractValidator.ComputeAssetManifestDigest(assets),
            DocumentExportContractValidator.ComputeFontManifestDigest(assets), "fsusui.markdown-renderer", "current-v1",
            digest, DocumentExportReadingStyleAuthority.LayoutProfile, DocumentExportReadingStyleAuthority.LightThemeProfile,
            "zh-Hant", assets.ToImmutableArray(), DocumentExportReadingStyleAuthority.AuthorityDigest, null, "");
        frozen = DocumentExportContractValidator.Seal(frozen);
        DocumentExportContractValidator.Validate(frozen);
        ArticlePackageInventoryEntry[] inventory = [
            new(ArticlePackageInventory.ManifestPath, ArticlePackageEntryKind.RegularFile, 1, 1),
            new(ArticlePackageInventory.ChecksumsPath, ArticlePackageEntryKind.RegularFile, 1, 1),
            new("articles/" + id.FileNameToken + ".md", ArticlePackageEntryKind.RegularFile, raw.Length, raw.Length),
            new("assets/" + assetId.FileNameToken + ".png", ArticlePackageEntryKind.RegularFile, png.Length, png.Length)];
        var result = ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan([input], [source], [new(id, assetId)], inventory, out var plan);
        Assert.True(result.IsValid, result.ReasonCode);
        return new(input, new(id, frozen), source, plan!, plan!);
    }

    private static string Hash(ReadOnlySpan<byte> b) => Convert.ToHexStringLower(SHA256.HashData(b));
    private static T Construct<T>(params object[] args) => (T)Activator.CreateInstance(typeof(T),
        BindingFlags.NonPublic | BindingFlags.Instance, null, args, null)!;
    private static ArticlePackageFrozenExportCandidate Write(Case c)
    {
        var r = ArticlePackageFrozenExportCandidateWriter.TryWriteCandidateToSnapshot(c.ExpectedPlan, c.Plan, [c.Article], [c.Frozen], out var candidate);
        Assert.True(r.IsValid, r.ReasonCode);
        return Assert.IsType<ArticlePackageFrozenExportCandidate>(candidate);
    }
    private static void Refuse(Case c, CancellationToken token = default)
    {
        var r = ArticlePackageFrozenExportCandidateWriter.TryWriteCandidateToSnapshot(c.ExpectedPlan, c.Plan, [c.Article], [c.Frozen], out var candidate, token);
        Assert.False(r.IsValid);
        Assert.NotEmpty(r.ReasonCode!);
        Assert.Null(candidate);
    }
    private static Case Reseal(Case c, DocumentExportAsset[] assets)
    {
        var input = DocumentExportContractValidator.Seal(c.Frozen.Input with
        {
            Assets = assets.ToImmutableArray(),
            AssetManifestDigest = DocumentExportContractValidator.ComputeAssetManifestDigest(assets),
            FontManifestDigest = DocumentExportContractValidator.ComputeFontManifestDigest(assets)
        });
        DocumentExportContractValidator.Validate(input);
        return c with
        {
            Frozen = c.Frozen with
            {
                Input = input
            }
        };
    }

    [Theory]
    [InlineData("en-US")]
    [InlineData("tr-TR")]
    public void Positive_RealFrozenBytesChecksumZipAndAuthority(string culture)
    {
        var c = Setup();
        var before = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo(culture);
            var output = Write(c);
            byte[] bytes = output.CopyArchiveBytes();
            Assert.Equal(bytes, Write(c).CopyArchiveBytes());
            Assert.Equal(Hash(bytes), output.ArchiveSha256);
            Assert.True(ArticlePackageImportAssetCandidateValidator.TryReadCandidate(bytes, output.Candidate.Manifest.Assets, out var read).IsValid);
            Assert.Equal(c.Plan.Manifest.SemanticDigest, read!.Candidate.Manifest.SemanticDigest);
            Assert.Equal(output.Candidate.PackageBytesDigest, read.Candidate.PackageBytesDigest);
            Assert.False(output.RequireExportAuthority().IsValid);
            Assert.False(c.Plan.RequirePackageAuthority().IsValid);
            Assert.False(read.RequireArchiveAuthority().IsValid);
            Assert.False(read.Candidate.Manifest.Assets!.RequireAssetAuthority().IsValid);
            Assert.All(read.Candidate.Manifest.Assets.Assets, x => Assert.False(x.RequireAssetAuthority().IsValid));
            using var zip = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read);
            Assert.Equal(zip.Entries.Select(x => x.FullName).Order(StringComparer.Ordinal), zip.Entries.Select(x => x.FullName));
            Assert.Equal(4, zip.Entries.Count);
            foreach (var e in zip.Entries)
            {
                Assert.Equal(e.Length, e.CompressedLength);
                Assert.Equal(new DateTime(1980, 1, 1), e.LastWriteTime.DateTime);
                Assert.Equal(unchecked((int)0x81a40000), e.ExternalAttributes);
            }
            Assert.DoesNotContain(zip.Entries, e => e.FullName.Contains("font"));
            using var sums = JsonDocument.Parse(output.Candidate.CopyFileBytes(ArticlePackageInventory.ChecksumsPath));
            var rows = sums.RootElement.GetProperty("files").EnumerateArray().ToArray();
            Assert.Equal(3, rows.Length);
            Assert.Equal(rows.Select(r => r.GetProperty("path").GetString()).Order(StringComparer.Ordinal),
                rows.Select(r => r.GetProperty("path").GetString()));
            foreach (var r in rows)
            {
                byte[] payload = output.Candidate.CopyFileBytes(r.GetProperty("path").GetString()!);
                Assert.Equal(payload.Length, r.GetProperty("byteLength").GetInt64());
                Assert.Equal(Hash(payload), r.GetProperty("sha256").GetString());
            }
            Assert.Equal(c.Frozen.Input.MarkdownUtf8.ToArray(), output.Candidate.CopyFileBytes("articles/" + c.Frozen.PortableArticle.FileNameToken + ".md"));
            Assert.Equal(c.Source.SourceBytes.ToArray(), output.Candidate.CopyFileBytes("assets/" + c.Source.PortableAsset.FileNameToken + ".png"));
        }
        finally { CultureInfo.CurrentCulture = before; }
    }

    [Theory]
    [InlineData("resealed-bytes")]
    [InlineData("mime")]
    [InlineData("id")]
    [InlineData("missing")]
    [InlineData("stale-digest")]
    [InlineData("dimension")]
    [InlineData("raw-hash")]
    [InlineData("inventory")]
    [InlineData("root")]
    [InlineData("v3")]
    public void Negative_IndependentDrift(string fault)
    {
        var c = Setup();
        var rows = c.Frozen.Input.Assets.ToArray();
        if (fault == "resealed-bytes")
        {
            byte[] changed = rows[^1].Bytes.ToArray();
            changed[^1] ^= 1;
            rows[^1] = rows[^1] with
            {
                Bytes = changed.ToImmutableArray(),
                Sha256 = DocumentExportDigest.ComputeBytes(changed)
            };
            c = Reseal(c, rows);
        }
        else if (fault == "mime")
        {
            rows[^1] = rows[^1] with
            {
                MediaType = "image/jpeg"
            };
            c = Reseal(c, rows);
        }
        else if (fault == "id")
        {
            rows[^1] = rows[^1] with
            {
                AssetId = "80000000-0000-4000-8000-000000000092"
            };
            c = Reseal(c, rows);
        }
        else if (fault == "missing")
        {
            c = Reseal(c, rows[..^1]);
        }
        else if (fault == "stale-digest")
        {
            byte[] changed = rows[^1].Bytes.ToArray();
            changed[^1] ^= 1;
            rows[^1] = rows[^1] with
            {
                Bytes = changed.ToImmutableArray()
            };
            c = c with
            {
                Frozen = c.Frozen with
                {
                    Input = c.Frozen.Input with
                    {
                        Assets = rows.ToImmutableArray()
                    }
                }
            };
        }
        else if (fault is "dimension" or "raw-hash")
        {
            var a = c.Plan.Assets![0];
            var source = c.Source with
            {
                Record = fault == "dimension" ? c.Source.Record with
                {
                    WidthPixels = 2
                } : c.Source.Record
            };
            var held = Construct<ArticlePackageManifestPlannedAsset>(source, a.Metadata, fault == "raw-hash" ? new string('0', 64) : a.RawByteSha256);
            c = c with
            {
                Plan = Construct<ArticlePackageManifestCandidatePlan>(c.Plan.Manifest, c.Plan.Articles.ToArray(), new[] { held })
            };
        }
        else if (fault == "inventory")
        {
            var a = c.Plan.Manifest.Assets!;
            var inv = a.Inventory.Select(e => e.Path.StartsWith("assets/") ? e with { UncompressedBytes = e.UncompressedBytes + 1 } : e).ToArray();
            var collection = Construct<ArticlePackageManifestAssetCollectionCandidate>(a.Assets.ToArray(), a.References.ToArray(), inv, a.TotalAssetBytes, a.ComponentDigest);
            typeof(ArticlePackageManifestCandidate).GetProperty("Assets")!.SetValue(c.Plan.Manifest, collection);
        }
        else if (fault == "v3")
        {
            // The actual candidate type can only represent v1/v2. Test future bytes at its codec boundary.
            byte[] raw = ArticlePackageManifestCandidateCodec.WriteCandidate(c.Plan.Manifest, c.Plan.Manifest.Assets!, c.Plan.Inventory!);
            raw = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(raw).Replace("\"schemaVersion\":2", "\"schemaVersion\":3", StringComparison.Ordinal));
            var read = ArticlePackageManifestCandidateCodec.TryParseCandidate(raw, c.Plan.Manifest.Assets!, c.Plan.Inventory!, out var future);
            Assert.False(read.IsValid);
            Assert.Equal("article_package_manifest_version_unsupported", read.ReasonCode);
            Assert.Null(future);
            Assert.False(ArticlePackageManifestVersionRegistry.TryGetRegistration(new(3, 1, 1), out _));
            return;
        }
        else
        {
            var m = Construct<ArticlePackageManifestCandidate>(c.Plan.Manifest.Articles.ToArray(), new string('0', 64));
            typeof(ArticlePackageManifestCandidate).GetProperty("Assets")!.SetValue(m, c.Plan.Manifest.Assets);
            c = c with
            {
                Plan = Construct<ArticlePackageManifestCandidatePlan>(m, c.Plan.Articles.ToArray(), c.Plan.Assets!.ToArray())
            };
        }
        Refuse(c);
        Write(Setup());
    }

    [Fact]
    public void Cancellation_NoCandidateThenRecovery()
    {
        var c = Setup();
        var expected = Write(c).CopyArchiveBytes();
        using var stop = new CancellationTokenSource();
        stop.Cancel();
        Refuse(c, stop.Token);
        Assert.Equal(expected, Write(c).CopyArchiveBytes());
    }

    [Theory]
    [InlineData("storage-key")]
    [InlineData("owner")]
    [InlineData("created")]
    [InlineData("updated")]
    public void KnownP2_PlannerMustRejectRecordDrift(string field)
    {
        var c = Setup();
        var r = ArticlePackageManifestCandidatePlanner.TryBindCandidatePlanToSnapshot(c.ExpectedPlan, [c.Article],
            [c.Source with { Record = Change(c.Source.Record, field) }], c.Plan.Manifest.Assets!.References,
            c.Plan.Inventory, out var result);
        Assert.False(r.IsValid); // Same rejection oracle; now compare against the independently retained expected snapshot.
        Assert.Null(result);
    }

    [Theory]
    [InlineData("storage-key")]
    [InlineData("owner")]
    [InlineData("created")]
    [InlineData("updated")]
    public void KnownP2_WriterMustRejectRecordDrift(string field)
    {
        var c = Setup();
        var a = c.Plan.Assets![0];
        var replacement = Construct<ArticlePackageManifestPlannedAsset>(c.Source with
        {
            Record = Change(c.Source.Record, field)
        }, a.Metadata, a.RawByteSha256);
        c = c with
        {
            Plan = Construct<ArticlePackageManifestCandidatePlan>(c.Plan.Manifest, c.Plan.Articles.ToArray(), new[] { replacement })
        };
        Refuse(c);
    }

    [Fact]
    public void Positive_ExplicitEmptyV2RemainsV2()
    {
        var c = Setup();
        c = Reseal(c, c.Frozen.Input.Assets.Where(a => a.Role == "font").ToArray());
        var inv = c.Plan.Inventory!.Where(e => !e.Path.StartsWith("assets/", StringComparison.Ordinal)).ToArray();
        Assert.True(ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan([c.Article], [], [], inv, out var plan).IsValid);
        c = c with
        {
            Plan = plan!
        };
        Refuse(c); // A nonempty retained snapshot cannot authorize an empty replacement.
        c = c with
        {
            ExpectedPlan = plan!
        };
        var output = Write(c);
        Assert.Equal(2, output.Candidate.Manifest.SchemaVersion);
        Assert.Empty(output.Candidate.Manifest.Assets!.Assets);
        Assert.False(ArticlePackageImportZipCandidateReader.TryReadCandidate(output.CopyArchiveBytes(), out var legacy).IsValid);
        Assert.Null(legacy);
    }

    [Theory]
    [InlineData("bytes")]
    [InlineData("rows")]
    public void Negative_PreCopyBudget(string fault)
    {
        var c = Setup();
        var input = fault == "bytes"
            ? c.Frozen.Input with
            {
                MarkdownUtf8 = new byte[64 * 1024 * 1024 + 1].ToImmutableArray()
            }
            : c.Frozen.Input with
            {
                Assets = Enumerable.Repeat(c.Frozen.Input.Assets.Last(), 257).ToImmutableArray()
            };
        Refuse(c with
        {
            Frozen = c.Frozen with
            {
                Input = input
            }
        });
        Write(c);
    }

    [Fact]
    public void Negative_ArchivePayloadTamperThroughOriginalReader()
    {
        var output = Write(Setup());
        byte[] archive = output.CopyArchiveBytes();
        int offset = archive.AsSpan().IndexOf(Setup().Source.SourceBytes.Span);
        Assert.True(offset >= 0);
        archive[offset + 8] ^= 1;
        Assert.False(ArticlePackageImportAssetCandidateValidator.TryReadCandidate(archive, output.Candidate.Manifest.Assets, out var candidate).IsValid);
        Assert.Null(candidate);
    }

    [Fact]
    public void RecordDriftCannotWriteAgainstRetainedExpectedSnapshot()
    {
        var c = Setup();
        var original = Write(c).CopyArchiveBytes();
        foreach (string field in new[] { "storage-key", "owner", "created", "updated" })
        {
            Assert.True(ArticlePackageManifestCandidatePlanner.TryBindCandidatePlan(c.Plan.Manifest, [c.Article],
                [c.Source with { Record = Change(c.Source.Record, field) }], c.Plan.Manifest.Assets!.References,
                c.Plan.Inventory, out var rebound).IsValid);
            Assert.NotEqual(c.Source.Record, rebound!.Assets![0].Record);
            // Portable consistency is unchanged; it no longer supplies a writer record anchor.
            Refuse(c with
            {
                Plan = rebound
            });
            var legacy = ArticlePackageFrozenExportCandidateWriter.TryWriteCandidate(rebound, [c.Frozen], out var unanchored);
            Assert.Equal("article_package_export_asset_record_snapshot_required", legacy.ReasonCode);
            Assert.Null(unanchored);
            Assert.Equal(original, Write(c).CopyArchiveBytes());
        }
    }

    private static AssetRecord Change(AssetRecord r, string field) => field switch
    {
        "storage-key" => r with { StorageKey = AssetStorageKey.Parse("content/public/drift.png") },
        "owner" => r with { OwnerAdminPrincipalId = 8 },
        "created" => r with { CreatedAtUtc = DateTimeOffset.UnixEpoch.AddSeconds(-1) },
        _ => r with { UpdatedAtUtc = DateTimeOffset.UnixEpoch.AddSeconds(1) }
    };
}
