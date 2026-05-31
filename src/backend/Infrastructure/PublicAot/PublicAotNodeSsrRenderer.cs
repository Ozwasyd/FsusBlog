using System.Collections.Concurrent;
using System.Diagnostics;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotNodeSsrRenderer(
    IWebHostEnvironment env,
    IConfiguration configuration,
    ILogger<PublicAotNodeSsrRenderer> logger) : IPublicAotEntryRenderer, IAsyncDisposable
{
    private readonly string _nodeExecutable = configuration["PublicAot:SsrNodePath"]?.Trim() is { Length: > 0 } configuredNode
        ? configuredNode
        : "node";
    private readonly string _workerMode = configuration["PublicAot:SsrWorkerMode"]?.Trim() is { Length: > 0 } mode
        ? mode
        : "Pooled";
    private readonly TimeSpan _requestTimeout = TimeSpan.FromSeconds(Math.Clamp(configuration.GetValue<int?>("PublicAot:SsrRequestTimeoutSeconds") ?? 30, 5, 180));
    private readonly Lazy<Result<string>> _clientRoot = new(() => ResolveClientRoot(env, configuration));
    private readonly Lazy<NodeWorkerPool> _workerPool = new(() => new NodeWorkerPool(
        ResolveClientRoot(env, configuration).Value ?? string.Empty,
        configuration["PublicAot:SsrNodePath"]?.Trim() is { Length: > 0 } configuredNode
            ? configuredNode
            : "node",
        Math.Clamp(configuration.GetValue<int?>("PublicAot:SsrWorkerCount") ?? 1, 1, Math.Min(4, Environment.ProcessorCount)),
        TimeSpan.FromSeconds(Math.Clamp(configuration.GetValue<int?>("PublicAot:SsrRequestTimeoutSeconds") ?? 30, 5, 180)),
        logger));

    public async Task<Result<PublicAotShellEntryContract>> BuildEntryAsync(
        PublicAotRenderRequest request,
        CancellationToken cancellationToken = default)
    {
        IReadOnlyDictionary<string, object?> payload = PublicAotRendererPayloadMapper.ToBuildEntryPayload(request);
        Result<RendererCommandResponse> result = await InvokeAsync("buildEntry", payload, cancellationToken);
        if (result.IsFailure)
        {
            return Result<PublicAotShellEntryContract>.Failure(result.Error);
        }

        RendererCommandResponse response = result.Value!;
        PublicAotShellEntryContract? entry = response.Entry;
        return entry is null
            ? Result<PublicAotShellEntryContract>.Failure(ErrorCode.InfraFailure, "public_aot_worker_empty_entry")
            : Result<PublicAotShellEntryContract>.Success(entry);
    }

    public async Task<Result> ValidateBundleAsync(PublicAotShellBundleContract bundle, CancellationToken cancellationToken = default)
    {
        Result<RendererCommandResponse> result = await InvokeAsync("validateBundle", PublicAotRendererPayloadMapper.ToBundlePayload(bundle), cancellationToken);
        return result.IsFailure ? Result.Failure(result.Error) : Result.Success();
    }

    public async ValueTask DisposeAsync()
    {
        if (_workerPool.IsValueCreated)
        {
            await _workerPool.Value.DisposeAsync();
        }
    }

    private async Task<Result<RendererCommandResponse>> InvokeAsync(string command, IReadOnlyDictionary<string, object?> payload, CancellationToken cancellationToken)
    {
        if (_clientRoot.Value.IsFailure || string.IsNullOrWhiteSpace(_clientRoot.Value.Value))
        {
            return Result<RendererCommandResponse>.Failure(_clientRoot.Value.Error);
        }

        return await BoundaryExecutor.ExecuteValueAsync(
            async () =>
            {
                string raw = IsPerRequestMode()
                    ? await InvokePerRequestAsync(_clientRoot.Value.Value!, command, payload, cancellationToken)
                    : await _workerPool.Value.SendAsync(command, payload, cancellationToken);
                return ParseResponse(raw);
            },
            ex => Result<RendererCommandResponse>.Failure(MapRenderException(ex)),
            logger,
            $"public-aot-node:{command}",
            LogLevel.Error);
    }

    private bool IsPerRequestMode()
        => string.Equals(_workerMode, "PerRequest", StringComparison.OrdinalIgnoreCase);

    private async Task<string> InvokePerRequestAsync(string clientRoot, string command, IReadOnlyDictionary<string, object?> payload, CancellationToken cancellationToken)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(_requestTimeout);
        var startInfo = CreateStartInfo(clientRoot, _nodeExecutable);
        using var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        if (!process.Start())
        {
            throw new InvalidOperationException("failed to start public AOT SSR worker process");
        }

        await process.StandardInput.WriteLineAsync(CreateRequestLine(Guid.NewGuid().ToString("N"), command, payload));
        await process.StandardInput.FlushAsync();
        process.StandardInput.Close();

        Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync(timeoutCts.Token);
        Task<string> stderrTask = process.StandardError.ReadToEndAsync(timeoutCts.Token);
        try
        {
            await process.WaitForExitAsync(timeoutCts.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            TryKill(process);
            throw new TimeoutException("public AOT SSR worker timed out");
        }

        string stdout = await stdoutTask;
        string stderr = await stderrTask;
        if (process.ExitCode != 0)
        {
            logger.LogError("Public AOT SSR worker exited with code {ExitCode}. stderr={Stderr}", process.ExitCode, string.IsNullOrWhiteSpace(stderr) ? "<empty>" : stderr);
            throw new InvalidOperationException($"public AOT SSR worker failed with exit code {process.ExitCode}");
        }

        return stdout;
    }

    private static ProcessStartInfo CreateStartInfo(string clientRoot, string nodeExecutable)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = nodeExecutable,
            WorkingDirectory = clientRoot,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        startInfo.ArgumentList.Add("./scripts/server-public-ssr.mjs");
        return startInfo;
    }

    private Result<RendererCommandResponse> ParseResponse(string stdout)
    {
        string line = ReadLastNonEmptyLine(stdout);
        string encodedPayload = ExtractResponsePayload(line);
        if (!PublicAotBinaryPayload.TryDecodeObject(encodedPayload, out Dictionary<string, object?> payload))
        {
            logger.LogError("Public AOT SSR worker returned invalid AEDS response. stdout={Stdout}", stdout);
            return Result<RendererCommandResponse>.Failure(ErrorCode.InfraFailure, "public_aot_worker_invalid_aeds");
        }

        RendererCommandResponse response = ToCommandResponse(payload);
        if (!response.Ok)
        {
            return Result<RendererCommandResponse>.Failure(ErrorCode.InfraFailure, string.IsNullOrWhiteSpace(response.Error) ? "public_aot_worker_failed" : response.Error);
        }

        return Result<RendererCommandResponse>.Success(response);
    }

    private static string ReadLastNonEmptyLine(string value)
    {
        ReadOnlySpan<char> remaining = value.AsSpan();
        while (!remaining.IsEmpty)
        {
            int end = remaining.Length - 1;
            while (end >= 0 && char.IsWhiteSpace(remaining[end]))
            {
                end--;
            }

            if (end < 0)
            {
                return string.Empty;
            }

            int start = end;
            while (start >= 0 && remaining[start] != '\n' && remaining[start] != '\r')
            {
                start--;
            }

            ReadOnlySpan<char> line = remaining.Slice(start + 1, end - start).Trim();
            if (!line.IsEmpty)
            {
                return line.ToString();
            }

            remaining = remaining[..Math.Max(0, start)];
        }

        return string.Empty;
    }

    private static string CreateRequestLine(string requestId, string command, IReadOnlyDictionary<string, object?> payload)
        => string.Concat(requestId, '\t', command, '\t', PublicAotBinaryPayload.EncodeObject(payload));

    private static string ExtractResponsePayload(string line)
    {
        int separator = line.IndexOf('\t');
        return separator < 0 ? line : line[(separator + 1)..];
    }

    private static RendererCommandResponse ToCommandResponse(IReadOnlyDictionary<string, object?> payload)
        => new()
        {
            Ok = GetBool(payload, "ok"),
            Entry = PublicAotBinaryPayload.TryGetObject(payload, "entry") is { } entry ? ToEntry(entry) : null,
            Error = PublicAotBinaryPayload.TryGetString(payload, "error")
        };

    private static PublicAotShellEntryContract ToEntry(IReadOnlyDictionary<string, object?> payload)
        => new()
        {
            PageId = (PublicPageId)GetInt(payload, "pageId"),
            RouteKey = PublicAotBinaryPayload.TryGetString(payload, "routeKey"),
            Html = PublicAotBinaryPayload.TryGetString(payload, "html"),
            ArticleId = GetNullableInt(payload, "articleId"),
            BootstrapPayload = PublicAotBinaryPayload.TryGetString(payload, "bootstrapPayload").NullIfEmpty(),
            HydrationPropsPayload = PublicAotBinaryPayload.TryGetString(payload, "hydrationPropsPayload").NullIfEmpty(),
            RendererVersion = PublicAotBinaryPayload.TryGetString(payload, "rendererVersion").NullIfEmpty(),
            IslandsPayload = PublicAotBinaryPayload.TryGetString(payload, "islandsPayload").NullIfEmpty(),
            Title = PublicAotBinaryPayload.TryGetString(payload, "title").NullIfEmpty(),
            BaseUrl = PublicAotBinaryPayload.TryGetString(payload, "baseUrl").NullIfEmpty()
        };

    private static bool GetBool(IReadOnlyDictionary<string, object?> payload, string propertyName)
        => payload.TryGetValue(propertyName, out object? value) && value switch
        {
            bool boolean => boolean,
            int number => number != 0,
            long number => number != 0,
            string text => bool.TryParse(text, out bool parsed) && parsed,
            _ => false
        };

    private static int GetInt(IReadOnlyDictionary<string, object?> payload, string propertyName)
        => GetNullableInt(payload, propertyName) ?? 0;

    private static int? GetNullableInt(IReadOnlyDictionary<string, object?> payload, string propertyName)
    {
        if (!payload.TryGetValue(propertyName, out object? value) || value is null)
        {
            return null;
        }

        return value switch
        {
            int number => number,
            long number when number >= int.MinValue && number <= int.MaxValue => (int)number,
            double number when number >= int.MinValue && number <= int.MaxValue => (int)number,
            string text when int.TryParse(text, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out int parsed) => parsed,
            _ => null
        };
    }

    private static Result<string> ResolveClientRoot(IWebHostEnvironment env, IConfiguration configuration)
    {
        string? configured = configuration["PublicAot:SsrClientRoot"];
        if (!string.IsNullOrWhiteSpace(configured) && Directory.Exists(configured))
        {
            return Result<string>.Success(Path.GetFullPath(configured));
        }

        string[] candidates =
        [
            Path.Combine(env.ContentRootPath, "..", "frontend"),
            Path.Combine(env.ContentRootPath, "..", "..", "frontend"),
            Path.Combine(env.ContentRootPath, "..", "FsusBlog.Client"),
            Path.Combine(env.ContentRootPath, "FsusBlog.Client"),
            Path.Combine(env.ContentRootPath, "FsusBlog.ClientRuntime")
        ];

        foreach (string candidate in candidates)
        {
            string normalized = Path.GetFullPath(candidate);
            if (Directory.Exists(normalized))
            {
                return Result<string>.Success(normalized);
            }
        }

        return Result<string>.Failure(ErrorCode.InfraFailure, "unable to resolve client root for public AOT SSR worker");
    }

    private static ErrorDetail MapRenderException(Exception exception)
        => exception switch
        {
            TimeoutException => ErrorDetail.Create(ErrorCode.InfraFailure, exception.Message),
            InvalidOperationException => ErrorDetail.Create(ErrorCode.InfraFailure, exception.Message),
            DirectoryNotFoundException => ErrorDetail.Create(ErrorCode.InfraFailure, exception.Message),
            _ => ErrorDetail.Create(ErrorCode.InfraFailure, "public AOT SSR worker failed")
        };

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
        }
    }

    private sealed class RendererCommandResponse
    {
        public bool Ok { get; init; }
        public PublicAotShellEntryContract? Entry { get; init; }
        public string? Error { get; init; }
    }

    private sealed class NodeWorkerPool : IAsyncDisposable
    {
        private readonly NodeWorkerClient[] _workers;
        private int _next;

        public NodeWorkerPool(string clientRoot, string nodeExecutable, int workerCount, TimeSpan requestTimeout, ILogger logger)
        {
            _workers = Enumerable.Range(0, workerCount)
                .Select(index => new NodeWorkerClient(clientRoot, nodeExecutable, requestTimeout, logger, index))
                .ToArray();
        }

        public async Task<string> SendAsync(string command, IReadOnlyDictionary<string, object?> payload, CancellationToken cancellationToken)
        {
            NodeWorkerClient worker = _workers[CalculateWorkerIndex(Interlocked.Increment(ref _next), _workers.Length)];
            return await worker.SendAsync(command, payload, cancellationToken);
        }

        internal static int CalculateWorkerIndex(int counter, int workerCount)
            => (int)((uint)counter % (uint)workerCount);

        public async ValueTask DisposeAsync()
        {
            foreach (NodeWorkerClient worker in _workers)
            {
                await worker.DisposeAsync();
            }
        }
    }

    internal static int CalculateWorkerIndexForTests(int counter, int workerCount)
        => NodeWorkerPool.CalculateWorkerIndex(counter, workerCount);

    private sealed class NodeWorkerClient(
        string clientRoot,
        string nodeExecutable,
        TimeSpan requestTimeout,
        ILogger logger,
        int index) : IAsyncDisposable
    {
        private readonly SemaphoreSlim _sendGate = new(1, 1);
        private readonly ConcurrentDictionary<string, TaskCompletionSource<string>> _pending = new(StringComparer.Ordinal);
        private Process? _process;
        private Task? _stdoutLoop;
        private Task? _stderrLoop;

        public async Task<string> SendAsync(string command, IReadOnlyDictionary<string, object?> payload, CancellationToken cancellationToken)
        {
            await _sendGate.WaitAsync(cancellationToken);
            try
            {
                EnsureStarted();
                string requestId = Guid.NewGuid().ToString("N");
                var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
                if (!_pending.TryAdd(requestId, tcs))
                {
                    throw new InvalidOperationException("duplicate public AOT worker request id");
                }

                string line = CreateRequestLine(requestId, command, payload);
                await _process!.StandardInput.WriteLineAsync(line.AsMemory(), cancellationToken);
                await _process.StandardInput.FlushAsync(cancellationToken);

                using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeoutCts.CancelAfter(requestTimeout);
                using (timeoutCts.Token.Register(() => tcs.TrySetCanceled(timeoutCts.Token)))
                {
                    try
                    {
                        return await tcs.Task;
                    }
                    catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                    {
                        Restart();
                        throw new TimeoutException("public AOT pooled SSR worker timed out");
                    }
                    finally
                    {
                        _pending.TryRemove(requestId, out _);
                    }
                }
            }
            finally
            {
                _sendGate.Release();
            }
        }

        public async ValueTask DisposeAsync()
        {
            if (_process is null)
            {
                return;
            }

            try
            {
                if (!_process.HasExited)
                {
                    await _process.StandardInput.WriteLineAsync(CreateRequestLine(Guid.NewGuid().ToString("N"), "shutdown", new Dictionary<string, object?>(StringComparer.Ordinal)));
                    await _process.StandardInput.FlushAsync();
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    await _process.WaitForExitAsync(cts.Token);
                }
            }
            catch
            {
                TryKill(_process);
            }
            finally
            {
                _process.Dispose();
                _process = null;
            }
        }

        private void EnsureStarted()
        {
            if (_process is { HasExited: false })
            {
                return;
            }

            Restart();
        }

        private void Restart()
        {
            if (_process is not null)
            {
                TryKill(_process);
                _process.Dispose();
            }

            foreach (TaskCompletionSource<string> pending in _pending.Values)
            {
                pending.TrySetException(new InvalidOperationException("public AOT worker restarted"));
            }
            _pending.Clear();

            ProcessStartInfo startInfo = CreateStartInfo(clientRoot, nodeExecutable);
            startInfo.ArgumentList.Add("--worker");
            _process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            if (!_process.Start())
            {
                throw new InvalidOperationException("failed to start public AOT pooled worker");
            }

            _stdoutLoop = Task.Run(ReadStdoutLoopAsync);
            _stderrLoop = Task.Run(ReadStderrLoopAsync);
            logger.LogInformation("Started public AOT pooled worker #{WorkerIndex}", index);
        }

        private async Task ReadStdoutLoopAsync()
        {
            try
            {
                while (_process is { HasExited: false } process)
                {
                    string? line = await process.StandardOutput.ReadLineAsync();
                    if (line is null)
                    {
                        break;
                    }

                    string requestId = ExtractRequestId(line);
                    if (!string.IsNullOrWhiteSpace(requestId) &&
                        _pending.TryRemove(requestId, out TaskCompletionSource<string>? pending))
                    {
                        pending.TrySetResult(line);
                    }
                }
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Public AOT pooled worker stdout loop failed.");
            }
        }

        private async Task ReadStderrLoopAsync()
        {
            try
            {
                while (_process is { HasExited: false } process)
                {
                    string? line = await process.StandardError.ReadLineAsync();
                    if (line is null)
                    {
                        break;
                    }

                    logger.LogWarning("Public AOT worker #{WorkerIndex}: {Message}", index, line);
                }
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Public AOT pooled worker stderr loop stopped.");
            }
        }

        private static string ExtractRequestId(string line)
        {
            int separator = line.IndexOf('\t');
            return separator <= 0 ? string.Empty : line[..separator];
        }
    }
}

file static class PublicAotNodeSsrStringExtensions
{
    public static string? NullIfEmpty(this string value)
        => string.IsNullOrEmpty(value) ? null : value;
}
