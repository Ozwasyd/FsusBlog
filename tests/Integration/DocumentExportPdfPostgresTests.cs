namespace FsusBlog.V2.Integration.Tests;

public sealed partial class DocumentExportPostgresTests
{
    private readonly ITestOutputHelper _evidence;

    public DocumentExportPostgresTests(ITestOutputHelper evidence) => _evidence = evidence;

    [MacPdfTaskPostgresFact]
    public async Task CancelsAnOwnedRunningPdfAndReleasesItsRendererBeforeTimeout()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var owner = await Login(fixture, "Running PDF cancellation", canAuthor: true, ct);
        var scratch = Directory.CreateTempSubdirectory("fsusv2-async-pdf-witness-");
        using (new MediaFixture.DirectoryCleanup(scratch))
        {
            var (settings, python) = PdfSettings(scratch.FullName);
            await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, settings);
            using var beforeRendererDeadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            beforeRendererDeadline.CancelAfter(TimeSpan.FromSeconds(10));
            var exp = new ExportClient(server.Client, owner, ct);
            var bounded = new ExportClient(server.Client, owner, beforeRendererDeadline.Token);
            var draft = await exp.Save(0, 0, "PDF cancellation 中文", LongPdfSource());
            var job = Guid.NewGuid();
            var started = Stopwatch.StartNew();
            await bounded.CreateTask(job, draft, draft.Revision, DocumentExportFormat.Pdf);
            var renderer = await PauseRenderer(server, scratch.FullName, python, beforeRendererDeadline.Token);
            try
            {
                var running = Assert.Single(await bounded.List(draft.Id), task => task.Request.Id == job);
                Assert.Equal((DocumentExportState.Running, 0), (running.State, running.OutputBytes));
                Assert.Equal(DocumentExportState.Cancelling, (await bounded.Cancel(job)).State);
                var cancelled = await bounded.Await(draft.Id, job, DocumentExportState.Cancelled);
                Assert.Equal(0, cancelled.OutputBytes);
                Assert.Null(cancelled.OutputDigest);
                await bounded.Reject(WireRoutes.DocumentExportDownload, Reference(job), NotFound);
                await RequireReleased(renderer, beforeRendererDeadline.Token);
                _evidence.WriteLine($"Owned renderer {renderer.Pid} was stopped before cancel. Receipt 2→7→5, no output, process and scratch released after {started.ElapsedMilliseconds} ms from enqueue.");
            }
            finally { await ResumeIfStillOwned(server, scratch.FullName, python, renderer); }

            var small = await exp.Save(0, 0, "Small PDF 中文", "An actual PDF after cancellation.\n");
            var next = Guid.NewGuid();
            await exp.CreateTask(next, small, small.Revision, DocumentExportFormat.Pdf);
            var completed = await exp.Await(small.Id, next, DocumentExportState.Succeeded);
            var bytes = await exp.Download(completed, "application/pdf", "article.pdf");
            ExportResponseFixture.AssertPdfBytes(bytes);
            Assert.Empty(scratch.EnumerateDirectories("fsusv2-pdf-*"));
            _evidence.WriteLine($"A subsequent real PDF used the released renderer. {bytes.Length} bytes, SHA-256 {Convert.ToHexStringLower(SHA256.HashData(bytes))}.");
        }
    }

    [MacPdfTaskPostgresFact]
    public Task RestartsAfterLeaseLossInterruptsRealPdfAndFinishesTheQueuedJob() => InterruptPdf(leaseLoss: true);

    [MacPdfTaskPostgresFact]
    public Task RestartsAfterSigtermInterruptsRealPdfAndFinishesTheQueuedJob() => InterruptPdf(leaseLoss: false);

    private async Task InterruptPdf(bool leaseLoss)
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var owner = await Login(fixture, "Running PDF interruption", canAuthor: true, ct);
        var scratch = Directory.CreateTempSubdirectory("fsusv2-async-pdf-restart-");
        using (new MediaFixture.DirectoryCleanup(scratch))
        {
            var (settings, python) = PdfSettings(scratch.FullName);
            var runningId = Guid.NewGuid();
            var queuedId = Guid.NewGuid();
            Draft draft;
            await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct, settings))
            {
                using var beforeRendererDeadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                beforeRendererDeadline.CancelAfter(TimeSpan.FromSeconds(10));
                var bounded = new ExportClient(server.Client, owner, beforeRendererDeadline.Token);
                draft = await new ExportClient(server.Client, owner, ct).Save(0, 0, "PDF interruption 中文", LongPdfSource(leaseLoss ? 80 : 240));
                await bounded.CreateTask(runningId, draft, draft.Revision, DocumentExportFormat.Pdf);
                var waiting = await bounded.CreateTask(queuedId, draft, draft.Revision, DocumentExportFormat.Html);
                Assert.Equal(DocumentExportState.Queued, waiting.State);
                // A stopped child can delay .NET's SIGCHLD handler on macOS. Graceful shutdown uses a running child.
                var renderer = leaseLoss
                    ? await PauseRenderer(server, scratch.FullName, python, beforeRendererDeadline.Token)
                    : await WaitForRenderer(server, scratch.FullName, python, beforeRendererDeadline.Token);
                try
                {
                    var pending = await bounded.List(draft.Id);
                    Assert.Equal(DocumentExportState.Queued, Assert.Single(pending, task => task.Request.Id == queuedId).State);
                    Assert.Equal(DocumentExportState.Running, Assert.Single(pending, task => task.Request.Id == runningId).State);
                    var interruption = Stopwatch.StartNew();
                    if (leaseLoss)
                    {
                        Assert.True(await fixture.TerminateAdvisoryOwner(PublicationLocks.Ownership, ct: beforeRendererDeadline.Token));
                        await RequireReleased(renderer, beforeRendererDeadline.Token);
                        await bounded.Reject(ListRoute(draft.Id), null, ServiceUnavailable);
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
                catch { _evidence.WriteLine(server.Logs); throw; }
                finally { if (leaseLoss) await ResumeIfStillOwned(server, scratch.FullName, python, renderer); }
            }

            await using var restarted = await ServerProcess.Start(fixture.ConnectionString, ct, settings);
            var exp = new ExportClient(restarted.Client, owner, ct);
            var failed = await exp.Await(draft.Id, runningId, DocumentExportState.Failed);
            Assert.Equal((DocumentExportFailure.Interrupted, 0), (failed.Failure, failed.OutputBytes));
            await exp.Reject(WireRoutes.DocumentExportDownload, Reference(runningId), NotFound);
            var completed = await exp.Await(draft.Id, queuedId, DocumentExportState.Succeeded);
            var html = await exp.Download(completed, "text/html", "article.html");
            Assert.Contains("<h2>Renderer section 70</h2>", Encoding.UTF8.GetString(html), StringComparison.Ordinal);
            _evidence.WriteLine("Restart sealed the interrupted PDF as Failed/Interrupted and served the previously queued HTML attachment.");
        }
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
            [rootKey] = root, [digestKey] = digest, ["TMPDIR"] = scratch, ["DOTNET_EnableDiagnostics"] = "0",
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
        catch { await ResumeIfStillOwned(server, scratch, python, found); throw; }
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
        var result = await FixtureProcess.Run(FixtureProcess.Command(executable, arguments), ct);
        Assert.Equal(0, result.Code);
        return result.Output;
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
