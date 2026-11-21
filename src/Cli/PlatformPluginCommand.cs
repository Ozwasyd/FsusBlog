using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using FsusBlog.V2.Core.Extensions;
using FsusBlog.V2.Platform.Extensions;

namespace FsusBlog.V2.Cli;

internal static class PlatformPluginCommand
{
    private const string ChildCommand = "__pure-platform-plugin-worker";
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly TimeSpan ChildTimeout = TimeSpan.FromSeconds(3);

    internal static bool IsWorker(string[] args) => args is ["platform-plugin", ChildCommand];

    internal static async Task<int> Worker()
    {
        if (!OperatingSystem.IsMacOS() || Environment.GetEnvironmentVariable("FSUSBLOG_PURE_PLUGIN_WORKER") != "1" ||
            !WorkerIsConfined()) return 3;
        return await PurePluginInterpreter.RunAsync(Console.OpenStandardInput(), Console.OpenStandardOutput(), CancellationToken.None);
    }

    private static bool WorkerIsConfined()
    {
        try
        {
            // A sentinel outside the trusted program and runtime directories must never be readable by the worker.
            // Permission denial is tested through libc to retain the exact OS error.
            var file = OpenSentinel("/private/etc/hosts", 0);
            if (file < 0) return Marshal.GetLastPInvokeError() is 1 or 13;
            new Microsoft.Win32.SafeHandles.SafeFileHandle(file, ownsHandle: true).Dispose();
            return false;
        }
        catch (Exception error) when (error is EntryPointNotFoundException or DllNotFoundException) { return false; }
    }

    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int OpenSentinel([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

    internal static async Task<int> RunAsync(string[] args, CancellationToken ct)
    {
        if (args is [] or ["help"] or ["--help"])
        {
            Console.WriteLine("platform-plugin render ID reads Markdown from stdin. Configure FSUSBLOG_PLATFORM_PLUGIN_ROOT for a signed, enabled local package.");
            return 0;
        }
        try
        {
            if (args is not ["render", var id]) throw Deny("plugin-command");
            var linux = OperatingSystem.IsLinux() ? LinuxPluginRunner.Open() : null;
            if (linux is null && (!OperatingSystem.IsMacOS() || !File.Exists("/usr/bin/sandbox-exec")))
                throw Deny("plugin-isolation-unavailable");
            if (Environment.GetEnvironmentVariable("FSUSBLOG_PLATFORM_PLUGIN_ROOT") is not { } root || !Path.IsPathFullyQualified(root))
                throw Deny("plugin-registry-required");
            var input = Utf8.GetString(await PluginWorkerCompletion.ReadAsync(Console.OpenStandardInput(), PureRenderPlugin.MaximumMarkdownBytes, ct));
            await PureRenderInvocation.RunAsync(new(root), id, input, linux is null ? RunIsolatedAsync : linux.RunAsync,
                authorizeResult: null, (result, cancellation) => Console.OpenStandardOutput().WriteAsync(result, cancellation).AsTask(), ct);
            return 0;
        }
        catch (OperationCanceledException error) when (ct.IsCancellationRequested)
        {
            if (PluginWorkerCompletion.CleanupFailure(error) is not null) WriteFailure("plugin-cancelled", error);
            return 130;
        }
        catch (ExtensionRejectedException error)
        {
            WriteFailure(error.Code, error);
            return 1;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException or
            TimeoutException or System.ComponentModel.Win32Exception or NotSupportedException)
        {
            WriteFailure("plugin-local-operation", error);
            return 1;
        }
    }

    private static void WriteFailure(string code, Exception error)
    {
        Console.Error.WriteLine(code);
        if (PluginWorkerCompletion.CleanupFailure(error) is not null)
            Console.Error.WriteLine("cleanup=" + PluginWorkerCompletion.DrainFailure);
    }

    private static async Task<byte[]> RunIsolatedAsync(byte[] request, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var assembly = Assembly.GetExecutingAssembly().Location;
        var framework = new DirectoryInfo(Path.GetDirectoryName(typeof(object).Assembly.Location)!);
        if (framework.Parent is not { Name: "Microsoft.NETCore.App", Parent: { Name: "shared", Parent: { } dotnet } shared } appReference)
            throw Deny("plugin-worker-host");
        var dotnetRoot = dotnet.FullName;
        var executable = Path.Combine(dotnetRoot, "dotnet");
        if (!File.Exists(executable)) throw Deny("plugin-worker-host");
        string[] runtimeDirectories = ["/System/Library", "/usr/lib", Path.Combine(dotnetRoot, "host", "fxr"), framework.FullName,
            Path.GetDirectoryName(assembly)!];
        string[] metadataDirectories = [dotnetRoot, Path.Combine(dotnetRoot, "host"), shared.FullName, appReference.FullName];
        var readRules = string.Join(' ', runtimeDirectories.Distinct(StringComparer.Ordinal).Select(directory =>
            "(subpath " + PathLiteral(directory) + ")"));
        var metadata = string.Join(' ', metadataDirectories.Select(directory => "(literal " + PathLiteral(directory) + ")"));
        var profile = $"""
            (version 1)
            (deny default)
            (allow process-info* (target self))
            (allow process-exec (literal {PathLiteral(executable)}))
            (allow file-read* {readRules} {metadata} (literal {PathLiteral(executable)})
                (literal "/") (literal "/dev/null") (literal "/dev/urandom"))
            (allow file-read-metadata)
            (allow mach-bootstrap)
            (allow file-map-executable {readRules} (literal {PathLiteral(executable)}))
            (allow dynamic-code-generation)
            (allow file-write* (literal "/dev/null"))
            (allow signal (target self))
            (allow sysctl-read)
            (allow mach-lookup (global-name "com.apple.system.logger"))
            """;
        var start = new ProcessStartInfo("/usr/bin/sandbox-exec")
        {
            UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true,
            RedirectStandardError = true, WorkingDirectory = "/"
        };
        start.Environment.Clear();
        start.Environment["DOTNET_EnableDiagnostics"] = "0";
        start.Environment["DOTNET_ROOT"] = dotnetRoot;
        start.Environment["DOTNET_SYSTEM_GLOBALIZATION_INVARIANT"] = "1";
        start.Environment["DOTNET_GCHeapHardLimit"] = "0x3000000";
        start.Environment["TZ"] = "UTC";
        start.Environment["FSUSBLOG_PURE_PLUGIN_WORKER"] = "1";
        foreach (var argument in new[] { "-p", profile, executable }) start.ArgumentList.Add(argument);
        start.ArgumentList.Add(assembly);
        start.ArgumentList.Add("platform-plugin");
        start.ArgumentList.Add(ChildCommand);
        return await RunProcessAsync(start, request, ct);

        static string PathLiteral(string path)
        {
            if (!Path.IsPathFullyQualified(path) || path.Any(char.IsControl)) throw Deny("plugin-worker-host");
            return "\"" + path.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal) + "\"";
        }
    }

    private static async Task<byte[]> RunProcessAsync(ProcessStartInfo start, byte[] request, CancellationToken ct)
    {
        using var process = Process.Start(start) ?? throw Deny("plugin-worker-start");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(ChildTimeout);
        Task<byte[]>? output = null;
        Task<byte[]>? errors = null;
        return await PluginWorkerCompletion.RunAsync(async () =>
        {
            try
            {
                output = PluginWorkerCompletion.ReadAsync(process.StandardOutput.BaseStream, PureRenderPlugin.MaximumMarkdownBytes, deadline.Token);
                errors = PluginWorkerCompletion.ReadAsync(process.StandardError.BaseStream, 4096, deadline.Token);
                await process.StandardInput.BaseStream.WriteAsync(request, deadline.Token);
                process.StandardInput.Close();
                var result = await output;
                var stderr = await errors;
                await process.WaitForExitAsync(deadline.Token);
                if (process.ExitCode == 2 && stderr.Length == 0) throw Deny("plugin-execution-rejected");
                if (process.ExitCode != 0 || stderr.Length != 0) throw Deny("plugin-worker-failure");
                return result;
            }
            catch (OperationCanceledException error) when (!ct.IsCancellationRequested)
            {
                throw PluginWorkerCompletion.Translate(error, "plugin-worker-deadline");
            }
        }, () => PluginWorkerCompletion.ReleaseProcessAsync(deadline,
            () => WorkerProcess.ReapAsync(process, entireProcessTree: true, TimeSpan.FromSeconds(2)), output, errors));
    }

    private static ExtensionRejectedException Deny(string code) => new(code);
}
