using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminOperationsRecentErrorsTests
{
    [Fact]
    public void RecentErrors_AreStructuredAndRemoveSqlProjectionArtifacts()
    {
        DateTime occurred = new(2026, 6, 14, 9, 30, 0, DateTimeKind.Utc);

        IReadOnlyList<RecentOpsErrorResponse> errors = AdminOperationsService.BuildRecentErrorResponses(
        [
            new RecentOpsErrorAuditRow
            {
                OccurredAtUtc = occurred,
                Severity = "error",
                Action = "public_aot.cache",
                EventInfo = "CAST(\"occurred_at_utc\" AS VARCHAR) public_aot.cache Boundary execution failed: \"public-aot-node:buildEntry\""
            }
        ]);

        RecentOpsErrorResponse error = Assert.Single(errors);
        Assert.Equal(new DateTimeOffset(occurred), error.OccurredAt);
        Assert.Equal("error", error.Severity);
        Assert.Equal("public_aot.cache", error.Action);
        Assert.Equal("Boundary execution failed", error.Message);
        Assert.Contains("public-aot-node:buildEntry", error.Detail, StringComparison.Ordinal);
        Assert.DoesNotContain("CAST(", error.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("CAST(", error.Detail ?? string.Empty, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(1, error.Count);
    }

    [Fact]
    public void RecentErrors_GroupRepeatedActionAndMessageWithLatestOccurrence()
    {
        DateTime older = new(2026, 6, 14, 9, 30, 0, DateTimeKind.Utc);
        DateTime latest = older.AddMinutes(7);

        IReadOnlyList<RecentOpsErrorResponse> errors = AdminOperationsService.BuildRecentErrorResponses(
        [
            CreateRow(older, "public_aot.cache", "Boundary execution failed: \"public-aot-node:buildEntry\""),
            CreateRow(latest, "public_aot.cache", "Boundary execution failed: \"public-aot-node:buildEntry\"")
        ]);

        RecentOpsErrorResponse error = Assert.Single(errors);
        Assert.Equal(2, error.Count);
        Assert.Equal(new DateTimeOffset(latest), error.OccurredAt);
        Assert.Equal("Boundary execution failed", error.Message);
    }

    [Fact]
    public void RecentErrors_KeepLongDetailOutOfPrimarySummary()
    {
        string detail = "System.InvalidOperationException " + new string('x', 420);

        IReadOnlyList<RecentOpsErrorResponse> errors = AdminOperationsService.BuildRecentErrorResponses(
        [
            CreateRow(new DateTime(2026, 6, 14, 9, 30, 0, DateTimeKind.Utc), "public_aot.cache", $"Unhandled exception: {detail}")
        ]);

        RecentOpsErrorResponse error = Assert.Single(errors);
        Assert.Equal("Unhandled exception", error.Message);
        Assert.NotNull(error.Detail);
        Assert.Contains("System.InvalidOperationException", error.Detail, StringComparison.Ordinal);
        Assert.True(error.Message.Length <= 140);
        Assert.True(error.Detail!.Length > error.Message.Length);
    }

    private static RecentOpsErrorAuditRow CreateRow(DateTime occurredAtUtc, string action, string eventInfo)
        => new()
        {
            OccurredAtUtc = occurredAtUtc,
            Severity = "error",
            Action = action,
            EventInfo = eventInfo
        };
}
