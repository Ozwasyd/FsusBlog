using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuditPipelineHotPathContractTests
{
    private const string ValidTamperKey = "unit-test-audit-tamper-evidence-key-with-enough-entropy";

    [Fact]
    public void AuditEventService_SourceDoesNotSerializeContextJsonOnRequestPath()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Audit/AuditEventService.cs");
        string buildRecord = ExtractMethodBlock(source, "private AuditRecord BuildRecord");

        Assert.DoesNotContain("JsonSerializer.Serialize(contextPayload", buildRecord, StringComparison.Ordinal);
        Assert.DoesNotContain("ContextJson: contextJson", buildRecord, StringComparison.Ordinal);
        Assert.Contains("PublicAotBinaryPayload.EncodeObjectFrame", buildRecord, StringComparison.Ordinal);
    }

    [Fact]
    public void AuditTamperEvidence_SourceWritesCanonicalJsonDirectlyToUtf8Buffer()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Audit/AuditTamperEvidence.cs");

        Assert.Contains("ArrayBufferWriter<byte>", source, StringComparison.Ordinal);
        Assert.Contains("Utf8JsonWriter", source, StringComparison.Ordinal);
        Assert.DoesNotContain("JsonSerializer.Serialize(new", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Encoding.UTF8.GetBytes(BuildCanonical", source, StringComparison.Ordinal);
        Assert.Contains("Convert.ToHexStringLower", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AuditTamperEvidence_SourceComparesTamperHashesWithFixedTimeHex()
    {
        string evidenceSource = ReadRepoFile("src/backend/Infrastructure/Audit/AuditTamperEvidence.cs");
        string querySource = ReadRepoFile("src/backend/Infrastructure/Audit/AuditQueryService.cs");
        string verifyMethod = ExtractMethodBlock(evidenceSource, "public static bool Verify");
        string verifyWithChainMethod = ExtractMethodBlock(querySource, "private async Task<bool> VerifyWithChainAsync");

        Assert.Contains("CryptographicOperations.FixedTimeEquals", evidenceSource, StringComparison.Ordinal);
        Assert.Contains("FixedTimeEqualsHexSha256(log.RecordHash, evidence.RecordHash)", verifyMethod, StringComparison.Ordinal);
        Assert.Contains("FixedTimeEqualsHexSha256(log.RecordMac, evidence.RecordMac)", verifyMethod, StringComparison.Ordinal);
        Assert.Contains("AuditTamperEvidence.FixedTimeEqualsHexSha256(row.PrevHash, expectedPrevHash)", verifyWithChainMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("string.Equals(log.RecordHash", verifyMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("string.Equals(log.RecordMac", verifyMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("string.Equals(row.PrevHash", verifyWithChainMethod, StringComparison.Ordinal);
    }

    [Fact]
    public void AuditLogWriterWorker_SourceDoesNotCreateLinkedCtsPerFlushCycle()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Audit/AuditLogWriterWorker.cs");

        Assert.DoesNotContain("CreateLinkedTokenSource", source, StringComparison.Ordinal);
        Assert.Contains("Task.Delay", source, StringComparison.Ordinal);
        Assert.Contains("WaitToReadAsync(stoppingToken)", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AuditLogStore_SourceCachesBatchSqlSkeletonAndFillsParameterArray()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Audit/AuditLogStore.cs");
        string writeBatch = ExtractMethodBlock(source, "public async Task WriteBatchAsync");

        Assert.Contains("AuditLogInsertBatchShape", source, StringComparison.Ordinal);
        Assert.Contains("ConcurrentDictionary<int, AuditLogInsertBatchShape>", source, StringComparison.Ordinal);
        Assert.Contains("new SugarParameter[", writeBatch, StringComparison.Ordinal);
        Assert.DoesNotContain("new StringBuilder(\"\"\"", writeBatch, StringComparison.Ordinal);
        Assert.DoesNotContain("parameters.ToArray()", writeBatch, StringComparison.Ordinal);
    }

    [Fact]
    public void AuditTamperEvidence_SignatureMatchesCanonicalGolden()
    {
        var occurredAt = new DateTime(2026, 6, 14, 12, 0, 0, DateTimeKind.Utc);
        var record = new AuditRecord(
            AuditSourceCatalog.Auth,
            AuditTypeCatalog.Security,
            occurredAt,
            "event",
            null,
            Action: "auth.test",
            Outcome: AuditOutcomeCatalog.Success,
            Severity: AuditSeverityCatalog.Info,
            ActorType: AuditActorTypeCatalog.Admin,
            ActorId: "7",
            ActorRole: "admin",
            TargetType: "session",
            TargetId: "42",
            IsHighValue: true,
            TraceId: "trace",
            RequestPath: "/login",
            RequestMethod: "POST",
            IpHash: "ip",
            UserAgentHash: "ua",
            SessionIdHash: "sid",
            DeviceFingerprintHash: "fp",
            ReasonCode: "risk",
            ContextJson: "{\"ok\":true}",
            ChainId: "20260614",
            PrevHash: "prev");
        byte[] key = Encoding.UTF8.GetBytes(ValidTamperKey);
        const string canonical = "{\"Source\":\"auth\",\"Type\":\"security\",\"OccurredAtUtc\":\"2026-06-14T12:00:00.0000000Z\",\"Action\":\"auth.test\",\"Outcome\":\"success\",\"Severity\":\"info\",\"ActorType\":\"admin\",\"ActorId\":\"7\",\"ActorRole\":\"admin\",\"TargetType\":\"session\",\"TargetId\":\"42\",\"IsHighValue\":true,\"TraceId\":\"trace\",\"RequestPath\":\"/login\",\"RequestMethod\":\"POST\",\"IpHash\":\"ip\",\"UserAgentHash\":\"ua\",\"SessionIdHash\":\"sid\",\"DeviceFingerprintHash\":\"fp\",\"ReasonCode\":\"risk\",\"EventInfo\":\"event\",\"ContextJson\":\"{\\u0022ok\\u0022:true}\",\"ChainId\":\"20260614\",\"PrevHash\":\"prev\"}";

        AuditTamperEvidenceResult result = AuditTamperEvidence.Sign(record, key);

        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))), result.RecordHash);
        Assert.Equal(Convert.ToHexStringLower(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(canonical))), result.RecordMac);
    }

    [Fact]
    public void AuditTamperEvidence_VerifyUsesFixedLengthHexComparison()
    {
        byte[] key = Encoding.UTF8.GetBytes(ValidTamperKey);
        AuditRecord record = BuildTamperRecord();
        AuditTamperEvidenceResult result = AuditTamperEvidence.Sign(record, key);
        AuditLog validLog = ToAuditLog(record, result);

        Assert.True(AuditTamperEvidence.Verify(validLog, key));
        Assert.True(AuditTamperEvidence.FixedTimeEqualsHexSha256(result.RecordHash, result.RecordHash.ToUpperInvariant()));
        Assert.False(AuditTamperEvidence.FixedTimeEqualsHexSha256(result.RecordHash, result.RecordHash[..^2]));
        Assert.False(AuditTamperEvidence.Verify(ToAuditLog(record, result, recordHash: result.RecordHash[..^2]), key));
        Assert.False(AuditTamperEvidence.Verify(ToAuditLog(record, result, recordMac: result.RecordMac![..^2]), key));
    }

    [Fact]
    public void AuditTamperEvidence_VerifyFailsClosedWhenKeyOrRecordMacMissing()
    {
        byte[] key = Encoding.UTF8.GetBytes(ValidTamperKey);
        AuditRecord record = BuildTamperRecord();
        AuditTamperEvidenceResult result = AuditTamperEvidence.Sign(record, key);
        AuditLog validLog = ToAuditLog(record, result);
        AuditLog missingMacLog = ToAuditLog(record, result);
        missingMacLog.RecordMac = null;

        Assert.False(AuditTamperEvidence.Verify(validLog, null));
        Assert.False(AuditTamperEvidence.Verify(missingMacLog, key));
    }

    [Fact]
    public void AuditTamperEvidence_ResolveKeyRejectsWeakOrLegacyConfiguration()
    {
        IConfiguration shortKeyConfiguration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Audit:TamperEvidenceKey"] = "short-key"
            })
            .Build();
        IConfiguration legacyKeyConfiguration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Security:AuditTamperEvidenceKey"] = ValidTamperKey
            })
            .Build();

        void ResolveShortKey() => AuditTamperEvidence.ResolveKey(shortKeyConfiguration);

        Assert.Throws<InvalidOperationException>(ResolveShortKey);
        Assert.Null(AuditTamperEvidence.ResolveKey(legacyKeyConfiguration));
    }

    [Fact]
    public void AuditTamperEvidence_FallbackChainIdIsInvariantAcrossCultures()
    {
        string[] chainIds = [];
        foreach (string cultureName in new[] { "en-US", "fa-IR", "ar-SA", "th-TH" })
        {
            chainIds = [.. chainIds, RunWithCulture(cultureName, () => AuditTamperEvidence.Sign(BuildTamperRecord(), null).ChainId)];
        }

        Assert.All(chainIds, chainId => Assert.Equal("20260614", chainId));
    }

    [Fact]
    public void AuditTamperEvidence_CrossNodeFallbackChainHeadIsConsistent()
    {
        byte[] key = Encoding.UTF8.GetBytes(ValidTamperKey);
        AuditTamperEvidenceResult enUs = RunWithCulture("en-US", () => AuditTamperEvidence.Sign(BuildTamperRecord(), key));
        AuditTamperEvidenceResult faIr = RunWithCulture("fa-IR", () => AuditTamperEvidence.Sign(BuildTamperRecord(), key));

        Assert.Equal(enUs.ChainId, faIr.ChainId);
        Assert.Equal(enUs.RecordHash, faIr.RecordHash);
        Assert.Equal(enUs.RecordMac, faIr.RecordMac);
    }

    [Fact]
    public void AuditContextJsonSerializer_DecodesBinaryPayloadWithoutReflectionJson()
    {
        byte[] payload = PublicAotBinaryPayload.EncodeObjectFrame(new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["trace"] = "trace-1",
            ["count"] = 2,
            ["ok"] = true,
            ["nested"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["value"] = "x"
            }
        });

        string? json = AuditContextJsonSerializer.Serialize(payload);

        Assert.Equal("{\"trace\":\"trace-1\",\"count\":2,\"ok\":true,\"nested\":{\"value\":\"x\"}}", json);
    }

    private static AuditRecord BuildTamperRecord()
        => new(
            AuditSourceCatalog.Auth,
            AuditTypeCatalog.Security,
            new DateTime(2026, 6, 14, 12, 0, 0, DateTimeKind.Utc),
            "event",
            null,
            Action: "auth.test",
            Outcome: AuditOutcomeCatalog.Success,
            Severity: AuditSeverityCatalog.Info,
            PrevHash: "prev");

    private static AuditLog ToAuditLog(
        AuditRecord record,
        AuditTamperEvidenceResult evidence,
        string? recordHash = null,
        string? recordMac = null)
        => new()
        {
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
            ActorRole = record.ActorRole,
            TargetType = record.TargetType,
            TargetId = record.TargetId,
            IsHighValue = record.IsHighValue,
            TraceId = record.TraceId,
            RequestPath = record.RequestPath,
            RequestMethod = record.RequestMethod,
            IpHash = record.IpHash,
            UserAgentHash = record.UserAgentHash,
            SessionIdHash = record.SessionIdHash,
            DeviceFingerprintHash = record.DeviceFingerprintHash,
            ReasonCode = record.ReasonCode,
            ContextJson = record.ContextJson,
            ChainId = evidence.ChainId,
            PrevHash = record.PrevHash,
            RecordHash = recordHash ?? evidence.RecordHash,
            RecordMac = recordMac ?? evidence.RecordMac
        };

    private static T RunWithCulture<T>(string cultureName, Func<T> action)
    {
        CultureInfo previousCulture = CultureInfo.CurrentCulture;
        CultureInfo previousUiCulture = CultureInfo.CurrentUICulture;
        CultureInfo culture = CultureInfo.GetCultureInfo(cultureName);
        CultureInfo.CurrentCulture = culture;
        CultureInfo.CurrentUICulture = culture;
        try
        {
            return action();
        }
        finally
        {
            CultureInfo.CurrentCulture = previousCulture;
            CultureInfo.CurrentUICulture = previousUiCulture;
        }
    }

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static string ExtractMethodBlock(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing method signature: {signature}");

        int braceStart = source.IndexOf('{', start);
        Assert.True(braceStart >= 0, $"Missing method body: {signature}");

        int depth = 0;
        for (int i = braceStart; i < source.Length; i++)
        {
            if (source[i] == '{')
            {
                depth++;
            }
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return source[start..(i + 1)];
                }
            }
        }

        throw new InvalidOperationException($"Unable to extract method body: {signature}");
    }
}
