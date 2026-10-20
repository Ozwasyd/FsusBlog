using System.Data;
using System.Data.Common;
using System.Reflection;

using FsusBlog.Contracts.Migration;

using MySqlConnector;

using Xunit;

namespace FsusBlog.Migration.Tests;

/// <summary>Pre-I/O and compiled surface controls, not native MySQL snapshot acceptance.</summary>
public sealed class OfflineMigrationStateStoreOwnedReadTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task CancelledBorrowerIsRefusedBeforeAccessingTheOwnedContext(bool wholeJournal)
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        OperationCanceledException refusal = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            wholeJournal
                ? OfflineMigrationStateStore.ReadApplyJournalAsync(null!, "unused", null!, null!, null!, cancellation.Token)
                : OfflineMigrationStateStore.ValidateApplyJournalAsync(null!, cancellation.Token));
        Assert.Equal(cancellation.Token, refusal.CancellationToken);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task MissingOriginalContextCannotReachNativeJournalIo(bool wholeJournal)
    {
        using var cancellation = new CancellationTokenSource();
        ArgumentNullException refusal = await Assert.ThrowsAsync<ArgumentNullException>(() =>
            wholeJournal
                ? OfflineMigrationStateStore.ReadApplyJournalAsync(null!, "unused", null!, null!, null!, cancellation.Token)
                : OfflineMigrationStateStore.ValidateApplyJournalAsync(null!, cancellation.Token));
        Assert.Equal("context", refusal.ParamName);
    }

    [Fact]
    public void OriginalTypedReadSignaturesKeepAllExplicitJournalInputs()
    {
        Type context = typeof(OfflineMigrationMySqlNativeSession.OwnedReadContext);
        MethodInfo[] methods = typeof(OfflineMigrationStateStore).GetMethods(BindingFlags.Static | BindingFlags.NonPublic);
        MethodInfo read = Assert.Single(methods, method => method.Name == "ReadApplyJournalAsync"
            && method.GetParameters()[0].ParameterType == context);
        Assert.Equal(new[]
        {
            context, typeof(string), typeof(CurrentSchemaDatabaseIdentity), typeof(OfflineMigrationApplyRequest),
            typeof(OfflineMigrationApplyJournalVerifier), typeof(CancellationToken)
        }, read.GetParameters().Select(parameter => parameter.ParameterType));
        Assert.Equal(typeof(Task), read.ReturnType);
        MethodInfo validate = Assert.Single(methods, method => method.Name == "ValidateApplyJournalAsync"
            && method.GetParameters()[0].ParameterType == context);
        Assert.Equal(new[] { context, typeof(CancellationToken) },
            validate.GetParameters().Select(parameter => parameter.ParameterType));
        Assert.Equal(typeof(Task), validate.ReturnType);
    }

    [Fact]
    public void OwnedReadContextDoesNotExposeAnyJournalWriteOrRawProviderAuthority()
    {
        Type context = typeof(OfflineMigrationMySqlNativeSession.OwnedReadContext);
        MethodInfo[] methods = typeof(OfflineMigrationStateStore).GetMethods(BindingFlags.Static | BindingFlags.NonPublic);
        foreach (string name in new[] { "EnsureApplyJournalAsync", "AppendApplyJournalAsync", "NativeProvider", "NativeCommand" })
        {
            MethodInfo[] original = methods.Where(method => method.Name == name).ToArray();
            Assert.NotEmpty(original);
            Assert.All(original, method => Assert.DoesNotContain(method.GetParameters(),
                parameter => parameter.ParameterType == context));
        }
        Assert.True(Assert.Single(methods, method => method.Name == "ReadApplyJournalRowsAsync").IsPrivate);
    }

    [Theory]
    [InlineData(IsolationLevel.RepeatableRead)]
    [InlineData(IsolationLevel.Snapshot)]
    public void CallerLabelledRawTransactionCannotBecomeOriginalMySqlReadCustody(IsolationLevel isolation)
    {
        using var connection = new MySqlConnection();
        using var transaction = new CallerLabelledTransaction(connection, isolation);
        InvalidOperationException refusal = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationStateStore.NativeProvider(connection, transaction));
        Assert.Equal("offline_apply_original_native_transaction_required", refusal.Message);
        Assert.Null(refusal.InnerException);
    }

    private sealed class CallerLabelledTransaction(DbConnection connection, IsolationLevel isolation) : DbTransaction
    {
        public override IsolationLevel IsolationLevel => isolation;

        protected override DbConnection DbConnection => connection;

        public override void Commit() => throw new NotSupportedException();

        public override void Rollback() => throw new NotSupportedException();
    }
}
