using System.Data;
using System.Data.Common;

using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Transient;
using FsusBlog.Server.Tests.Helpers;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DatabaseMaterializationScopeTests
{
    [Fact]
    public async Task AdmissionRejectedBeforeTheQueryCallbackOrMaterialization()
    {
        var (ledger, host, operations) = TransientMemoryTestLedger.Create(64);
        using var cancellation = new CancellationTokenSource();
        int calls = 0;
        var result = await DatabaseMaterializationScope.RunAsync(ledger, host, operations,
            new(2, 16, 32, 128), (_, _) =>
            {
                calls++;
                return ValueTask.CompletedTask;
            }, cancellation.Token);
        Assert.Equal(MemoryFailure.BudgetRejected, result.Failure);
        Assert.Equal(0, calls);
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
        Assert.Empty(ledger.EventWindow().Events);
    }

    [Fact]
    public async Task RowFrameAndWorkspaceBoundsFailBeforeTheNextAllocation()
    {
        var (ledger, host, operations) = TransientMemoryTestLedger.Create(128);
        using var cancellation = new CancellationTokenSource();
        DatabaseMaterializationScope? captured = null;
        var result = await DatabaseMaterializationScope.RunAsync(ledger, host, operations,
            new(1, 16, 32, 128), (scope, _) =>
            {
                captured = scope;
                scope.AdmitRow(64);
                Assert.Throws<InvalidDataException>(() => scope.AdmitRow(1));
                Assert.Throws<InvalidDataException>(() => scope.AdmitFrame(33));
                scope.AdmitFrame(32);
                Assert.Throws<InvalidDataException>(() => scope.AdmitFrame(32 + 1));
                Assert.Equal(128, ledger.Snapshot().Used["host"]);
                return ValueTask.CompletedTask;
            }, cancellation.Token);
        Assert.True(result.Succeeded);
        Assert.Throws<ObjectDisposedException>(() => captured!.AdmitFrame(1));
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
    }

    [Fact]
    public async Task StringLengthIsProbedBeforeAllocatingOrReadingOversizeCharacters()
    {
        var (ledger, host, operations) = TransientMemoryTestLedger.Create(128);
        using var cancellation = new CancellationTokenSource();
        using var table = new DataTable();
        table.Columns.Add("text", typeof(string));
        table.Rows.Add("stable");
        table.Rows.Add(new string('x', 17));
        using DbDataReader reader = table.CreateDataReader();
        var result = await DatabaseMaterializationScope.RunAsync(ledger, host, operations,
            new(2, 16, 32, 128), (scope, _) =>
            {
                Assert.True(reader.Read());
                scope.AdmitRow(32);
                Assert.Equal("stable", scope.ReadBoundedString(reader, 0));
                Assert.True(reader.Read());
                scope.AdmitRow(32);
                Assert.Throws<InvalidDataException>(() => scope.ReadBoundedString(reader, 0));
                return ValueTask.CompletedTask;
            }, cancellation.Token);
        Assert.True(result.Succeeded);
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
    }

    [Fact]
    public async Task CancellationOfOuterWaitRetainsWorkspaceUntilUnderlyingQueryEnds()
    {
        var (ledger, host, operations) = TransientMemoryTestLedger.Create(128);
        using var cancellation = new CancellationTokenSource();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task task = DatabaseMaterializationScope.RunAsync(ledger, host, operations,
            new(2, 16, 32, 128), async (scope, _) =>
            {
                entered.SetResult();
                await completion.Task;
                scope.AdmitRow(32);
            }, cancellation.Token).AsTask();
        await entered.Task;
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => task.WaitAsync(cancellation.Token));
        Assert.Equal(128, ledger.Snapshot().Used["host"]);
        Assert.Equal(1, ledger.Snapshot().Used["operations"]);
        completion.SetResult();
        await task;
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
        Assert.Equal(0, ledger.Snapshot().Reservations);
    }

}
