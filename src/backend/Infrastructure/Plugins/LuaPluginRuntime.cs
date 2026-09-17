using System.Collections.Concurrent;
using System.Collections.Frozen;
using System.IO.Compression;
using System.Text;

namespace FsusBlog.Server.Infrastructure.Plugins;

public sealed record LuaEngineSecurityCapabilities(
    bool SupportsLibraryAllowList,
    bool DisablesClrInterop,
    bool DisablesAssemblyLoad,
    bool DisablesReflection,
    bool DisablesRawFileSystem,
    bool DisablesUnrestrictedNetwork,
    bool DisablesProcessSpawn,
    bool SupportsInstructionBudget,
    bool SupportsMemoryBudget,
    bool SupportsCallDepthBudget,
    bool SupportsOutputBudget,
    bool SupportsLogBudget,
    bool SupportsCancellation);

public sealed record LuaPluginCompilationRequest(
    string PluginId,
    string EntryPath,
    string Source,
    PluginSandboxProfile Sandbox,
    IReadOnlySet<string> AllowedStandardLibraries,
    IReadOnlyList<string> DeclaredHooks);

public sealed record LuaPluginExecutionContext(
    string PluginId,
    string HookName,
    object? Payload,
    IReadOnlyDictionary<string, object?> Items,
    PluginExecutionBudgetGuard Budget,
    PluginHostApiProxy HostApi)
{
    public ValueTask<T> InvokeHostAsync<T>(
        PluginCapability capability,
        Func<CancellationToken, ValueTask<T>> operation,
        CancellationToken cancellationToken)
    {
        Budget.ThrowIfTimeoutExceeded();
        Budget.ConsumeInstructions(1);
        return HostApi.InvokeAsync(capability, operation, cancellationToken);
    }
}

public interface ILuaPluginProgram : IAsyncDisposable
{
    IReadOnlySet<string> RegisteredHooks
    {
        get;
    }

    ValueTask<PluginHookResult> InvokeHookAsync(
        LuaPluginExecutionContext context,
        CancellationToken cancellationToken);
}

public interface ILuaScriptEngineAdapter
{
    string Name
    {
        get;
    }

    LuaEngineSecurityCapabilities SecurityCapabilities
    {
        get;
    }

    ValueTask<ILuaPluginProgram> CompileAsync(
        LuaPluginCompilationRequest request,
        CancellationToken cancellationToken);
}

public interface ILuaPluginRuntime
{
    ValueTask LoadAsync(PluginRegistryEntry plugin, CancellationToken cancellationToken = default);

    ValueTask<PluginHookResult> InvokeHookAsync(
        PluginHookInvocation invocation,
        CancellationToken cancellationToken = default);

    ValueTask UnloadAsync(string pluginId, CancellationToken cancellationToken = default);
}

public sealed class LuaPluginRuntime(
    ILuaScriptEngineAdapter engine,
    IPluginHookRegistry hooks) : ILuaPluginRuntime
{
    private const int MaximumSourceBytes = 1024 * 1024;
    private static readonly IReadOnlySet<string> s_allowedStandardLibraries =
        new[] { "string", "table", "math", "utf8" }.ToFrozenSet(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, LoadedLuaPlugin> _loaded =
        new(StringComparer.Ordinal);

    public async ValueTask LoadAsync(
        PluginRegistryEntry plugin,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(plugin);
        if (plugin.Manifest.Runtime.Type != PluginRuntimeType.Lua)
        {
            throw new LuaPluginRuntimeException(
                $"Plugin '{plugin.Manifest.Id}' does not declare runtime=lua.");
        }
        if (!plugin.Enabled || plugin.InstallState != PluginInstallState.Enabled)
        {
            throw new LuaPluginRuntimeException(
                $"Lua plugin '{plugin.Manifest.Id}' must be enabled before runtime load.");
        }
        ValidateEngineSecurity(engine);
        string source = ReadEntrySource(plugin);
        PluginSandboxProfile sandbox = PluginSandboxPolicy.CreateLevelOne(PluginRuntimeType.Lua);
        var request = new LuaPluginCompilationRequest(
            plugin.Manifest.Id,
            plugin.Manifest.Runtime.Entry,
            source,
            sandbox,
            s_allowedStandardLibraries,
            Array.AsReadOnly(
                plugin.Manifest.Hooks.Select(static item => item.Name).ToArray()));
        ILuaPluginProgram program = await engine.CompileAsync(request, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            string[] missingHooks =
            [
                .. plugin.Manifest.Hooks
                    .Select(static item => item.Name)
                    .Where(name => !program.RegisteredHooks.Contains(name))
                    .Order(StringComparer.Ordinal)
            ];
            if (missingHooks.Length > 0)
            {
                throw new LuaPluginRuntimeException(
                    $"Lua plugin '{plugin.Manifest.Id}' did not register declared hooks: "
                    + string.Join(", ", missingHooks));
            }

        }
        catch
        {
            await program.DisposeAsync().ConfigureAwait(false);
            throw;
        }

        var replacement = new LoadedLuaPlugin(
            program,
            plugin.Manifest.Hooks.Select(static item => item.Name)
                .ToFrozenSet(StringComparer.Ordinal));
        LoadedLuaPlugin? replaced = null;
        _loaded.AddOrUpdate(
            plugin.Manifest.Id,
            replacement,
            (_, previous) =>
            {
                replaced = previous;
                return replacement;
            });
        hooks.ReplacePlugin(
            plugin.Manifest.Id,
            PluginRuntimeType.Lua,
            plugin.Manifest.Hooks);
        if (replaced is not null)
        {
            await replaced.RetireAsync().ConfigureAwait(false);
        }
    }

    public async ValueTask<PluginHookResult> InvokeHookAsync(
        PluginHookInvocation invocation,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(invocation);
        if (invocation.Runtime != PluginRuntimeType.Lua)
        {
            throw new LuaPluginRuntimeException(
                $"Lua runtime cannot invoke '{invocation.Runtime}' plugin '{invocation.PluginId}'.");
        }
        LoadedLuaPlugin loaded;
        while (true)
        {
            if (!_loaded.TryGetValue(invocation.PluginId, out loaded!)
                || !loaded.Hooks.Contains(invocation.Definition.Name))
            {
                throw new LuaPluginRuntimeException(
                    $"Lua plugin '{invocation.PluginId}' is not loaded for hook '{invocation.Definition.Name}'.");
            }
            if (loaded.TryAcquire())
            {
                break;
            }
        }

        try
        {
            invocation.Budget.ThrowIfTimeoutExceeded();
            var context = new LuaPluginExecutionContext(
                invocation.PluginId,
                invocation.Definition.Name,
                invocation.Context.Payload,
                invocation.Context.Items,
                invocation.Budget,
                invocation.HostApi);
            PluginHookResult result = await loaded.Program.InvokeHookAsync(context, cancellationToken)
                .ConfigureAwait(false);
            invocation.Budget.ThrowIfTimeoutExceeded();
            return result;
        }
        finally
        {
            await loaded.ReleaseAsync().ConfigureAwait(false);
        }
    }

    public async ValueTask UnloadAsync(
        string pluginId,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pluginId);
        cancellationToken.ThrowIfCancellationRequested();
        hooks.RemovePlugin(pluginId);
        if (_loaded.TryRemove(pluginId, out LoadedLuaPlugin? loaded))
        {
            await loaded.RetireAsync().ConfigureAwait(false);
        }
    }

    private static void ValidateEngineSecurity(ILuaScriptEngineAdapter engine)
    {
        LuaEngineSecurityCapabilities capabilities = engine.SecurityCapabilities;
        if (!capabilities.SupportsLibraryAllowList
            || !capabilities.DisablesClrInterop
            || !capabilities.DisablesAssemblyLoad
            || !capabilities.DisablesReflection
            || !capabilities.DisablesRawFileSystem
            || !capabilities.DisablesUnrestrictedNetwork
            || !capabilities.DisablesProcessSpawn
            || !capabilities.SupportsInstructionBudget
            || !capabilities.SupportsMemoryBudget
            || !capabilities.SupportsCallDepthBudget
            || !capabilities.SupportsOutputBudget
            || !capabilities.SupportsLogBudget
            || !capabilities.SupportsCancellation)
        {
            throw new LuaPluginRuntimeException(
                $"Lua engine '{engine.Name}' cannot enforce the required Level 1 sandbox.");
        }
    }

    private static string ReadEntrySource(PluginRegistryEntry plugin)
    {
        if (plugin.PackageBytes.Length == 0)
        {
            throw new LuaPluginRuntimeException(
                $"Lua plugin '{plugin.Manifest.Id}' has no verified package bytes.");
        }
        try
        {
            using var package = new MemoryStream(plugin.PackageBytes, writable: false);
            using var archive = new ZipArchive(package, ZipArchiveMode.Read, leaveOpen: false);
            ZipArchiveEntry? entry = archive.GetEntry(plugin.Manifest.Runtime.Entry);
            if (entry is null
                || entry.Length <= 0
                || entry.Length > MaximumSourceBytes)
            {
                throw new LuaPluginRuntimeException(
                    $"Lua entry '{plugin.Manifest.Runtime.Entry}' is missing, empty, or too large.");
            }
            using Stream input = entry.Open();
            using var bounded = new MemoryStream(capacity: checked((int)entry.Length));
            input.CopyTo(bounded);
            if (bounded.Length != entry.Length || bounded.Length > MaximumSourceBytes)
            {
                throw new LuaPluginRuntimeException(
                    $"Lua entry '{plugin.Manifest.Runtime.Entry}' exceeded its verified size.");
            }
            string source = new UTF8Encoding(
                encoderShouldEmitUTF8Identifier: false,
                throwOnInvalidBytes: true).GetString(bounded.GetBuffer(), 0, checked((int)bounded.Length));
            if (source.IndexOf('\0') >= 0)
            {
                throw new LuaPluginRuntimeException("Lua entry contains a NUL character.");
            }
            return source;
        }
        catch (LuaPluginRuntimeException)
        {
            throw;
        }
        catch (Exception exception) when (
            exception is InvalidDataException
                or IOException
                or DecoderFallbackException
                or OverflowException)
        {
            throw new LuaPluginRuntimeException(
                $"Lua plugin '{plugin.Manifest.Id}' package could not be loaded.",
                exception);
        }
    }

    private sealed class LoadedLuaPlugin(
        ILuaPluginProgram program,
        IReadOnlySet<string> hooks)
    {
        private readonly object _gate = new();
        private int _leases;
        private bool _retired;
        private Task? _disposeTask;
        private readonly TaskCompletionSource _retirement =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public ILuaPluginProgram Program
        {
            get;
        } = program;

        public IReadOnlySet<string> Hooks
        {
            get;
        } = hooks;

        public bool TryAcquire()
        {
            lock (_gate)
            {
                if (_retired)
                {
                    return false;
                }
                _leases++;
                return true;
            }
        }

        public ValueTask ReleaseAsync()
        {
            Task? disposeTask;
            lock (_gate)
            {
                _leases--;
                disposeTask = StartDisposeIfReady();
            }
            return disposeTask is null ? ValueTask.CompletedTask : new ValueTask(disposeTask);
        }

        public ValueTask RetireAsync()
        {
            Task? disposeTask;
            lock (_gate)
            {
                _retired = true;
                disposeTask = StartDisposeIfReady();
            }
            return disposeTask is null ? ValueTask.CompletedTask : new ValueTask(disposeTask);
        }

        private Task? StartDisposeIfReady()
        {
            if (!_retired)
            {
                return null;
            }
            if (_leases == 0)
            {
                _disposeTask ??= DisposeAndSignalAsync();
            }
            return _disposeTask ?? _retirement.Task;
        }

        private async Task DisposeAndSignalAsync()
        {
            try
            {
                await Program.DisposeAsync().ConfigureAwait(false);
                _retirement.TrySetResult();
            }
            catch (Exception exception)
            {
                _retirement.TrySetException(exception);
                throw;
            }
        }
    }
}

public sealed class UnavailableLuaScriptEngineAdapter : ILuaScriptEngineAdapter
{
    public string Name => "unavailable";

    public LuaEngineSecurityCapabilities SecurityCapabilities => new(
        SupportsLibraryAllowList: false,
        DisablesClrInterop: false,
        DisablesAssemblyLoad: false,
        DisablesReflection: false,
        DisablesRawFileSystem: false,
        DisablesUnrestrictedNetwork: false,
        DisablesProcessSpawn: false,
        SupportsInstructionBudget: false,
        SupportsMemoryBudget: false,
        SupportsCallDepthBudget: false,
        SupportsOutputBudget: false,
        SupportsLogBudget: false,
        SupportsCancellation: false);

    public ValueTask<ILuaPluginProgram> CompileAsync(
        LuaPluginCompilationRequest request,
        CancellationToken cancellationToken)
        => ValueTask.FromException<ILuaPluginProgram>(
            new LuaPluginRuntimeException(
                "No Lua engine adapter is installed; Lua plugins remain fail-closed."));
}

public sealed class LuaPluginHookRuntimeInvoker(ILuaPluginRuntime lua) : IPluginHookRuntimeInvoker
{
    public ValueTask<PluginHookResult> InvokeAsync(
        PluginHookInvocation invocation,
        CancellationToken cancellationToken)
        => invocation.Runtime == PluginRuntimeType.Lua
            ? lua.InvokeHookAsync(invocation, cancellationToken)
            : ValueTask.FromException<PluginHookResult>(
                new PluginHookDispatchException(
                    $"Plugin runtime '{invocation.Runtime}' is not available on this node."));
}

public sealed class LuaPluginRuntimeException(string message, Exception? innerException = null)
    : InvalidOperationException(message, innerException);
