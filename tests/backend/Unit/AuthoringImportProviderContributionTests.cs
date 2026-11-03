using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Tests;

[Trait("Category", "Unit")]
public sealed class AuthoringImportProviderContributionTests
{
    private static readonly DateTime s_now = new(2026, 10, 8, 0, 0, 0, DateTimeKind.Utc);

    [Theory]
    [InlineData(false, CompressionLevel.NoCompression)]
    [InlineData(true, CompressionLevel.NoCompression)]
    [InlineData(true, CompressionLevel.Optimal)]
    public void Candidate_UsesActualOwnersAndPreservesAuthorityRefusals(bool zip, CompressionLevel compression)
    {
        var fixture = new Fixture(zip, compression);
        AuthoringImportProviderCandidateHandoff handoff = fixture.Prepare();
        Assert.False(handoff.RequireExecutionAuthority().IsValid);
        Assert.Equal("article_package_import_authority_unavailable", handoff.RequireExecutionAuthority().ReasonCode);
        Assert.True(fixture.Adapter.ValidateRequestBinding(handoff, fixture.Owner, fixture.Provider, fixture.Attempt, fixture.Intent).IsValid);
        if (zip)
        {
            Assert.Equal(fixture.Attempt.ExpectedArchiveSha256, handoff.ZipCandidate!.ArchiveSha256);
            Assert.False(handoff.ZipCandidate.RequireArchiveAuthority().IsValid);
        }
        else
        {
            Assert.Null(handoff.ZipCandidate);
        }
        Assert.Contains("current_actor_site_target_permissions", handoff.Plan.RequiredAuthorities);
        Assert.Contains("execution_qualification", handoff.Plan.RequiredAuthorities);
    }

    [Theory]
    [InlineData("provider")]
    [InlineData("package")]
    [InlineData("version")]
    [InlineData("schema")]
    [InlineData("input-schema")]
    [InlineData("candidate-schema")]
    [InlineData("streaming")]
    [InlineData("unknown-kind")]
    [InlineData("wrong-kind")]
    public void InvalidProvider_NeverReturnsCandidate(string change)
    {
        var f = new Fixture();
        f.Provider = change switch
        {
            "provider" => f.Provider with { ProviderId = "acme.unknown" },
            "package" => f.Provider with { PackageSha256 = new string('b', 64) },
            "version" => f.Provider with { ExtensionVersion = "2.0.0" },
            "schema" => f.Provider with { SchemaVersion = 2 },
            "input-schema" => f.Provider with { InputSchemaVersion = 2 },
            "candidate-schema" => f.Provider with { CandidateSchemaVersion = 2 },
            "streaming" => f.Provider with { SupportsStreaming = true },
            "unknown-kind" => f.Provider with { InputKind = (AuthoringImportProviderCandidateInput)123 },
            _ => f.Provider with { InputKind = AuthoringImportProviderCandidateInput.ZipBytes }
        };
        AssertRejected(f);
    }

    [Theory]
    [InlineData("package")]
    [InlineData("archive")]
    [InlineData("empty-attempt")]
    [InlineData("grant")]
    public void InputOrAttemptDrift_NeverReturnsCandidate(string change)
    {
        var f = new Fixture(true);
        f.Attempt = change switch
        {
            "package" => f.Attempt with { ExpectedPackageBytesDigest = new string('a', 64) },
            "archive" => f.Attempt with { ExpectedArchiveSha256 = new string('b', 64) },
            "empty-attempt" => f.Attempt with { AttemptId = "" },
            _ => f.Attempt with { DeclaredGrantDigest = "forged" }
        };
        AssertRejected(f);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ChangedAttemptGrantOrInput_RejectsPreviousHandoffAndRetryHasNewDigest(bool zip)
    {
        var f = new Fixture(zip);
        var first = f.Prepare();
        var retry = f.Attempt with
        {
            AttemptId = "attempt:two",
            DeclaredGrantDigest = new string('e', 64)
        };
        Assert.False(f.Adapter.ValidateRequestBinding(first, f.Owner, f.Provider, retry, f.Intent).IsValid);
        f.Attempt = retry;
        var second = f.Prepare();
        Assert.NotEqual(first.ContentDigest, second.ContentDigest);
        Assert.False(second.RequireExecutionAuthority().IsValid);
        Assert.False(f.Adapter.ValidateRequestBinding(second, f.Owner, f.Provider,
            retry with
            {
                ExpectedPackageBytesDigest = new string('f', 64)
            }, f.Intent).IsValid);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CallerStorageMutation_DoesNotChangeFrozenCandidate(bool zip)
    {
        var f = new Fixture(zip);
        var handoff = f.Prepare();
        string path = f.Package.Candidate.FilePaths.Single(p => p.EndsWith(".md", StringComparison.Ordinal));
        byte[] original = handoff.Plan.Candidate.CopyFileBytes(path);
        Array.Fill(f.Archive, (byte)0);
        foreach (var file in f.Package.Files)
        {
            // Fixture arrays retain caller ownership; product must copy before planning.
            if (System.Runtime.InteropServices.MemoryMarshal.TryGetArray(file.Bytes, out ArraySegment<byte> bytes))
            {
                Array.Fill(bytes.Array!, (byte)0);
            }
        }
        Assert.Equal(original, handoff.Plan.Candidate.CopyFileBytes(path));
        byte[] copy = handoff.Plan.Candidate.CopyFileBytes(path);
        copy[0] ^= 1;
        Assert.Equal(original, handoff.Plan.Candidate.CopyFileBytes(path));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CancelledOrExpiredAttempt_DoesNotReturnCandidate(bool zip)
    {
        var f = new Fixture(zip);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Assert.Throws<OperationCanceledException>(() => f.TryPrepare(out _, cancellation.Token));
        var handoff = f.Prepare();
        f.Clock.Now = s_now.AddSeconds(4);
        AssertRejected(f);
        Assert.False(f.Adapter.ValidateRequestBinding(handoff, f.Owner, f.Provider, f.Attempt, f.Intent).IsValid);
    }

    [Fact]
    public void ExpiryDuringRead_RejectsCompletedBytes()
    {
        var f = new Fixture();
        var files = new ObservedFiles(f.Package.Files, () => f.Clock.Now = s_now.AddSeconds(4));
        var result = f.Adapter.TryPrepareCandidate(f.Owner, f.Provider, f.Attempt, f.Intent,
            f.Package.Inventory, files, out var handoff);
        Assert.False(result.IsValid);
        Assert.Null(handoff);
    }

    [Fact]
    public void CancellationDuringRead_DoesNotReturnCandidate()
    {
        var f = new Fixture();
        using var cancellation = new CancellationTokenSource();
        var files = new ObservedFiles(f.Package.Files, cancellation.Cancel);
        Assert.Throws<OperationCanceledException>(() => f.Adapter.TryPrepareCandidate(f.Owner, f.Provider,
            f.Attempt, f.Intent, f.Package.Inventory, files, out _, cancellation.Token));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CorruptedBytes_UseOriginalOwnerRefusal(bool zip)
    {
        var f = new Fixture(zip);
        if (zip)
        {
            f.Archive[0] ^= 1;
        }
        else
        {
            f.Package.Files[0] = new(f.Package.Files[0].Path, Encoding.UTF8.GetBytes("{}"));
        }
        AssertRejected(f);
    }

    [Fact]
    public void UnknownMetadataField_IsRejected()
    {
        var f = new Fixture();
        string json = JsonSerializer.Serialize(f.Provider);
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<AuthoringImportProviderContribution>(json[..^1] + ",\"CanExecute\":true}"));
    }

    [Fact]
    public void UpdateTargets_AreExplicitFrozenAndStillNotWritable()
    {
        var f = new Fixture(true);
        ArticlePackageImportRequestedTarget[] targets = [new(Identity(1), 42, 7)];
        f.Intent = f.Intent with
        {
            Mode = ArticlePackageImportCandidateMode.UpdateRequested,
            RequestedTargets = targets
        };
        var handoff = f.Prepare();
        string digest = handoff.Plan.PlanDigest;
        targets[0] = new(Identity(1), 99, 8);
        Assert.Equal(digest, handoff.Plan.PlanDigest);
        Assert.False(f.Adapter.ValidateRequestBinding(handoff, f.Owner, f.Provider, f.Attempt, f.Intent).IsValid);
        Assert.False(handoff.RequireExecutionAuthority().IsValid);
    }

    [Fact]
    public void NoMatchingTarget_IsNotGuessed()
    {
        var f = new Fixture(true);
        f.Intent = f.Intent with
        {
            Mode = ArticlePackageImportCandidateMode.UpdateRequested,
            RequestedTargets = []
        };
        AssertRejected(f);
    }

    [Fact]
    public void ChangedPolicyOrActor_DoesNotMatchCandidate()
    {
        var f = new Fixture(true);
        var handoff = f.Prepare();
        Assert.False(f.Adapter.ValidateRequestBinding(handoff, f.Owner, f.Provider, f.Attempt,
            f.Intent with
            {
                PolicyDigest = new string('f', 64)
            }).IsValid);
        Assert.False(f.Adapter.ValidateRequestBinding(handoff, f.Owner, f.Provider, f.Attempt,
            f.Intent with
            {
                Actor = new ArticleRelationActorContext("actor:other", "site:primary", new string('a', 64))
            }).IsValid);
    }

    [Theory]
    [InlineData("InputKind")]
    [InlineData("SupportsStreaming")]
    [InlineData("ProviderId")]
    public void MissingExplicitMetadata_IsRejected(string property)
    {
        var f = new Fixture();
        JsonObject json = JsonNode.Parse(JsonSerializer.Serialize(f.Provider))!.AsObject();
        json.Remove(property);
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<AuthoringImportProviderContribution>(json.ToJsonString()));
    }

    private static void AssertRejected(Fixture fixture)
    {
        Assert.False(fixture.TryPrepare(out var handoff).IsValid);
        Assert.Null(handoff);
    }

    private sealed class Clock : TimeProvider
    {
        public DateTime Now { get; set; } = s_now;
        public override DateTimeOffset GetUtcNow() => new(Now);
    }

    private sealed class ObservedFiles(ArticlePackageFileBytes[] files, Action observed) : IReadOnlyList<ArticlePackageFileBytes>
    {
        public int Count => files.Length;
        public ArticlePackageFileBytes this[int index]
        {
            get
            {
                observed();
                return files[index];
            }
        }
        public IEnumerator<ArticlePackageFileBytes> GetEnumerator() => ((IEnumerable<ArticlePackageFileBytes>)files).GetEnumerator();
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private sealed class Fixture
    {
        public Fixture(bool zip = false, CompressionLevel compression = CompressionLevel.NoCompression)
        {
            Package = AuthoringImportProviderContributionTests.Package();
            var manifest = AuthoringExtensionContractsTests.CreateManifest();
            manifest = manifest with
            {
                Contributions = [manifest.Contributions[0] with
            {
                Id = "acme.import.raw", Kind = AuthoringContributionKind.ImportProvider, Capabilities = []
            }]
            };
            Owner = AuthoringExtensionContractValidator.Verify(manifest);
            Provider = new(1, "acme.import.raw", manifest.Id, manifest.Version, manifest.PackageSha256,
                zip ? AuthoringImportProviderCandidateInput.ZipBytes : AuthoringImportProviderCandidateInput.PackageFileBytes, 1, 1, false);
            using var stream = new MemoryStream();
            using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
            {
                foreach (var file in Package.Files)
                {
                    var entry = archive.CreateEntry(file.Path, compression);
                    entry.LastWriteTime = new DateTimeOffset(s_now);
                    entry.ExternalAttributes = 0;
                    using Stream target = entry.Open();
                    target.Write(file.Bytes.Span);
                }
            }
            Archive = stream.ToArray();
            Attempt = new("runtime:one", "request:one", "attempt:one", new string('d', 64),
                Package.Candidate.PackageBytesDigest, zip ? Convert.ToHexStringLower(SHA256.HashData(Archive)) : null);
            Intent = new(new ArticleRelationActorContext("actor:importer", "site:primary", new string('a', 64)),
                ArticlePackageImportCandidateMode.CreateNew, new string('b', 64), s_now, s_now.AddSeconds(4), null);
            Adapter = new(Clock);
        }
        public PackageFixture Package
        {
            get;
        }
        public byte[] Archive
        {
            get;
        }
        public VerifiedAuthoringExtensionContract Owner
        {
            get;
        }
        public AuthoringImportProviderContribution Provider
        {
            get; set;
        }
        public AuthoringImportProviderCandidateAttempt Attempt
        {
            get; set;
        }
        public ArticlePackageImportCandidateRequest Intent
        {
            get; set;
        }
        public Clock Clock { get; } = new();
        public AuthoringImportProviderCandidateAdapter Adapter
        {
            get;
        }
        public ArticlePackageManifestCandidateResult TryPrepare(out AuthoringImportProviderCandidateHandoff? handoff, CancellationToken token = default)
            => Provider.InputKind == AuthoringImportProviderCandidateInput.ZipBytes
                ? Adapter.TryPrepareZipCandidate(Owner, Provider, Attempt, Intent, Archive, out handoff, token)
                : Adapter.TryPrepareCandidate(Owner, Provider, Attempt, Intent, Package.Inventory, Package.Files, out handoff, token);
        public AuthoringImportProviderCandidateHandoff Prepare()
        {
            var result = TryPrepare(out var handoff);
            Assert.True(result.IsValid, result.ReasonCode);
            return Assert.IsType<AuthoringImportProviderCandidateHandoff>(handoff);
        }
    }

    private sealed record PackageFixture(ArticlePackageInventoryEntry[] Inventory, ArticlePackageFileBytes[] Files,
        ArticlePackageValidatedImportCandidate Candidate);
    private static ArticlePackageIdentity Identity(int index)
    {
        Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article,
            $"article:{index:x8}-0000-4000-8000-000000000001", out var identity).IsValid);
        return identity;
    }

    private static PackageFixture Package(int count = 1, string markdown = "exact source\r\n")
    {
        byte[] raw = System.Text.Encoding.UTF8.GetBytes(markdown);
        Assert.True(ArticlePackageSourceBytes.Inspect(raw, out var metadata).IsValid);
        ArticlePackageManifestArticle[] articles = Enumerable.Range(1, count).Select(index =>
            new ArticlePackageManifestArticle(Identity(index),
                new(index, 1000 + index, 3, new string('c', 64), "site:primary", 1, null, null, null),
                "Caller supplied title", null, new string('d', 64), new string('e', 64), new string('f', 64),
                metadata!, new(0, null, null))).ToArray();
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate(articles, out var manifest).IsValid);
        var files = new List<ArticlePackageFileBytes>
        {
            new(ArticlePackageInventory.ManifestPath, ArticlePackageManifestCandidateCodec.WriteCandidate(manifest!))
        };
        files.AddRange(articles.Select(article => new ArticlePackageFileBytes($"articles/{article.PortableArticle.FileNameToken}.md", raw)));
        ArticlePackageInventoryEntry[] inventory = [.. files.Select(file => Entry(file.Path, file.Bytes.Length)),
            Entry(ArticlePackageInventory.ChecksumsPath, 0)];
        ArticlePackageChecksumEntry[] rows = files.Select(file => new ArticlePackageChecksumEntry(file.Path,
            file.Bytes.Length, Convert.ToHexStringLower(SHA256.HashData(file.Bytes.Span)))).ToArray();
        ArticlePackageChecksumValidationResult checksum = ArticlePackageChecksums.ComputeComponentDigest(inventory, rows);
        Assert.True(checksum.IsValid, checksum.ReasonCode);
        byte[] document = JsonSerializer.SerializeToUtf8Bytes(new
        {
            schema = ArticlePackageChecksums.Schema,
            version = ArticlePackageChecksums.Version,
            algorithm = ArticlePackageChecksums.Algorithm,
            componentDigest = checksum.ComponentDigest,
            files = rows.Select(row => new
            {
                path = row.Path,
                byteLength = row.ByteLength,
                sha256 = row.Sha256
            })
        });
        inventory[^1] = Entry(ArticlePackageInventory.ChecksumsPath, document.Length);
        files.Add(new(ArticlePackageInventory.ChecksumsPath, document));
        Assert.True(ArticlePackageChecksums.Verify(inventory, files).IsValid);
        ArticlePackageManifestCandidateResult result = ArticlePackageImportCandidateBytes.Validate(inventory, files, out var candidate);
        Assert.True(result.IsValid, result.ReasonCode);
        return new(inventory, files.ToArray(), Assert.IsType<ArticlePackageValidatedImportCandidate>(candidate));
    }

    private static ArticlePackageInventoryEntry Entry(string path, int length)
        => new(path, ArticlePackageEntryKind.RegularFile, length, length);

}
