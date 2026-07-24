using System.IO.Compression;
using System.Text;

using FsusBlog.Server.Infrastructure.Plugins;

namespace FsusBlog.Server.Tests;

public sealed class LuaPluginRuntimeTests
{
    [Fact]
    public async Task Load_ReadsVerifiedEntry_RegistersHooks_AndInvokesThroughRuntimeRoute()
    {
        var registry = new PluginHookRegistry();
        var engine = new RecordingLuaEngine();
        var runtime = new LuaPluginRuntime(engine, registry);
        PluginRegistryEntry plugin = CreatePlugin(
            """
            function activate(ctx)
              ctx.hooks:on("comment.beforeCreate", function(event)
                return ctx.next()
              end)
            end
            """);

        await runtime.LoadAsync(plugin);

        Assert.NotNull(engine.LastRequest);
        Assert.Equal("lua/main.lua", engine.LastRequest.EntryPath);
        Assert.Equal(
            ["math", "string", "table", "utf8"],
            engine.LastRequest.AllowedStandardLibraries.Order(StringComparer.Ordinal));
        Assert.False(engine.LastRequest.Sandbox.AllowClrAccess);
        Assert.False(engine.LastRequest.Sandbox.AllowRawFileSystem);
        Assert.Single(registry.Get("comment.beforeCreate"));

        var grants = new InMemoryPluginPermissionGrantStore();
        grants.Replace(
            plugin.Manifest.Id,
            new HashSet<PluginCapability> { PluginCapability.CommentCreate });
        var permissions = new PluginPermissionManager(grants);
        using var budget = Budget();
        PluginHookResult result = await new LuaPluginHookRuntimeInvoker(runtime).InvokeAsync(
            Invocation(plugin.Manifest.Id, budget, permissions, "contains spam"),
            CancellationToken.None);

        Assert.False(result.Continue);
        Assert.Equal("spam_detected", result.Value);
        Assert.Equal(1, permissions.DemandCount);
        Assert.Equal(1, engine.Program.InvocationCount);
    }

    [Fact]
    public async Task HostApiGrant_IsRecheckedInsideEveryLuaInvocation()
    {
        var registry = new PluginHookRegistry();
        var engine = new RecordingLuaEngine();
        var runtime = new LuaPluginRuntime(engine, registry);
        PluginRegistryEntry plugin = CreatePlugin("function activate(ctx) end");
        await runtime.LoadAsync(plugin);
        var store = new InMemoryPluginPermissionGrantStore();
        store.Replace(
            plugin.Manifest.Id,
            new HashSet<PluginCapability> { PluginCapability.CommentCreate });
        var permissions = new PluginPermissionManager(store);

        using var firstBudget = Budget();
        PluginHookResult first = await runtime.InvokeHookAsync(
            Invocation(plugin.Manifest.Id, firstBudget, permissions, "clean"));
        Assert.True(first.Continue);

        store.Replace(plugin.Manifest.Id, new HashSet<PluginCapability>());
        using var revokedBudget = Budget();
        await Assert.ThrowsAsync<PluginCapabilityDeniedException>(
            () => runtime.InvokeHookAsync(
                Invocation(plugin.Manifest.Id, revokedBudget, permissions, "clean")).AsTask());

        Assert.Equal(2, permissions.DemandCount);
        Assert.Equal(2, engine.Program.InvocationCount);
    }

    [Fact]
    public async Task Load_FailsClosedWhenEngineCannotEnforceLevelOneSandbox()
    {
        var registry = new PluginHookRegistry();
        var runtime = new LuaPluginRuntime(
            new UnavailableLuaScriptEngineAdapter(),
            registry);

        LuaPluginRuntimeException exception = await Assert.ThrowsAsync<LuaPluginRuntimeException>(
            () => runtime.LoadAsync(
                CreatePlugin("function activate(ctx) end")).AsTask());

        Assert.Contains("Level 1 sandbox", exception.Message, StringComparison.Ordinal);
        Assert.Empty(registry.Get("comment.beforeCreate"));
    }

    [Fact]
    public async Task Load_RejectsDisabledRegistryEntryBeforeCompilation()
    {
        var registry = new PluginHookRegistry();
        var engine = new RecordingLuaEngine();
        var runtime = new LuaPluginRuntime(engine, registry);
        PluginRegistryEntry disabled = CreatePlugin("function activate(ctx) end") with
        {
            InstallState = PluginInstallState.Disabled,
            Enabled = false
        };

        LuaPluginRuntimeException exception = await Assert.ThrowsAsync<LuaPluginRuntimeException>(
            () => runtime.LoadAsync(disabled).AsTask());

        Assert.Contains("must be enabled", exception.Message, StringComparison.Ordinal);
        Assert.Null(engine.LastRequest);
        Assert.Empty(registry.Get("comment.beforeCreate"));
    }

    [Fact]
    public async Task Load_RejectsMissingDeclaredHookWithoutPublishingRegistration()
    {
        var registry = new PluginHookRegistry();
        var engine = new RecordingLuaEngine
        {
            RegisteredHooks = new HashSet<string>(StringComparer.Ordinal)
        };
        var runtime = new LuaPluginRuntime(engine, registry);

        LuaPluginRuntimeException exception = await Assert.ThrowsAsync<LuaPluginRuntimeException>(
            () => runtime.LoadAsync(
                CreatePlugin("function activate(ctx) end")).AsTask());

        Assert.Contains("did not register", exception.Message, StringComparison.Ordinal);
        Assert.True(engine.Program.Disposed);
        Assert.Empty(registry.Get("comment.beforeCreate"));
    }

    [Fact]
    public async Task BudgetAndUnload_StopExecutionWithoutLeavingHookRegistration()
    {
        var registry = new PluginHookRegistry();
        var engine = new RecordingLuaEngine
        {
            InstructionsPerInvocation = 101
        };
        var runtime = new LuaPluginRuntime(engine, registry);
        PluginRegistryEntry plugin = CreatePlugin("function activate(ctx) end");
        await runtime.LoadAsync(plugin);
        var store = new InMemoryPluginPermissionGrantStore();
        store.Replace(
            plugin.Manifest.Id,
            new HashSet<PluginCapability> { PluginCapability.CommentCreate });

        using var budget = new PluginExecutionBudgetGuard(
            new PluginExecutionBudget(
                TimeSpan.FromSeconds(30),
                1024,
                100,
                8,
                1024,
                1024),
            TimeProvider.System);
        await Assert.ThrowsAsync<PluginResourceLimitException>(
            () => runtime.InvokeHookAsync(
                Invocation(
                    plugin.Manifest.Id,
                    budget,
                    new PluginPermissionManager(store),
                    "clean")).AsTask());

        await runtime.UnloadAsync(plugin.Manifest.Id);

        Assert.Empty(registry.Get("comment.beforeCreate"));
        Assert.True(engine.Program.Disposed);
        using var afterUnloadBudget = Budget();
        await Assert.ThrowsAsync<LuaPluginRuntimeException>(
            () => runtime.InvokeHookAsync(
                Invocation(
                    plugin.Manifest.Id,
                    afterUnloadBudget,
                    new PluginPermissionManager(store),
                    "clean")).AsTask());
    }

    [Fact]
    public async Task Unload_RemovesRegistrationAndWaitsForInFlightProgramBeforeDispose()
    {
        var registry = new PluginHookRegistry();
        var engine = new RecordingLuaEngine
        {
            BlockInvocation = true
        };
        var runtime = new LuaPluginRuntime(engine, registry);
        PluginRegistryEntry plugin = CreatePlugin("function activate(ctx) end");
        await runtime.LoadAsync(plugin);
        var store = new InMemoryPluginPermissionGrantStore();
        store.Replace(
            plugin.Manifest.Id,
            new HashSet<PluginCapability> { PluginCapability.CommentCreate });
        using var budget = Budget();

        Task<PluginHookResult> invocation = runtime.InvokeHookAsync(
            Invocation(
                plugin.Manifest.Id,
                budget,
                new PluginPermissionManager(store),
                "clean")).AsTask();
        await engine.Program.InvocationStarted.Task;
        Task unload = runtime.UnloadAsync(plugin.Manifest.Id).AsTask();

        Assert.Empty(registry.Get("comment.beforeCreate"));
        Assert.False(unload.IsCompleted);
        Assert.False(engine.Program.Disposed);

        engine.Program.InvocationRelease.SetResult();
        await invocation;
        await unload;

        Assert.True(engine.Program.Disposed);
    }

    private static PluginHookInvocation Invocation(
        string pluginId,
        PluginExecutionBudgetGuard budget,
        PluginPermissionManager permissions,
        object payload)
    {
        PluginHookDefinition definition = PluginHookCatalog.Get("comment.beforeCreate");
        return new PluginHookInvocation(
            pluginId,
            PluginRuntimeType.Lua,
            definition,
            Hook(),
            new PluginHookContext(
                definition.Name,
                "trace-lua-122",
                "operation-lua-122",
                payload,
                new Dictionary<string, object?>()),
            budget,
            new PluginHostApiProxy(pluginId, permissions));
    }

    private static PluginExecutionBudgetGuard Budget()
        => new(
            new PluginExecutionBudget(
                TimeSpan.FromSeconds(1),
                1024 * 1024,
                1000,
                8,
                1024,
                1024),
            TimeProvider.System);

    private static PluginRegistryEntry CreatePlugin(string source)
    {
        const string PluginId = "fsusblog.example.lua-comment-filter";
        PluginManifest manifest = new()
        {
            Id = PluginId,
            Name = "Lua comment filter",
            Version = "1.0.0",
            Fsusblog = ">=1.3.0 <1.4.0",
            Author = "tests",
            Description = "Controlled Lua adapter test",
            Runtime = new PluginRuntimeDescriptor
            {
                Type = PluginRuntimeType.Lua,
                Entry = "lua/main.lua"
            },
            Hooks = [Hook()],
            Capabilities = ["comment.create"],
            Permissions = new PluginPermissionDescriptor
            {
                Network = false,
                Filesystem = false,
                Database = "none"
            },
            ConfigSchema = "config/schema.json"
        };
        return new PluginRegistryEntry(
            manifest,
            PluginInstallState.Enabled,
            Enabled: true,
            PackageBytes: Package(source),
            PackageSha256: new byte[32],
            InstalledAtUtc: DateTimeOffset.Parse("2026-07-24T00:00:00Z"),
            UpdatedAtUtc: DateTimeOffset.Parse("2026-07-24T00:00:00Z"),
            Version: 1);
    }

    private static PluginHookDescriptor Hook()
        => new()
        {
            Name = "comment.beforeCreate",
            Priority = 100,
            TimeoutMs = 30,
            FailPolicy = "fail-closed",
            ExecutionMode = "sync",
            Scope = "local",
            Idempotent = true
        };

    private static byte[] Package(string source)
    {
        using var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            ZipArchiveEntry entry = archive.CreateEntry(
                "lua/main.lua",
                CompressionLevel.NoCompression);
            using Stream output = entry.Open();
            using var writer = new StreamWriter(output, new UTF8Encoding(false));
            writer.Write(source);
        }
        return stream.ToArray();
    }

    private sealed class RecordingLuaEngine : ILuaScriptEngineAdapter
    {
        public string Name => "recording-secure-engine";

        public LuaEngineSecurityCapabilities SecurityCapabilities => new(
            SupportsLibraryAllowList: true,
            DisablesClrInterop: true,
            DisablesAssemblyLoad: true,
            DisablesReflection: true,
            DisablesRawFileSystem: true,
            DisablesUnrestrictedNetwork: true,
            DisablesProcessSpawn: true,
            SupportsInstructionBudget: true,
            SupportsMemoryBudget: true,
            SupportsCallDepthBudget: true,
            SupportsOutputBudget: true,
            SupportsLogBudget: true,
            SupportsCancellation: true);

        public IReadOnlySet<string> RegisteredHooks
        {
            get; set;
        } = new HashSet<string>(["comment.beforeCreate"], StringComparer.Ordinal);

        public long InstructionsPerInvocation
        {
            get; set;
        } = 10;

        public bool BlockInvocation
        {
            get; set;
        }

        public LuaPluginCompilationRequest? LastRequest
        {
            get; private set;
        }

        public RecordingLuaProgram Program
        {
            get; private set;
        } = null!;

        public ValueTask<ILuaPluginProgram> CompileAsync(
            LuaPluginCompilationRequest request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            LastRequest = request;
            Program = new RecordingLuaProgram(
                RegisteredHooks,
                InstructionsPerInvocation,
                BlockInvocation);
            return ValueTask.FromResult<ILuaPluginProgram>(Program);
        }
    }

    private sealed class RecordingLuaProgram(
        IReadOnlySet<string> registeredHooks,
        long instructionsPerInvocation,
        bool blockInvocation) : ILuaPluginProgram
    {
        public IReadOnlySet<string> RegisteredHooks => registeredHooks;

        public TaskCompletionSource InvocationStarted
        {
            get;
        } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource InvocationRelease
        {
            get;
        } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int InvocationCount
        {
            get; private set;
        }

        public bool Disposed
        {
            get; private set;
        }

        public async ValueTask<PluginHookResult> InvokeHookAsync(
            LuaPluginExecutionContext context,
            CancellationToken cancellationToken)
        {
            InvocationCount++;
            InvocationStarted.TrySetResult();
            if (blockInvocation)
            {
                await InvocationRelease.Task.WaitAsync(cancellationToken);
            }
            context.Budget.ConsumeInstructions(instructionsPerInvocation);
            context.Budget.ReserveMemory(128);
            context.Budget.RecordLog(16);
            using IDisposable call = context.Budget.EnterCall();
            string content = (string)context.Payload!;
            PluginHookResult result = await context.InvokeHostAsync(
                PluginCapability.CommentCreate,
                _ => ValueTask.FromResult(
                    content.Contains("spam", StringComparison.Ordinal)
                        ? PluginHookResult.Stop("spam_detected")
                        : PluginHookResult.Next(content)),
                cancellationToken);
            context.Budget.RecordOutput(32);
            return result;
        }

        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.CompletedTask;
        }
    }
}
