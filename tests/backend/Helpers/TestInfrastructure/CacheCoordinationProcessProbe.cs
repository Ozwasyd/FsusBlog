using System.Diagnostics;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using StackExchange.Redis;
using StackExchange.Redis.Profiling;

namespace FsusBlog.Server.Tests;

public static class CacheCoordinationProcessProbe
{
    internal sealed class Child : IAsyncDisposable
    {
        private readonly Process _process;
        private readonly long _start;
        private readonly string _invocation;
        private readonly Task<string> _errors;

        internal Child(string redis, string postgres, string prefix, string mode, int count)
        {
            string assembly = BackendTestPaths.FromRoot("tests", "cache-coordination-probe", "bin", "Debug", "net10.0", "CacheCoordinationProbe.dll");
            if (!File.Exists(assembly))
            {
                throw new InvalidOperationException("Build tests/cache-coordination-probe/CacheCoordinationProbe.csproj before this focused test");
            }
            _invocation = Guid.NewGuid().ToString("N");
            var start = new ProcessStartInfo("dotnet") { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
            start.ArgumentList.Add(assembly);
            foreach ((string key, string value) in new[] { ("INVOCATION", _invocation), ("REDIS", redis), ("POSTGRES", postgres), ("PREFIX", prefix), ("MODE", mode), ("COUNT", count.ToString(System.Globalization.CultureInfo.InvariantCulture)) })
            {
                start.Environment["FSUS_CACHE_PROBE_" + key] = value;
            }
            _process = Process.Start(start) ?? throw new InvalidOperationException("Probe did not start");
            _start = _process.StartTime.ToUniversalTime().Ticks;
            _errors = _process.StandardError.ReadToEndAsync();
        }

        internal async Task ReadyAsync()
        {
            using JsonDocument message = await ReadAsync("ready");
            Assert.Equal(_process.Id, message.RootElement.GetProperty("pid").GetInt32());
            Assert.Equal(_start, message.RootElement.GetProperty("start").GetInt64());
        }

        internal Task GoAsync() => _process.StandardInput.WriteLineAsync(_invocation);

        internal string Identity => $"pid={_process.Id} startUtcTicks={_start} invocation={_invocation}";

        internal async Task<JsonDocument> ReadAsync(string stage)
        {
            string line = await _process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(35))
                ?? throw new InvalidOperationException("Probe ended before " + stage);
            JsonDocument message = JsonDocument.Parse(line);
            Assert.Equal(stage, message.RootElement.GetProperty("stage").GetString());
            Assert.Equal(_invocation, message.RootElement.GetProperty("invocation").GetString());
            return message;
        }

        internal async Task FinishAsync()
        {
            await _process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(0, _process.ExitCode);
            Assert.Equal(string.Empty, await _errors);
        }

        internal async Task KillOwnerAsync()
        {
            Assert.False(_process.HasExited);
            using Process current = Process.GetProcessById(_process.Id);
            Assert.Equal(_start, current.StartTime.ToUniversalTime().Ticks);
            current.Kill();
            await _process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Assert.NotEqual(0, _process.ExitCode);
        }

        public async ValueTask DisposeAsync()
        {
            if (!_process.HasExited)
            {
                await KillOwnerAsync();
            }
            _process.Dispose();
        }
    }

    public static async Task<int> RunAsync()
    {
        string Read(string name) => Environment.GetEnvironmentVariable("FSUS_CACHE_PROBE_" + name)
            ?? throw new InvalidOperationException("Missing probe configuration");
        string invocation = Read("INVOCATION");
        using Process self = Process.GetCurrentProcess();
        using var capture = new CommandCapture();
        using ILoggerFactory logging = LoggerFactory.Create(builder => builder.SetMinimumLevel(LogLevel.Information).AddProvider(capture));
        var builder = new NpgsqlDataSourceBuilder(Read("POSTGRES"));
        builder.UseLoggerFactory(logging);
        await using NpgsqlDataSource source = builder.Build();
        await using ConnectionMultiplexer connection = await ConnectionMultiplexer.ConnectAsync(Read("REDIS"));
        var profile = new ProfilingSession();
        connection.RegisterProfiler(() => profile);
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new ProbeScope(Read("PREFIX"));
        using var cache = new UnifiedCache(memory, connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var single = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var coordinator = new CacheMissCoordinator(single, cache, policies, NullLogger<CacheMissCoordinator>.Instance);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            stage = "ready",
            invocation,
            pid = self.Id,
            start = self.StartTime.ToUniversalTime().Ticks
        }));
        if (await Console.In.ReadLineAsync() != invocation)
        {
            return 64;
        }
        bool crash = Read("MODE") == "crash";
        int concurrency = int.Parse(Read("COUNT"), System.Globalization.CultureInfo.InvariantCulture);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        Task<string?>[] calls = Enumerable.Range(0, concurrency).Select(_ => coordinator.CoordinateAsync<string>(CachePolicyId.SystemPage, "value",
            async token =>
            {
                string? value = await cache.GetStringAsync(CachePolicyId.SystemPage, "value", token);
                return new CacheReadResult<string>(value is not null, value);
            },
            async token =>
            {
                await using NpgsqlCommand command = source.CreateCommand("SELECT 'built'::text");
                string? result = (string?)await command.ExecuteScalarAsync(token);
                if (crash)
                {
                    Console.WriteLine(JsonSerializer.Serialize(new
                    {
                        stage = "owned",
                        invocation,
                        dbCommands = capture.Count,
                        redisCommands = profile.FinishProfiling().Select(item => item.Command).ToArray()
                    }));
                    await Task.Delay(Timeout.InfiniteTimeSpan, token);
                }
                await cache.SetStringAsync(CachePolicyId.SystemPage, "value", result!, cancellationToken: token);
                return result;
            }, "process-probe", deadline.Token,
            new CacheRebuildStrategy(TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(3), TimeSpan.FromSeconds(20)))).ToArray();
        string?[] results = await Task.WhenAll(calls);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            stage = "complete",
            invocation,
            dbCommands = capture.Count,
            activeEntries = single.ActiveEntryCount,
            successes = results.Count(value => value == "built"),
            redisCommands = profile.FinishProfiling().Select(item => item.Command).ToArray()
        }));
        return results.All(value => value == "built") ? 0 : 1;
    }

    private sealed class ProbeScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;
        public string PrefixKey(string key) => prefix + key;
    }

    private sealed class CommandCapture : ILoggerProvider, ILogger
    {
        private int _count;
        public int Count => Volatile.Read(ref _count);
        public ILogger CreateLogger(string categoryName) => this;
        public bool IsEnabled(LogLevel logLevel) => true;
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public void Dispose()
        {
        }
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (eventId.Name == "CommandExecutionCompleted")
            {
                Interlocked.Increment(ref _count);
            }
        }
    }
}
