using System.Data.Common;

using Xunit;

using FsusBlog.Contracts.Migration;

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


    [Fact]
    public void OriginalFingerprintTransportSurvivesReturnedCleanupWithoutParsingItsMessage()
    {
        OfflineMigrationSourceFingerprintException primary = UnknownFingerprint();
        OfflineMigrationSourceFingerprintException refusal = Assert.Throws<OfflineMigrationSourceFingerprintException>(() =>
            OfflineMigrationMySqlNativeSession.ThrowAfterCleanup(primary, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned,
                OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, CancellationToken.None));
        Assert.Same(primary, refusal);
        Assert.Equal("source_fingerprint_unknown", refusal.Code);
        Assert.NotEmpty(refusal.Differences);
        Assert.Null(refusal.InnerException);
    }

    [Theory]
    [InlineData(OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned)]
    [InlineData(OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned)]
    [InlineData(OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified)]
    public void AnyUnverifiedCleanupRefusesBeforeTypedFingerprintTransport(
        OfflineMigrationPostgreSqlNativeSession.CleanupState transaction, OfflineMigrationPostgreSqlNativeSession.CleanupState connection, OfflineMigrationPostgreSqlNativeSession.CleanupState adapter)
    {
        OfflineMigrationSourceFingerprintException primary = UnknownFingerprint();
        InvalidOperationException refusal = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationMySqlNativeSession.ThrowAfterCleanup(primary, transaction, connection, adapter, CancellationToken.None));
        Assert.IsNotType<OfflineMigrationSourceFingerprintException>(refusal);
        Assert.Equal(OfflineMigrationPostgreSqlNativeSession.CleanupFailureCode(primary, transaction, connection, adapter), refusal.Message);
        Assert.Null(refusal.InnerException);
    }

    [Fact]
    public void MessageLookalikeDoesNotBecomeTypedFailureOrLeakDriverText()
    {
        var primary = new InvalidOperationException("source_fingerprint_unknown: Password=private-fixture; SELECT private rows");
        InvalidOperationException refusal = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationMySqlNativeSession.ThrowAfterCleanup(primary, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned,
                OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, CancellationToken.None));
        Assert.Equal("offline_source_mysql_native_operation_failed", refusal.Message);
        Assert.Null(refusal.InnerException);
    }

    [Fact]
    public void ReturnedCleanupPreservesCancellationBeforeGenericOperationProjection()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        OperationCanceledException refusal = Assert.Throws<OperationCanceledException>(() =>
            OfflineMigrationMySqlNativeSession.ThrowAfterCleanup(new OperationCanceledException("private native data"),
                OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned,
                OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, cancellation.Token));
        Assert.Equal("offline_source_native_operation_cancelled", refusal.Message);
        Assert.Equal(cancellation.Token, refusal.CancellationToken);
        Assert.Null(refusal.InnerException);
    }

    private static OfflineMigrationSourceFingerprintException UnknownFingerprint()
        => Assert.Throws<OfflineMigrationSourceFingerprintException>(() =>
            OfflineMigrationSourceFingerprints.RequireKnownSchema(CurrentSchemaProviderKind.MySql,
                OfflineMigrationSourceFingerprints.Schema(CurrentSchemaProviderKind.MySql, false)
                    .Add(new("table/private-fixture-name-not-for-errors", "base"))));

    private static Task<OfflineMigrationSourceObservation> NeverObserve(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
        => throw new InvalidOperationException("observer must not run before argument refusal");
}
