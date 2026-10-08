global using Xunit;

using System.Text.Json;

using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Tests.Unit;
using FsusBlog.Shared.Contracts.ArticleVault;

using Npgsql;
using SqlSugar;

// Diagnostic process worker. Actual published stores are used; no server receipts are fabricated.
string action = args[0];
string connectionString = args[1];
try
{
    await using NpgsqlDataSource dataSource = NpgsqlDataSource.Create(connectionString);
    using var db = new SqlSugarClient(new ConnectionConfig
    {
        ConnectionString = connectionString,
        DbType = DbType.PostgreSQL,
        IsAutoCloseConnection = true
    });
    var clock = new DiagnosticClock();
    var execution = new PostgresArticleVaultExecutionStore(db, clock);
    var store = new PostgresArticleVaultOperationCheckpointStore(dataSource, execution, clock);
    ArticleVaultSyncPlan plan = ArticleVaultOperationFixture.Plan();
    ArticleVaultOperationIdentity identity = ArticleVaultOperationFixture.Identity(plan);
    ArticleVaultOperationCheckpoint planned = ArticleVaultOperationFixture.Checkpoint(identity, plan);
    ArticleVaultOperationCheckpoint validating = ArticleVaultOperationFixture.Checkpoint(identity, plan, planned, VaultOperationState.Validating);
    ArticleVaultOperationCheckpoint executing = ArticleVaultOperationFixture.Checkpoint(identity, plan, validating,
        VaultOperationState.ExecutingServer, VaultServerCommitDisposition.Unknown);
    ArticleVaultOperationCheckpoint recovery = ArticleVaultOperationFixture.Checkpoint(identity, plan, executing,
        VaultOperationState.RecoveryRequired, VaultServerCommitDisposition.Unknown, reason: "server_outcome_unknown", cancelled: true);
    ArticleVaultOperationCheckpoint cancelled = ArticleVaultOperationFixture.Checkpoint(identity, plan, validating,
        VaultOperationState.Cancelled, reason: "operation_cancelled", cancelled: true);
    ArticleVaultOperationCheckpoint target = action switch
    {
        "validating" => validating,
        "executing" => executing,
        "cancel" => cancelled,
        "recovery" => recovery,
        _ => planned
    };
    if (action == "identity-conflict")
    {
        identity = ArticleVaultOperationVerifier.Bind(plan, identity.AgentIdentity, identity.RequestSha256,
            identity.IdempotencySha256, identity.DeadlineUnixMs - 1);
        await store.RegisterAsync(identity, plan);
    }
    else if (action == "stale-plan")
    {
        await store.ReadThroughAsync(identity, plan with { ContentSha256 = ArticleVaultOperationFixture.DigestC }, 0, planned.ContentSha256);
    }
    else if (action == "unsafe-cancel")
    {
        target = ArticleVaultOperationFixture.Checkpoint(identity, plan, executing, VaultOperationState.Cancelled,
            VaultServerCommitDisposition.Unknown, reason: "operation_cancelled", cancelled: true);
        await store.AppendAsync(identity, plan, target);
    }
    else if (action == "missing-server-result")
    {
        target = ArticleVaultOperationFixture.Checkpoint(identity, plan, executing, VaultOperationState.MaterializingLocal,
            VaultServerCommitDisposition.Accepted, new(plan.ResultCandidateIdentity, ArticleVaultOperationFixture.DigestA));
        await store.AppendAsync(identity, plan, target);
    }
    else if (action.StartsWith("read-", StringComparison.Ordinal))
    {
        target = action switch
        {
            "read-validating" => validating,
            "read-executing" => executing,
            "read-recovery" => recovery,
            "read-cancel" => cancelled,
            _ => planned
        };
        var history = await store.ReadThroughAsync(identity, plan, target.Sequence, target.ContentSha256);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            action, pid = Environment.ProcessId, count = history.Count,
            state = history[^1].State.ToString(), digest = history[^1].ContentSha256,
            baseUnchanged = history.All(checkpoint => checkpoint.Articles.All(article => article.BaseBeforeSha256 == article.BaseAfterSha256))
        }));
        return 0;
    }
    else if (action == "expired-executing")
    {
        clock.NowUnixMs = identity.DeadlineUnixMs + 1;
        await store.AppendAsync(identity, plan, executing);
    }
    else
    {
        await store.RegisterAsync(identity, plan);
        await store.AppendAsync(identity, plan, target);
    }
    Console.WriteLine(JsonSerializer.Serialize(new { action, pid = Environment.ProcessId, status = "committed", sequence = target.Sequence, digest = target.ContentSha256 }));
    Console.Out.Flush();
    if (args.Contains("hold"))
    {
        await Task.Delay(Timeout.InfiniteTimeSpan);
    }
    return 0;
}
catch (Exception exception)
{
    Console.WriteLine(JsonSerializer.Serialize(new { action, pid = Environment.ProcessId, error = exception.GetType().Name,
        reason = exception.Message, sqlState = (exception as PostgresException)?.SqlState }));
    return 20;
}

internal sealed class DiagnosticClock : TimeProvider
{
    internal long NowUnixMs { get; set; } = 1_800_000_000_100;

    public override DateTimeOffset GetUtcNow() => DateTimeOffset.FromUnixTimeMilliseconds(NowUnixMs);
}
