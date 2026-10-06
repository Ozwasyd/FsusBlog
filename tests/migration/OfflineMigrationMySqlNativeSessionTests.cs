using System.Data.Common;

using Xunit;

namespace FsusBlog.Migration.Tests;

/// <summary>Pre-connection refusals only, not a mock MySQL provider acceptance lane.</summary>
public sealed class OfflineMigrationMySqlNativeSessionTests
{
    [Fact]
    public async Task CancelledCallerDoesNotCreateANativeConnection()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            OfflineMigrationMySqlNativeSession.ObserveAsync("not parsed after cancellation", NeverObserve, cancellation.Token));
    }

    [Fact]
    public async Task MissingOwnerCancellationContextIsRefused()
    {
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationMySqlNativeSession.ObserveAsync("not parsed without context", NeverObserve, CancellationToken.None));
        Assert.Equal("offline_source_native_operation_context_required", error.Message);
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    public async Task EmptyConnectionSettingsAreRefusedBeforeDriverCreation(string settings)
    {
        using var cancellation = new CancellationTokenSource();
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationMySqlNativeSession.ObserveAsync(settings, NeverObserve, cancellation.Token));
        Assert.Equal("offline_source_native_operation_context_required", error.Message);
    }

    [Fact]
    public async Task BadPrivateConnectionOptionsCannotLeakCredentialsOrDriverMessages()
    {
        using var cancellation = new CancellationTokenSource();
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationMySqlNativeSession.ObserveAsync(
                "Password=private-fixture-not-for-errors;UnsupportedNativeSessionFixtureOption=1", NeverObserve, cancellation.Token));
        Assert.Equal("offline_source_mysql_native_operation_failed", error.Message);
        Assert.Null(error.InnerException);
    }

    private static Task<OfflineMigrationSourceObservation> NeverObserve(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
        => throw new InvalidOperationException("observer must not run before argument refusal");
}
