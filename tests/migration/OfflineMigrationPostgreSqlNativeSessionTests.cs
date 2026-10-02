using System.Data.Common;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

using Xunit;

namespace FsusBlog.Migration.Tests;

/// <summary>
/// Real filesystem/argument refusal fixtures, not a fake PostgreSQL capture or restore drill.
/// Native DB snapshot, dump handshake, sequence drift and disposal acceptance require the
/// original admitted provider environment and remain separate from these source fixtures.
/// </summary>
public sealed class OfflineMigrationPostgreSqlNativeSessionTests
{
    [Fact]
    public async Task CompletedRegularDumpIsHashedFromItsActualBytes()
    {
        using var fixture = new DumpFixture();
        byte[] bytes = Encoding.UTF8.GetBytes("actual temporary dump fixture\n");
        string path = fixture.Write("dump.sql", bytes);
        string actual = await OfflineMigrationPostgreSqlNativeSession.HashCompletedDumpAsync(path, CancellationToken.None);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(bytes)), actual);
        Assert.Equal(bytes, File.ReadAllBytes(path));
    }

    [Fact]
    public async Task CompletedDumpHashIsStreamingAcrossBufferBoundaries()
    {
        using var fixture = new DumpFixture();
        byte[] bytes = new byte[(64 * 1024 * 3) + 17];
        for (int index = 0; index < bytes.Length; index++)
        {
            bytes[index] = (byte)(index % 251);
        }
        string path = fixture.Write("multi-buffer.sql", bytes);
        string actual = await OfflineMigrationPostgreSqlNativeSession.HashCompletedDumpAsync(path, CancellationToken.None);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(bytes)), actual);
    }

    [Fact]
    public async Task EmptyDumpIsRefused()
    {
        using var fixture = new DumpFixture();
        await AssertCodeAsync("offline_source_capture_regular_unique_dump_required",
            () => OfflineMigrationPostgreSqlNativeSession.HashCompletedDumpAsync(
                fixture.Write("empty.sql", []), CancellationToken.None));
    }

    [Fact]
    public async Task DirectoryIsNotACompletedDump()
    {
        using var fixture = new DumpFixture();
        await AssertCodeAsync("offline_source_capture_regular_unique_dump_required",
            () => OfflineMigrationPostgreSqlNativeSession.HashCompletedDumpAsync(fixture.Directory, CancellationToken.None));
    }

    [Theory]
    [InlineData("")]
    [InlineData("relative.sql")]
    public async Task MissingOrRelativePathCannotSelectACaptureArtifact(string path)
    {
        await AssertCodeAsync("offline_source_capture_native_dump_path_required",
            () => OfflineMigrationPostgreSqlNativeSession.HashCompletedDumpAsync(path, CancellationToken.None));
    }

    [Fact]
    public async Task MissingAbsoluteDumpIsRefusedWithoutLeakingItsPath()
    {
        using var fixture = new DumpFixture();
        string path = Path.Combine(fixture.Directory, "private-artifact-not-present.sql");
        await AssertCodeAsync("offline_source_capture_regular_unique_dump_required",
            () => OfflineMigrationPostgreSqlNativeSession.HashCompletedDumpAsync(path, CancellationToken.None));
    }

    [Fact]
    public async Task FinalDumpSymlinkIsRefusedWithoutReadingItsTarget()
    {
        using var fixture = new DumpFixture();
        string target = fixture.Write("target.sql", [1, 2, 3]);
        string alias = Path.Combine(fixture.Directory, "alias.sql");
        File.CreateSymbolicLink(alias, target);
        await AssertCodeAsync("offline_source_capture_regular_unique_dump_required",
            () => OfflineMigrationPostgreSqlNativeSession.HashCompletedDumpAsync(alias, CancellationToken.None));
        Assert.Equal(new byte[] { 1, 2, 3 }, File.ReadAllBytes(target));
    }

    [Fact]
    public async Task HardLinkedDumpIsNotAUniquePreboundArtifact()
    {
        using var fixture = new DumpFixture();
        string target = fixture.Write("target.sql", [4, 5, 6]);
        string alias = Path.Combine(fixture.Directory, "hardlink.sql");
        Assert.Equal(0, NativeMethods.Link(target, alias));
        await AssertCodeAsync("offline_source_capture_regular_unique_dump_required",
            () => OfflineMigrationPostgreSqlNativeSession.HashCompletedDumpAsync(target, CancellationToken.None));
        Assert.Equal(new byte[] { 4, 5, 6 }, File.ReadAllBytes(alias));
    }

    [Fact]
    public async Task SymlinkParentCannotSelectAnExternalDump()
    {
        using var fixture = new DumpFixture();
        using var external = new DumpFixture();
        string target = external.Write("dump.sql", [3, 2, 1]);
        string alias = Path.Combine(fixture.Directory, "external");
        System.IO.Directory.CreateSymbolicLink(alias, external.Directory);
        await AssertCodeAsync("offline_source_capture_dump_parent_invalid",
            () => OfflineMigrationPostgreSqlNativeSession.HashCompletedDumpAsync(
                Path.Combine(alias, "dump.sql"), CancellationToken.None));
        Assert.Equal(new byte[] { 3, 2, 1 }, File.ReadAllBytes(target));
    }

    [Fact]
    public async Task CancellationBeforeFileOpenCannotProduceADumpDigest()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            OfflineMigrationPostgreSqlNativeSession.HashCompletedDumpAsync("/not-opened.sql", cancellation.Token));
    }

    [Fact]
    public async Task CancellationBeforeSessionCreationDoesNotInvokeTheObserver()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        bool observed = false;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            OfflineMigrationPostgreSqlNativeSession.ObserveAsync("not parsed after cancellation",
                (_, _, _) =>
                {
                    observed = true;
                    throw new InvalidOperationException("observer must not run");
                }, cancellation.Token));
        Assert.False(observed);
    }

    [Fact]
    public async Task MissingOperationCancellationContextIsRefusedBeforeConnectionCreation()
    {
        await AssertCodeAsync("offline_source_native_operation_context_required", () =>
            OfflineMigrationPostgreSqlNativeSession.ObserveAsync("not parsed without owner context",
                NeverObserve, CancellationToken.None));
    }

    [Fact]
    public async Task InvalidPrivateConnectionSettingsDoNotLeakDriverMessagesOrCredentials()
    {
        using var cancellation = new CancellationTokenSource();
        await AssertCodeAsync("offline_source_native_operation_failed", () =>
            OfflineMigrationPostgreSqlNativeSession.ObserveAsync(
                "Password=private-fixture-not-for-errors;UnsupportedNativeSessionFixtureOption=1",
                NeverObserve, cancellation.Token));
    }

    [Fact]
    public async Task EmptyConnectionSettingsAreRefusedBeforeNativeCreation()
    {
        using var cancellation = new CancellationTokenSource();
        await AssertCodeAsync("offline_source_native_operation_context_required", () =>
            OfflineMigrationPostgreSqlNativeSession.ObserveAsync("", NeverObserve, cancellation.Token));
    }

    [Theory]
    [InlineData("")]
    [InlineData("snapshot\nDUMP_COMPLETED")]
    [InlineData("snapshot id")]
    [InlineData("../snapshot")]
    [InlineData("snapshot;SELECT")]
    [InlineData("snapshot_quoted")]
    [InlineData("é")]
    public void SnapshotTransportTokenRejectsControlOrSqlLikeInputs(string snapshot)
    {
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationPostgreSqlNativeSession.RequireSnapshotId(snapshot));
        Assert.Equal("offline_source_native_snapshot_id_invalid", error.Message);
    }

    [Fact]
    public void OversizedSnapshotTransportTokenIsRefused()
    {
        Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationPostgreSqlNativeSession.RequireSnapshotId(new string('A', 129)));
    }

    [Fact]
    public void NativeSnapshotTokenGrammarIsOnlyATransportControlNotLivenessEvidence()
    {
        OfflineMigrationPostgreSqlNativeSession.RequireSnapshotId("00000003-0000001B-1");
    }

    [Fact]
    public void CancellationAndSecondaryCleanupFailureKeepBothFixedFacts()
    {
        string code = OfflineMigrationPostgreSqlNativeSession.CleanupFailureCode(
            new OperationCanceledException("private driver text must not escape"),
            OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified,
            OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned,
            OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned);
        Assert.Equal("offline_source_native_cleanup_unverified_primary_cancelled_transaction_unverified_connection_returned_adapter_returned", code);
    }

    [Fact]
    public void PrimaryOperationAndMultipleCleanupFailuresCannotLeakExceptionText()
    {
        string code = OfflineMigrationPostgreSqlNativeSession.CleanupFailureCode(
            new InvalidOperationException("Password=private-fixture; SELECT private rows"),
            OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified,
            OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified,
            OfflineMigrationPostgreSqlNativeSession.CleanupState.NotOwned);
        Assert.Equal("offline_source_native_cleanup_unverified_primary_operation_failed_transaction_unverified_connection_unverified_adapter_not_owned", code);
    }

    [Fact]
    public void CleanupOnlyFailureIsNotProjectedAsSuccessfulOperationOrCancellation()
    {
        string code = OfflineMigrationPostgreSqlNativeSession.CleanupFailureCode(
            null,
            OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned,
            OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned,
            OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified);
        Assert.Equal("offline_source_native_cleanup_unverified_primary_none_transaction_returned_connection_returned_adapter_unverified", code);
    }

    [Fact]
    public void UnknownCleanupStateCannotClaimACompletedRelease()
    {
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationPostgreSqlNativeSession.CleanupFailureCode(
            null, (OfflineMigrationPostgreSqlNativeSession.CleanupState)999,
            OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned,
            OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned));
    }

    private static Task<OfflineMigrationSourceObservation> NeverObserve(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
        => throw new InvalidOperationException("observer must not run before argument refusal");

    private static async Task AssertCodeAsync(string code, Func<Task> operation)
    {
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(operation);
        Assert.Equal(code, error.Message);
        Assert.Null(error.InnerException);
    }

    private sealed class DumpFixture : IDisposable
    {
        internal string Directory { get; } = Path.Combine(Path.GetTempPath(), $"fsusblog-native-session-fixture-{Guid.NewGuid():N}");

        internal DumpFixture()
        {
            System.IO.Directory.CreateDirectory(Directory);
        }

        internal string Write(string name, byte[] bytes)
        {
            string path = Path.Combine(Directory, name);
            File.WriteAllBytes(path, bytes);
            return path;
        }

        public void Dispose()
        {
            // The fixture owns only this fresh GUID directory. A directory symlink is not
            // traversed by Directory.Delete; the external fixture remains separately owned.
            System.IO.Directory.Delete(Directory, recursive: true);
        }
    }

    private static class NativeMethods
    {
        [DllImport("libc", EntryPoint = "link", SetLastError = true)]
        internal static extern int Link(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string existingPath,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string newPath);
    }
}
