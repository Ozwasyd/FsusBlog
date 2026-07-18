using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuditDetachedCheckpointTests
{
    private static readonly byte[] AuditHmacKey = Encoding.UTF8.GetBytes(
        "unit-test-audit-hmac-key-separated-from-checkpoint-ecdsa-domain");
    private static readonly DateTimeOffset FirstCheckpointAt = DateTimeOffset.Parse("2026-07-15T08:00:00Z");

    [Fact]
    public async Task CreateAndVerify_BindsSequenceRangeHeadMerkleAndExportedAnchor()
    {
        using var temp = new TempDirectory();
        List<AuditLog> logs = BuildChain(3);
        var source = new InMemoryAuditRecordSource(logs);
        var transport = new LocalFileAuditCheckpointTransport(temp.Path);
        AuditCheckpointKeyRecord key = Key("audit-checkpoint-2026-07", 1, FirstCheckpointAt.AddDays(-1));
        var service = CreateService(source, transport, Registry(key), FirstCheckpointAt);

        AuditDetachedCheckpointEnvelope checkpoint = Assert.IsType<AuditDetachedCheckpointEnvelope>(
            await service.CreateNextAsync(100));
        var verifier = new AuditDetachedCheckpointVerifier(source, transport, PublicRegistry(key));
        AuditDetachedCheckpointVerificationResult verified = await verifier.VerifyAsync();
        AuditDetachedCheckpointTrustAnchor anchor = AuditDetachedCheckpointTrustAnchor.FromEnvelope(checkpoint);
        byte[] exportedAnchor = AuditDetachedCheckpointPackageCodec.SerializeTrustAnchor(anchor);

        Assert.True(verified.Accepted);
        Assert.Equal("accepted", verified.Code);
        Assert.Equal(1, checkpoint.Manifest.Sequence);
        Assert.Null(checkpoint.Manifest.PreviousCheckpointDigest);
        Assert.Equal(1, checkpoint.Manifest.FromRecordId);
        Assert.Equal(3, checkpoint.Manifest.ToRecordId);
        Assert.Equal(3, checkpoint.Manifest.RecordCount);
        Assert.Equal(logs[^1].RecordHash, checkpoint.Manifest.AuditHeadHash);
        Assert.Equal(checkpoint.CheckpointDigest, verified.VerifiedHead?.CheckpointDigest);
        Assert.Equal(anchor, AuditDetachedCheckpointPackageCodec.DeserializeTrustAnchor(exportedAnchor));
        Assert.Single(Directory.GetFiles(temp.Path, "checkpoint-*.json"));
    }

    [Fact]
    public async Task Verify_DetectsRecordModificationAndFullHmacHolderRewrite()
    {
        using var temp = new TempDirectory();
        List<AuditLog> logs = BuildChain(4);
        var source = new InMemoryAuditRecordSource(logs);
        var transport = new LocalFileAuditCheckpointTransport(temp.Path);
        AuditCheckpointKeyRecord key = Key("audit-checkpoint-primary", 1, FirstCheckpointAt.AddDays(-1));
        await CreateService(source, transport, Registry(key), FirstCheckpointAt).CreateNextAsync(100);
        var verifier = new AuditDetachedCheckpointVerifier(source, transport, PublicRegistry(key));

        logs[1].EventInfo = "database-record-modified";
        AuditDetachedCheckpointVerificationResult directMutation = await verifier.VerifyAsync();
        ResignEntireAuditChain(logs);
        AuditDetachedCheckpointVerificationResult hmacHolderRewrite = await verifier.VerifyAsync();

        Assert.False(directMutation.Accepted);
        Assert.Equal("audit-record-hash-mismatch", directMutation.Code);
        Assert.False(hmacHolderRewrite.Accepted);
        Assert.Equal("audit-record-merkle-root-mismatch", hmacHolderRewrite.Code);
    }

    [Fact]
    public async Task Verify_DetectsDeletedAndReorderedRecords()
    {
        using var temp = new TempDirectory();
        List<AuditLog> logs = BuildChain(4);
        var source = new InMemoryAuditRecordSource(logs);
        var transport = new LocalFileAuditCheckpointTransport(temp.Path);
        AuditCheckpointKeyRecord key = Key("audit-checkpoint-primary", 1, FirstCheckpointAt.AddDays(-1));
        await CreateService(source, transport, Registry(key), FirstCheckpointAt).CreateNextAsync(100);
        var verifier = new AuditDetachedCheckpointVerifier(source, transport, PublicRegistry(key));

        AuditLog deleted = logs[1];
        logs.RemoveAt(1);
        AuditDetachedCheckpointVerificationResult deletion = await verifier.VerifyAsync();
        logs.Insert(1, deleted);
        source.ReverseRange = true;
        AuditDetachedCheckpointVerificationResult reordering = await verifier.VerifyAsync();

        Assert.Equal("audit-record-range-mismatch", deletion.Code);
        Assert.Equal("audit-record-order-invalid", reordering.Code);
    }

    [Fact]
    public async Task Verify_DetectsMissingCheckpointTamperedFileAndWrongPublicKey()
    {
        using var temp = new TempDirectory();
        List<AuditLog> logs = BuildChain(4);
        var source = new InMemoryAuditRecordSource(logs);
        var transport = new LocalFileAuditCheckpointTransport(temp.Path);
        AuditCheckpointKeyRecord key = Key("audit-checkpoint-primary", 1, FirstCheckpointAt.AddDays(-1));
        AuditDetachedCheckpointService service = CreateService(source, transport, Registry(key), FirstCheckpointAt);
        await service.CreateNextAsync(2);
        await service.CreateNextAsync(2);
        string[] checkpointFiles = Directory.GetFiles(temp.Path, "checkpoint-*.json").Order(StringComparer.Ordinal).ToArray();
        byte[] firstOriginal = await File.ReadAllBytesAsync(checkpointFiles[0]);

        File.Delete(checkpointFiles[0]);
        var verifier = new AuditDetachedCheckpointVerifier(source, transport, PublicRegistry(key));
        Assert.Equal("checkpoint-sequence-gap", (await verifier.VerifyAsync()).Code);

        await File.WriteAllBytesAsync(checkpointFiles[0], firstOriginal);
        AuditDetachedCheckpointEnvelope parsed = AuditDetachedCheckpointPackageCodec.Deserialize(firstOriginal);
        string signature = parsed.Signature.SignatureBase64Url;
        string changedSignature = string.Concat(signature[..^1], signature[^1] == 'A' ? 'B' : 'A');
        await File.WriteAllBytesAsync(
            checkpointFiles[0],
            AuditDetachedCheckpointPackageCodec.Serialize(parsed with
            {
                Signature = parsed.Signature with
                {
                    SignatureBase64Url = changedSignature
                }
            }));
        Assert.Equal("checkpoint-file-invalid", (await verifier.VerifyAsync()).Code);

        await File.WriteAllBytesAsync(checkpointFiles[0], firstOriginal);
        AuditCheckpointKeyRecord unrelated = Key(key.KeyId, key.Version, FirstCheckpointAt.AddDays(-1));
        var wrongKeyVerifier = new AuditDetachedCheckpointVerifier(source, transport, PublicRegistry(unrelated));
        Assert.Equal("checkpoint-signature-payload-signature-invalid", (await wrongKeyVerifier.VerifyAsync()).Code);

        byte[] withUnknownField = Encoding.UTF8.GetBytes(
            Encoding.UTF8.GetString(firstOriginal).Replace("{", "{\"unknown\":true,", StringComparison.Ordinal));
        Assert.Throws<JsonException>(() => AuditDetachedCheckpointPackageCodec.Deserialize(withUnknownField));
    }

    [Fact]
    public async Task Verify_ExpectedDetachedHeadDetectsTailRollback()
    {
        using var temp = new TempDirectory();
        List<AuditLog> logs = BuildChain(4);
        var source = new InMemoryAuditRecordSource(logs);
        var transport = new LocalFileAuditCheckpointTransport(temp.Path);
        AuditCheckpointKeyRecord key = Key("audit-checkpoint-primary", 1, FirstCheckpointAt.AddDays(-1));
        AuditDetachedCheckpointService service = CreateService(source, transport, Registry(key), FirstCheckpointAt);
        await service.CreateNextAsync(2);
        AuditDetachedCheckpointEnvelope second = Assert.IsType<AuditDetachedCheckpointEnvelope>(await service.CreateNextAsync(2));
        AuditDetachedCheckpointTrustAnchor expected = AuditDetachedCheckpointTrustAnchor.FromEnvelope(second);
        string latest = Directory.GetFiles(temp.Path, "checkpoint-*.json").Order(StringComparer.Ordinal).Last();
        File.Delete(latest);

        var verifier = new AuditDetachedCheckpointVerifier(source, transport, PublicRegistry(key));
        AuditDetachedCheckpointVerificationResult result = await verifier.VerifyAsync(expected);

        Assert.False(result.Accepted);
        Assert.Equal("checkpoint-rollback-detected", result.Code);
    }

    [Fact]
    public async Task Export_CreateNewSequenceAllowsOnlyOneConcurrentWriter()
    {
        using var temp = new TempDirectory();
        var transport = new LocalFileAuditCheckpointTransport(temp.Path);
        AuditCheckpointKeyRecord key = Key("audit-checkpoint-primary", 1, FirstCheckpointAt.AddDays(-1));
        AuditCheckpointRecordSet records = AuditCheckpointRecordSetBuilder.Build(BuildChain(2));
        AuditDetachedCheckpointEnvelope envelope = new AuditCheckpointSigningService(Registry(key)).Sign(
            Manifest(1, null, records, FirstCheckpointAt));

        Task<Exception?> first = CaptureAsync(() => transport.ExportAsync(envelope));
        Task<Exception?> second = CaptureAsync(() => transport.ExportAsync(envelope));
        Exception?[] outcomes = await Task.WhenAll(first, second);

        Assert.Single(outcomes, static outcome => outcome is null);
        Assert.Single(outcomes, static outcome => outcome is AuditCheckpointAppendConflictException);
        Assert.Single(Directory.GetFiles(temp.Path, "checkpoint-*.json"));
        Assert.Empty(Directory.GetFiles(temp.Path, "*.lock"));
        Assert.Empty(Directory.GetFiles(temp.Path, "*.tmp"));
    }

    [Fact]
    public async Task Rotation_NewCheckpointUsesNewKeyAndIndependentPublicRegistryVerifiesHistory()
    {
        using var temp = new TempDirectory();
        List<AuditLog> logs = BuildChain(4);
        var source = new InMemoryAuditRecordSource(logs);
        var transport = new LocalFileAuditCheckpointTransport(temp.Path);
        AuditCheckpointKeyRecord oldKey = Key("audit-checkpoint-2026-06", 1, FirstCheckpointAt.AddDays(-10));
        AuditCheckpointKeyRecord newKey = Key("audit-checkpoint-2026-07", 2, FirstCheckpointAt.AddMinutes(1));
        AuditDetachedCheckpointEnvelope first = Assert.IsType<AuditDetachedCheckpointEnvelope>(
            await CreateService(source, transport, Registry(oldKey), FirstCheckpointAt).CreateNextAsync(2));
        AuditCheckpointKeyRegistry rotated = AuditCheckpointKeyRegistry.Create(
            [oldKey.WithoutPrivateKey(), newKey],
            newKey.KeyId);
        AuditDetachedCheckpointEnvelope second = Assert.IsType<AuditDetachedCheckpointEnvelope>(
            await CreateService(source, transport, rotated, FirstCheckpointAt.AddHours(1)).CreateNextAsync(2));
        AuditCheckpointKeyRegistry publicOnly = AuditCheckpointKeyRegistry.Create(
            [oldKey.WithoutPrivateKey(), newKey.WithoutPrivateKey()],
            newKey.KeyId);

        AuditDetachedCheckpointVerificationResult verified = await new AuditDetachedCheckpointVerifier(
            source,
            transport,
            publicOnly).VerifyAsync(AuditDetachedCheckpointTrustAnchor.FromEnvelope(second));

        Assert.Equal(oldKey.KeyId, first.Signature.KeyId);
        Assert.Equal(newKey.KeyId, second.Signature.KeyId);
        Assert.Equal(first.CheckpointDigest, second.Manifest.PreviousCheckpointDigest);
        Assert.True(verified.Accepted);
        Assert.All(publicOnly.PublicKeys, static key => Assert.Null(key.PrivateKeyPkcs8Base64Url));
    }

    [Fact]
    public async Task RuntimeConfiguration_LoadsDistinctDerKeyDomainAndRejectsBroadPrivatePermissions()
    {
        using var temp = new TempDirectory();
        string publicPath = System.IO.Path.Combine(temp.Path, "checkpoint-public.der");
        string privatePath = System.IO.Path.Combine(temp.Path, "checkpoint-private.der");
        using (ECDsa ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            await File.WriteAllBytesAsync(publicPath, ecdsa.ExportSubjectPublicKeyInfo());
            await File.WriteAllBytesAsync(privatePath, ecdsa.ExportPkcs8PrivateKey());
        }
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(privatePath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }

        var options = new AuditDetachedCheckpointRuntimeOptions
        {
            Enabled = true,
            CurrentKeyId = "checkpoint-runtime-key",
            Keys =
            [
                new AuditDetachedCheckpointRuntimeKeyOptions
                {
                    KeyId = "checkpoint-runtime-key",
                    Version = 1,
                    PublicKeyPath = publicPath,
                    PrivateKeyPath = privatePath,
                    NotBeforeUtc = FirstCheckpointAt.AddDays(-1)
                }
            ]
        };

        AuditCheckpointKeyRegistry registry = AuditDetachedCheckpointRuntimeConfiguration.LoadKeyRegistry(options);
        Assert.True(registry.TryGetCurrent(out AuditCheckpointKeyRecord? current));
        Assert.NotNull(current.PrivateKeyPkcs8Base64Url);
        Assert.All(registry.PublicKeys, static key => Assert.Null(key.PrivateKeyPkcs8Base64Url));

        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(privatePath, UnixFileMode.UserRead | UnixFileMode.GroupRead);
            InvalidOperationException error = Assert.Throws<InvalidOperationException>(
                () => AuditDetachedCheckpointRuntimeConfiguration.LoadKeyRegistry(options));
            Assert.Equal("audit_checkpoint_private_key_permissions_invalid", error.Message);
        }
    }

    [Fact]
    public void SigningTrustDomain_IsAsymmetricAndSeparatedFromAuditHmacAndRequestPlanes()
    {
        string signingShape = RuntimeMetadataInspection.DescribeType(typeof(AuditCheckpointSigningService));
        string verifierShape = RuntimeMetadataInspection.DescribeType(typeof(AuditDetachedCheckpointVerifier));

        Assert.Equal("ECDSA_P256_SHA256", AuditDetachedCheckpointConstants.Algorithm);
        Assert.Equal("fsusblog.audit.detached-checkpoint.v1", AuditDetachedCheckpointConstants.TrustDomain);
        Assert.DoesNotContain("HMAC", signingShape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("TamperEvidenceKey", signingShape, StringComparison.Ordinal);
        foreach (string forbidden in new[] { "HttpContext", "Authorization", "NotificationStream", "Aeds", "BinaryEndpoints" })
        {
            Assert.DoesNotContain(forbidden, verifierShape, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static AuditDetachedCheckpointService CreateService(
        IAuditCheckpointRecordSource source,
        LocalFileAuditCheckpointTransport transport,
        AuditCheckpointKeyRegistry registry,
        DateTimeOffset now)
        => new(source, transport, transport, new AuditCheckpointSigningService(registry), new FixedTimeProvider(now));

    private static AuditDetachedCheckpointManifest Manifest(
        long sequence,
        string? previousDigest,
        AuditCheckpointRecordSet records,
        DateTimeOffset createdAt)
        => new(
            AuditDetachedCheckpointConstants.ManifestVersion,
            AuditDetachedCheckpointConstants.TrustDomain,
            sequence,
            previousDigest,
            records.FromRecordId,
            records.ToRecordId,
            records.RecordCount,
            records.MerkleRootHash,
            records.AuditHeadHash,
            createdAt);

    private static AuditCheckpointKeyRecord Key(string id, int version, DateTimeOffset notBefore)
        => AuditCheckpointKeyRecord.CreateEcdsaP256(id, version, notBefore);

    private static AuditCheckpointKeyRegistry Registry(params AuditCheckpointKeyRecord[] keys)
        => AuditCheckpointKeyRegistry.Create(keys, keys[^1].KeyId);

    private static AuditCheckpointKeyRegistry PublicRegistry(params AuditCheckpointKeyRecord[] keys)
        => AuditCheckpointKeyRegistry.Create(keys.Select(static key => key.WithoutPrivateKey()), keys[^1].KeyId);

    private static List<AuditLog> BuildChain(int count)
    {
        var logs = new List<AuditLog>(count);
        string? previous = null;
        for (int index = 1; index <= count; index++)
        {
            var record = new AuditRecord(
                AuditSourceCatalog.Security,
                AuditTypeCatalog.Audit,
                new DateTime(2026, 7, 15, 7, index, 0, DateTimeKind.Utc),
                $"audit-event-{index}",
                ContextPayload: [1, 2, (byte)index],
                Action: "security.audit.test",
                Outcome: AuditOutcomeCatalog.Success,
                Severity: AuditSeverityCatalog.Warning,
                ActorType: AuditActorTypeCatalog.Admin,
                ActorId: "7",
                TargetType: "audit-record",
                TargetId: index.ToString(),
                IsHighValue: true,
                ContextJson: $"{{\"index\":{index}}}",
                ChainId: "20260715",
                PrevHash: previous);
            AuditTamperEvidenceResult evidence = AuditTamperEvidence.Sign(record, AuditHmacKey);
            logs.Add(ToLog(index, record, evidence));
            previous = evidence.RecordHash;
        }

        return logs;
    }

    private static void ResignEntireAuditChain(IReadOnlyList<AuditLog> logs)
    {
        string? previous = null;
        foreach (AuditLog log in logs.OrderBy(static log => log.Id))
        {
            AuditRecord record = AuditTamperEvidence.FromLog(log) with
            {
                PrevHash = previous,
                RecordHash = null,
                RecordMac = null
            };
            AuditTamperEvidenceResult evidence = AuditTamperEvidence.Sign(record, AuditHmacKey);
            log.PrevHash = previous;
            log.RecordHash = evidence.RecordHash;
            log.RecordMac = evidence.RecordMac;
            previous = evidence.RecordHash;
        }
    }

    private static AuditLog ToLog(long id, AuditRecord record, AuditTamperEvidenceResult evidence)
        => new()
        {
            Id = id,
            Source = record.Source,
            Type = record.Type,
            OccurredAtUtc = record.OccurredAtUtc,
            EventInfo = record.EventInfo,
            ContextPayload = record.ContextPayload,
            Action = record.Action,
            Outcome = record.Outcome,
            Severity = record.Severity,
            ActorType = record.ActorType,
            ActorId = record.ActorId,
            TargetType = record.TargetType,
            TargetId = record.TargetId,
            IsHighValue = record.IsHighValue,
            ContextJson = record.ContextJson,
            ChainId = evidence.ChainId,
            PrevHash = record.PrevHash,
            RecordHash = evidence.RecordHash,
            RecordMac = evidence.RecordMac
        };

    private static async Task<Exception?> CaptureAsync(Func<Task> action)
    {
        try
        {
            await action();
            return null;
        }
        catch (Exception ex)
        {
            return ex;
        }
    }

    private sealed class InMemoryAuditRecordSource(List<AuditLog> records) : IAuditCheckpointRecordSource
    {
        public bool ReverseRange
        {
            get; set;
        }

        public Task<IReadOnlyList<AuditLog>> ReadAfterAsync(
            long afterRecordId,
            int limit,
            CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<AuditLog>>(records
                .Where(record => record.Id > afterRecordId)
                .OrderBy(static record => record.Id)
                .Take(limit)
                .ToArray());

        public Task<IReadOnlyList<AuditLog>> ReadRangeAsync(
            long fromRecordId,
            long toRecordId,
            CancellationToken cancellationToken = default)
        {
            IEnumerable<AuditLog> range = records.Where(record => record.Id >= fromRecordId && record.Id <= toRecordId);
            range = ReverseRange
                ? range.OrderByDescending(static record => record.Id)
                : range.OrderBy(static record => record.Id);
            return Task.FromResult<IReadOnlyList<AuditLog>>(range.ToArray());
        }
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class TempDirectory : IDisposable
    {
        public TempDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"fsusblog-audit-checkpoint-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path
        {
            get;
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(Path, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
