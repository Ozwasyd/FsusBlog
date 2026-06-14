using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.PublicAot;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuditPipelineHotPathContractTests
{
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
        byte[] key = Encoding.UTF8.GetBytes("secret");
        const string canonical = "{\"Source\":\"auth\",\"Type\":\"security\",\"OccurredAtUtc\":\"2026-06-14T12:00:00.0000000Z\",\"Action\":\"auth.test\",\"Outcome\":\"success\",\"Severity\":\"info\",\"ActorType\":\"admin\",\"ActorId\":\"7\",\"ActorRole\":\"admin\",\"TargetType\":\"session\",\"TargetId\":\"42\",\"IsHighValue\":true,\"TraceId\":\"trace\",\"RequestPath\":\"/login\",\"RequestMethod\":\"POST\",\"IpHash\":\"ip\",\"UserAgentHash\":\"ua\",\"SessionIdHash\":\"sid\",\"DeviceFingerprintHash\":\"fp\",\"ReasonCode\":\"risk\",\"EventInfo\":\"event\",\"ContextJson\":\"{\\u0022ok\\u0022:true}\",\"ChainId\":\"20260614\",\"PrevHash\":\"prev\"}";

        AuditTamperEvidenceResult result = AuditTamperEvidence.Sign(record, key);

        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))), result.RecordHash);
        Assert.Equal(Convert.ToHexStringLower(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(canonical))), result.RecordMac);
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

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(FindRepoRoot(), relativePath));

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

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }
}
