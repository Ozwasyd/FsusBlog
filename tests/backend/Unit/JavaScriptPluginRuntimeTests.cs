using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Plugins;

namespace FsusBlog.Server.Tests;

public sealed class JavaScriptPluginRuntimeTests
{
    private const string PluginId = "fsusblog.plugin.comment-guard";

    [Fact]
    public async Task BuiltEsmFixture_LoadsAndExecutesRealJintHook()
    {
        const string Source =
            """
            const definePlugin = plugin => plugin

            export default definePlugin({
              id: 'fsusblog.plugin.comment-guard',

              async activate(ctx) {
                ctx.hooks.on('comment.beforeCreate', async event => {
                  if (event.payload.content.includes('spam')) {
                    await event.log.write('comment rejected by comment-guard')
                    return event.comment.reject('spam_detected')
                  }

                  return event.next()
                })
              }
            })
            """;
        var host = new RecordingHostApi();
        var runtime = new JavaScriptPluginRuntime(
            host,
            new JavaScriptPluginRuntimeOptions(EnginePoolSize: 2));
        PluginPackage package = CreatePackage(
            Source,
            ["comment.create", "plugin.log.write"]);
        await runtime.LoadAsync(package);
        var grants = new InMemoryPluginPermissionGrantStore();
        grants.Replace(
            PluginId,
            new HashSet<PluginCapability>
            {
                PluginCapability.CommentCreate,
                PluginCapability.PluginLogWrite
            });
        var permissions = new PluginPermissionManager(grants);
        using Invocation invocation = CreateInvocation(
            permissions,
            new
            {
                id = 7,
                articleId = 9,
                content = "contains spam"
            },
            budget => budget with
            {
                Timeout = TimeSpan.FromSeconds(5)
            });

        PluginHookResult result = await runtime.InvokeHookAsync(invocation.Value);

        Assert.False(result.Continue);
        JsonElement value = Assert.IsType<JsonElement>(result.Value);
        Assert.Equal("spam_detected", value.GetProperty("reason").GetString());
        Assert.Equal("log.write", Assert.Single(host.Operations));
        JavaScriptPluginRuntimeSnapshot snapshot = runtime.GetSnapshot(PluginId);
        Assert.True(snapshot.Loaded);
        Assert.Equal(2, snapshot.EnginePoolSize);
        Assert.Equal(0, snapshot.ActiveLeases);
        Assert.Equal(1, snapshot.MaximumConcurrentLeases);
        Assert.Equal(3, snapshot.CreatedEngines);
        Assert.Equal(1, snapshot.DiscardedEngines);
        Assert.Equal(0, snapshot.PoisonedEngines);
    }

    [Fact]
    public async Task HostApiProxy_RechecksCapabilityBeforeEveryJavaScriptCall()
    {
        var host = new RecordingHostApi();
        var runtime = new JavaScriptPluginRuntime(
            host,
            new JavaScriptPluginRuntimeOptions(EnginePoolSize: 1));
        await runtime.LoadAsync(CreatePackage(
            """
            export default {
              id: "fsusblog.plugin.comment-guard",
              activate(ctx) {
                ctx.hooks.on("comment.beforeCreate", async event => {
                  await event.log.write("must be granted");
                  return event.next();
                });
              }
            };
            """,
            ["comment.create", "plugin.log.write"]));
        var permissions = new PluginPermissionManager(
            new InMemoryPluginPermissionGrantStore());
        using Invocation invocation = CreateInvocation(
            permissions,
            new
            {
                content = "hello"
            },
            budget => budget with
            {
                Timeout = TimeSpan.FromSeconds(5)
            });

        await Assert.ThrowsAsync<PluginJavaScriptRuntimeException>(
            () => runtime.InvokeHookAsync(invocation.Value).AsTask());

        Assert.Empty(host.Operations);
        Assert.Equal(1, permissions.DemandCount);
        Assert.Equal(1, runtime.GetSnapshot(PluginId).PoisonedEngines);
    }

    [Fact]
    public async Task EnginePool_DoesNotShareAnEngineAcrossConcurrentHookCalls()
    {
        var host = new BlockingHostApi(expectedConcurrentCalls: 2);
        var runtime = new JavaScriptPluginRuntime(
            host,
            new JavaScriptPluginRuntimeOptions(EnginePoolSize: 2));
        await runtime.LoadAsync(CreatePackage(
            """
            let busy = false;
            export default {
              id: "fsusblog.plugin.comment-guard",
              activate(ctx) {
                ctx.hooks.on("scheduler.tick", async event => {
                  if (busy) {
                    return event.stop("engine_shared_concurrently");
                  }
                  busy = true;
                  await event.log.write("wait");
                  busy = false;
                  return event.next(event.payload);
                });
              }
            };
            """,
            ["scheduler.job.create", "plugin.log.write"],
            hookName: "scheduler.tick"));
        var store = new InMemoryPluginPermissionGrantStore();
        store.Replace(
            PluginId,
            new HashSet<PluginCapability>
            {
                PluginCapability.SchedulerJobCreate,
                PluginCapability.PluginLogWrite
            });
        var permissions = new PluginPermissionManager(store);
        using Invocation first = CreateInvocation(permissions, new
        {
            sequence = 1
        }, budget => budget with
        {
            Timeout = TimeSpan.FromSeconds(10)
        }, hookName: "scheduler.tick");
        using Invocation second = CreateInvocation(permissions, new
        {
            sequence = 2
        }, budget => budget with
        {
            Timeout = TimeSpan.FromSeconds(10)
        }, hookName: "scheduler.tick");

        Task<PluginHookResult> firstTask = runtime.InvokeHookAsync(first.Value).AsTask();
        Task<PluginHookResult> secondTask = runtime.InvokeHookAsync(second.Value).AsTask();
        await host.AllEntered.WaitAsync(TimeSpan.FromSeconds(5));

        JavaScriptPluginRuntimeSnapshot active = runtime.GetSnapshot(PluginId);
        Assert.Equal(2, active.ActiveLeases);
        Assert.Equal(2, active.MaximumConcurrentLeases);
        host.Release();
        PluginHookResult[] results = await Task.WhenAll(firstTask, secondTask);

        Assert.All(results, static result => Assert.True(result.Continue));
        JavaScriptPluginRuntimeSnapshot complete = runtime.GetSnapshot(PluginId);
        Assert.Equal(0, complete.ActiveLeases);
        Assert.Equal(2, complete.DiscardedEngines);
        Assert.Equal(0, complete.PoisonedEngines);
    }

    [Fact]
    public async Task JintInstructionBudget_StopsInfiniteHookAndPoisonsLease()
    {
        var runtime = new JavaScriptPluginRuntime(
            new RecordingHostApi(),
            new JavaScriptPluginRuntimeOptions(EnginePoolSize: 1));
        await runtime.LoadAsync(CreatePackage(
            """
            export default {
              id: "fsusblog.plugin.comment-guard",
              activate(ctx) {
                ctx.hooks.on("comment.beforeCreate", event => {
                  while (true) {
                  }
                });
              }
            };
            """,
            ["comment.create"]));
        var store = new InMemoryPluginPermissionGrantStore();
        store.Replace(
            PluginId,
            new HashSet<PluginCapability>
            {
                PluginCapability.CommentCreate
            });
        var permissions = new PluginPermissionManager(store);
        using Invocation invocation = CreateInvocation(
            permissions,
            new
            {
                content = "hello"
            },
            budget => budget with
            {
                Timeout = TimeSpan.FromSeconds(1),
                InstructionCount = 500
            });

        await Assert.ThrowsAsync<PluginResourceLimitException>(
            () => runtime.InvokeHookAsync(invocation.Value).AsTask());

        JavaScriptPluginRuntimeSnapshot snapshot = runtime.GetSnapshot(PluginId);
        Assert.Equal(1, snapshot.DiscardedEngines);
        Assert.Equal(1, snapshot.PoisonedEngines);
    }

    [Fact]
    public async Task LevelOneJintProfile_DoesNotExposeClrNamespaceOrImportHelpers()
    {
        var runtime = new JavaScriptPluginRuntime(
            new RecordingHostApi(),
            new JavaScriptPluginRuntimeOptions(EnginePoolSize: 1));
        await runtime.LoadAsync(CreatePackage(
            """
            export default {
              id: "fsusblog.plugin.comment-guard",
              activate(ctx) {
                ctx.hooks.on("comment.beforeCreate", event =>
                  event.next(
                    `${typeof globalThis.System}:` +
                    `${typeof globalThis.clr}:` +
                    `${typeof globalThis.importNamespace}`));
              }
            };
            """,
            ["comment.create"]));
        var store = new InMemoryPluginPermissionGrantStore();
        store.Replace(
            PluginId,
            new HashSet<PluginCapability>
            {
                PluginCapability.CommentCreate
            });
        var permissions = new PluginPermissionManager(store);
        using Invocation invocation = CreateInvocation(
            permissions,
            new
            {
                content = "hello"
            });

        PluginHookResult result = await runtime.InvokeHookAsync(invocation.Value);

        JsonElement value = Assert.IsType<JsonElement>(result.Value);
        Assert.Equal("undefined:undefined:undefined", value.GetString());
    }

    [Fact]
    public async Task Load_RejectsManifestAndDefaultExportIdentityMismatch()
    {
        var runtime = new JavaScriptPluginRuntime(
            new RecordingHostApi(),
            new JavaScriptPluginRuntimeOptions(EnginePoolSize: 1));
        PluginPackage package = CreatePackage(
            """
            export default {
              id: "fsusblog.plugin.someone-else",
              activate() {
              }
            };
            """,
            ["comment.create"]);

        await Assert.ThrowsAsync<PluginJavaScriptRuntimeException>(
            () => runtime.LoadAsync(package).AsTask());

        Assert.False(runtime.GetSnapshot(PluginId).Loaded);
    }

    [Fact]
    public async Task Unload_CancelsAndRemovesPoolWithoutAProcessRestart()
    {
        var runtime = new JavaScriptPluginRuntime(
            new RecordingHostApi(),
            new JavaScriptPluginRuntimeOptions(EnginePoolSize: 1));
        await runtime.LoadAsync(CreatePackage(
            """
            export default {
              id: "fsusblog.plugin.comment-guard",
              activate(ctx) {
                ctx.hooks.on("comment.beforeCreate", event => event.next());
              }
            };
            """,
            ["comment.create"]));

        await runtime.UnloadAsync(PluginId);

        Assert.False(runtime.GetSnapshot(PluginId).Loaded);
    }

    [Fact]
    public async Task ScriptRuntimeInvoker_RoutesJavaScriptAndLuaWithoutRegistrationOrderFallback()
    {
        var javaScript = new RecordingJavaScriptRuntime();
        var lua = new RecordingLuaRuntime();
        var runtime = new ScriptPluginHookRuntimeInvoker(javaScript, lua);
        var permissions = new PluginPermissionManager(
            new InMemoryPluginPermissionGrantStore());
        using Invocation javaScriptInvocation = CreateInvocation(
            permissions,
            new
            {
                runtime = "javascript"
            });
        using Invocation luaInvocation = CreateInvocation(
            permissions,
            new
            {
                runtime = "lua"
            },
            runtime: PluginRuntimeType.Lua);

        await runtime.InvokeAsync(javaScriptInvocation.Value, CancellationToken.None);
        await runtime.InvokeAsync(luaInvocation.Value, CancellationToken.None);

        Assert.Equal(1, javaScript.InvokeCount);
        Assert.Equal(1, lua.InvokeCount);
    }

    private static Invocation CreateInvocation(
        PluginPermissionManager permissions,
        object payload,
        Func<PluginExecutionBudget, PluginExecutionBudget>? configureBudget = null,
        string hookName = "comment.beforeCreate",
        PluginRuntimeType runtime = PluginRuntimeType.JavaScript)
    {
        PluginHookDefinition definition = PluginHookCatalog.Get(hookName);
        PluginExecutionBudget budget = configureBudget?.Invoke(definition.MaximumBudget)
            ?? definition.MaximumBudget;
        var guard = new PluginExecutionBudgetGuard(
            budget,
            TimeProvider.System);
        return new Invocation(
            new PluginHookInvocation(
                PluginId,
                runtime,
                definition,
                new PluginHookDescriptor
                {
                    Name = definition.Name,
                    Priority = 100,
                    TimeoutMs = checked((int)budget.Timeout.TotalMilliseconds),
                    FailPolicy = "fail-closed",
                    ExecutionMode = "sync",
                    Scope = "local",
                    Idempotent = true
                },
                new PluginHookContext(
                    definition.Name,
                    "trace-120",
                    Guid.NewGuid().ToString("N"),
                    payload,
                    new Dictionary<string, object?>()),
                guard,
                new PluginHostApiProxy(PluginId, permissions)),
            guard);
    }

    private static PluginPackage CreatePackage(
        string source,
        IReadOnlyList<string> capabilities,
        string hookName = "comment.beforeCreate")
    {
        PluginHookDefinition definition = PluginHookCatalog.Get(hookName);
        var manifest = new PluginManifest
        {
            Id = PluginId,
            Name = "Comment Guard",
            Version = "1.0.0",
            Fsusblog = ">=1.3.0 <1.4.0",
            Author = "example",
            Description = "Jint runtime fixture",
            Runtime = new PluginRuntimeDescriptor
            {
                Type = PluginRuntimeType.JavaScript,
                Entry = "dist/main.js"
            },
            Hooks =
            [
                new PluginHookDescriptor
                {
                    Name = hookName,
                    Priority = 100,
                    TimeoutMs = Math.Min(
                        30_000,
                        checked((int)definition.MaximumBudget.Timeout.TotalMilliseconds)),
                    FailPolicy = "fail-closed",
                    ExecutionMode = "sync",
                    Scope = "local",
                    Idempotent = true
                }
            ],
            Capabilities = capabilities,
            Permissions = new PluginPermissionDescriptor
            {
                Network = false,
                Filesystem = false,
                Database = "none"
            },
            ConfigSchema = "config/schema.json"
        };
        byte[] bytes;
        using (var buffer = new MemoryStream())
        {
            using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
            {
                ZipArchiveEntry entry = archive.CreateEntry("dist/main.js");
                using var writer = new StreamWriter(
                    entry.Open(),
                    new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
                writer.Write(source);
            }
            bytes = buffer.ToArray();
        }
        return new PluginPackage(
            manifest,
            new PluginConfigSchema("config/schema.json", Json("{}")),
            bytes,
            SHA256.HashData(bytes));
    }

    private static JsonElement Json(string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private sealed record Invocation(
        PluginHookInvocation Value,
        PluginExecutionBudgetGuard Guard) : IDisposable
    {
        public void Dispose() => Guard.Dispose();
    }

    private sealed class RecordingHostApi : IJavaScriptPluginHostApi
    {
        public List<string> Operations
        {
            get;
        } = [];

        public ValueTask<JsonElement> InvokeAsync(
            string pluginId,
            string operation,
            JsonElement input,
            CancellationToken cancellationToken)
        {
            Operations.Add(operation);
            return ValueTask.FromResult(Json("""{"ok":true}"""));
        }
    }

    private sealed class BlockingHostApi(int expectedConcurrentCalls) : IJavaScriptPluginHostApi
    {
        private readonly TaskCompletionSource _allEntered =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _release =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _entered;

        public Task AllEntered => _allEntered.Task;

        public async ValueTask<JsonElement> InvokeAsync(
            string pluginId,
            string operation,
            JsonElement input,
            CancellationToken cancellationToken)
        {
            if (Interlocked.Increment(ref _entered) == expectedConcurrentCalls)
            {
                _allEntered.TrySetResult();
            }
            await _release.Task.WaitAsync(cancellationToken);
            return Json("""{"ok":true}""");
        }

        public void Release() => _release.TrySetResult();
    }

    private sealed class RecordingJavaScriptRuntime : IJavaScriptPluginRuntime
    {
        public int InvokeCount
        {
            get;
            private set;
        }

        public ValueTask LoadAsync(
            PluginPackage plugin,
            CancellationToken cancellationToken = default)
            => ValueTask.CompletedTask;

        public ValueTask<PluginHookResult> InvokeHookAsync(
            PluginHookInvocation invocation,
            CancellationToken cancellationToken = default)
        {
            InvokeCount++;
            return ValueTask.FromResult(PluginHookResult.Next());
        }

        public ValueTask UnloadAsync(
            string pluginId,
            CancellationToken cancellationToken = default)
            => ValueTask.CompletedTask;

        public JavaScriptPluginRuntimeSnapshot GetSnapshot(string pluginId)
            => new(pluginId, false, 0, 0, 0, 0, 0, 0);
    }

    private sealed class RecordingLuaRuntime : ILuaPluginRuntime
    {
        public int InvokeCount
        {
            get;
            private set;
        }

        public ValueTask LoadAsync(
            PluginRegistryEntry plugin,
            CancellationToken cancellationToken = default)
            => ValueTask.CompletedTask;

        public ValueTask<PluginHookResult> InvokeHookAsync(
            PluginHookInvocation invocation,
            CancellationToken cancellationToken = default)
        {
            InvokeCount++;
            return ValueTask.FromResult(PluginHookResult.Next());
        }

        public ValueTask UnloadAsync(
            string pluginId,
            CancellationToken cancellationToken = default)
            => ValueTask.CompletedTask;
    }
}
