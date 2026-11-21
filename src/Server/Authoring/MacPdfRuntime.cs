using System.Diagnostics;
using FsusBlog.V2.Core.Extensions;
using FsusBlog.V2.Platform.Extensions;

namespace FsusBlog.V2.Server.Authoring;

internal sealed class MacPdfRuntime(PdfExportToolchain toolchain)
{
    internal const string Sandbox = "/usr/bin/sandbox-exec";
    internal const string Env = "/usr/bin/env";

    internal async Task<byte[]> RenderAsync(byte[] request, CancellationToken ct)
    {
        var scratch = Directory.CreateTempSubdirectory("fsusv2-pdf-");
        return await PluginWorkerCompletion.RunAsync(async () =>
        {
            var workerPath = Path.Combine(scratch.FullName, "worker.py");
            await using (var worker = OpenWorker())
            await using (var target = File.Open(workerPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                await worker.CopyToAsync(target, ct);
            return await RunProcess(BuildStart(scratch.FullName, workerPath), request, ct);
        }, () => { scratch.Delete(recursive: true); return Task.CompletedTask; });
    }

    private ProcessStartInfo BuildStart(string scratch, string workerPath)
    {
        static string Quoted(string path) => "\"" + path.Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal) + "\"";
        static string Literal(string path) => $"(literal {Quoted(path)})";
        static string Subpath(string path) => $"(subpath {Quoted(path)})";

        var scratchRule = Subpath(scratch);
        if (scratch.StartsWith("/var/", StringComparison.Ordinal) || scratch.StartsWith("/tmp/", StringComparison.Ordinal))
            scratchRule += " " + Subpath("/private" + scratch);
        var runtime = string.Join(' ', toolchain.ReadRoots.Prepend(toolchain.Root).Select(Subpath));
        var executable = $"{Literal(toolchain.Python)} {Literal(toolchain.ResolvedPython)}";
        var profile = $"""
            (version 1)
            (deny default)
            (allow process-info* (target self))
            (allow process-exec (literal "{Env}") {executable})
            (allow file-read-metadata)
            (allow file-read* {runtime} {scratchRule} {executable} {Literal(toolchain.Font)}
                (subpath "/System/Library") (subpath "/usr/lib") (literal "{Env}")
                (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
            (allow file-map-executable {runtime} {executable}
                (subpath "/System/Library") (subpath "/usr/lib") (literal "{Env}"))
            (allow file-write* {scratchRule} (literal "/dev/null"))
            (allow signal (target self))
            (allow sysctl-read)
            (allow mach-bootstrap)
            (allow mach-lookup (global-name "com.apple.system.logger"))
            """;
        var start = new ProcessStartInfo(Sandbox)
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = scratch
        };
        start.Environment.Clear();
        start.Environment["HOME"] = scratch;
        start.Environment["TMPDIR"] = scratch;
        start.Environment["XDG_CACHE_HOME"] = scratch;
        start.Environment["TZ"] = "UTC";
        // sandbox-exec is a platform binary. Set the loader path on the fixed env command after it applies Seatbelt.
        foreach (var argument in new[] { "-p", profile, Env,
            "DYLD_FALLBACK_LIBRARY_PATH=" + string.Join(':', toolchain.LibraryRoots),
            toolchain.Python, "-I", "-B", workerPath, toolchain.Font, toolchain.FontDigest, scratch })
            start.ArgumentList.Add(argument);
        return start;
    }

    private static Stream OpenWorker() => typeof(MacPdfRuntime).Assembly.GetManifestResourceStream("FsusBlog.PdfRender")
        ?? throw new InvalidOperationException("The offline PDF worker resource is missing.");

    private static async Task<byte[]> RunProcess(ProcessStartInfo start, byte[] request, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(12));
        deadline.Token.ThrowIfCancellationRequested();
        using var process = Process.Start(start) ?? throw new PublicUnavailableException();
        Task<byte[]>? stdout = null;
        Task<byte[]>? stderr = null;
        return await PluginWorkerCompletion.RunAsync(async () =>
        {
            stderr = ReadBounded(process.StandardError.BaseStream, 4096, deadline.Token);
            var pipe = process.StandardOutput.BaseStream;
            var ready = new byte[PdfWorkerProtocol.Ready.Length];
            await pipe.ReadExactlyAsync(ready, deadline.Token);
            if (!ready.AsSpan().SequenceEqual(PdfWorkerProtocol.Ready.Span)) throw new PublicUnavailableException();

            stdout = ReadBounded(pipe, PdfWorkerProtocol.MaximumOutput, deadline.Token);
            await process.StandardInput.BaseStream.WriteAsync(request, deadline.Token);
            process.StandardInput.Close();
            var result = await stdout;
            var errors = await stderr;
            await process.WaitForExitAsync(deadline.Token);
            return PdfWorkerProtocol.Accept(process.ExitCode, result, errors);
        }, () => PluginWorkerCompletion.ReleaseProcessAsync(deadline,
            () => WorkerProcess.ReapAsync(process, entireProcessTree: true, TimeSpan.FromSeconds(2)), stdout, stderr));
    }

    private static async Task<byte[]> ReadBounded(Stream stream, int maximum, CancellationToken ct)
    {
        var buffer = new byte[16 * 1024];
        using var bytes = new MemoryStream();
        var read = await stream.ReadAsync(buffer, ct);
        while (read > 0)
        {
            if (bytes.Length + read > maximum) throw new PublicUnavailableException();
            bytes.Write(buffer, 0, read);
            read = await stream.ReadAsync(buffer, ct);
        }
        return bytes.ToArray();
    }
}
