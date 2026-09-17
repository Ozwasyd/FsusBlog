using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.PublicAot;

using Microsoft.Extensions.Configuration;
namespace FsusBlog.Server.Tests.Unit;

public sealed class AuditTamperEvidenceBehaviorTests
{
    private const string ValidTamperKey = "unit-test-audit-tamper-evidence-key-with-enough-entropy";

    [Fact]
    public void Sign_MatchesCanonicalHashAndMacGolden()
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
        const string Canonical = "{\"Source\":\"auth\",\"Type\":\"security\",\"OccurredAtUtc\":\"2026-06-14T12:00:00.0000000Z\",\"Action\":\"auth.test\",\"Outcome\":\"success\",\"Severity\":\"info\",\"ActorType\":\"admin\",\"ActorId\":\"7\",\"ActorRole\":\"admin\",\"TargetType\":\"session\",\"TargetId\":\"42\",\"IsHighValue\":true,\"TraceId\":\"trace\",\"RequestPath\":\"/login\",\"RequestMethod\":\"POST\",\"IpHash\":\"ip\",\"UserAgentHash\":\"ua\",\"SessionIdHash\":\"sid\",\"DeviceFingerprintHash\":\"fp\",\"ReasonCode\":\"risk\",\"EventInfo\":\"event\",\"ContextJson\":\"{\\u0022ok\\u0022:true}\",\"ChainId\":\"20260614\",\"PrevHash\":\"prev\"}";

        AuditTamperEvidenceResult result = AuditTamperEvidence.Sign(record, key);

        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Canonical))), result.RecordHash);
        Assert.Equal(Convert.ToHexStringLower(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(Canonical))), result.RecordMac);
    }

    [Fact]
    public void Verify_AcceptsExactHashesAndRejectsTruncatedOrTamperedValues()
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
    public void Verify_FailsClosedWhenKeyOrRecordMacIsMissing()
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
    public void VerifyDetailed_ReturnsStableFieldReasons()
    {
        byte[] key = Encoding.UTF8.GetBytes(ValidTamperKey);
        AuditRecord record = BuildTamperRecord();
        AuditTamperEvidenceResult evidence = AuditTamperEvidence.Sign(record, key);
        AuditLog valid = ToAuditLog(record, evidence);

        Assert.Equal("valid", AuditTamperEvidence.VerifyDetailed(valid, key).Reason);

        AuditLog wrongChain = Clone(valid);
        wrongChain.ChainId = "20260615";
        AuditTamperVerificationResult chainResult = AuditTamperEvidence.VerifyDetailed(wrongChain, key);
        Assert.Equal("chain_id_mismatch", chainResult.Reason);
        Assert.Equal("chain_id", chainResult.Field);

        AuditTamperVerificationResult previousResult = AuditTamperEvidence.VerifyDetailed(
            valid,
            key,
            new string('a', 64));
        Assert.Equal("prev_hash_mismatch", previousResult.Reason);
        Assert.Equal("prev_hash", previousResult.Field);

        AuditLog wrongHash = Clone(valid);
        wrongHash.EventInfo = "tampered";
        Assert.Equal(
            "record_hash_mismatch",
            AuditTamperEvidence.VerifyDetailed(wrongHash, key).Reason);

        AuditLog wrongMac = Clone(valid);
        wrongMac.RecordMac = new string('a', 64);
        Assert.Equal(
            "record_mac_mismatch",
            AuditTamperEvidence.VerifyDetailed(wrongMac, key).Reason);
    }

    [Fact]
    public void VerifyDetailed_BindsProtectedPayloadDigest()
    {
        byte[] key = Encoding.UTF8.GetBytes(ValidTamperKey);
        AuditRecord record = BuildTamperRecord() with
        {
            ContextPayload = Encoding.UTF8.GetBytes("ciphertext-envelope")
        };
        AuditTamperEvidenceResult evidence = AuditTamperEvidence.Sign(record, key);
        AuditLog tampered = ToAuditLog(record, evidence);
        tampered.ContextPayload![0] ^= 0x01;

        AuditTamperVerificationResult result = AuditTamperEvidence.VerifyDetailed(tampered, key);

        Assert.Equal("record_hash_mismatch", result.Reason);
        Assert.Equal("record_hash", result.Field);
    }

    [Fact]
    public void VerifyDetailed_AcceptsPayloadUnboundV1HistoricalSignature()
    {
        byte[] key = Encoding.UTF8.GetBytes(ValidTamperKey);
        AuditRecord historicalCanonical = BuildTamperRecord();
        AuditTamperEvidenceResult historicalEvidence = AuditTamperEvidence.Sign(historicalCanonical, key);
        AuditRecord stored = historicalCanonical with
        {
            ContextPayload = Encoding.UTF8.GetBytes("historical-envelope")
        };

        AuditTamperVerificationResult result = AuditTamperEvidence.VerifyDetailed(
            ToAuditLog(stored, historicalEvidence),
            key);

        Assert.True(result.IsValid);
        Assert.Equal("valid", result.Reason);
    }

    [Fact]
    public void ResolveKey_RejectsWeakKeyAndIgnoresLegacyConfigurationLocation()
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

        Assert.Throws<InvalidOperationException>(() => AuditTamperEvidence.ResolveKey(shortKeyConfiguration));
        Assert.Null(AuditTamperEvidence.ResolveKey(legacyKeyConfiguration));
    }

    [Fact]
    public void Sign_FallbackChainIdIsInvariantAcrossCultures()
    {
        string[] chainIds = [];
        foreach (string cultureName in new[] { "en-US", "fa-IR", "ar-SA", "th-TH" })
        {
            chainIds = [.. chainIds, RunWithCulture(cultureName, () => AuditTamperEvidence.Sign(BuildTamperRecord(), null).ChainId)];
        }

        Assert.All(chainIds, chainId => Assert.Equal("20260614", chainId));
    }

    [Fact]
    public void Sign_CrossNodeFallbackChainHeadIsCultureInvariant()
    {
        byte[] key = Encoding.UTF8.GetBytes(ValidTamperKey);
        AuditTamperEvidenceResult enUs = RunWithCulture("en-US", () => AuditTamperEvidence.Sign(BuildTamperRecord(), key));
        AuditTamperEvidenceResult faIr = RunWithCulture("fa-IR", () => AuditTamperEvidence.Sign(BuildTamperRecord(), key));

        Assert.Equal(enUs.ChainId, faIr.ChainId);
        Assert.Equal(enUs.RecordHash, faIr.RecordHash);
        Assert.Equal(enUs.RecordMac, faIr.RecordMac);
    }

    [Fact]
    public void Sign_ChangingPreviousHashChangesTheChainHead()
    {
        byte[] key = Encoding.UTF8.GetBytes(ValidTamperKey);

        AuditTamperEvidenceResult first = AuditTamperEvidence.Sign(BuildTamperRecord() with
        {
            PrevHash = "head-a"
        }, key);
        AuditTamperEvidenceResult second = AuditTamperEvidence.Sign(BuildTamperRecord() with
        {
            PrevHash = "head-b"
        }, key);

        Assert.NotEqual(first.RecordHash, second.RecordHash);
        Assert.NotEqual(first.RecordMac, second.RecordMac);
    }

    [Fact]
    public void ContextSerializer_DecodesBinaryContextToCanonicalJson()
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

    private static AuditLog Clone(AuditLog source)
        => new()
        {
            Id = source.Id,
            Source = source.Source,
            Type = source.Type,
            OccurredAtUtc = source.OccurredAtUtc,
            ActorType = source.ActorType,
            ActorId = source.ActorId,
            ActorRole = source.ActorRole,
            Action = source.Action,
            TargetType = source.TargetType,
            TargetId = source.TargetId,
            Outcome = source.Outcome,
            Severity = source.Severity,
            IsHighValue = source.IsHighValue,
            TraceId = source.TraceId,
            RequestPath = source.RequestPath,
            RequestMethod = source.RequestMethod,
            IpHash = source.IpHash,
            UserAgentHash = source.UserAgentHash,
            SessionIdHash = source.SessionIdHash,
            DeviceFingerprintHash = source.DeviceFingerprintHash,
            ReasonCode = source.ReasonCode,
            EventInfo = source.EventInfo,
            ContextPayload = source.ContextPayload?.ToArray(),
            ContextJson = source.ContextJson,
            ChainId = source.ChainId,
            PrevHash = source.PrevHash,
            RecordHash = source.RecordHash,
            RecordMac = source.RecordMac
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
}
