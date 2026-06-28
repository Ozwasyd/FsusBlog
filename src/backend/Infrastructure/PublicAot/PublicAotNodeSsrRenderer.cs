using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed record PublicAotSsrWorkerResourceStatus(
    string Status,
    bool IsProduction,
    bool UsesPrebuiltBundle,
    string? ClientRoot,
    string? WorkerScript,
    string? BundlePath,
    string? Error);

public sealed class PublicAotNodeSsrRenderer(
    IWebHostEnvironment env,
    IConfiguration configuration,
    PublicAotSsrRuntimeState runtimeState,
    ILogger<PublicAotNodeSsrRenderer> logger) : IPublicAotEntryRenderer, IAsyncDisposable
{
    private const string DevelopmentWorkerScriptName = "server-public-ssr.vite.mjs";
    private const string ProductionWorkerScriptName = "server-public-ssr.bundle.mjs";
    private const int MaxSsrOutputBytes = 2 * 1024 * 1024;
    private const int MaxSsrErrorBytes = 256 * 1024;
    private const bool WorkerProtocolSupportsMultiplexing = false;

    private readonly string _nodeExecutable = configuration["PublicAot:SsrNodePath"]?.Trim() is { Length: > 0 } configuredNode
        ? configuredNode
        : "node";
    private readonly string _workerMode = configuration["PublicAot:SsrWorkerMode"]?.Trim() is { Length: > 0 } mode
        ? mode
        : "Pooled";
    private readonly TimeSpan _requestTimeout = TimeSpan.FromSeconds(Math.Clamp(configuration.GetValue<int?>("PublicAot:SsrRequestTimeoutSeconds") ?? 30, 5, 180));
    private readonly Lazy<Result<SsrWorkerOptions>> _workerOptions = new(() => ResolveWorkerOptions(env, configuration));
    private readonly Lazy<NodeWorkerPool> _workerPool = new(() =>
    {
        SsrWorkerOptions workerOptions = ResolveWorkerOptions(env, configuration).Value!;
        return new NodeWorkerPool(
            workerOptions.ClientRoot,
            workerOptions.WorkerScript,
            configuration["PublicAot:SsrNodePath"]?.Trim() is { Length: > 0 } configuredNode
                ? configuredNode
                : "node",
            ResolveWorkerCount(configuration),
            TimeSpan.FromSeconds(Math.Clamp(configuration.GetValue<int?>("PublicAot:SsrRequestTimeoutSeconds") ?? 30, 5, 180)),
            runtimeState,
            logger);
    });

    private static int ResolveWorkerCount(IConfiguration configuration)
    {
        int maxWorkerCount = Math.Max(1, Math.Min(4, Environment.ProcessorCount));
        return Math.Clamp(configuration.GetValue<int?>("PublicAot:SsrWorkerCount") ?? maxWorkerCount, 1, maxWorkerCount);
    }

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
        if (_workerOptions.Value.IsFailure || _workerOptions.Value.Value is null)
        {
            return Result<RendererCommandResponse>.Failure(_workerOptions.Value.Error);
        }

        return await BoundaryExecutor.ExecuteValueAsync(
            async () =>
            {
                string raw = IsPerRequestMode()
                    ? await InvokePerRequestAsync(_workerOptions.Value.Value!, command, payload, cancellationToken)
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

    private async Task<string> InvokePerRequestAsync(SsrWorkerOptions workerOptions, string command, IReadOnlyDictionary<string, object?> payload, CancellationToken cancellationToken)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(_requestTimeout);
        var startInfo = CreateStartInfo(workerOptions.ClientRoot, workerOptions.WorkerScript, _nodeExecutable);
        using var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        if (!process.Start())
        {
            throw new InvalidOperationException("failed to start public AOT SSR worker process");
        }
        runtimeState.RecordWorkerStart();

        await process.StandardInput.WriteLineAsync(CreateRequestLine(Guid.NewGuid().ToString("N"), command, payload));
        await process.StandardInput.FlushAsync();
        process.StandardInput.Close();

        Task<string> stdoutTask = ReadProcessOutputBoundedAsync(process.StandardOutput, MaxSsrOutputBytes, "stdout", timeoutCts.Token);
        Task<string> stderrTask = ReadProcessOutputBoundedAsync(process.StandardError, MaxSsrErrorBytes, "stderr", timeoutCts.Token);
        Task waitTask = process.WaitForExitAsync(timeoutCts.Token);
        Task firstCompleted = await Task.WhenAny(waitTask, stdoutTask, stderrTask).ConfigureAwait(false);
        await RethrowBoundedOutputFailureAsync(firstCompleted, stdoutTask, process).ConfigureAwait(false);
        await RethrowBoundedOutputFailureAsync(firstCompleted, stderrTask, process).ConfigureAwait(false);
        try
        {
            await waitTask.ConfigureAwait(false);
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

    private static async Task RethrowBoundedOutputFailureAsync(
        Task completedTask,
        Task<string> outputTask,
        Process process)
    {
        if (!ReferenceEquals(completedTask, outputTask) || !(outputTask.IsFaulted || outputTask.IsCanceled))
        {
            return;
        }

        TryKill(process);
        _ = await outputTask.ConfigureAwait(false);
    }

    private static async Task<string> ReadProcessOutputBoundedAsync(
        TextReader reader,
        int maxBytes,
        string streamName,
        CancellationToken cancellationToken)
    {
        var builder = new StringBuilder(Math.Min(maxBytes, 16 * 1024));
        char[] buffer = ArrayPool<char>.Shared.Rent(4096);
        int totalBytes = 0;
        try
        {
            while (true)
            {
                int read = await reader.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken).ConfigureAwait(false);
                if (read == 0)
                {
                    break;
                }

                int bytes = Encoding.UTF8.GetByteCount(buffer.AsSpan(0, read));
                if (totalBytes + bytes > maxBytes)
                {
                    throw new InvalidOperationException($"public_aot_worker_{streamName}_too_large:{maxBytes}");
                }

                totalBytes += bytes;
                builder.Append(buffer, 0, read);
            }

            return builder.ToString();
        }
        finally
        {
            ArrayPool<char>.Shared.Return(buffer, clearArray: false);
        }
    }

    private static ProcessStartInfo CreateStartInfo(string clientRoot, string workerScript, string nodeExecutable)
    {
        string resolvedWorkerScript = ResolveWorkerScriptPath(clientRoot, workerScript);
        var startInfo = new ProcessStartInfo
        {
            FileName = nodeExecutable,
            WorkingDirectory = Path.GetFullPath(clientRoot),
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        startInfo.ArgumentList.Add(resolvedWorkerScript);
        return startInfo;
    }

    private static string ResolveWorkerScriptPath(string clientRoot, string workerScript)
    {
        string root = Path.GetFullPath(clientRoot);
        string candidate = Path.GetFullPath(Path.IsPathRooted(workerScript)
            ? workerScript
            : Path.Combine(root, workerScript));
        if (!IsPathWithinDirectory(root, candidate))
        {
            throw new InvalidOperationException("public_aot_worker_script_outside_client_root");
        }

        return candidate;
    }

    private static bool IsPathWithinDirectory(string directory, string candidatePath)
    {
        string root = Path.GetFullPath(directory);
        string candidate = Path.GetFullPath(candidatePath);
        string relative = Path.GetRelativePath(root, candidate);
        return relative.Length == 0 ||
            (!relative.StartsWith("..", StringComparison.Ordinal) &&
             !Path.IsPathRooted(relative));
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

    internal static PublicAotSsrWorkerResourceStatus CheckWorkerResourceForTests(IWebHostEnvironment env, IConfiguration configuration)
        => CheckWorkerResource(env, configuration);

    internal static Task<string> ReadProcessOutputBoundedForTests(string output, int maxBytes, CancellationToken cancellationToken = default)
        => ReadProcessOutputBoundedAsync(new StringReader(output), maxBytes, "stdout", cancellationToken);

    internal static PublicAotSsrWorkerResourceStatus CheckWorkerResource(IWebHostEnvironment env, IConfiguration configuration)
    {
        Result<SsrWorkerOptions> options = ResolveWorkerOptions(env, configuration);
        if (options.IsFailure || options.Value is null)
        {
            return new PublicAotSsrWorkerResourceStatus(
                "failed",
                env.IsProduction(),
                false,
                null,
                null,
                null,
                options.Error.Message);
        }

        return new PublicAotSsrWorkerResourceStatus(
            "ok",
            env.IsProduction(),
            options.Value.UsesPrebuiltBundle,
            options.Value.ClientRoot,
            options.Value.WorkerScript,
            options.Value.BundlePath,
            null);
    }

    private static Result<SsrWorkerOptions> ResolveWorkerOptions(IWebHostEnvironment env, IConfiguration configuration)
    {
        Result<string> clientRootResult = ResolveClientRoot(env, configuration);
        if (clientRootResult.IsFailure || string.IsNullOrWhiteSpace(clientRootResult.Value))
        {
            return Result<SsrWorkerOptions>.Failure(clientRootResult.Error);
        }

        string clientRoot = clientRootResult.Value!;
        string workerScript = ResolveWorkerScript(env, configuration);
        string fullWorkerScriptPath = Path.GetFullPath(Path.Combine(clientRoot, workerScript));
        if (!File.Exists(fullWorkerScriptPath))
        {
            return Result<SsrWorkerOptions>.Failure(ErrorCode.InfraFailure, $"public_aot_worker_script_missing:{workerScript}");
        }

        bool usesPrebuiltBundle = string.Equals(Path.GetFileName(workerScript), ProductionWorkerScriptName, StringComparison.OrdinalIgnoreCase);
        if (env.IsProduction() && !usesPrebuiltBundle)
        {
            return Result<SsrWorkerOptions>.Failure(ErrorCode.InfraFailure, "public_aot_production_worker_must_use_prebuilt_bundle");
        }

        string? bundlePath = ResolveSsrBundlePath(clientRoot, fullWorkerScriptPath);
        if (usesPrebuiltBundle && !File.Exists(bundlePath))
        {
            return Result<SsrWorkerOptions>.Failure(ErrorCode.InfraFailure, "public_aot_ssr_bundle_missing:public-ssr.mjs");
        }

        return Result<SsrWorkerOptions>.Success(new SsrWorkerOptions(
            clientRoot,
            workerScript,
            usesPrebuiltBundle,
            usesPrebuiltBundle ? bundlePath : null));
    }

    private static string ResolveWorkerScript(IWebHostEnvironment env, IConfiguration configuration)
    {
        string? configured = configuration["PublicAot:SsrWorkerScript"];
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured.Trim();
        }

        return env.IsProduction()
            ? $"./server/{ProductionWorkerScriptName}"
            : $"./scripts/{DevelopmentWorkerScriptName}";
    }

    private static string ResolveSsrBundlePath(string clientRoot, string fullWorkerScriptPath)
    {
        string workerDirectory = Path.GetDirectoryName(fullWorkerScriptPath) ?? clientRoot;
        string[] candidates =
        [
            Path.Combine(workerDirectory, "public-ssr.mjs"),
            Path.Combine(clientRoot, "server", "public-ssr.mjs"),
            Path.Combine(clientRoot, "dist", "server", "public-ssr.mjs")
        ];

        foreach (string candidate in candidates)
        {
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return candidates[0];
    }

    private static Result<string> ResolveClientRoot(IWebHostEnvironment env, IConfiguration configuration)
    {
        string? configured = configuration["PublicAot:SsrClientRoot"];
        if (!string.IsNullOrWhiteSpace(configured) && Directory.Exists(configured))
        {
            return Result<string>.Success(Path.GetFullPath(configured));
        }

        string webRoot = string.IsNullOrWhiteSpace(env.WebRootPath)
            ? Path.Combine(env.ContentRootPath, "wwwroot")
            : env.WebRootPath;
        string[] productionCandidates =
        [
            webRoot,
            Path.Combine(env.ContentRootPath, "wwwroot"),
            Path.Combine(env.ContentRootPath, "FsusBlog.ClientRuntime")
        ];
        string[] developmentCandidates =
        [
            Path.Combine(env.ContentRootPath, "..", "frontend"),
            Path.Combine(env.ContentRootPath, "..", "..", "frontend"),
            Path.Combine(env.ContentRootPath, "..", "FsusBlog.Client"),
            Path.Combine(env.ContentRootPath, "FsusBlog.Client"),
            Path.Combine(env.ContentRootPath, "FsusBlog.ClientRuntime"),
            webRoot
        ];

        string[] candidates = env.IsProduction()
            ? [.. productionCandidates, .. developmentCandidates]
            : developmentCandidates;

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

    private sealed record SsrWorkerOptions(
        string ClientRoot,
        string WorkerScript,
        bool UsesPrebuiltBundle,
        string? BundlePath);

    private sealed class NodeWorkerPool : IAsyncDisposable
    {
        private readonly NodeWorkerClient[] _workers;
        private int _next;

        public NodeWorkerPool(
            string clientRoot,
            string workerScript,
            string nodeExecutable,
            int workerCount,
            TimeSpan requestTimeout,
            PublicAotSsrRuntimeState runtimeState,
            ILogger logger)
        {
            _workers = Enumerable.Range(0, workerCount)
                .Select(index => new NodeWorkerClient(clientRoot, workerScript, nodeExecutable, requestTimeout, runtimeState, logger, index))
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
        string workerScript,
        string nodeExecutable,
        TimeSpan requestTimeout,
        PublicAotSsrRuntimeState runtimeState,
        ILogger logger,
        int index) : IAsyncDisposable
    {
        // WorkerProtocolSupportsMultiplexing is false: request ids correlate responses,
        // but the Node renderer executes one command at a time per worker process.
        private readonly SemaphoreSlim _sendGate = new(
            WorkerProtocolSupportsMultiplexing ? Environment.ProcessorCount : 1,
            WorkerProtocolSupportsMultiplexing ? Environment.ProcessorCount : 1);
        private readonly ConcurrentDictionary<string, TaskCompletionSource<string>> _pending = new(StringComparer.Ordinal);
        private CancellationTokenSource _lifetimeCts = new();
        private Process? _process;
        private Task? _stdoutLoop;
        private Task? _stderrLoop;
        private int _generation;

        public async Task<string> SendAsync(string command, IReadOnlyDictionary<string, object?> payload, CancellationToken cancellationToken)
        {
            await _sendGate.WaitAsync(cancellationToken);
            try
            {
                await EnsureStartedAsync(cancellationToken);
                Process process = _process!;
                string requestId = Guid.NewGuid().ToString("N");
                var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
                if (!_pending.TryAdd(requestId, tcs))
                {
                    throw new InvalidOperationException("duplicate public AOT worker request id");
                }

                string line = CreateRequestLine(requestId, command, payload);
                await process.StandardInput.WriteLineAsync(line.AsMemory(), cancellationToken);
                await process.StandardInput.FlushAsync(cancellationToken);

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
                        await RestartAsync();
                        throw new TimeoutException("public AOT pooled SSR worker timed out");
                    }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                    {
                        await RestartAsync();
                        throw;
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
                Process process = _process;
                if (!process.HasExited)
                {
                    await process.StandardInput.WriteLineAsync(CreateRequestLine(Guid.NewGuid().ToString("N"), "shutdown", new Dictionary<string, object?>(StringComparer.Ordinal)));
                    await process.StandardInput.FlushAsync();
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    await process.WaitForExitAsync(cts.Token);
                }
            }
            catch
            {
                TryKill(_process);
            }
            finally
            {
                await StopCurrentWorkerAsync();
            }
        }

        private async Task EnsureStartedAsync(CancellationToken cancellationToken)
        {
            if (_process is { HasExited: false })
            {
                return;
            }

            await RestartAsync(cancellationToken);
        }

        private async Task RestartAsync(CancellationToken cancellationToken = default)
        {
            await StopCurrentWorkerAsync();

            foreach (TaskCompletionSource<string> pending in _pending.Values)
            {
                pending.TrySetException(new InvalidOperationException("public AOT worker restarted"));
            }
            _pending.Clear();

            _lifetimeCts = new CancellationTokenSource();
            cancellationToken.ThrowIfCancellationRequested();
            ProcessStartInfo startInfo = CreateStartInfo(clientRoot, workerScript, nodeExecutable);
            startInfo.ArgumentList.Add("--worker");
            _process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            if (!_process.Start())
            {
                throw new InvalidOperationException("failed to start public AOT pooled worker");
            }
            runtimeState.RecordWorkerStart();

            Process process = _process;
            int generation = Interlocked.Increment(ref _generation);
            _stdoutLoop = ReadStdoutLoopAsync(process, generation, _lifetimeCts.Token);
            _stderrLoop = ReadStderrLoopAsync(process, generation, _lifetimeCts.Token);
            logger.LogInformation("Started public AOT pooled worker #{WorkerIndex}", index);
        }

        private async Task StopCurrentWorkerAsync()
        {
            Process? process = _process;
            Task? stdoutLoop = _stdoutLoop;
            Task? stderrLoop = _stderrLoop;
            CancellationTokenSource lifetimeCts = _lifetimeCts;

            Interlocked.Increment(ref _generation);
            lifetimeCts.Cancel();
            if (process is not null)
            {
                TryKill(process);
                process.Dispose();
            }

            _process = null;
            _stdoutLoop = null;
            _stderrLoop = null;

            await AwaitReaderLoopsAsync(stdoutLoop, stderrLoop);
            lifetimeCts.Dispose();
        }

        private async Task ReadStdoutLoopAsync(Process process, int generation, CancellationToken cancellationToken)
        {
            try
            {
                while (!cancellationToken.IsCancellationRequested && !process.HasExited && Volatile.Read(ref _generation) == generation)
                {
                    string? line = await process.StandardOutput.ReadLineAsync(cancellationToken);
                    if (line is null)
                    {
                        break;
                    }

                    string requestId = ExtractRequestId(line);
                    if (!string.IsNullOrWhiteSpace(requestId) &&
                        Volatile.Read(ref _generation) == generation &&
                        _pending.TryRemove(requestId, out TaskCompletionSource<string>? pending))
                    {
                        pending.TrySetResult(line);
                    }
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Public AOT pooled worker stdout loop failed.");
            }
        }

        private async Task ReadStderrLoopAsync(Process process, int generation, CancellationToken cancellationToken)
        {
            try
            {
                while (!cancellationToken.IsCancellationRequested && !process.HasExited && Volatile.Read(ref _generation) == generation)
                {
                    string? line = await process.StandardError.ReadLineAsync(cancellationToken);
                    if (line is null)
                    {
                        break;
                    }

                    runtimeState.RecordWorkerStderrWarning(line);
                    logger.LogWarning("Public AOT worker #{WorkerIndex}: {Message}", index, line);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Public AOT pooled worker stderr loop stopped.");
            }
        }

        private static async Task AwaitReaderLoopsAsync(Task? stdoutLoop, Task? stderrLoop)
        {
            try
            {
                Task[] loops = [stdoutLoop ?? Task.CompletedTask, stderrLoop ?? Task.CompletedTask];
                await Task.WhenAll(loops).WaitAsync(TimeSpan.FromSeconds(2));
            }
            catch
            {
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
