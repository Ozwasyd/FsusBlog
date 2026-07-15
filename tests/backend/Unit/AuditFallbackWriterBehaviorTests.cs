using System.Text.Json;
using FsusBlog.Server.Infrastructure.Audit;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuditFallbackWriterBehaviorTests
{
    [Fact]
    public async Task WriteBatchAsync_AppendsEveryDurableRecordAndUpdatesRuntimeState()
    {
        string root = Path.Combine(Path.GetTempPath(), "fsusblog-audit-fallback-" + Guid.NewGuid().ToString("N"));
        try
        {
            var channel = new AuditLogChannel();
            var runtimeState = new AuditLogRuntimeState(channel);
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["FSUSBLOG_DATA_ROOT"] = root
                })
                .Build();
            var writer = new AuditFallbackWriter(configuration, runtimeState);
            AuditRecord[] records =
            [
                BuildRecord(AuditActionCatalog.SecurityPolicyActivated, "first"),
                BuildRecord(AuditActionCatalog.SecurityPolicyRolledBack, "second")
            ];

            await writer.WriteBatchAsync(records, new InvalidOperationException("database unavailable"), CancellationToken.None);

            string path = Assert.Single(Directory.GetFiles(Path.Combine(root, "audit-fallback"), "critical-audit-*.jsonl"));
            string[] lines = await File.ReadAllLinesAsync(path);
            Assert.Equal(2, lines.Length);
            using JsonDocument first = JsonDocument.Parse(lines[0]);
            using JsonDocument second = JsonDocument.Parse(lines[1]);
            Assert.Equal(AuditActionCatalog.SecurityPolicyActivated, first.RootElement.GetProperty("Action").GetString());
            Assert.Equal("first", first.RootElement.GetProperty("EventInfo").GetString());
            Assert.Equal("database unavailable", first.RootElement.GetProperty("Message").GetString());
            Assert.Equal(AuditActionCatalog.SecurityPolicyRolledBack, second.RootElement.GetProperty("Action").GetString());
            Assert.Equal("second", second.RootElement.GetProperty("EventInfo").GetString());
            Assert.Equal(2, runtimeState.Snapshot().FallbackWriteCount);
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    private static AuditRecord BuildRecord(string action, string eventInfo)
        => new(
            AuditSourceCatalog.Security,
            AuditTypeCatalog.Security,
            new DateTime(2026, 7, 11, 10, 0, 0, DateTimeKind.Utc),
            eventInfo,
            null,
            Action: action,
            Outcome: AuditOutcomeCatalog.Failure,
            Severity: AuditSeverityCatalog.Critical,
            ActorType: AuditActorTypeCatalog.System,
            TargetType: "audit-store",
            ReasonCode: "db_unavailable");
}
