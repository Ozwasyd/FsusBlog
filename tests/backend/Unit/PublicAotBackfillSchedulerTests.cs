using System.Reflection;
using System.Runtime.CompilerServices;

using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Services.Background;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

using NSubstitute;
namespace FsusBlog.Server.Tests;

public sealed class PublicAotBackfillSchedulerTests
{
    [Fact]
    public void TrySchedule_WhenQueueIsFull_ReturnsFalse_AndDoesNotLeakInFlight()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["PublicAot:BackfillQueueCapacity"] = "32"
            })
            .Build();
        var scheduler = new PublicAotBackfillScheduler(configuration);
        for (int i = 0; i < scheduler.QueueCapacity; i++)
        {
            bool queued = scheduler.TrySchedule(new PublicAotBackfillRequest(
                PublicPageKind.Home,
                $"home:{i}",
                "/",
                string.Empty,
                $"cache:{i}"));
            Assert.True(queued);
        }

        bool overflowQueued = scheduler.TrySchedule(new PublicAotBackfillRequest(
            PublicPageKind.ArticleDetail,
            "article:99",
            "/article/99",
            string.Empty,
            "cache:overflow"));

        Assert.False(overflowQueued);
        Assert.Equal(scheduler.QueueCapacity, scheduler.InFlightCount);
        Assert.Equal(32, scheduler.QueueCapacity);
    }

    [Fact]
    public void TrySchedule_DuplicateCacheKey_IsDeduplicated()
    {
        IConfiguration configuration = new ConfigurationBuilder().Build();
        var scheduler = new PublicAotBackfillScheduler(configuration);
        var first = new PublicAotBackfillRequest(PublicPageKind.Home, "home", "/", string.Empty, "cache:dup");
        var second = new PublicAotBackfillRequest(PublicPageKind.Home, "home", "/", string.Empty, "cache:dup");

        bool firstQueued = scheduler.TrySchedule(first);
        bool secondQueued = scheduler.TrySchedule(second);

        Assert.True(firstQueued);
        Assert.False(secondQueued);
        Assert.Equal(1, scheduler.InFlightCount);
    }

    [Fact]
    public void TrySchedule_DuplicateRouteKeyAcrossCacheKeys_IsDeduplicatedUntilComplete()
    {
        IConfiguration configuration = new ConfigurationBuilder().Build();
        var scheduler = new PublicAotBackfillScheduler(configuration);
        var first = new PublicAotBackfillRequest(PublicPageKind.ArticleDetail, "article:42", "/article/42", string.Empty, "cache:first");
        var duplicateRoute = new PublicAotBackfillRequest(PublicPageKind.ArticleDetail, "article:42", "/article/42?from=feed", string.Empty, "cache:second");

        bool firstQueued = scheduler.TrySchedule(first);
        bool duplicateQueued = scheduler.TrySchedule(duplicateRoute);
        scheduler.Complete(first);
        bool queuedAfterComplete = scheduler.TrySchedule(duplicateRoute);

        Assert.True(firstQueued);
        Assert.False(duplicateQueued);
        Assert.True(queuedAfterComplete);
        Assert.Equal(1, scheduler.InFlightCount);
    }

    [Fact]
    public void TrySchedule_NewerInvalidationVersionForSameRouteSupersedesOlderReservation()
    {
        IConfiguration configuration = new ConfigurationBuilder().Build();
        var scheduler = new PublicAotBackfillScheduler(configuration);
        var stale = new PublicAotBackfillRequest(PublicPageKind.ArticleDetail, "article:42", "/article/42", string.Empty, "cache:article:42")
        {
            ScheduledInvalidationVersion = 1
        };
        var fresh = stale with
        {
            ScheduledInvalidationVersion = 2
        };
        var duplicateFresh = stale with
        {
            ScheduledInvalidationVersion = 2
        };

        bool staleQueued = scheduler.TrySchedule(stale);
        bool freshQueued = scheduler.TrySchedule(fresh);
        bool duplicateFreshQueued = scheduler.TrySchedule(duplicateFresh);
        scheduler.Complete(stale);
        bool duplicateWhileFreshInFlight = scheduler.TrySchedule(duplicateFresh);
        scheduler.Complete(fresh);
        bool queuedAfterFreshComplete = scheduler.TrySchedule(duplicateFresh);

        Assert.True(staleQueued);
        Assert.True(freshQueued);
        Assert.False(duplicateFreshQueued);
        Assert.False(duplicateWhileFreshInFlight);
        Assert.True(queuedAfterFreshComplete);
        Assert.Equal(1, scheduler.InFlightCount);
    }

    [Fact]
    public void TrySchedule_WhenSsrCircuitIsOpen_DropsWithoutLeakingInFlight()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["PublicAot:SsrCircuitFailureThreshold"] = "1",
                ["PublicAot:SsrCircuitCooldownSeconds"] = "60"
            })
            .Build();
        var runtimeState = new PublicAotSsrRuntimeState(configuration);
        var failed = new PublicAotBackfillRequest(PublicPageKind.Home, "home", "/", string.Empty, "cache:home");
        runtimeState.RecordBackfillFailure(failed, PublicAotSsrFailureClass.WorkerTimeout, "public AOT pooled SSR worker timed out", TimeSpan.FromSeconds(1));
        var scheduler = new PublicAotBackfillScheduler(configuration, runtimeState);

        bool queued = scheduler.TrySchedule(new PublicAotBackfillRequest(
            PublicPageKind.ArticleDetail,
            "article:42",
            "/article/42",
            string.Empty,
            "cache:article:42"));

        Assert.False(queued);
        Assert.Equal(0, scheduler.InFlightCount);
        PublicAotSsrRuntimeSnapshot snapshot = runtimeState.CreateSnapshot(scheduler.InFlightCount, scheduler.QueueCapacity);
        Assert.Equal(1, snapshot.DroppedBackfills);
        Assert.Equal("circuit-open", snapshot.LastDropReason);
    }

    [Theory]
    [InlineData(-1, 1)]
    [InlineData(0, 1)]
    [InlineData(1, 1)]
    [InlineData(4, 4)]
    [InlineData(99, 8)]
    public void NormalizeBackfillConcurrency_ClampsDatabasePressure(int configured, int expected)
    {
        Assert.Equal(expected, PublicAotBackfillWorker.NormalizeBackfillConcurrency(configured));
    }

    [Fact]
    public void PublicAotBackfillWorker_UsesScopedSessionKeyScopeWithoutHttpContextMutation()
    {
        Type[] runtimeTypes = typeof(PublicAotBackfillWorker).GetConstructors()
            .SelectMany(static constructor => constructor.GetParameters())
            .Select(static parameter => parameter.ParameterType)
            .Concat(typeof(PublicAotBackfillWorker).GetFields(BindingFlags.NonPublic | BindingFlags.Instance)
                .Select(static field => field.FieldType))
            .ToArray();
        MethodInfo processMoveNext = StateMachineMoveNext(typeof(PublicAotBackfillWorker), "ProcessRequestAsync");
        IReadOnlyList<(int Offset, MethodBase Method)> calls = ReadCalledMethods(processMoveNext);

        Assert.DoesNotContain(typeof(IHttpContextAccessor), runtimeTypes);
        Assert.DoesNotContain(typeof(DefaultHttpContext), runtimeTypes);
        Assert.Contains(calls, static call =>
            call.Method.DeclaringType == typeof(ITestSessionKeyScope)
            && call.Method.Name == nameof(ITestSessionKeyScope.BeginScope));
    }

    [Fact]
    public void PublicAotFileShellCache_WritesTempThenMovesBeforePublishingMemoryEntry()
    {
        MethodInfo moveNext = StateMachineMoveNext(typeof(PublicAotFileShellCache), nameof(PublicAotFileShellCache.SetAsync));
        IReadOnlyList<(int Offset, MethodBase Method)> calls = ReadCalledMethods(moveNext);
        int tempWrite = FindCallOffset(calls, typeof(File), nameof(File.WriteAllBytesAsync));
        int atomicMove = FindCallOffset(calls, typeof(File), nameof(File.Move));
        int memoryPublish = calls
            .Where(static call => call.Method.Name == "set_Item"
                && call.Method.DeclaringType == typeof(PublicAotBoundedMemoryCache))
            .Select(static call => call.Offset)
            .DefaultIfEmpty(-1)
            .First();

        Assert.True(tempWrite >= 0);
        Assert.True(atomicMove > tempWrite);
        Assert.True(memoryPublish > atomicMove);
    }

    [Fact]
    public async Task HttpTestSessionKeyScope_BeginScope_FlowsAcrossAwaitsAndRestores()
    {
        var environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns("Test");
        var keyScope = new HttpTestSessionKeyScope(new HttpContextAccessor(), environment);

        Assert.Null(keyScope.SessionId);
        using (keyScope.BeginScope("PW-0"))
        {
            Assert.Equal("pw-0", keyScope.SessionId);
            Assert.Equal("e2e:pw-0:cache:key", keyScope.PrefixKey("cache:key"));
            await Task.Yield();
            Assert.Equal("pw-0", keyScope.SessionId);
        }

        Assert.Null(keyScope.SessionId);
    }

    private static MethodInfo StateMachineMoveNext(Type type, string methodName)
    {
        MethodInfo method = type.GetMethod(methodName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
            ?? throw new InvalidOperationException($"Async runtime method was not found: {type.Name}.{methodName}");
        AsyncStateMachineAttribute stateMachine = method.GetCustomAttribute<AsyncStateMachineAttribute>()
            ?? throw new InvalidOperationException($"Async state machine was not found: {type.Name}.{methodName}");
        return stateMachine.StateMachineType.GetMethod("MoveNext", BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance)
            ?? throw new InvalidOperationException($"Async MoveNext was not found: {type.Name}.{methodName}");
    }

    private static IReadOnlyList<(int Offset, MethodBase Method)> ReadCalledMethods(MethodInfo method)
    {
        var calls = new List<(int Offset, MethodBase Method)>();
        byte[] il = method.GetMethodBody()?.GetILAsByteArray() ?? [];
        for (int offset = 0; offset <= il.Length - 5; offset++)
        {
            if (il[offset] is not (0x28 or 0x6F))
            {
                continue;
            }

            try
            {
                MethodBase? called = method.Module.ResolveMethod(
                    BitConverter.ToInt32(il, offset + 1),
                    method.DeclaringType?.GetGenericArguments(),
                    method.GetGenericArguments());
                if (called is not null)
                {
                    calls.Add((offset, called));
                }
            }
            catch (ArgumentException)
            {
            }
        }
        return calls;
    }

    private static int FindCallOffset(IReadOnlyList<(int Offset, MethodBase Method)> calls, Type declaringType, string name)
        => calls.Where(call => call.Method.DeclaringType == declaringType && call.Method.Name == name)
            .Select(static call => call.Offset)
            .DefaultIfEmpty(-1)
            .First();
}
