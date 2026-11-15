using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using FsusBlogV2.Storage;
using Npgsql;
using Xunit.Abstractions;

namespace FsusBlog.V2.Integration.Tests;

public sealed partial class DocumentExportPostgresTests
{
    private readonly ITestOutputHelper _evidence;

    public DocumentExportPostgresTests(ITestOutputHelper evidence) => _evidence = evidence;

    [MacPdfTaskPostgresFact]
    public async Task CancelsAnOwnedRunningPdfAndReleasesItsRendererBeforeTimeout()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var owner = await Login(db, new Store(fixture.DataSource), "Running PDF cancellation", canAuthor: true, ct);
        var scratch = Directory.CreateTempSubdirectory("fsusv2-async-pdf-witness-");
        try
        {
            var (settings, python) = PdfSettings(scratch.FullName);
            await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, settings);
            var draft = await Save(server.Client, owner, 0, 0, "PDF cancellation 中文", LongPdfSource(), ct);
            var job = Guid.NewGuid();
            using var beforeRendererDeadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            beforeRendererDeadline.CancelAfter(TimeSpan.FromSeconds(10));
            var started = Stopwatch.StartNew();
            await ReadTask(server.Client, CreateRoute, owner, Create(job, draft.Id, draft.Revision, draft.Revision, format: 2), beforeRendererDeadline.Token);
            var renderer = await PauseRenderer(server, scratch.FullName, python, beforeRendererDeadline.Token);
            try
            {
                var running = Assert.Single(await List(server.Client, owner, draft.Id, beforeRendererDeadline.Token), task => task.Id == job);
                Assert.Equal(Running, running.State);
                Assert.Equal(0, running.Length);
                var stopping = await ReadTask(server.Client, CancelRoute, owner, Reference(job), beforeRendererDeadline.Token);
                Assert.Equal(Cancelling, stopping.State);
                var cancelled = await AwaitTask(server.Client, owner, draft.Id, job, Cancelled, beforeRendererDeadline.Token);
                Assert.Equal(0, cancelled.Length);
                Assert.All(cancelled.OutputDigest, value => Assert.Equal(0, value));
                await Reject(server.Client, DownloadRoute, owner, Reference(job), HttpStatusCode.NotFound, beforeRendererDeadline.Token);
                await RequireReleased(renderer, beforeRendererDeadline.Token);
                _evidence.WriteLine($"Owned renderer {renderer.Pid} was stopped before cancel. Receipt 2→7→5, no output, process and scratch released after {started.ElapsedMilliseconds} ms from enqueue.");
            }
            finally
            {
                await ResumeIfStillOwned(server, scratch.FullName, python, renderer);
            }

            var small = await Save(server.Client, owner, 0, 0, "Small PDF 中文", "An actual PDF after cancellation.\n", ct);
            var next = Guid.NewGuid();
            await ReadTask(server.Client, CreateRoute, owner, Create(next, small.Id, small.Revision, small.Revision, format: 2), ct);
            var completed = await AwaitTask(server.Client, owner, small.Id, next, Succeeded, ct);
            var bytes = await Download(server.Client, owner, completed, "application/pdf", "article.pdf", ct);
            Assert.Equal("%PDF-", Encoding.ASCII.GetString(bytes, 0, 5));
            Assert.EndsWith("%%EOF", Encoding.ASCII.GetString(bytes[^16..]).TrimEnd(), StringComparison.Ordinal);
            Assert.Empty(scratch.EnumerateDirectories("fsusv2-pdf-*"));
            _evidence.WriteLine($"A subsequent real PDF used the released renderer. {bytes.Length} bytes, SHA-256 {Convert.ToHexStringLower(SHA256.HashData(bytes))}.");
        }
        finally
        {
            scratch.Delete(recursive: true);
        }
    }

    [MacPdfTaskPostgresFact]
    public Task RestartsAfterLeaseLossInterruptsRealPdfAndFinishesTheQueuedJob() => InterruptPdf(leaseLoss: true);

    [MacPdfTaskPostgresFact]
    public Task RestartsAfterSigtermInterruptsRealPdfAndFinishesTheQueuedJob() => InterruptPdf(leaseLoss: false);

    private async Task InterruptPdf(bool leaseLoss)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var owner = await Login(db, new Store(fixture.DataSource), "Running PDF interruption", canAuthor: true, ct);
        var scratch = Directory.CreateTempSubdirectory("fsusv2-async-pdf-restart-");
        try
        {
            var (settings, python) = PdfSettings(scratch.FullName);
            var runningId = Guid.NewGuid();
            var queuedId = Guid.NewGuid();
            Draft draft;
            await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct, settings))
            {
                draft = await Save(server.Client, owner, 0, 0, "PDF interruption 中文", LongPdfSource(leaseLoss ? 80 : 240), ct);
                using var beforeRendererDeadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                beforeRendererDeadline.CancelAfter(TimeSpan.FromSeconds(10));
                await ReadTask(server.Client, CreateRoute, owner, Create(runningId, draft.Id, draft.Revision, draft.Revision, 2), beforeRendererDeadline.Token);
                var waiting = await ReadTask(server.Client, CreateRoute, owner, Create(queuedId, draft.Id, draft.Revision, draft.Revision, 1),
                    beforeRendererDeadline.Token);
                Assert.Equal(Queued, waiting.State);
                // A stopped child can delay .NET's SIGCHLD handler on macOS. Graceful shutdown uses a running child.
                var renderer = leaseLoss
                    ? await PauseRenderer(server, scratch.FullName, python, beforeRendererDeadline.Token)
                    : await WaitForRenderer(server, scratch.FullName, python, beforeRendererDeadline.Token);
                try
                {
                    var pending = await List(server.Client, owner, draft.Id, beforeRendererDeadline.Token);
                    Assert.Equal(Queued, Assert.Single(pending, task => task.Id == queuedId).State);
                    Assert.Equal(Running, Assert.Single(pending, task => task.Id == runningId).State);
                    var interruption = Stopwatch.StartNew();
                    if (leaseLoss)
                    {
                        await BreakFixtureLease(db, beforeRendererDeadline.Token);
                        await RequireReleased(renderer, beforeRendererDeadline.Token);
                        await RejectList(server.Client, draft.Id, owner, HttpStatusCode.ServiceUnavailable, beforeRendererDeadline.Token);
                        _evidence.WriteLine($"Lease loss closed task requests and released owned renderer {renderer.Pid} and its scratch after {interruption.ElapsedMilliseconds} ms.");
                    }
                    else
                    {
                        Assert.NotEqual('T', renderer.State);
                        await Signal(server.ProcessId, "-TERM", beforeRendererDeadline.Token);
                        await RequireReleased(renderer, beforeRendererDeadline.Token);
                        await server.WaitForExitAsync(beforeRendererDeadline.Token);
                        Assert.Contains("Application is shutting down", server.Logs, StringComparison.Ordinal);
                        _evidence.WriteLine($"SIGTERM released running renderer {renderer.Pid} (state {renderer.State}) and its scratch, and stopped Kestrel after {interruption.ElapsedMilliseconds} ms.");
                    }
                }
                catch
                {
                    _evidence.WriteLine(server.Logs);
                    throw;
                }
                finally
                {
                    if (leaseLoss) await ResumeIfStillOwned(server, scratch.FullName, python, renderer);
                }
            }

            await using var restarted = await ServerProcess.Start(fixture.ConnectionString, ct, settings);
            var failed = await AwaitTask(restarted.Client, owner, draft.Id, runningId, (byte)DocumentExportState.Failed, ct);
            Assert.Equal((byte)DocumentExportFailure.Interrupted, failed.Failure);
            Assert.Equal(0, failed.Length);
            await Reject(restarted.Client, DownloadRoute, owner, Reference(runningId), HttpStatusCode.NotFound, ct);
            var completed = await AwaitTask(restarted.Client, owner, draft.Id, queuedId, Succeeded, ct);
            var html = await Download(restarted.Client, owner, completed, "text/html", "article.html", ct);
            Assert.Contains("<h2>Renderer section 70</h2>", Encoding.UTF8.GetString(html), StringComparison.Ordinal);
            _evidence.WriteLine("Restart sealed the interrupted PDF as Failed/Interrupted and served the previously queued HTML attachment.");
        }
        finally
        {
            scratch.Delete(recursive: true);
        }
    }

    private static async Task BreakFixtureLease(NpgsqlConnection db, CancellationToken ct)
    {
        await using var release = Store.Sql(db, null, """
            select pg_catalog.pg_terminate_backend(l.pid, 5000) from pg_catalog.pg_locks l
            where l.database=(select oid from pg_catalog.pg_database where datname=current_database())
              and l.locktype='advisory' and l.mode='ExclusiveLock' and l.granted and l.objsubid=1
              and ((l.classid::bigint << 32) | l.objid::bigint)=$1
            """, PublicationLocks.Ownership);
        Assert.Equal(true, await release.ExecuteScalarAsync(ct));
    }

    private static (IReadOnlyDictionary<string, string> Settings, string Python) PdfSettings(string scratch)
    {
        const string rootKey = "FSUSBLOG_PDF_TOOL_ROOT";
        const string digestKey = "FSUSBLOG_PDF_TOOL_SHA256";
        var root = Environment.GetEnvironmentVariable(rootKey);
        var digest = Environment.GetEnvironmentVariable(digestKey);
        Assert.False(string.IsNullOrWhiteSpace(root), $"Set {rootKey} to the pinned macOS PDF toolchain.");
        Assert.False(string.IsNullOrWhiteSpace(digest), $"Set {digestKey} to the approved manifest SHA-256.");
        var manifest = File.ReadAllBytes(Path.Combine(root, "toolchain.json"));
        Assert.Equal(digest, Convert.ToHexStringLower(SHA256.HashData(manifest)));
        using var configuration = JsonDocument.Parse(manifest);
        var python = configuration.RootElement.GetProperty("python").GetString();
        Assert.False(string.IsNullOrWhiteSpace(python));
        Assert.True(Path.IsPathFullyQualified(python));
        return (new Dictionary<string, string>(Settings)
        {
            [rootKey] = root,
            [digestKey] = digest,
            ["TMPDIR"] = scratch,
            ["DOTNET_EnableDiagnostics"] = "0",
        }, python);
    }

    private static string LongPdfSource(int sections = 80) => string.Concat(Enumerable.Range(1, sections).Select(index =>
        FormattableString.Invariant($"## Renderer section {index}\n\n中文段落验证离线字体与排版。A printable sentence uses the approved font.\n\n")));

    private static async Task<Renderer> PauseRenderer(ServerProcess server, string scratch, string python, CancellationToken ct)
    {
        var found = await WaitForRenderer(server, scratch, python, ct);
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(20));
        await Signal(found.Pid, "-STOP", ct);
        try
        {
            do
            {
                var stopped = await FindRenderer(server, scratch, python, ct);
                if (stopped is { State: 'T' } && stopped.SameAs(found)) return stopped;
            } while (await timer.WaitForNextTickAsync(ct));
            throw new InvalidOperationException("The owned renderer did not stop.");
        }
        catch
        {
            await ResumeIfStillOwned(server, scratch, python, found);
            throw;
        }
    }

    private static async Task<Renderer> WaitForRenderer(ServerProcess server, string scratch, string python, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(20));
        do
        {
            if (await FindRenderer(server, scratch, python, ct) is { } renderer) return renderer;
        } while (await timer.WaitForNextTickAsync(ct));
        throw new InvalidOperationException("The owned renderer did not start.");
    }

    private static async Task<Renderer?> FindRenderer(ServerProcess server, string scratch, string python, CancellationToken ct)
    {
        var workerDirs = Directory.EnumerateDirectories(scratch, "fsusv2-pdf-*")
            .Where(path => File.Exists(Path.Combine(path, "fonts.conf"))).ToArray();
        if (workerDirs.Length == 0) return null;
        var processes = await RunTool("/bin/ps", ["-axww", "-o", "pid=,ppid=,state=,command="], ct);
        foreach (var line in processes.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var fields = line.Split((char[]?)null, 4, StringSplitOptions.RemoveEmptyEntries);
            if (fields.Length != 4 || !int.TryParse(fields[1], NumberStyles.None, CultureInfo.InvariantCulture, out var parent) ||
                parent != server.ProcessId || !int.TryParse(fields[0], NumberStyles.None, CultureInfo.InvariantCulture, out var pid))
                continue;
            var directory = workerDirs.FirstOrDefault(path =>
                fields[3].StartsWith($"{python} -I -B {Path.Combine(path, "worker.py")} ", StringComparison.Ordinal));
            if (directory is not null && StartedAt(pid) is { } started)
                return new(pid, started, fields[2][0], directory);
        }
        return null;
    }

    private static async Task ResumeIfStillOwned(ServerProcess server, string scratch, string python, Renderer renderer)
    {
        using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var observed = await FindRenderer(server, scratch, python, cleanup.Token);
        if (observed is { State: 'T' } && observed.SameAs(renderer))
            await Signal(observed.Pid, "-CONT", cleanup.Token);
    }

    private static Task RequireReleased(Renderer renderer, CancellationToken ct) =>
        Poll(_ => Task.FromResult(StartedAt(renderer.Pid) != renderer.Started && !Directory.Exists(renderer.Scratch)),
            "The owned PDF subprocess or scratch survived its export operation.", ct);

    private static DateTime? StartedAt(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.StartTime;
        }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            // ps may have observed a process that exited before .NET acquired its handle.
            return null;
        }
    }

    private static Task<string> Signal(int pid, string signal, CancellationToken ct) =>
        RunTool("/bin/kill", [signal, pid.ToString(CultureInfo.InvariantCulture)], ct);

    private static async Task<string> RunTool(string executable, string[] arguments, CancellationToken ct)
    {
        var info = new ProcessStartInfo(executable) { UseShellExecute = false, RedirectStandardOutput = true };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        using var process = Process.Start(info) ?? throw new InvalidOperationException($"Could not start {executable}.");
        var output = await process.StandardOutput.ReadToEndAsync(ct);
        await process.WaitForExitAsync(ct);
        Assert.Equal(0, process.ExitCode);
        return output;
    }

    private sealed record Renderer(int Pid, DateTime Started, char State, string Scratch)
    {
        internal bool SameAs(Renderer other) => Pid == other.Pid && Started == other.Started && Scratch == other.Scratch;
    }
}

internal sealed class MacPdfTaskPostgresFactAttribute : FactAttribute
{
    public MacPdfTaskPostgresFactAttribute()
    {
        if (!OperatingSystem.IsMacOS() || Environment.GetEnvironmentVariable("FSUSBLOG_TEST_PDF") != "1" ||
            string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)))
            Skip = "Set FSUSBLOG_TEST_PDF and FSUSBLOG_TEST_DB on macOS to run the real PDF task fixture.";
    }
}
