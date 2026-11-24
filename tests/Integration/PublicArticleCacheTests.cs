using System.Net.Sockets;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;

public sealed class PublicArticleCacheTests
{
    [Fact]
    public async Task ColdHtmlAndAedsWaitersShareOneEncodingAndHotReadsReuseBytes()
    {
        var now = DateTimeOffset.UtcNow;
        var article = new Article(1, 1, 1, 1, 1, "Cold detail", "## Cold payload", now, now, now);
        var cache = new PublicArticleCache(new Dictionary<int, Article> { [article.Id] = article },
            new WebPages("<title>Fsu's Blog</title><!--fsus-public-content-->"));
        var concurrent = Enumerable.Range(0, 64).Select(_ => cache.Read(article.Id, CancellationToken.None).AsTask());
        var results = await Task.WhenAll(concurrent);

        Assert.NotNull(results[0]);
        foreach (var result in results) Assert.Same(results[0], result);
        Assert.Equal(1, cache.ColdStarts);
        Assert.Same(results[0], await cache.Read(article.Id, CancellationToken.None));
        Assert.Null(await cache.Read(2, CancellationToken.None));
        Assert.Equal(1, cache.ColdStarts);
        Assert.Contains("<h2>Cold payload</h2>", System.Text.Encoding.UTF8.GetString(results[0]!.Html));
        _ = Aeds.Decode(results[0]!.Wire, FrameType.ArticleDetail).Length;
    }

    [Fact]
    public async Task KestrelDisconnectCancelsOneWaiterWithoutDiscardingTheSharedRender()
    {
        using var budget = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var trace = new HeldColdTrace();
        var now = DateTimeOffset.UtcNow;
        var article = new Article(1, 1, 1, 1, 1, "Cold detail", "## Cold payload", now, now, now);
        var cache = new PublicArticleCache(new Dictionary<int, Article> { [article.Id] = article },
            new WebPages("<!--fsus-public-content-->"), log: trace);

        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build();
        var requestToken = new TaskCompletionSource<CancellationToken>(TaskCreationOptions.RunContinuationsAsynchronously);
        app.MapGet("/article/1", async (HttpContext request) =>
        {
            requestToken.TrySetResult(request.RequestAborted);
            try
            {
                var result = await cache.Read(article.Id, request.RequestAborted);
                return Results.Bytes(result!.Html, "text/html");
            }
            catch (OperationCanceledException) when (request.RequestAborted.IsCancellationRequested)
            {
                return Results.Empty;
            }
        });
        await app.StartAsync(budget.Token);
        try
        {
            var origin = new Uri(Assert.Single(app.Urls));
            using var client = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            await client.ConnectAsync(new IPEndPoint(IPAddress.Loopback, origin.Port), budget.Token);
            var message = "GET /article/1 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n"u8.ToArray();
            Assert.Equal(message.Length, await client.SendAsync(message, SocketFlags.None, budget.Token));
            await trace.RenderStarted.Task.WaitAsync(budget.Token);
            client.LingerState = new LingerOption(true, 0);
            client.Close();

            // The waiter may run its cancellation continuation synchronously and
            // need the held trace lock before other token callbacks can run.
            var requestAborted = await requestToken.Task.WaitAsync(budget.Token);
            while (!requestAborted.IsCancellationRequested) await Task.Delay(1, budget.Token);
            trace.ReleaseRender.Set();
            await trace.WaiterCancelled.Task.WaitAsync(budget.Token);

            using var retry = new HttpClient { BaseAddress = origin };
            Assert.Contains("<h2>Cold payload</h2>", await retry.GetStringAsync("/article/1", budget.Token));
            Assert.Equal(1, cache.ColdStarts);
        }
        finally
        {
            trace.ReleaseRender.Set();
            await app.StopAsync(CancellationToken.None);
        }
    }

    private sealed class HeldColdTrace : ILogger, IDisposable
    {
        internal TaskCompletionSource RenderStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource WaiterCancelled { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal ManualResetEventSlim ReleaseRender { get; } = new();

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> format)
        {
            if (eventId.Name != "PublicArticleColdCache" || state is not IReadOnlyList<KeyValuePair<string, object?>> fields) return;
            switch (fields.First(field => field.Key == "Event").Value)
            {
                case "started":
                    RenderStarted.TrySetResult();
                    Assert.True(ReleaseRender.Wait(TimeSpan.FromSeconds(10)), "Kestrel did not abort the waiting request.");
                    break;
                case "wait-cancelled":
                    WaiterCancelled.TrySetResult();
                    break;
            }
        }

        public void Dispose() => ReleaseRender.Dispose();
    }
}
