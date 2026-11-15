using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Extensions;

namespace FsusBlog.V2.Server.Authoring;

internal sealed class PdfDocumentExport(Func<byte[], CancellationToken, Task<byte[]>> render)
{
    internal const string ContentType = "application/pdf";
    internal const string RatePolicy = "pdf-export";
    internal const string PageMarker = "<meta name=\"fsus-pdf-export\" content=\"1\">";
    private const int MaximumInput = 384 * 1024;
    internal const int MaximumOutput = 4 * 1024 * 1024;
    private const int MaximumMarkdown = 256 * 1024;
    private const string Sandbox = "/usr/bin/sandbox-exec";
    private const string Env = "/usr/bin/env";
    private static readonly byte[] ReadyBytes = "FSUS-PDF-1\n"u8.ToArray();
    private readonly SemaphoreSlim rendererSlot = new(1, 1);
    internal byte[]? ToolDigest { get; private init; }
    internal static ReadOnlyMemory<byte> Ready => ReadyBytes;

    internal static PdfDocumentExport? Read(IConfiguration configuration)
    {
        var root = configuration["FSUSBLOG_PDF_TOOL_ROOT"];
        var digest = configuration["FSUSBLOG_PDF_TOOL_SHA256"];
        if (string.IsNullOrEmpty(root) && string.IsNullOrEmpty(digest)) return null;
        if (OperatingSystem.IsLinux())
            return new(LinuxPdfRuntime.Read(root, digest).RenderAsync) { ToolDigest = Convert.FromHexString(digest!) };
        if (!OperatingSystem.IsMacOS() || !File.Exists(Sandbox) || !File.Exists(Env))
            throw new InvalidOperationException("Offline PDF requires a supported sandbox host.");
        return new(new MacRuntime(PdfExportToolchain.Read(root, digest)).RenderAsync) { ToolDigest = Convert.FromHexString(digest!) };
    }

    internal async Task<byte[]> WriteAsync(string title, string markdown, DateTimeOffset happenedAt, CancellationToken ct,
        bool includeTables = true)
    {
        ct.ThrowIfCancellationRequested();
        if (Encoding.UTF8.GetByteCount(markdown) > MaximumMarkdown) throw HtmlDocumentExport.TooLarge("PDF");
        var body = HtmlDocumentExport.RenderBody(title, markdown, "PDF", ct, includeTables);
        var created = happenedAt.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
        var document = HtmlDocumentExport.Wrap(title, body, $"<meta name=\"dcterms.created\" content=\"{created}\">");
        if (Encoding.UTF8.GetByteCount(document) > MaximumInput) throw HtmlDocumentExport.TooLarge("PDF");

        await rendererSlot.WaitAsync(ct);
        try
        {
            ct.ThrowIfCancellationRequested();
            return await render(Encoding.UTF8.GetBytes(document), ct);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new PublicUnavailableException(); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or Win32Exception or
            ExtensionRejectedException or InvalidOperationException or TimeoutException)
        {
            // An engine error or its stderr must never appear in the public response or service log.
            throw new PublicUnavailableException();
        }
        finally { rendererSlot.Release(); }
    }

    private static Stream OpenWorker() => typeof(PdfDocumentExport).Assembly.GetManifestResourceStream("FsusBlog.PdfRender")
        ?? throw new InvalidOperationException("The offline PDF worker resource is missing.");

    internal static byte[] Accept(int exit, byte[] result, byte[] errors)
    {
        if (exit == 2 && result.Length == 0)
        {
            Exception rejection = Encoding.ASCII.GetString(errors).TrimEnd('\n', '\r') switch
            {
                "pdf-glyphs" => new BusinessException(Rejection.Invalid, "Offline PDF cannot display one or more characters in this revision."),
                "pdf-resources" => new BusinessException(Rejection.Invalid, "Offline PDF could not render the revision without external resources."),
                "pdf-budget" => HtmlDocumentExport.TooLarge("PDF"),
                _ => new PublicUnavailableException()
            };
            throw rejection;
        }
        if (exit != 0 || errors.Length != 0 || !result.AsSpan().StartsWith("%PDF-"u8))
            throw new PublicUnavailableException();
        return result;
    }

    private sealed class MacRuntime(PdfExportToolchain toolchain)
    {
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
    }

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
            var ready = new byte[Ready.Length];
            await pipe.ReadExactlyAsync(ready, deadline.Token);
            if (!ready.AsSpan().SequenceEqual(Ready.Span)) throw new PublicUnavailableException();

            stdout = ReadBounded(pipe, MaximumOutput, deadline.Token);
            await process.StandardInput.BaseStream.WriteAsync(request, deadline.Token);
            process.StandardInput.Close();
            var result = await stdout;
            var errors = await stderr;
            await process.WaitForExitAsync(deadline.Token);
            return Accept(process.ExitCode, result, errors);
        }, () => PluginWorkerCompletion.ReleaseProcessAsync(deadline,
            () => PluginWorkerCompletion.ReapProcessAsync(process, entireProcessTree: true, TimeSpan.FromSeconds(2)), stdout, stderr));
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
