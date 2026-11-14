using System.Diagnostics;
using System.Net;
using System.Text;

namespace FsusBlog.V2.Integration.Tests;

internal sealed class ServerProcess : IAsyncDisposable
{
    private readonly Process _process;
    private readonly string _temporaryDist;
    internal HttpClient Client { get; }

    private ServerProcess(Process process, string temporaryDist, Uri address)
    {
        _process = process;
        _temporaryDist = temporaryDist;
        Client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }) { BaseAddress = address };
    }

    internal static async Task<ServerProcess> Start(string connectionString, CancellationToken cancellationToken,
        IReadOnlyDictionary<string, string>? settings = null)
    {
        var host = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet";
        var assembly = Path.Combine(AppContext.BaseDirectory, "FsusBlog.V2.Server.dll");
        var dist = Directory.CreateTempSubdirectory("fsusblog-v2-integration-").FullName;
        Process? process = null;
        var started = false;
        try
        {
            await File.WriteAllTextAsync(Path.Combine(dist, "index.html"),
                "<!doctype html><html lang=\"en\"><head><title>Fsu's Blog</title></head><body><!--fsus-public-content--></body></html>", cancellationToken);

            var start = new ProcessStartInfo(host)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = dist,
            };
            start.ArgumentList.Add(assembly);
            start.Environment["FSUSBLOG_DB"] = connectionString;
            start.Environment["FSUSBLOG_WEB_DIST"] = dist;
            start.Environment["ASPNETCORE_URLS"] = "http://127.0.0.1:0";
            start.Environment["DOTNET_ENVIRONMENT"] = "Production";
            start.Environment["ASPNETCORE_ENVIRONMENT"] = "Production";
            start.Environment["Logging__LogLevel__Default"] = "Warning";
            start.Environment["Logging__LogLevel__Microsoft.Hosting.Lifetime"] = "Information";
            if (settings is not null)
                foreach (var setting in settings) start.Environment[setting.Key] = setting.Value;

            var listening = new TaskCompletionSource<Uri>(TaskCreationOptions.RunContinuationsAsynchronously);
            var log = new BoundedLog();
            process = new Process { StartInfo = start, EnableRaisingEvents = true };
            process.OutputDataReceived += (_, args) =>
            {
                if (args.Data is not { } line) return;
                log.Add(line);
                const string marker = "Now listening on: ";
                var prefix = line.IndexOf(marker, StringComparison.Ordinal);
                if (prefix >= 0 && Uri.TryCreate(line[(prefix + marker.Length)..], UriKind.Absolute, out var address) &&
                    address.Scheme == Uri.UriSchemeHttp && address.Host == "127.0.0.1")
                    listening.TrySetResult(address);
            };
            process.ErrorDataReceived += (_, args) =>
            {
                if (args.Data is { } line) log.Add(line);
                else listening.TrySetException(new InvalidOperationException($"Integration server exited before binding.\n{log}"));
            };
            started = process.Start();
            if (!started) throw new InvalidOperationException("Could not start the integration server.");
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            var uri = await listening.Task.WaitAsync(cancellationToken);
            var server = new ServerProcess(process, dist, uri);
            try
            {
                using var ready = await server.Client.GetAsync("/health/ready", cancellationToken);
                if (ready.StatusCode != HttpStatusCode.NoContent)
                    throw new InvalidOperationException($"Integration server did not become ready ({ready.StatusCode}).\n{log}");
                return server;
            }
            catch
            {
                server.Client.Dispose();
                throw;
            }
        }
        catch (Exception error)
        {
            if (!started) process?.Dispose();
            try { await Cleanup(started ? process : null, dist); }
            catch (Exception cleanup) { throw new AggregateException(error, cleanup); }
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        Client.Dispose();
        await Cleanup(_process, _temporaryDist);
    }

    private static async Task Cleanup(Process? process, string dist)
    {
        using (process)
        {
            if (process is not null)
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(15));
            }
        }
        Directory.Delete(dist, recursive: true);
    }

    private sealed class BoundedLog
    {
        private readonly StringBuilder _lines = new();
        private const int MaxLength = 16_000;

        internal void Add(string line)
        {
            lock (_lines)
            {
                _lines.AppendLine(line);
                if (_lines.Length > MaxLength) _lines.Remove(0, _lines.Length - MaxLength);
            }
        }

        public override string ToString()
        {
            lock (_lines) return _lines.ToString();
        }
    }
}
