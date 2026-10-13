using System.Diagnostics;

using Xunit;

namespace FsusBlog.ArticleVault.Windows.Tests;

[Trait("Category", "WindowsArticleVaultWatcher")]
public sealed class WindowsVaultWatcherNtfsTests
{
    [Fact]
    public async Task RealNtfsCreateEditRenameRemoveProduceRawActions()
    {
        using var fixture = new WindowsVaultNtfsFixture();
        using WindowsVaultWatcherSession watcher = fixture.Start();
        await watcher.NativeStarted.WaitAsync(TimeSpan.FromSeconds(5));
        _ = watcher.ReadAvailable();
        string original = Path.Combine(fixture.RootPath, "Original.md");
        await File.WriteAllTextAsync(original, "private fixture sentinel\r\n");
        await AwaitFact(watcher, fact => fact.NativeAction == 1 && fact.RawNewRelativePath == "Original.md");
        await File.AppendAllTextAsync(original, "next bytes\n");
        await AwaitFact(watcher, fact => fact.NativeAction == 3 && fact.RawNewRelativePath == "Original.md");
        string renamed = Path.Combine(fixture.RootPath, "Renamed.md");
        File.Move(original, renamed);
        IReadOnlyList<WindowsVaultRawFact> rename = await AwaitFacts(watcher, facts =>
            facts.Any(fact => fact.NativeAction == 4 && fact.RawOldRelativePath == "Original.md")
                && facts.Any(fact => fact.NativeAction == 5 && fact.RawNewRelativePath == "Renamed.md"));
        Assert.All(rename, fact => Assert.Null(fact.CookieDiagnostic));
        File.Delete(renamed);
        await AwaitFact(watcher, fact => fact.NativeAction == 2 && fact.RawOldRelativePath == "Renamed.md");
        Assert.False(watcher.Watermark.IsValid);
    }

    [Fact]
    public async Task RealNtfsTruncatePartialWriteAndTempReplaceNeverProduceContentOrCleanState()
    {
        using var fixture = new WindowsVaultNtfsFixture();
        string path = Path.Combine(fixture.RootPath, "article.md");
        await File.WriteAllTextAsync(path, "initial private bytes");
        using WindowsVaultWatcherSession watcher = fixture.Start();
        await watcher.NativeStarted.WaitAsync(TimeSpan.FromSeconds(5));
        _ = watcher.ReadAvailable();
        using (var writer = new FileStream(path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
        {
            writer.SetLength(0);
            writer.Flush(true);
            await AwaitFact(watcher, fact => fact.NativeAction == 3);
            writer.Write([0xEF, 0xBB, 0xBF, 0x41]);
            writer.Flush(true);
            await AwaitFact(watcher, fact => fact.NativeAction == 3);
            writer.Write([0x0D, 0x0A, 0x42]);
            writer.Flush(true);
            await AwaitFact(watcher, fact => fact.NativeAction == 3);
        }

        string temporary = Path.Combine(fixture.RootPath, "save.tmp");
        await File.WriteAllTextAsync(temporary, "replacement private bytes");
        await AwaitFact(watcher, fact => fact.NativeAction == 1 && fact.RawNewRelativePath == "save.tmp");
        File.Replace(temporary, path, null);
        IReadOnlyList<WindowsVaultRawFact> replacement = await AwaitFacts(watcher,
            facts => facts.Any(fact => fact.RawNewRelativePath == "article.md"
                || fact.RawOldRelativePath == "article.md"));
        Assert.All(replacement, fact =>
        {
            Assert.Null(fact.SourceContentDigest);
            Assert.False(fact.WatermarkValid);
        });
        Assert.Equal("replacement private bytes", await File.ReadAllTextAsync(path));
    }

    [Fact]
    public async Task RealNtfsRestartAndCancellationCloseOwnedHandlesAndLeaveUserBytes()
    {
        using var fixture = new WindowsVaultNtfsFixture();
        string path = Path.Combine(fixture.RootPath, "retained.md");
        await File.WriteAllTextAsync(path, "keep exact user fixture");
        int handlesBefore = Process.GetCurrentProcess().HandleCount;
        string? previousInstance = null;
        for (int index = 0; index < 12; index++)
        {
            WindowsVaultWatcherSession watcher = fixture.Start();
            await watcher.NativeStarted.WaitAsync(TimeSpan.FromSeconds(5));
            WindowsVaultRawFact restart = Assert.Single(watcher.ReadAvailable());
            Assert.Equal(1, restart.Sequence);
            Assert.True(restart.RescanRequired);
            Assert.NotEqual(previousInstance, watcher.Identity.WatchInstanceIdentity);
            previousInstance = watcher.Identity.WatchInstanceIdentity;
            watcher.Dispose();
            watcher.Dispose();
            Assert.Throws<ObjectDisposedException>(() => watcher.ReadAvailable());
        }

        Assert.InRange(Process.GetCurrentProcess().HandleCount - handlesBefore, -16, 8);
        Assert.Equal("keep exact user fixture", await File.ReadAllTextAsync(path));
    }

    [Fact]
    public async Task RealNtfsManagedBurstOverflowIsObservableAndBounded()
    {
        using var fixture = new WindowsVaultNtfsFixture();
        using WindowsVaultWatcherSession watcher = fixture.Start(new(QueueCapacity: 8));
        await watcher.NativeStarted.WaitAsync(TimeSpan.FromSeconds(5));
        _ = watcher.ReadAvailable();
        for (int index = 0; index < 512; index++)
        {
            await File.WriteAllTextAsync(Path.Combine(fixture.RootPath, $"burst-{index}.md"), "fixture");
        }

        IReadOnlyList<WindowsVaultRawFact> facts = await AwaitFacts(watcher,
            batch => batch.Any(fact => fact.FactClass == WindowsVaultFactClass.BufferOverflow));
        Assert.InRange(facts.Count, 1, 8);
        Assert.False(watcher.Watermark.IsValid);
        Assert.Contains(facts, fact => fact.RescanRequired);
    }

    [Fact]
    public async Task RealNtfsKernelBufferOverflowRequiresEnumeration()
    {
        using var fixture = new WindowsVaultNtfsFixture();
        using var handle = fixture.OpenDirectory();
        using var stop = new CancellationTokenSource();
        using var releaseReader = new ManualResetEventSlim();
        var queued = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var firstRead = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var overflow = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        Task observation = Task.Factory.StartNew(() =>
            WindowsDirectoryChangesNative.Observe(handle, 4096, stop.Token, _ =>
            {
                firstRead.TrySetResult();
                releaseReader.Wait(stop.Token);
            }, error => overflow.TrySetResult(error), () => queued.TrySetResult()),
            stop.Token, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        try
        {
            await queued.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await File.WriteAllTextAsync(Path.Combine(fixture.RootPath, "first.md"), "fixture");
            await firstRead.Task.WaitAsync(TimeSpan.FromSeconds(5));
            // Hold completion delivery while genuine NTFS changes exceed the fixed kernel buffer.
            for (int index = 0; index < 512; index++)
            {
                string name = new string('a', 160) + $"-{index}.md";
                await File.WriteAllTextAsync(Path.Combine(fixture.RootPath, name), "fixture");
            }

            releaseReader.Set();
            Assert.Equal(WindowsDirectoryChangesNative.NotifyEnumerationRequired,
                await overflow.Task.WaitAsync(TimeSpan.FromSeconds(10)));
        }
        finally
        {
            releaseReader.Set();
            stop.Cancel();
            await observation.WaitAsync(TimeSpan.FromSeconds(10));
        }
    }

    private static async Task AwaitFact(WindowsVaultWatcherSession watcher, Func<WindowsVaultRawFact, bool> predicate)
        => _ = await AwaitFacts(watcher, facts => facts.Any(predicate));

    private static async Task<IReadOnlyList<WindowsVaultRawFact>> AwaitFacts(WindowsVaultWatcherSession watcher,
        Func<IReadOnlyList<WindowsVaultRawFact>, bool> complete)
    {
        var facts = new List<WindowsVaultRawFact>();
        long start = Stopwatch.GetTimestamp();
        while (Stopwatch.GetElapsedTime(start) < TimeSpan.FromSeconds(10))
        {
            facts.AddRange(watcher.ReadAvailable());
            Assert.All(facts, fact => Assert.True(WindowsVaultRawFactCodec.Verify(fact, watcher.Identity)));
            if (complete(facts))
            {
                return facts;
            }

            await Task.Delay(10);
        }

        Assert.Fail("Required real NTFS raw fact was not observed before the bound.");
        return facts;
    }
}
