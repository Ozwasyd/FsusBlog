using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

// These controls call the original port, recovery owner and exception middleware.
// They do not implement a parallel classifier or prove physical fence release.
public sealed class CanonicalArticleLifecycleScheduledFailureTests
{
    private static readonly DateTimeOffset s_now = new(2026, 9, 15, 12, 1, 0, TimeSpan.Zero);
    private static readonly string s_digest = "sha256:" + new string('a', 64);

    [Theory]
    [InlineData("origin", StatusCodes.Status500InternalServerError)]
    [InlineData("permission", StatusCodes.Status400BadRequest)]
    [InlineData("clock", StatusCodes.Status500InternalServerError)]
    public async Task TransactionFaultThenCallerCancellationRetainsOriginalClassification(string cause, int expectedStatus)
    {
        using var cancellation = new CancellationTokenSource();
        Exception primary = Primary(cause);
        var inputs = CreateInputs(primary, () => cancellation.Cancel());
        Exception thrown = await Assert.ThrowsAnyAsync<Exception>(() => inputs.Port.PublishScheduledAsync(
            Binding(), PendingReceipt(), cancellation.Token));
        Assert.Same(primary, thrown);
        Assert.Contains(nameof(Primary), thrown.StackTrace!, StringComparison.Ordinal);
        Assert.Contains(nameof(CanonicalArticleLifecycleFixturePort.PublishScheduledAsync), thrown.StackTrace!, StringComparison.Ordinal);
        Assert.IsAssignableFrom<OperationCanceledException>(thrown.Data[CanonicalArticleLifecycleFixturePort.ScheduledRecoveryFailureKey]);
        Assert.False((bool)thrown.Data[CanonicalArticleLifecycleFixturePort.ScheduledRecoveryCompletedKey]!);
        Assert.False((bool)thrown.Data[CanonicalArticleLifecycleFixturePort.ScheduledRecoveryQualifiedKey]!);
        await inputs.Lease.Received(1).ReleaseAsync(0, CancellationToken.None);
        await AssertOriginalClassificationAsync(thrown, expectedStatus, cancelled: false);
    }

    [Theory]
    [InlineData("origin", StatusCodes.Status500InternalServerError)]
    [InlineData("permission", StatusCodes.Status400BadRequest)]
    [InlineData("clock", StatusCodes.Status500InternalServerError)]
    public async Task RecoveryFaultCannotReplaceOriginalTransactionFault(string cause, int expectedStatus)
    {
        using var cancellation = new CancellationTokenSource();
        Exception primary = Primary(cause);
        var inputs = CreateInputs(primary);
        var recovery = new IOException("recovery_revocation_failed");
        inputs.Revocations.RevokeAllAsync(Arg.Any<CancellationToken>()).Returns(Task.FromException(recovery));
        Exception thrown = await Assert.ThrowsAnyAsync<Exception>(() => inputs.Port.PublishScheduledAsync(
            Binding(), PendingReceipt(), cancellation.Token));
        Assert.Same(primary, thrown);
        Assert.Same(recovery, thrown.Data[CanonicalArticleLifecycleFixturePort.ScheduledRecoveryFailureKey]);
        Assert.False((bool)thrown.Data[CanonicalArticleLifecycleFixturePort.ScheduledRecoveryCompletedKey]!);
        Assert.False((bool)thrown.Data[CanonicalArticleLifecycleFixturePort.ScheduledRecoveryQualifiedKey]!);
        await inputs.Lease.Received(1).ReleaseAsync(0, CancellationToken.None);
        await AssertOriginalClassificationAsync(thrown, expectedStatus, cancelled: false);
    }

    [Fact]
    public async Task PureCancellationKeepsOriginalCancellationAndUnprovenRecoveryObligation()
    {
        using var cancellation = new CancellationTokenSource();
        var primary = new OperationCanceledException("transaction_cancelled", cancellation.Token);
        var inputs = CreateInputs(primary, () => cancellation.Cancel());
        OperationCanceledException thrown = await Assert.ThrowsAsync<OperationCanceledException>(() =>
            inputs.Port.PublishScheduledAsync(Binding(), PendingReceipt(), cancellation.Token));
        Assert.Same(primary, thrown);
        Assert.Equal(cancellation.Token, thrown.CancellationToken);
        Assert.IsAssignableFrom<OperationCanceledException>(thrown.Data[CanonicalArticleLifecycleFixturePort.ScheduledRecoveryFailureKey]);
        Assert.False((bool)thrown.Data[CanonicalArticleLifecycleFixturePort.ScheduledRecoveryQualifiedKey]!);
        await AssertOriginalClassificationAsync(thrown, null, cancelled: true);
    }

    [Fact]
    public async Task CompletedRecoveryCallDoesNotQualifyPhysicalCleanupOrReturnAcceptedReceipt()
    {
        using var cancellation = new CancellationTokenSource();
        Exception primary = Primary("origin");
        var inputs = CreateInputs(primary);
        Exception thrown = await Assert.ThrowsAnyAsync<Exception>(() => inputs.Port.PublishScheduledAsync(
            Binding(), PendingReceipt(), cancellation.Token));
        Assert.Same(primary, thrown);
        Assert.True((bool)thrown.Data[CanonicalArticleLifecycleFixturePort.ScheduledRecoveryCompletedKey]!);
        Assert.False((bool)thrown.Data[CanonicalArticleLifecycleFixturePort.ScheduledRecoveryQualifiedKey]!);
        Assert.False(thrown.Data.Contains(CanonicalArticleLifecycleFixturePort.ScheduledRecoveryFailureKey));
        await inputs.Revocations.Received(1).RevokeAllAsync(cancellation.Token);
        await inputs.Lease.Received(1).ReleaseAsync(0, CancellationToken.None);
    }

    private static (CanonicalArticleLifecycleFixturePort Port, IPublicMutationFenceLease Lease,
        IPublicArtifactRevocationCoordinator Revocations) CreateInputs(Exception primary, Action? afterTransactionFault = null)
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IAdo ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(_ =>
        {
            // Supply an actual SqlSugar failure result to the original port;
            // cancellation follows the first transaction error, never precedes it.
            var transaction = new DbResult<bool> { IsSuccess = false, ErrorException = primary };
            afterTransactionFault?.Invoke();
            return Task.FromResult(transaction);
        });
        IPublicMutationFenceLease lease = Substitute.For<IPublicMutationFenceLease>();
        IPublicArtifactRevocationCoordinator revocations = Substitute.For<IPublicArtifactRevocationCoordinator>();
        var queue = new PublicHotArtifactUpdateQueue(
            Options.Create(new PublicHotReadOptions()), new InMemoryPublicHotArtifactDeliveryStateStore());
        var fence = new ArticlePublicMutationFence(lease, revocations, queue, NullLogger<ArticlePublicMutationFence>.Instance);
        var port = new CanonicalArticleLifecycleFixturePort(db, new ConfigurationBuilder().Build(),
            Substitute.For<IArticlePublicationValidator>(), fence, new FixedBusinessClock());
        return (port, lease, revocations);
    }

    private static Exception Primary(string cause)
    {
        Exception failure = cause switch
        {
            "origin" => new CanonicalArticleLifecycleValidationException("scheduled_origin_receipt_mismatch"),
            "permission" => new ArticleWriteValidationException("article_write_permission_required", "Permission required."),
            "clock" => new InvalidOperationException("operation_ahead_of_business_clock"),
            _ => throw new ArgumentOutOfRangeException(nameof(cause))
        };
        try
        {
            throw failure;
        }
        catch (Exception original)
        {
            return original;
        }
    }

    private static async Task AssertOriginalClassificationAsync(Exception failure, int? expectedStatus, bool cancelled)
    {
        IHostEnvironment environment = Substitute.For<IHostEnvironment>();
        environment.EnvironmentName.Returns(Environments.Development);
        var middleware = new GlobalExceptionMiddleware(_ => Task.FromException(failure),
            NullLogger<GlobalExceptionMiddleware>.Instance, environment);
        var context = new DefaultHttpContext();
        using var body = new MemoryStream();
        context.Response.Body = body;
        await middleware.InvokeAsync(context);
        if (cancelled)
        {
            // The original cancellation classifier emits no error frame. This
            // is not evidence of a successful fixture or qualified recovery.
            Assert.Equal(0, body.Length);
        }
        else
        {
            Assert.Equal(expectedStatus!.Value, context.Response.StatusCode);
            Assert.True(body.Length > 0);
        }
    }

    private static CanonicalArticleLifecycleFixtureBinding Binding() => new(
        "run", "namespace", "profile", ["article.write"], 1,
        CanonicalArticleLifecycleFixturePort.CurrentWriterContractDigest, s_digest);

    private static CanonicalArticleLifecycleReceipt PendingReceipt()
    {
        CanonicalArticleLifecycleFixtureBinding binding = Binding();
        var pending = new CanonicalArticleLifecycleOperationReceipt("pending", "create", null, ArticleStatus.Scheduled,
            false, false, null, null, 10, 1, null, null, null, null, 20, 30, 1, null,
            s_now.UtcDateTime.AddMinutes(-1), s_now.UtcDateTime, s_digest, "outbox", s_digest, "audit", s_digest);
        return new(CanonicalArticleLifecycleFixturePort.Schema, binding.WriterContractDigest, binding.TemporalContextDigest,
            binding.RunId, binding.Namespace, binding.ProfileId, "scheduled", CanonicalArticleLifecycleVariants.Scheduled,
            binding.AdminPrincipalId, 1, [pending], [10], [], 10, null, ArticleStatus.Scheduled, false,
            s_digest, s_digest, s_digest);
    }

    private sealed class FixedBusinessClock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => s_now;
    }
}
