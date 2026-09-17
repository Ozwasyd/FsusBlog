using System.Collections.Concurrent;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

using Jint;
using Jint.Constraints;
using Jint.Native;

namespace FsusBlog.Server.Infrastructure.Plugins;

public sealed record JavaScriptPluginRuntimeOptions(int EnginePoolSize)
{
    public const int DefaultEnginePoolSize = 2;
    public const int MaximumEnginePoolSize = 8;

    public static JavaScriptPluginRuntimeOptions FromConfiguration(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        int configured = configuration.GetValue(
            "Plugins:JavaScript:EnginePoolSize",
            DefaultEnginePoolSize);
        if (configured is < 1 or > MaximumEnginePoolSize)
        {
            throw new InvalidOperationException(
                $"Plugins:JavaScript:EnginePoolSize must be between 1 and {MaximumEnginePoolSize}.");
        }
        return new JavaScriptPluginRuntimeOptions(configured);
    }
}

public sealed record JavaScriptPluginRuntimeSnapshot(
    string PluginId,
    bool Loaded,
    int EnginePoolSize,
    int ActiveLeases,
    int MaximumConcurrentLeases,
    long CreatedEngines,
    long DiscardedEngines,
    long PoisonedEngines);

public interface IJavaScriptPluginRuntime
{
    ValueTask LoadAsync(PluginPackage plugin, CancellationToken cancellationToken = default);

    ValueTask<PluginHookResult> InvokeHookAsync(
        PluginHookInvocation invocation,
        CancellationToken cancellationToken = default);

    ValueTask UnloadAsync(string pluginId, CancellationToken cancellationToken = default);

    JavaScriptPluginRuntimeSnapshot GetSnapshot(string pluginId);
}

public interface IJavaScriptPluginHostApi
{
    ValueTask<JsonElement> InvokeAsync(
        string pluginId,
        string operation,
        JsonElement input,
        CancellationToken cancellationToken);
}

public sealed class DefaultJavaScriptPluginHostApi(
    ILogger<DefaultJavaScriptPluginHostApi> logger,
    PluginObservabilityStore? observability = null) : IJavaScriptPluginHostApi
{
    public ValueTask<JsonElement> InvokeAsync(
        string pluginId,
        string operation,
        JsonElement input,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (operation != "log.write")
        {
            return ValueTask.FromException<JsonElement>(
                new PluginJavaScriptRuntimeException(
                    $"JavaScript Host API operation '{operation}' is not installed."));
        }
        if (input.ValueKind != JsonValueKind.Object
            || !input.TryGetProperty("message", out JsonElement messageElement)
            || messageElement.ValueKind != JsonValueKind.String)
        {
            return ValueTask.FromException<JsonElement>(
                new PluginJavaScriptRuntimeException(
                    "JavaScript log.write requires a string message."));
        }
        string message = messageElement.GetString() ?? string.Empty;
        if (message.Length is < 1 or > 4096
            || message.Any(static character => char.IsControl(character)))
        {
            return ValueTask.FromException<JsonElement>(
                new PluginJavaScriptRuntimeException(
                    "JavaScript log.write message is empty, too long or contains control characters."));
        }
        string level = input.TryGetProperty("level", out JsonElement levelElement)
            && levelElement.ValueKind == JsonValueKind.String
                ? levelElement.GetString() ?? "info"
                : "info";
        if (level is not ("debug" or "info" or "warning" or "error"))
        {
            return ValueTask.FromException<JsonElement>(
                new PluginJavaScriptRuntimeException(
                    "JavaScript log.write level is unsupported."));
        }
        logger.Log(
            level switch
            {
                "debug" => LogLevel.Debug,
                "warning" => LogLevel.Warning,
                "error" => LogLevel.Error,
                _ => LogLevel.Information
            },
            "Plugin {PluginId} wrote {PluginMessage}",
            pluginId,
            message);
        PluginExecutionAmbientContext.Context? execution = PluginExecutionAmbientContext.Current;
        observability?.RecordLog(
            pluginId,
            PluginRuntimeType.JavaScript,
            execution?.HookName ?? "host.log",
            execution?.TraceId ?? string.Empty,
            level,
            message);
        return ValueTask.FromResult(JsonSerializer.SerializeToElement(
            new
            {
                accepted = true
            }));
    }
}

public sealed class JavaScriptPluginRuntime(
    IJavaScriptPluginHostApi hostApi,
    JavaScriptPluginRuntimeOptions options) : IJavaScriptPluginRuntime, IPluginHookRuntimeInvoker
{
    private const int MaximumContextBytes = 1024 * 1024;
    private static readonly UTF8Encoding s_strictUtf8 = new(false, true);
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web)
    {
        MaxDepth = 32
    };
    private static readonly PluginExecutionBudget s_loadBudget = new(
        TimeSpan.FromSeconds(2),
        64 * 1024 * 1024,
        1_000_000,
        64,
        1024 * 1024,
        64 * 1024);
    private static readonly string s_bootstrapSource = """
        (() => {
          "use strict";
          const definition = globalThis.__fsusPluginDefinition;
          const expectedPluginId = globalThis.__fsusExpectedPluginId;
          const allowedHooks = new Set(JSON.parse(globalThis.__fsusAllowedHooksJson));
          const handlers = Object.create(null);

          function registerHook(name, handler) {
            if (typeof name !== "string" || !allowedHooks.has(name)) {
              throw new Error("plugin_hook_not_declared");
            }
            if (typeof handler !== "function") {
              throw new Error("plugin_hook_handler_invalid");
            }
            if (Object.prototype.hasOwnProperty.call(handlers, name)) {
              throw new Error("plugin_hook_duplicate_registration");
            }
            handlers[name] = handler;
          }

          globalThis.__fsusActivatePlugin = async () => {
            if (!definition || typeof definition !== "object") {
              throw new Error("plugin_default_export_invalid");
            }
            if (definition.id !== expectedPluginId) {
              throw new Error("plugin_id_mismatch");
            }
            if (definition.hooks && typeof definition.hooks === "object") {
              for (const [name, handler] of Object.entries(definition.hooks)) {
                registerHook(name, handler);
              }
            }
            if (typeof definition.activate === "function") {
              const activationContext = Object.freeze({
                hooks: Object.freeze({ on: registerHook }),
                config: Object.freeze({})
              });
              await definition.activate(activationContext);
            }
          };

          globalThis.__fsusInvokeHookJson = async (hookName, contextJson, hostCall) => {
            const handler = handlers[hookName];
            if (typeof handler !== "function") {
              throw new Error("plugin_hook_handler_missing");
            }
            const data = JSON.parse(contextJson);
            const invokeHost = async (operation, input) => {
              const response = await hostCall(operation, JSON.stringify(input ?? null));
              return JSON.parse(response);
            };
            const next = (value = data.payload) => ({ continue: true, value });
            const stop = (value = null) => ({ continue: false, value });
            const context = Object.freeze({
              hookName: data.hookName,
              traceId: data.traceId,
              operationId: data.operationId,
              payload: data.payload,
              items: Object.freeze(data.items ?? {}),
              next,
              stop,
              hooks: Object.freeze({ current: hookName }),
              log: Object.freeze({
                write: (message, level = "info") =>
                  invokeHost("log.write", { level, message: String(message) })
              }),
              storage: Object.freeze({
                get: key => invokeHost("storage.kv.get", { key }),
                put: (key, value) => invokeHost("storage.kv.put", { key, value }),
                delete: key => invokeHost("storage.kv.delete", { key }),
                getObject: key => invokeHost("storage.object.get", { key }),
                putObject: (key, value) => invokeHost("storage.object.put", { key, value })
              }),
              article: Object.freeze({
                read: input => invokeHost("article.read", input),
                render: input => invokeHost("article.render", input),
                writeDraft: input => invokeHost("article.write.draft", input)
              }),
              comment: Object.freeze({
                read: input => invokeHost("comment.read", input),
                create: input => invokeHost("comment.create", input),
                moderate: input => invokeHost("comment.moderate", input),
                reject: reason => stop({ reason })
              }),
              search: Object.freeze({
                rewrite: input => invokeHost("search.query.rewrite", input),
                writeIndex: input => invokeHost("search.index.write", input)
              }),
              media: Object.freeze({
                process: input => invokeHost("media.process", input)
              }),
              network: Object.freeze({
                request: input => invokeHost("network.http.request", input)
              }),
              scheduler: Object.freeze({
                createJob: input => invokeHost("scheduler.job.create", input)
              }),
              theme: Object.freeze({
                readAsset: input => invokeHost("theme.asset.read", input)
              })
            });
            const raw = await handler(context);
            const normalized =
              raw === undefined ? next() :
              raw && typeof raw === "object" && typeof raw.continue === "boolean"
                ? raw
                : next(raw);
            return JSON.stringify({
              continue: normalized.continue,
              value: normalized.value === undefined ? null : normalized.value
            });
          };
        })();
        """;

    private readonly ConcurrentDictionary<string, PluginPool> _plugins =
        new(StringComparer.Ordinal);

    public async ValueTask LoadAsync(
        PluginPackage plugin,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(plugin);
        if (plugin.Manifest.Runtime.Type != PluginRuntimeType.JavaScript)
        {
            throw new PluginJavaScriptRuntimeException(
                $"Plugin '{plugin.Manifest.Id}' is not a JavaScript plugin.");
        }
        EnsureSandboxSupported();
        string source = ReadJavaScriptEntry(plugin);
        var replacement = new PluginPool(
            plugin.Manifest,
            source,
            options.EnginePoolSize,
            CreateEngineAsync);
        try
        {
            await replacement.ValidateAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (IsResourceLimit(exception))
        {
            replacement.Dispose();
            throw new PluginResourceLimitException(
                $"JavaScript plugin '{plugin.Manifest.Id}' exceeded its load budget.",
                exception);
        }
        catch (Exception exception) when (exception is not PluginJavaScriptRuntimeException)
        {
            replacement.Dispose();
            throw new PluginJavaScriptRuntimeException(
                $"JavaScript plugin '{plugin.Manifest.Id}' could not be loaded.",
                exception);
        }

        PluginPool? prior = null;
        _plugins.AddOrUpdate(
            plugin.Manifest.Id,
            _ => replacement,
            (_, current) =>
            {
                prior = current;
                return replacement;
            });
        prior?.Dispose();
    }

    public ValueTask<PluginHookResult> InvokeAsync(
        PluginHookInvocation invocation,
        CancellationToken cancellationToken)
        => invocation.Runtime == PluginRuntimeType.JavaScript
            ? InvokeHookAsync(invocation, cancellationToken)
            : ValueTask.FromException<PluginHookResult>(
                new PluginHookDispatchException(
                    $"Plugin runtime '{invocation.Runtime}' is not available on this node."));

    public async ValueTask<PluginHookResult> InvokeHookAsync(
        PluginHookInvocation invocation,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(invocation);
        if (invocation.Runtime != PluginRuntimeType.JavaScript)
        {
            throw new PluginJavaScriptRuntimeException(
                $"Plugin '{invocation.PluginId}' did not request the JavaScript runtime.");
        }
        if (!_plugins.TryGetValue(invocation.PluginId, out PluginPool? pool))
        {
            throw new PluginJavaScriptRuntimeException(
                $"JavaScript plugin '{invocation.PluginId}' is not loaded.");
        }

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken,
            invocation.Budget.CancellationToken,
            pool.CancellationToken);
        CancellationToken token = linked.Token;
        PluginEngineLease lease = await pool.RentAsync(invocation, token).ConfigureAwait(false);
        Engine engine = lease.Engine;
        bool poisoned = false;
        Exception? hostFailure = null;
        try
        {
            string contextJson = SerializeContext(invocation);
            invocation.Budget.ReserveMemory(Encoding.UTF8.GetByteCount(contextJson));
            invocation.Budget.ThrowIfTimeoutExceeded();

            Func<string, string, Task<string>> bridge =
                async (operation, inputJson) =>
                {
                    try
                    {
                        return await InvokeHostAsync(
                            invocation,
                            operation,
                            inputJson,
                            token).ConfigureAwait(false);
                    }
                    catch (Exception exception)
                    {
                        hostFailure = exception;
                        throw;
                    }
                };
            using IDisposable ambient = PluginExecutionAmbientContext.Push(
                invocation.PluginId,
                invocation.Runtime,
                invocation.Definition.Name,
                invocation.Context.TraceId);
            JsValue raw = await engine.InvokeAsync(
                "__fsusInvokeHookJson",
                token,
                invocation.Definition.Name,
                contextJson,
                bridge).ConfigureAwait(false);
            invocation.Budget.ThrowIfTimeoutExceeded();
            string resultJson = raw.AsString();
            invocation.Budget.RecordOutput(Encoding.UTF8.GetByteCount(resultJson));
            return ParseResult(resultJson);
        }
        catch (Exception exception) when (
            IsResourceLimit(exception)
            || hostFailure is not null && IsResourceLimit(hostFailure))
        {
            poisoned = true;
            throw new PluginResourceLimitException(
                $"JavaScript plugin '{invocation.PluginId}' exceeded its execution budget.",
                hostFailure ?? exception);
        }
        catch (Exception exception) when (exception is not PluginResourceLimitException)
        {
            poisoned = true;
            throw new PluginJavaScriptRuntimeException(
                $"JavaScript plugin '{invocation.PluginId}' failed Hook '{invocation.Definition.Name}'.",
                exception);
        }
        finally
        {
            await pool.DiscardAndReplaceAsync(lease, poisoned)
                .ConfigureAwait(false);
        }
    }

    public ValueTask UnloadAsync(
        string pluginId,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pluginId);
        cancellationToken.ThrowIfCancellationRequested();
        if (_plugins.TryRemove(pluginId, out PluginPool? pool))
        {
            pool.Dispose();
        }
        return ValueTask.CompletedTask;
    }

    internal IReadOnlyList<JavaScriptPluginRuntimeSnapshot> GetLoadedSnapshots()
        => _plugins.Select(static pair => pair.Value.GetSnapshot()).ToArray();

    public JavaScriptPluginRuntimeSnapshot GetSnapshot(string pluginId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pluginId);
        return _plugins.TryGetValue(pluginId, out PluginPool? pool)
            ? pool.GetSnapshot()
            : new JavaScriptPluginRuntimeSnapshot(
                pluginId,
                Loaded: false,
                options.EnginePoolSize,
                ActiveLeases: 0,
                MaximumConcurrentLeases: 0,
                CreatedEngines: 0,
                DiscardedEngines: 0,
                PoisonedEngines: 0);
    }

    private async Task<Engine> CreateEngineAsync(
        PluginManifest manifest,
        string source,
        PluginExecutionBudget budget,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Engine engine = new(engineOptions =>
        {
            engineOptions.Strict();
            engineOptions.DisableStringCompilation();
            engineOptions.LimitMemory(budget.MemoryBytes);
            engineOptions.MaxStatements(checked((int)budget.InstructionCount));
            engineOptions.TimeoutInterval(budget.Timeout);
            engineOptions.CancellationToken(cancellationToken);
            engineOptions.LimitRecursion(budget.MaximumCallDepth);
            engineOptions.Constraints.PromiseTimeout = budget.Timeout;
            engineOptions.Constraints.RegexTimeout =
                budget.Timeout < TimeSpan.FromMilliseconds(100)
                    ? budget.Timeout
                    : TimeSpan.FromMilliseconds(100);
            engineOptions.Constraints.MaxArraySize =
                (uint)Math.Min(uint.MaxValue, Math.Max(1, budget.MemoryBytes / 8));
            engineOptions.Interop.Enabled = false;
            engineOptions.Interop.AllowGetType = false;
            engineOptions.Interop.AllowSystemReflection = false;
            engineOptions.Interop.AllowWrite = false;
        });
        string moduleName = $"fsusblog:{manifest.Id}";
        engine.Modules.Add(moduleName, source);
        var module = engine.Modules.Import(moduleName);
        JsValue definition = module.Get("default");
        engine.SetValue("__fsusPluginDefinition", definition);
        engine.SetValue("__fsusExpectedPluginId", manifest.Id);
        engine.SetValue(
            "__fsusAllowedHooksJson",
            JsonSerializer.Serialize(
                manifest.Hooks.Select(static hook => hook.Name),
                s_jsonOptions));
        engine.Execute(s_bootstrapSource, "fsusblog-runtime-bootstrap.js");
        await engine.InvokeAsync(
            "__fsusActivatePlugin",
            cancellationToken,
            Array.Empty<object>()).ConfigureAwait(false);
        return engine;
    }

    private async Task<string> InvokeHostAsync(
        PluginHookInvocation invocation,
        string operation,
        string inputJson,
        CancellationToken cancellationToken)
    {
        JavaScriptHostOperation definition = JavaScriptHostOperationCatalog.Get(operation);
        invocation.Budget.ThrowIfTimeoutExceeded();
        int inputBytes = Encoding.UTF8.GetByteCount(inputJson);
        invocation.Budget.ReserveMemory(inputBytes);
        if (definition.Capability == PluginCapability.PluginLogWrite)
        {
            invocation.Budget.RecordLog(inputBytes);
        }
        using IDisposable call = invocation.Budget.EnterCall();
        JsonElement input;
        try
        {
            using JsonDocument document = JsonDocument.Parse(inputJson, new JsonDocumentOptions
            {
                MaxDepth = 16
            });
            input = document.RootElement.Clone();
        }
        catch (JsonException exception)
        {
            throw new PluginJavaScriptRuntimeException(
                $"JavaScript Host API input for '{operation}' is invalid.",
                exception);
        }

        JsonElement result = await invocation.HostApi.InvokeAsync(
            definition.Capability,
            token => hostApi.InvokeAsync(
                invocation.PluginId,
                operation,
                input,
                token),
            cancellationToken).ConfigureAwait(false);
        string resultJson = JsonSerializer.Serialize(result, s_jsonOptions);
        invocation.Budget.RecordOutput(Encoding.UTF8.GetByteCount(resultJson));
        return resultJson;
    }

    private static string SerializeContext(PluginHookInvocation invocation)
    {
        try
        {
            string json = JsonSerializer.Serialize(
                new
                {
                    hookName = invocation.Context.HookName,
                    traceId = invocation.Context.TraceId,
                    operationId = invocation.Context.OperationId,
                    payload = invocation.Context.Payload,
                    items = invocation.Context.Items
                },
                s_jsonOptions);
            if (Encoding.UTF8.GetByteCount(json) > MaximumContextBytes)
            {
                throw new PluginResourceLimitException(
                    "JavaScript plugin Hook context exceeds the serialization limit.");
            }
            return json;
        }
        catch (JsonException exception)
        {
            throw new PluginJavaScriptRuntimeException(
                "JavaScript plugin Hook context is not a bounded JSON value.",
                exception);
        }
    }

    private static PluginHookResult ParseResult(string resultJson)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(resultJson, new JsonDocumentOptions
            {
                MaxDepth = 32
            });
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("continue", out JsonElement continueElement)
                || continueElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            {
                throw new PluginJavaScriptRuntimeException(
                    "JavaScript plugin Hook returned an invalid result envelope.");
            }
            object? value = root.TryGetProperty("value", out JsonElement valueElement)
                ? valueElement.Clone()
                : null;
            return new PluginHookResult(continueElement.GetBoolean(), value);
        }
        catch (JsonException exception)
        {
            throw new PluginJavaScriptRuntimeException(
                "JavaScript plugin Hook result is not bounded JSON.",
                exception);
        }
    }

    private static string ReadJavaScriptEntry(PluginPackage plugin)
    {
        try
        {
            using var packageStream = new MemoryStream(plugin.PackageBytes, writable: false);
            using var archive = new ZipArchive(packageStream, ZipArchiveMode.Read, leaveOpen: false);
            ZipArchiveEntry entry = archive.GetEntry(plugin.Manifest.Runtime.Entry)
                ?? throw new PluginJavaScriptRuntimeException(
                    $"Verified JavaScript entry '{plugin.Manifest.Runtime.Entry}' is missing.");
            if (entry.Length > MaximumContextBytes)
            {
                throw new PluginJavaScriptRuntimeException(
                    "JavaScript plugin entry exceeds the runtime source limit.");
            }
            using Stream stream = entry.Open();
            using var buffer = new MemoryStream(checked((int)entry.Length));
            stream.CopyTo(buffer);
            return s_strictUtf8.GetString(buffer.GetBuffer(), 0, checked((int)buffer.Length));
        }
        catch (DecoderFallbackException exception)
        {
            throw new PluginJavaScriptRuntimeException(
                "JavaScript plugin entry is not valid UTF-8.",
                exception);
        }
        catch (InvalidDataException exception)
        {
            throw new PluginJavaScriptRuntimeException(
                "JavaScript plugin package cannot be opened by the runtime.",
                exception);
        }
    }

    private static void EnsureSandboxSupported()
    {
        PluginSandboxProfile sandbox =
            PluginSandboxPolicy.CreateLevelOne(PluginRuntimeType.JavaScript);
        if (sandbox.AllowClrAccess
            || sandbox.AllowAssemblyLoad
            || sandbox.AllowReflection
            || sandbox.AllowServiceProvider
            || sandbox.AllowRawFileSystem
            || sandbox.AllowUnrestrictedNetwork
            || sandbox.AllowProcessSpawn
            || sandbox.ImportedClrTypes.Count != 0)
        {
            throw new PluginJavaScriptRuntimeException(
                "The configured JavaScript sandbox is not a Level 1 deny-by-default profile.");
        }
    }

    private static bool IsResourceLimit(Exception exception)
    {
        for (Exception? current = exception; current is not null; current = current.InnerException)
        {
            if (current is OperationCanceledException
                || current is TimeoutException
                || current.GetType().Name is
                    "ExecutionCanceledException"
                    or "MemoryLimitExceededException"
                    or "StatementsCountOverflowException"
                    or "RecursionDepthOverflowException"
                    or "RegexMatchTimeoutException")
            {
                return true;
            }
        }
        return false;
    }

    private sealed class PluginPool : IDisposable
    {
        private readonly PluginManifest _manifest;
        private readonly string _source;
        private readonly int _poolSize;
        private readonly Func<
            PluginManifest,
            string,
            PluginExecutionBudget,
            CancellationToken,
            Task<Engine>> _factory;
        private readonly CancellationTokenSource _unload = new();
        private readonly SemaphoreSlim _capacity;
        private readonly ConcurrentDictionary<string, EngineBucket> _buckets =
            new(StringComparer.Ordinal);
        private int _activeLeases;
        private int _maximumConcurrentLeases;

        public PluginPool(
            PluginManifest manifest,
            string source,
            int poolSize,
            Func<
                PluginManifest,
                string,
                PluginExecutionBudget,
                CancellationToken,
                Task<Engine>> factory)
        {
            _manifest = manifest;
            _source = source;
            _poolSize = poolSize;
            _factory = factory;
            _capacity = new SemaphoreSlim(poolSize, poolSize);
        }

        public CancellationToken CancellationToken => _unload.Token;

        public async Task ValidateAsync(CancellationToken cancellationToken)
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken,
                _unload.Token);
            if (_manifest.Hooks.Count == 0)
            {
                _ = await _factory(
                    _manifest,
                    _source,
                    s_loadBudget,
                    linked.Token).ConfigureAwait(false);
                return;
            }

            foreach (PluginHookDescriptor descriptor in _manifest.Hooks)
            {
                PluginHookDefinition definition = PluginHookCatalog.Get(descriptor.Name);
                TimeSpan declared = TimeSpan.FromMilliseconds(descriptor.TimeoutMs);
                if (declared > definition.MaximumBudget.Timeout)
                {
                    throw new PluginJavaScriptRuntimeException(
                        $"JavaScript plugin Hook '{descriptor.Name}' exceeds its host timeout.");
                }
                PluginExecutionBudget budget = definition.MaximumBudget with
                {
                    Timeout = declared
                };
                EngineBucket bucket = _buckets.GetOrAdd(
                    descriptor.Name,
                    _ => new EngineBucket(
                        _poolSize,
                        token => _factory(
                            _manifest,
                            _source,
                            budget,
                            token)));
                await bucket.EnsureInitializedAsync(linked.Token).ConfigureAwait(false);
            }
        }

        public async ValueTask<PluginEngineLease> RentAsync(
            PluginHookInvocation invocation,
            CancellationToken cancellationToken)
        {
            await _capacity.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                EngineBucket bucket =
                    _buckets.TryGetValue(invocation.Definition.Name, out EngineBucket? found)
                        ? found
                        : throw new PluginJavaScriptRuntimeException(
                            $"JavaScript plugin Hook '{invocation.Definition.Name}' was not preloaded.");
                Engine engine = await bucket.RentAsync(cancellationToken).ConfigureAwait(false);
                int active = Interlocked.Increment(ref _activeLeases);
                UpdateMaximum(active);
                return new PluginEngineLease(bucket, engine);
            }
            catch
            {
                _capacity.Release();
                throw;
            }
        }

        public async ValueTask DiscardAndReplaceAsync(
            PluginEngineLease lease,
            bool poisoned)
        {
            try
            {
                await lease.Bucket.DiscardAndReplaceAsync(
                    lease.Engine,
                    poisoned,
                    _unload.Token).ConfigureAwait(false);
            }
            finally
            {
                Interlocked.Decrement(ref _activeLeases);
                _capacity.Release();
            }
        }

        public JavaScriptPluginRuntimeSnapshot GetSnapshot()
        {
            EngineBucket[] buckets = [.. _buckets.Values];
            return new JavaScriptPluginRuntimeSnapshot(
                _manifest.Id,
                Loaded: true,
                _poolSize,
                Volatile.Read(ref _activeLeases),
                Volatile.Read(ref _maximumConcurrentLeases),
                buckets.Sum(static item => item.CreatedEngines),
                buckets.Sum(static item => item.DiscardedEngines),
                buckets.Sum(static item => item.PoisonedEngines));
        }

        public void Dispose() => _unload.Cancel();

        private void UpdateMaximum(int active)
        {
            while (true)
            {
                int current = Volatile.Read(ref _maximumConcurrentLeases);
                if (active <= current
                    || Interlocked.CompareExchange(
                        ref _maximumConcurrentLeases,
                        active,
                        current) == current)
                {
                    return;
                }
            }
        }
    }

    private readonly record struct PluginEngineLease(EngineBucket Bucket, Engine Engine);

    private sealed class EngineBucket
    {
        private readonly int _poolSize;
        private readonly Func<CancellationToken, Task<Engine>> _factory;
        private readonly Channel<Engine> _engines;
        private readonly SemaphoreSlim _initializeGate = new(1, 1);
        private volatile bool _initialized;
        private int _activeLeases;
        private int _maximumConcurrentLeases;
        private long _createdEngines;
        private long _discardedEngines;
        private long _poisonedEngines;

        public EngineBucket(int poolSize, Func<CancellationToken, Task<Engine>> factory)
        {
            _poolSize = poolSize;
            _factory = factory;
            _engines = Channel.CreateBounded<Engine>(new BoundedChannelOptions(poolSize)
            {
                FullMode = BoundedChannelFullMode.Wait,
                SingleReader = false,
                SingleWriter = false,
                AllowSynchronousContinuations = false
            });
        }

        public int ActiveLeases => Volatile.Read(ref _activeLeases);

        public int MaximumConcurrentLeases => Volatile.Read(ref _maximumConcurrentLeases);

        public long CreatedEngines => Interlocked.Read(ref _createdEngines);

        public long DiscardedEngines => Interlocked.Read(ref _discardedEngines);

        public long PoisonedEngines => Interlocked.Read(ref _poisonedEngines);

        public async ValueTask<Engine> RentAsync(CancellationToken cancellationToken)
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            Engine engine = await _engines.Reader.ReadAsync(cancellationToken).ConfigureAwait(false);
            CancellationConstraint constraint =
                engine.Constraints.Find<CancellationConstraint>()
                ?? throw new PluginJavaScriptRuntimeException(
                    "Jint engine is missing its cancellation constraint.");
            constraint.Reset(cancellationToken);
            int active = Interlocked.Increment(ref _activeLeases);
            UpdateMaximum(active);
            return engine;
        }

        public async ValueTask DiscardAndReplaceAsync(
            Engine engine,
            bool poisoned,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _discardedEngines);
            if (poisoned)
            {
                Interlocked.Increment(ref _poisonedEngines);
            }
            Interlocked.Decrement(ref _activeLeases);
            try
            {
                Engine replacement = await CreateAsync(cancellationToken).ConfigureAwait(false);
                await _engines.Writer.WriteAsync(replacement, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // Unload deliberately drains the pool and cancels in-flight replacement.
            }
            catch (Exception exception)
            {
                _engines.Writer.TryComplete(exception);
                throw new PluginJavaScriptRuntimeException(
                    "Jint engine pool could not replace a discarded engine.",
                    exception);
            }
        }

        public async Task EnsureInitializedAsync(CancellationToken cancellationToken)
        {
            if (_initialized)
            {
                return;
            }
            await _initializeGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (_initialized)
                {
                    return;
                }
                for (int index = 0; index < _poolSize; index++)
                {
                    Engine engine = await CreateAsync(cancellationToken).ConfigureAwait(false);
                    await _engines.Writer.WriteAsync(engine, cancellationToken).ConfigureAwait(false);
                }
                _initialized = true;
            }
            finally
            {
                _initializeGate.Release();
            }
        }

        private async Task<Engine> CreateAsync(CancellationToken cancellationToken)
        {
            Engine engine = await _factory(cancellationToken).ConfigureAwait(false);
            Interlocked.Increment(ref _createdEngines);
            return engine;
        }

        private void UpdateMaximum(int active)
        {
            while (true)
            {
                int current = Volatile.Read(ref _maximumConcurrentLeases);
                if (active <= current
                    || Interlocked.CompareExchange(
                        ref _maximumConcurrentLeases,
                        active,
                        current) == current)
                {
                    return;
                }
            }
        }
    }
}

public sealed record JavaScriptHostOperation(string Name, PluginCapability Capability);

public static class JavaScriptHostOperationCatalog
{
    private static readonly IReadOnlyDictionary<string, JavaScriptHostOperation> s_operations =
        new Dictionary<string, JavaScriptHostOperation>(StringComparer.Ordinal)
        {
            ["log.write"] = O("log.write", PluginCapability.PluginLogWrite),
            ["storage.kv.get"] = O("storage.kv.get", PluginCapability.PluginStorageKv),
            ["storage.kv.put"] = O("storage.kv.put", PluginCapability.PluginStorageKv),
            ["storage.kv.delete"] = O("storage.kv.delete", PluginCapability.PluginStorageKv),
            ["storage.object.get"] = O("storage.object.get", PluginCapability.PluginStorageObject),
            ["storage.object.put"] = O("storage.object.put", PluginCapability.PluginStorageObject),
            ["article.read"] = O("article.read", PluginCapability.ArticleRead),
            ["article.render"] = O("article.render", PluginCapability.ArticleRender),
            ["article.write.draft"] = O("article.write.draft", PluginCapability.ArticleWriteDraft),
            ["comment.read"] = O("comment.read", PluginCapability.CommentRead),
            ["comment.create"] = O("comment.create", PluginCapability.CommentCreate),
            ["comment.moderate"] = O("comment.moderate", PluginCapability.CommentModerate),
            ["search.query.rewrite"] = O("search.query.rewrite", PluginCapability.SearchQueryRewrite),
            ["search.index.write"] = O("search.index.write", PluginCapability.SearchIndexWrite),
            ["media.process"] = O("media.process", PluginCapability.MediaProcess),
            ["network.http.request"] = O("network.http.request", PluginCapability.NetworkHttpOutbound),
            ["scheduler.job.create"] = O("scheduler.job.create", PluginCapability.SchedulerJobCreate),
            ["theme.asset.read"] = O("theme.asset.read", PluginCapability.ThemeAssetRead)
        };

    public static JavaScriptHostOperation Get(string name)
        => s_operations.TryGetValue(name, out JavaScriptHostOperation? operation)
            ? operation
            : throw new PluginJavaScriptRuntimeException(
                $"JavaScript Host API operation '{name}' is unsupported.");

    private static JavaScriptHostOperation O(string name, PluginCapability capability)
        => new(name, capability);
}

public sealed class PluginJavaScriptRuntimeException(
    string message,
    Exception? innerException = null) : InvalidOperationException(message, innerException);
