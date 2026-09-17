using System.Reflection;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Services.Background;

using Microsoft.Extensions.Configuration;
namespace FsusBlog.Server.Tests.Unit;

public sealed class AuditRetentionPolicyTests
{
    private static readonly DateTimeOffset s_now = DateTimeOffset.Parse("2026-07-16T08:00:00Z");
    private static readonly byte[] s_auditHmacKey = Encoding.UTF8.GetBytes(
        "audit-retention-test-hmac-key-with-independent-domain");

    [Fact]
    public void Catalog_CoversDeclaredActionsAndUnknownActionFailsClosed()
    {
        Assert.Empty(AuditRetentionCatalog.ValidateCatalogCoverage());
        Assert.All(AuditRetentionCatalog.All, static policy =>
        {
            Assert.True(policy.MaxFullRecordAge > TimeSpan.Zero);
            Assert.True(policy.MaxPseudonymAge > TimeSpan.Zero);
            Assert.True(policy.AggregateAfter > TimeSpan.Zero);
            Assert.True(policy.MaxPseudonymAge <= policy.MaxFullRecordAge);
            Assert.True(policy.AggregateAfter <= policy.MaxFullRecordAge);
            Assert.True(policy.AnchorForever);
            Assert.False(string.IsNullOrWhiteSpace(policy.CryptographicEraseKeyDomain));
        });
        Assert.Throws<InvalidOperationException>(() => AuditRetentionCatalog.GetRequired("new.unregistered.action"));

        AuditRetentionPolicy issuance = AuditRetentionCatalog.GetRequired(AuditActionCatalog.AnonymousCredentialIssued);
        Assert.True(issuance.MaxFullRecordAge <= TimeSpan.FromDays(30));
        Assert.True(issuance.MaxPseudonymAge <= TimeSpan.FromDays(30));
        Assert.False(issuance.LegalHoldAllowed);
        Assert.Equal(
            AuditActionCatalog.MfaChallengeFailed,
            AuditRetentionCatalog.GetRequired(AuditActionCatalog.MfaChallengeFailed).Action);
        Assert.Equal(
            AuditActionCatalog.MfaChallengeLocked,
            AuditRetentionCatalog.GetRequired(AuditActionCatalog.MfaChallengeLocked).Action);
        Assert.Equal(
            AuditActionCatalog.ModerationDictionaryLoaded,
            AuditRetentionCatalog.GetRequired(AuditActionCatalog.ModerationDictionaryLoaded).Action);
        Assert.Equal(
            AuditActionCatalog.ModerationRegionPolicyLoaded,
            AuditRetentionCatalog.GetRequired(AuditActionCatalog.ModerationRegionPolicyLoaded).Action);
        Assert.Equal(
            AuditActionCatalog.PublicAotCache,
            AuditRetentionCatalog.GetRequired(AuditActionCatalog.PublicAotCache).Action);

        foreach (string runtimeAction in new[]
        {
            "dictionary_checksum_changed",
            "dictionary_reload_failed",
            "dictionary_rollback",
            "region_policy_reload_failed",
            "model_moderation_auto_disposition",
            "model_moderation_contract_invalid",
            "model_moderation_error",
            "model_moderation_scored",
            "model_moderation_timeout",
            "model_moderation_unavailable"
        })
        {
            Assert.Equal(runtimeAction, AuditRetentionCatalog.GetRequired(runtimeAction).Action);
        }
    }

    [Fact]
    public void CleanupSql_DoesNotPermanentlyExcludeHighValueOrCriticalRows()
    {
        string sql = Assert.IsType<string>(typeof(LogCleanupService)
            .GetField("CleanupAuditLogsSql", BindingFlags.NonPublic | BindingFlags.Static)!
            .GetRawConstantValue());

        Assert.DoesNotContain("is_high_value", sql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("severity", sql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("action = @Action", sql, StringComparison.Ordinal);
    }

    [Fact]
    public async Task EnvelopeEncryption_KeyDestructionMakesOldCiphertextAndBackupUndecryptable()
    {
        var keyStore = new MemoryEpochKeyStore();
        var protector = new AuditRetentionPayloadProtector(keyStore);
        AuditRecord source = SensitiveRecord(AuditActionCatalog.AnonymousCredentialIssued);
        AuditRecord protectedRecord = await protector.ProtectAsync(source, CancellationToken.None);
        AuditLog ciphertext = ToUnsignedLog(1, protectedRecord);
        Assert.True(AuditRetentionPayloadProtector.TryReadEnvelope(ciphertext, out AuditRetentionEnvelope envelope));

        AuditLog beforeDestruction = await protector.TryUnprotectAsync(Clone(ciphertext), CancellationToken.None);
        Assert.Equal(source.ActorId, beforeDestruction.ActorId);
        Assert.Equal(source.RequestPath, beforeDestruction.RequestPath);
        Assert.Equal(source.EventInfo, beforeDestruction.EventInfo);

        Assert.True(await keyStore.DestroyAsync(envelope.KeyDomain, envelope.EpochId, CancellationToken.None));
        AuditLog afterDestruction = await protector.TryUnprotectAsync(Clone(ciphertext), CancellationToken.None);
        Assert.Equal(AuditRetentionPayloadProtector.EncryptedEventInfo, afterDestruction.EventInfo);
        Assert.Null(afterDestruction.RequestPath);
        Assert.NotEqual(source.ActorId, afterDestruction.ActorId);
    }

    [Fact]
    public async Task RetentionErasure_AnchorsBeforeKeyDestructionAndEvidenceContainsNoIdentity()
    {
        using var temp = new TempDirectory();
        IConfiguration configuration = CreateCheckpointConfiguration(temp.Path, s_now);
        var keyStore = new MemoryEpochKeyStore();
        var protector = new AuditRetentionPayloadProtector(keyStore);
        AuditRecord protectedRecord = await protector.ProtectAsync(
            SensitiveRecord(AuditActionCatalog.AnonymousCredentialIssued),
            CancellationToken.None);
        AuditLog row = SignLog(1, protectedRecord);
        Assert.True(AuditRetentionPayloadProtector.TryReadEnvelope(row, out AuditRetentionEnvelope envelope));
        var service = new AuditRetentionErasureService(configuration, keyStore, new FixedTimeProvider(s_now));

        AuditRetentionErasureResult result = await service.AnchorAndDestroyKeysAsync([row], CancellationToken.None);

        Assert.False(await keyStore.ContainsAsync(envelope.KeyDomain, envelope.EpochId));
        AuditKeyDestructionEvidence evidence = Assert.Single(result.DestructionEvidence);
        AuditCheckpointKeyRegistry registry = AuditDetachedCheckpointRuntimeConfiguration.LoadKeyRegistry(
            configuration.GetSection(AuditDetachedCheckpointRuntimeOptions.SectionName)
                .Get<AuditDetachedCheckpointRuntimeOptions>()!);
        AuditCheckpointKeyRegistry publicRegistry = AuditCheckpointKeyRegistry.Create(
            registry.PublicKeys,
            registry.CurrentKeyId);
        Assert.True(AuditRetentionErasureService.VerifyEvidence(evidence, publicRegistry));
        Assert.Equal(1, result.Anchor.Manifest.RecordCount);

        string persistedEvidence = string.Join('\n', Directory
            .EnumerateFiles(temp.Path, "*.json", SearchOption.AllDirectories)
            .Select(File.ReadAllText));
        Assert.DoesNotContain("account-subject-42", persistedEvidence, StringComparison.Ordinal);
        Assert.DoesNotContain("/api/binary/auth/credential", persistedEvidence, StringComparison.Ordinal);
        Assert.DoesNotContain("device-fingerprint", persistedEvidence, StringComparison.Ordinal);
    }

    [Fact]
    public void LegalHold_DefaultsOffRequiresApprovalAndExpiryThenCleanupResumes()
    {
        var time = new MutableTimeProvider(s_now);
        var registry = new AuditLegalHoldRegistry(time);
        string action = AuditActionCatalog.SecurityPolicyActivated;

        Assert.False(registry.IsHeld(action, s_now));
        Assert.Throws<ArgumentException>(() => registry.Approve("hold-1", action, "", "approval-1", s_now.AddDays(1)));
        Assert.Throws<ArgumentOutOfRangeException>(() => registry.Approve(
            "hold-2", action, "incident response", "approval-2", s_now.AddDays(31)));
        Assert.Throws<InvalidOperationException>(() => registry.Approve(
            "hold-3", AuditActionCatalog.AnonymousCredentialIssued, "incident response", "approval-3", s_now.AddDays(1)));

        AuditLegalHold hold = registry.Approve(
            "hold-4", action, "incident response", "approval-ticket-4", s_now.AddDays(2));
        Assert.True(registry.IsHeld(action, s_now.AddDays(1)));
        Assert.False(registry.IsHeld(action, hold.ExpiresAtUtc));
    }

    [Fact]
    public async Task LocalFallback_StoresEncryptedEnvelopeInsteadOfRawIdentity()
    {
        using var temp = new TempDirectory();
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["FSUSBLOG_DATA_ROOT"] = temp.Path })
            .Build();
        var keyStore = new MemoryEpochKeyStore();
        var protector = new AuditRetentionPayloadProtector(keyStore);
        var writer = new AuditFallbackWriter(
            configuration,
            new AuditLogRuntimeState(new AuditLogChannel()),
            protector);

        await writer.WriteAsync(
            SensitiveRecord(AuditActionCatalog.PasskeyCounterRollback),
            new IOException("database unavailable"),
            CancellationToken.None);

        string json = File.ReadAllText(Assert.Single(Directory.GetFiles(temp.Path, "*.jsonl", SearchOption.AllDirectories)));
        Assert.Contains("RetentionEnvelopeBase64Url", json, StringComparison.Ordinal);
        Assert.DoesNotContain("account-subject-42", json, StringComparison.Ordinal);
        Assert.DoesNotContain("/api/binary/auth/credential", json, StringComparison.Ordinal);
        Assert.DoesNotContain("device-fingerprint", json, StringComparison.Ordinal);
    }

    [Fact]
    public void StorageAndInvestigationContracts_AreBoundedAndDoNotClaimExternalControl()
    {
        Assert.Equal(5, AuditRetentionStorageContract.All.Count);
        Assert.All(AuditRetentionStorageContract.All, static policy =>
            Assert.InRange(policy.MaximumCiphertextAge, TimeSpan.FromDays(1), TimeSpan.FromDays(90)));
        Assert.All(
            AuditRetentionStorageContract.All.Where(static policy => policy.Surface is "backup" or "wal" or "replica"),
            static policy =>
            {
                Assert.False(policy.ControlledByApplication);
                Assert.True(policy.RequiresOperatorAttestation);
            });
        Assert.False(AuditInvestigationAccessPolicy.IsValidPurpose(null));
        Assert.False(AuditInvestigationAccessPolicy.IsValidPurpose("test"));
        Assert.True(AuditInvestigationAccessPolicy.IsValidPurpose("credential abuse investigation"));
        Assert.Equal(200, AuditInvestigationAccessPolicy.EnforceRowLimit(10_000));
    }

    private static AuditRecord SensitiveRecord(string action)
        => new(
            AuditSourceCatalog.Security,
            AuditTypeCatalog.Security,
            s_now.UtcDateTime,
            "credential issued for account-subject-42",
            Encoding.UTF8.GetBytes("sensitive-context"),
            action,
            AuditOutcomeCatalog.Success,
            AuditSeverityCatalog.Critical,
            ActorType: AuditActorTypeCatalog.User,
            ActorId: "account-subject-42",
            ActorRole: "member",
            TargetType: "anonymous-credential",
            TargetId: "credential-42",
            IsHighValue: true,
            TraceId: "trace-42",
            RequestPath: "/api/binary/auth/credential",
            RequestMethod: "POST",
            IpHash: "ip-hash",
            UserAgentHash: "ua-hash",
            SessionIdHash: "session-hash",
            DeviceFingerprintHash: "device-fingerprint",
            ReasonCode: "issued",
            ContextJson: "{\"subject\":\"account-subject-42\"}");

    private static AuditLog SignLog(long id, AuditRecord record)
    {
        AuditRecord chained = record with
        {
            ChainId = "20260716",
            PrevHash = null
        };
        AuditTamperEvidenceResult evidence = AuditTamperEvidence.Sign(chained, s_auditHmacKey);
        AuditLog log = ToUnsignedLog(id, chained);
        log.ChainId = evidence.ChainId;
        log.RecordHash = evidence.RecordHash;
        log.RecordMac = evidence.RecordMac;
        return log;
    }

    private static AuditLog ToUnsignedLog(long id, AuditRecord record)
        => new()
        {
            Id = id,
            Source = record.Source,
            Type = record.Type,
            OccurredAtUtc = record.OccurredAtUtc,
            ActorType = record.ActorType,
            ActorId = record.ActorId,
            ActorRole = record.ActorRole,
            Action = record.Action,
            TargetType = record.TargetType,
            TargetId = record.TargetId,
            Outcome = record.Outcome,
            Severity = record.Severity,
            IsHighValue = record.IsHighValue,
            TraceId = record.TraceId,
            RequestPath = record.RequestPath,
            RequestMethod = record.RequestMethod,
            IpHash = record.IpHash,
            UserAgentHash = record.UserAgentHash,
            SessionIdHash = record.SessionIdHash,
            DeviceFingerprintHash = record.DeviceFingerprintHash,
            ReasonCode = record.ReasonCode,
            EventInfo = record.EventInfo,
            ContextPayload = record.ContextPayload,
            ContextJson = record.ContextJson,
            ChainId = record.ChainId,
            PrevHash = record.PrevHash,
            RecordHash = record.RecordHash,
            RecordMac = record.RecordMac
        };

    private static AuditLog Clone(AuditLog row)
        => ToUnsignedLog(row.Id, AuditTamperEvidence.FromLog(row));

    private static IConfiguration CreateCheckpointConfiguration(string root, DateTimeOffset now)
    {
        string publicPath = Path.Combine(root, "checkpoint-public.der");
        string privatePath = Path.Combine(root, "checkpoint-private.der");
        using ECDsa key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        File.WriteAllBytes(publicPath, key.ExportSubjectPublicKeyInfo());
        File.WriteAllBytes(privatePath, key.ExportPkcs8PrivateKey());
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(privatePath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }

        return new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["FSUSBLOG_DATA_ROOT"] = root,
            ["Audit:DetachedCheckpoint:Enabled"] = "true",
            ["Audit:DetachedCheckpoint:DirectoryName"] = "audit-checkpoints",
            ["Audit:DetachedCheckpoint:IntervalSeconds"] = "300",
            ["Audit:DetachedCheckpoint:MaxRecords"] = "100",
            ["Audit:DetachedCheckpoint:CurrentKeyId"] = "retention-test-key",
            ["Audit:DetachedCheckpoint:Keys:0:KeyId"] = "retention-test-key",
            ["Audit:DetachedCheckpoint:Keys:0:Version"] = "1",
            ["Audit:DetachedCheckpoint:Keys:0:PublicKeyPath"] = publicPath,
            ["Audit:DetachedCheckpoint:Keys:0:PrivateKeyPath"] = privatePath,
            ["Audit:DetachedCheckpoint:Keys:0:NotBeforeUtc"] = now.AddDays(-1).ToString("O")
        }).Build();
    }

    private sealed class MemoryEpochKeyStore : IAuditRetentionEpochKeyStore
    {
        private readonly Dictionary<string, byte[]> _keys = new(StringComparer.Ordinal);

        public ValueTask<byte[]> CreateAsync(string keyDomain, string epochId, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            byte[] key = RandomNumberGenerator.GetBytes(32);
            _keys.Add(Key(keyDomain, epochId), key);
            return ValueTask.FromResult(key.ToArray());
        }

        public ValueTask<byte[]?> TryReadAsync(string keyDomain, string epochId, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(_keys.TryGetValue(Key(keyDomain, epochId), out byte[]? key) ? key.ToArray() : null);
        }

        public ValueTask<bool> DestroyAsync(string keyDomain, string epochId, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string id = Key(keyDomain, epochId);
            if (!_keys.Remove(id, out byte[]? key))
            {
                return ValueTask.FromResult(false);
            }
            CryptographicOperations.ZeroMemory(key);
            return ValueTask.FromResult(true);
        }

        public ValueTask<bool> ContainsAsync(string keyDomain, string epochId)
            => ValueTask.FromResult(_keys.ContainsKey(Key(keyDomain, epochId)));

        private static string Key(string domain, string epoch) => string.Concat(domain, "\n", epoch);
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class TempDirectory : IDisposable
    {
        public TempDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"fsusblog-audit-retention-{Guid.NewGuid():N}");
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
