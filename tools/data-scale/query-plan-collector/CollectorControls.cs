using System.Buffers;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.Internal;

using Npgsql;

using SqlSugar;

// Executable collector controls, never a product fixture or runtime qualification.
internal static class CollectorControls
{
    private static readonly Assembly s_server = typeof(SqlSugarInitializer).Assembly;
    private const BindingFlags InstanceFlags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
    private const BindingFlags StaticFlags = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;

    internal static async Task<int> RunAsync(string[] args)
    {
        if (args.Length != 4)
        {
            return 2;
        }
        string connectionPath = args[1];
        string directory = Path.GetFullPath(args[2]);
        string sourceCommit = args[3];
        var controlConnection = new NpgsqlConnectionStringBuilder((await File.ReadAllTextAsync(connectionPath)).Trim());
        if (controlConnection.Host is not ("127.0.0.1" or "localhost" or "::1") || controlConnection.Database != "query_capture_controls")
        {
            throw new InvalidOperationException("collector controls require their owned disposable loopback database");
        }
        Directory.CreateDirectory(directory);
        string captureDirectory = Path.Combine(directory, "commands");
        string bindingPath = Path.Combine(directory, "binding.json");
        var binding = new
        {
            sourceCommit,
            dataScaleRunId = "collector-control",
            fixtureGeneration = "collector-control",
            seedReceiptDigest = "sha256:" + new string('a', 64),
            expectedModelDigest = "sha256:" + new string('b', 64),
            businessEpochUtc = "2026-01-01T00:00:00Z"
        };
        QueryPlanCollector.WritePrivate(bindingPath, binding);
        WritePayloadControls(directory);
        string connectionString = (await File.ReadAllTextAsync(connectionPath)).Trim();
        TestTemporalRuntimeContext temporal = TestTemporalRuntimeContext.LoadOptional()!;
        await using (var setup = new NpgsqlConnection(connectionString))
        {
            await setup.OpenAsync();
            await using var command = new NpgsqlCommand("CREATE TABLE query_capture_control (id integer PRIMARY KEY, bucket integer NOT NULL); INSERT INTO query_capture_control SELECT id, id % 10 FROM generate_series(1, 10000) id; ANALYZE query_capture_control;", setup);
            await command.ExecuteNonQueryAsync();
        }
        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = connectionString,
            ["FSUSBLOG_RUNTIME_CACHE_EVIDENCE_SECRET"] = "collector-control-secret",
            ["fsus:queryPlanCaptureDirectory"] = captureDirectory,
            ["fsus:queryPlanCaptureBindingPath"] = bindingPath
        };
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        var environment = new HostingEnvironment { EnvironmentName = Environments.Development };
        var services = new ServiceCollection();
        services.AddSingleton(configuration);
        services.AddSingleton(temporal);
        services.AddLogging();
        services.AddSqlSugar();
        await using ServiceProvider provider = services.BuildServiceProvider();
        Type storeType = TypeOf("RuntimeCacheEvidenceStore");
        object store = Activator.CreateInstance(storeType, InstanceFlags, null, [4096], null)!;
        Type middlewareType = s_server.GetType("FsusBlog.Server.Infrastructure.Middlewares.RuntimeCacheEvidenceMiddleware", throwOnError: true)!;
        MethodInfo invoke = middlewareType.GetMethod("InvokeAsync", InstanceFlags)!;
        RequestDelegate activeHandler = _ => Task.CompletedTask;
        RequestDelegate next = context => activeHandler(context);
        object middleware = Activator.CreateInstance(middlewareType, InstanceFlags, null,
            [next, configuration, environment, store], null)!;

        async Task<string> RunRequest(string requestId, RequestDelegate handler, bool authorized = true)
        {
            activeHandler = handler;
            var context = new DefaultHttpContext();
            context.Request.Method = "GET";
            context.Request.Path = "/api/binary/query-capture-control.aeds";
            context.Request.Headers["X-Fsus-Runtime-Evidence-Request"] = requestId;
            context.Request.Headers["X-Fsus-Runtime-Evidence-Secret"] = authorized ? "collector-control-secret" : "incorrect-control-secret";
            context.Response.Body = new MemoryStream();
            await (Task)invoke.Invoke(middleware, [context])!;
            string fileName = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(requestId))) + ".json";
            return Path.Combine(captureDirectory, fileName);
        }

        object CurrentCapture()
        {
            Type observationType = TypeOf("RuntimeCacheEvidenceObservation");
            object observation = observationType.GetProperty("Current", StaticFlags)!.GetValue(null)!;
            return observationType.GetProperty("QueryPlanCapture", InstanceFlags)!.GetValue(observation)!;
        }

        async Task RawQuery(bool record)
        {
            var scoped = new NpgsqlConnectionStringBuilder(connectionString) { Options = temporal.PostgresSessionOptions };
            await using var connection = new NpgsqlConnection(scoped.ConnectionString);
            await connection.OpenAsync();
            await using var command = new NpgsqlCommand("SELECT id FROM query_capture_control WHERE id > $1 ORDER BY id LIMIT 10", connection);
            command.Parameters.Add(new NpgsqlParameter<int> { TypedValue = 9000 });
            if (record)
            {
                object capture = CurrentCapture();
                capture.GetType().GetMethod("Record", InstanceFlags, [typeof(NpgsqlCommand)])!.Invoke(capture, [command]);
            }
            await command.PrepareAsync();
            await using NpgsqlDataReader reader = await command.ExecuteReaderAsync();
            while (await reader.ReadAsync())
            {
                _ = reader.GetInt32(0);
            }
        }

        string completePath = await RunRequest("collector-complete", async context =>
        {
            using IServiceScope scope = provider.CreateScope();
            ISqlSugarClient client = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
            List<int> rows = await client.Ado.SqlQueryAsync<int>("SELECT id FROM query_capture_control WHERE id > @cursor ORDER BY id LIMIT 10", new SugarParameter("@cursor", 9000));
            Require(rows.Count == 10, "SqlSugar source query failed");
            await RawQuery(record: true);
            await context.Response.WriteAsync("collector-control");
        });
        using (JsonDocument complete = JsonDocument.Parse(await File.ReadAllTextAsync(completePath)))
        {
            Require(complete.RootElement.GetProperty("status").GetString() == "captured", "complete capture failed");
            Require(complete.RootElement.GetProperty("commands").GetArrayLength() == 2, "SqlSugar or Npgsql command omitted");
            Require(!File.ReadAllText(completePath).Contains("collector-control-secret", StringComparison.Ordinal), "secret leaked into capture");
        }
        string planPath = Path.Combine(directory, "plans.json");
        await QueryPlanCollector.CollectAsync(completePath, bindingPath, connectionPath, planPath);
        using (JsonDocument plans = JsonDocument.Parse(await File.ReadAllTextAsync(planPath)))
        {
            foreach (JsonElement query in plans.RootElement.GetProperty("queries").EnumerateArray())
            {
                Require(query.GetProperty("status").GetString() == "collected", "actual plan unavailable");
                Require(query.GetProperty("explain")[0].GetProperty("Plan").GetProperty("Actual Rows").GetInt32() == 10, "parameter replay changed result");
            }
        }
        string missingPath = await RunRequest("collector-missing", _ => RawQuery(record: false));
        using (JsonDocument missing = JsonDocument.Parse(await File.ReadAllTextAsync(missingPath)))
        using (JsonDocument expected = JsonDocument.Parse(await File.ReadAllTextAsync(bindingPath)))
        {
            Require(missing.RootElement.GetProperty("status").GetString() == "failed", "missing command passed capture");
            Reject(() => QueryPlanCollector.ValidateCapture(missing.RootElement, expected.RootElement));
        }
        string unauthorizedPath = await RunRequest("collector-unauthorized", _ => RawQuery(record: false), authorized: false);
        Require(!File.Exists(unauthorizedPath), "unauthorized request created SQL capture");
        string unsupportedPath = await RunRequest("collector-unsupported", async _ =>
        {
            object capture = CurrentCapture();
            capture.GetType().GetMethod("Record", InstanceFlags, [typeof(string), typeof(SugarParameter[]), typeof(string)])!.Invoke(capture,
                ["SELECT @unsupported", new[] { new SugarParameter("@unsupported", new object()) }, connectionString]);
            await RawQuery(record: false);
        });
        using (JsonDocument unsupported = JsonDocument.Parse(await File.ReadAllTextAsync(unsupportedPath)))
        {
            Require(unsupported.RootElement.GetProperty("status").GetString() == "failed", "unsupported parameter passed capture");
        }
        string repeatedPath = await RunRequest("collector-complete", _ => RawQuery(record: true));
        using (JsonDocument repeated = JsonDocument.Parse(await File.ReadAllTextAsync(repeatedPath)))
        {
            Require(repeated.RootElement.GetProperty("status").GetString() == "failed", "repeated request ID admitted stale capture identity");
        }
        string freshPath = await RunRequest("collector-fresh-after-repeat", _ => RawQuery(record: true));
        using (JsonDocument fresh = JsonDocument.Parse(await File.ReadAllTextAsync(freshPath)))
        {
            Require(fresh.RootElement.GetProperty("status").GetString() == "captured", "fresh request failed after repeated request");
            Require(fresh.RootElement.GetProperty("commands").GetArrayLength() == 1, "fresh request retained stale command inventory");
        }
        var releaseLate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task? lateTask = null;
        string latePath = await RunRequest("collector-late-command", _ =>
        {
            lateTask = Task.Run(async () =>
            {
                await releaseLate.Task;
                await RawQuery(record: true);
            });
            return Task.CompletedTask;
        });
        releaseLate.SetResult();
        await lateTask!;
        using (JsonDocument late = JsonDocument.Parse(await File.ReadAllTextAsync(latePath)))
        {
            Require(late.RootElement.GetProperty("status").GetString() == "failed", "late command passed capture");
        }
        var releaseSuperseded = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task? supersededTask = null;
        string supersededPath = await RunRequest("collector-superseded", _ =>
        {
            supersededTask = Task.Run(async () =>
            {
                await releaseSuperseded.Task;
                await RawQuery(record: true);
            });
            return Task.CompletedTask;
        });
        await RunRequest("collector-superseded", _ => RawQuery(record: true));
        releaseSuperseded.SetResult();
        await supersededTask!;
        using (JsonDocument superseded = JsonDocument.Parse(await File.ReadAllTextAsync(supersededPath)))
        {
            Require(superseded.RootElement.GetProperty("failureReasons").EnumerateArray()
                .Any(static reason => reason.GetString() == "duplicateRequestId"), "superseded late observation overwrote the newer capture");
        }
        var production = new HostingEnvironment { EnvironmentName = Environments.Production };
        Reject(() => Activator.CreateInstance(middlewareType, InstanceFlags, null,
            [(RequestDelegate)(_ => Task.CompletedTask), configuration, production, store], null));
        Console.WriteLine("{\"status\":\"passed\",\"qualification\":\"not-performed\",\"controls\":[\"sqlsugar-and-npgsql\",\"actual-parameterized-plans\",\"missing-command\",\"unsupported-parameter\",\"unauthorized-request\",\"repeated-request\",\"late-command\",\"production-gate\"]}");
        return 0;
    }

    private static Type TypeOf(string name)
        => s_server.GetType("FsusBlog.Server.Infrastructure.Testing." + name, throwOnError: true)!;

    private static void WritePayloadControls(string directory)
    {
        DateTime created = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var articlePod = PodProjector.ProjectArticleList(42, 0, created, 7, "collector category", "collector article", "collector summary", false, out _);
        var article = new ArticleListCoreModel(articlePod, 42, "collector article", "collector summary", null, null,
            0, created, new(7, "collector category"), [new(9, "collector tag")], false,
            CurrentRevisionId: 101, RevisionNo: 1, CurrentPublicationId: 201, PublicationNo: 1);
        File.WriteAllBytes(Path.Combine(directory, "article-page.payload"), PodBinaryCodec.EncodeArticlePage(new([article], 1)));
        File.WriteAllBytes(Path.Combine(directory, "article-search.payload"), PodBinaryCodec.EncodeArticleSearch([article]));
        var rights = new ArticleRightsCoreModel(1, 101, 1, false, "CC-BY-4.0", null, null, null, null,
            "append-attribution", 300, true, false, false, null, "sha256:" + new string('a', 64),
            "sha256:" + new string('b', 64), null, null);
        var detail = new ArticleDetailCoreModel(default, 42, article.Title, "collector body", article.Summary, null,
            0, 14, 1, false, created, article.Category, article.Tags, 7, false, Rights: rights,
            CurrentRevisionId: 101, RevisionNo: 1, CurrentPublicationId: 201, PublicationNo: 1);
        File.WriteAllBytes(Path.Combine(directory, "article-detail.payload"), PodBinaryCodec.EncodeArticleDetail(detail));
        var author = new CommentAuthorViewDto("zk_anonymous", "Anonymous", "en", null, null);
        var root = new CommentTreeNodeDto("301", "collector root", created, author, null, null, "301", null, 0, false, 1, false);
        var child = new CommentTreeNodeDto("302", "collector child", created, author, null, "301", "301", null, 1, false, 0, false);
        var rootWriter = new ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteCommentTreeRootCursor(new CursorResponse<CommentTreeRootDto>
        {
            Data = [new(root, [child])],
            HasMore = false,
            NextCursor = null
        }, rootWriter);
        File.WriteAllBytes(Path.Combine(directory, "comment-roots.payload"), rootWriter.WrittenSpan.ToArray());
        var childWriter = new ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteCommentChildCursor(301, 301, new CursorResponse<CommentTreeNodeDto>
        {
            Data = [child],
            HasMore = false,
            NextCursor = null
        }, childWriter);
        File.WriteAllBytes(Path.Combine(directory, "comment-children.payload"), childWriter.WrittenSpan.ToArray());
    }

    private static void Require(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private static void Reject(Action action)
    {
        try
        {
            action();
        }
        catch (Exception exception) when (exception is InvalidOperationException or TargetInvocationException)
        {
            return;
        }
        throw new InvalidOperationException("negative collector control unexpectedly passed");
    }
}
