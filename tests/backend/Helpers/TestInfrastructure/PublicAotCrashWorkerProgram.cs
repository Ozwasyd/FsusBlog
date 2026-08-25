using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal static class PublicAotCrashWorkerProgram
{
    internal const string Command = "public-aot-crash-worker";
    internal const string HandshakePrefix = "public-aot-crash-worker-handshake ";
    internal const string CrashStatePrefix = "public-aot-crash-worker-durable-state ";
    internal const string FailurePrefix = "public-aot-crash-worker-failure ";
    internal const int InvalidArgumentsExitCode = 64;
    internal const int CompletedWithoutCrashExitCode = 70;
    internal const int WorkerFailureExitCode = 71;
    internal const string CacheKey = "public:aot:v2:doc:2:article:process-crash:iv:17";
    internal const string FrontendAssetVersion = "frontend-v2";
    internal const string ExpectedValue = "<main>process crash</main>";

    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly HashSet<PublicAotArtifactCommitState> s_supportedCrashStates =
    [
        PublicAotArtifactCommitState.Staged,
        PublicAotArtifactCommitState.ArtifactCommitted,
        PublicAotArtifactCommitState.RegistryCommitted,
        PublicAotArtifactCommitState.PointerAdvanced,
        PublicAotArtifactCommitState.Complete
    ];

    public static async Task<int> Main(string[] args)
    {
        if (args.Length == 0 || !string.Equals(args[0], Command, StringComparison.Ordinal))
        {
            Console.Error.WriteLine($"{FailurePrefix}invalid-command");
            return InvalidArgumentsExitCode;
        }

        try
        {
            PublicAotCrashWorkerRequest request = ParseArguments(args.AsSpan(1));
            return await RunAsync(request);
        }
        catch (PublicAotCrashWorkerInputException exception)
        {
            Console.Error.WriteLine($"{FailurePrefix}{exception.ErrorCode}");
            return InvalidArgumentsExitCode;
        }
        catch (Exception)
        {
            Console.Error.WriteLine($"{FailurePrefix}worker-exception");
            return WorkerFailureExitCode;
        }
    }

    internal static ProcessStartInfo CreateStartInfo(
        string dotnetHostPath,
        string assemblyPath,
        PublicAotCrashWorkerRequest request)
        => CreateStartInfo(
            dotnetHostPath,
            assemblyPath,
            [
                "--sandbox-root",
                request.SandboxRoot,
                "--cache-root",
                request.CacheRoot,
                "--state",
                request.CrashState.ToString(),
                "--invocation-id",
                request.InvocationId.ToString("D"),
                "--parent-pid",
                request.ParentProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture)
            ]);

    internal static ProcessStartInfo CreateStartInfo(
        string dotnetHostPath,
        string assemblyPath,
        IReadOnlyList<string> workerArguments)
    {
        var startInfo = new ProcessStartInfo(dotnetHostPath)
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false
        };
        startInfo.ArgumentList.Add(assemblyPath);
        startInfo.ArgumentList.Add(Command);
        foreach (string argument in workerArguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        return startInfo;
    }

    internal static IReadOnlyList<string> CreateArguments(PublicAotCrashWorkerRequest request)
        =>
        [
            "--sandbox-root",
            request.SandboxRoot,
            "--cache-root",
            request.CacheRoot,
            "--state",
            request.CrashState.ToString(),
            "--invocation-id",
            request.InvocationId.ToString("D"),
            "--parent-pid",
            request.ParentProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture)
        ];

    internal static PublicAotCrashWorkerEvidence ParseAndValidateEvidence(
        string standardOutput,
        string standardError,
        PublicAotCrashWorkerRequest request,
        int childProcessId,
        string dotnetHostPath,
        string assemblyPath)
    {
        if (standardOutput.Contains(FailurePrefix, StringComparison.Ordinal)
            || standardError.Contains(FailurePrefix, StringComparison.Ordinal))
        {
            throw new InvalidDataException("The Public AOT crash worker reported a failure marker.");
        }

        PublicAotCrashWorkerHandshake handshake = ParseSingleRecord<PublicAotCrashWorkerHandshake>(
            standardOutput,
            HandshakePrefix);
        PublicAotCrashWorkerDurableState durableState = ParseSingleRecord<PublicAotCrashWorkerDurableState>(
            standardOutput,
            CrashStatePrefix);
        string expectedInvocationIdentity = TextIdentity(request.InvocationId.ToString("D"));
        string expectedSandboxIdentity = PathIdentity(request.SandboxRoot);
        string expectedCacheRootIdentity = PathIdentity(request.CacheRoot);
        string expectedExecutableIdentity = FileIdentity(dotnetHostPath);
        string expectedAssemblyIdentity = FileIdentity(assemblyPath);
        string expectedCommandIdentity = CommandIdentity(dotnetHostPath, assemblyPath);

        if (handshake.Schema != "fsusblog.public-aot-crash-worker-handshake.v1"
            || handshake.InvocationIdentity != expectedInvocationIdentity
            || handshake.ParentProcessId != request.ParentProcessId
            || handshake.ChildProcessId != childProcessId
            || handshake.ExecutableIdentity != expectedExecutableIdentity
            || handshake.AssemblyIdentity != expectedAssemblyIdentity
            || handshake.CommandIdentity != expectedCommandIdentity
            || handshake.SandboxRootIdentity != expectedSandboxIdentity
            || handshake.CacheRootIdentity != expectedCacheRootIdentity
            || !string.Equals(handshake.CrashState, request.CrashState.ToString(), StringComparison.Ordinal))
        {
            throw new InvalidDataException("The Public AOT crash worker handshake did not bind the requested child.");
        }

        if (durableState.Schema != "fsusblog.public-aot-crash-worker-durable-state.v1"
            || durableState.InvocationIdentity != expectedInvocationIdentity
            || durableState.ChildProcessId != childProcessId
            || durableState.CacheRootIdentity != expectedCacheRootIdentity
            || !string.Equals(durableState.CrashState, request.CrashState.ToString(), StringComparison.Ordinal))
        {
            throw new InvalidDataException("The Public AOT crash worker did not reach the requested durable state.");
        }

        return new(
            expectedInvocationIdentity,
            handshake.ExecutableIdentity,
            handshake.AssemblyIdentity,
            handshake.CommandIdentity,
            expectedSandboxIdentity,
            expectedCacheRootIdentity,
            childProcessId,
            request.ParentProcessId,
            request.CrashState.ToString());
    }

    internal static string ResolveDotNetHostPath()
    {
        string? configured = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH");
        if (!string.IsNullOrWhiteSpace(configured) && Path.IsPathFullyQualified(configured) && File.Exists(configured))
        {
            return Path.GetFullPath(configured);
        }

        string executableName = OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet";
        string? pathValue = Environment.GetEnvironmentVariable("PATH");
        foreach (string directory in (pathValue ?? string.Empty).Split(
            Path.PathSeparator,
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            string candidate = Path.Combine(directory, executableName);
            if (File.Exists(candidate))
            {
                return Path.GetFullPath(candidate);
            }
        }

        throw new FileNotFoundException("The .NET host executable could not be resolved.");
    }

    internal static PublicAotFileShellCache BuildCache(
        string root,
        Func<PublicAotArtifactCommitState, CancellationToken, Task>? observer = null)
    {
        IDatabase database = Substitute.For<IDatabase>();
        var subscriber = Substitute.For<ISubscriber>();
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        redis.GetSubscriber(Arg.Any<object?>()).Returns(subscriber);
        database.SetAddAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(true));
        database.SetRemoveAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue[]>(), Arg.Any<CommandFlags>())
            .Returns(call => Task.FromResult((long)call.ArgAt<RedisValue[]>(1).Length));
        subscriber.PublishAsync(Arg.Any<RedisChannel>(), Arg.Any<RedisValue>(), Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(1L));
        return new PublicAotFileShellCache(
            new CrashWorkerWebHostEnvironment(root),
            redis,
            NullLogger<PublicAotFileShellCache>.Instance,
            derivedPublisher: null,
            configuration: null,
            timeProvider: null,
            publicArtifactStorage: null,
            observer);
    }

    private static async Task<int> RunAsync(PublicAotCrashWorkerRequest request)
    {
        string assemblyPath = typeof(PublicAotCrashWorkerProgram).Assembly.Location;
        string executablePath = Environment.ProcessPath
            ?? throw new InvalidOperationException("The worker executable identity is unavailable.");
        int childProcessId = Environment.ProcessId;
        var handshake = new PublicAotCrashWorkerHandshake(
            "fsusblog.public-aot-crash-worker-handshake.v1",
            TextIdentity(request.InvocationId.ToString("D")),
            request.ParentProcessId,
            childProcessId,
            FileIdentity(executablePath),
            FileIdentity(assemblyPath),
            CommandIdentity(executablePath, assemblyPath),
            PathIdentity(request.SandboxRoot),
            PathIdentity(request.CacheRoot),
            request.CrashState.ToString());
        Console.Out.WriteLine($"{HandshakePrefix}{JsonSerializer.Serialize(handshake, s_jsonOptions)}");
        Console.Out.Flush();

        PublicAotFileShellCache cache = BuildCache(
            request.CacheRoot,
            (state, _) =>
            {
                if (state == request.CrashState)
                {
                    var durableState = new PublicAotCrashWorkerDurableState(
                        "fsusblog.public-aot-crash-worker-durable-state.v1",
                        handshake.InvocationIdentity,
                        childProcessId,
                        handshake.CacheRootIdentity,
                        state.ToString());
                    Console.Out.WriteLine(
                        $"{CrashStatePrefix}{JsonSerializer.Serialize(durableState, s_jsonOptions)}");
                    Console.Out.Flush();
                    Process.GetCurrentProcess().Kill();
                }

                return Task.CompletedTask;
            });
        var entry = new PublicAotCacheEntry
        {
            CacheKey = CacheKey,
            RouteKey = "article:process-crash",
            PageId = PublicPageId.ArticleDetail,
            Source = PublicAotWriteSource.ServerSsrBackfill,
            GeneratedAtUtc = DateTimeOffset.UtcNow.AddSeconds(-1),
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(30),
            RendererVersion = "renderer-v2",
            FrontendAssetVersion = FrontendAssetVersion,
            Value = ExpectedValue
        };
        await cache.SetAsync(entry);
        Console.Error.WriteLine($"{FailurePrefix}completed-without-crash");
        return CompletedWithoutCrashExitCode;
    }

    private static PublicAotCrashWorkerRequest ParseArguments(ReadOnlySpan<string> arguments)
    {
        if (arguments.Length % 2 != 0)
        {
            throw new PublicAotCrashWorkerInputException("argument-pair-required");
        }

        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int index = 0; index < arguments.Length; index += 2)
        {
            string name = arguments[index];
            if (name is not ("--sandbox-root" or "--cache-root" or "--state" or "--invocation-id" or "--parent-pid"))
            {
                throw new PublicAotCrashWorkerInputException("unknown-argument");
            }
            if (!values.TryAdd(name, arguments[index + 1]))
            {
                throw new PublicAotCrashWorkerInputException("duplicate-argument");
            }
        }

        string sandboxRoot = RequiredValue(values, "--sandbox-root");
        string cacheRoot = RequiredValue(values, "--cache-root");
        string stateValue = RequiredValue(values, "--state");
        string invocationValue = RequiredValue(values, "--invocation-id");
        string parentProcessValue = RequiredValue(values, "--parent-pid");
        if (!Path.IsPathFullyQualified(sandboxRoot) || !Path.IsPathFullyQualified(cacheRoot))
        {
            throw new PublicAotCrashWorkerInputException("absolute-root-required");
        }

        sandboxRoot = Path.GetFullPath(sandboxRoot);
        cacheRoot = Path.GetFullPath(cacheRoot);
        if (!Directory.Exists(sandboxRoot) || !Directory.Exists(cacheRoot))
        {
            throw new PublicAotCrashWorkerInputException("root-missing");
        }

        string relativeCacheRoot = Path.GetRelativePath(sandboxRoot, cacheRoot);
        if (string.Equals(relativeCacheRoot, ".", StringComparison.Ordinal)
            || Path.IsPathRooted(relativeCacheRoot)
            || string.Equals(relativeCacheRoot, "..", StringComparison.Ordinal)
            || relativeCacheRoot.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            || !CanonicalPathBoundary.TryResolveRelative(sandboxRoot, relativeCacheRoot, out string resolvedCacheRoot)
            || !string.Equals(resolvedCacheRoot, cacheRoot, StringComparison.Ordinal))
        {
            throw new PublicAotCrashWorkerInputException("cache-root-escape");
        }

        if (!Enum.TryParse(stateValue, ignoreCase: false, out PublicAotArtifactCommitState crashState)
            || !s_supportedCrashStates.Contains(crashState)
            || !string.Equals(stateValue, crashState.ToString(), StringComparison.Ordinal))
        {
            throw new PublicAotCrashWorkerInputException("unknown-state");
        }
        if (!Guid.TryParseExact(invocationValue, "D", out Guid invocationId))
        {
            throw new PublicAotCrashWorkerInputException("invalid-invocation-id");
        }
        if (!int.TryParse(
                parentProcessValue,
                System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture,
                out int parentProcessId)
            || parentProcessId <= 0)
        {
            throw new PublicAotCrashWorkerInputException("invalid-parent-pid");
        }

        try
        {
            using Process parent = Process.GetProcessById(parentProcessId);
            if (parent.HasExited)
            {
                throw new PublicAotCrashWorkerInputException("parent-not-running");
            }
        }
        catch (ArgumentException)
        {
            throw new PublicAotCrashWorkerInputException("parent-not-running");
        }

        return new(sandboxRoot, cacheRoot, crashState, invocationId, parentProcessId);
    }

    private static string RequiredValue(IReadOnlyDictionary<string, string> values, string name)
    {
        if (!values.TryGetValue(name, out string? value) || string.IsNullOrWhiteSpace(value))
        {
            throw new PublicAotCrashWorkerInputException("missing-argument");
        }

        return value;
    }

    private static T ParseSingleRecord<T>(string output, string prefix)
    {
        string[] payloads = output
            .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)
            .Where(line => line.StartsWith(prefix, StringComparison.Ordinal))
            .Select(line => line[prefix.Length..])
            .ToArray();
        if (payloads.Length != 1)
        {
            throw new InvalidDataException($"Expected exactly one {prefix.Trim()} record.");
        }

        return JsonSerializer.Deserialize<T>(payloads[0], s_jsonOptions)
            ?? throw new InvalidDataException($"The {prefix.Trim()} record is invalid.");
    }

    private static string CommandIdentity(string executablePath, string assemblyPath)
        => TextIdentity($"{FileIdentity(executablePath)}\0{FileIdentity(assemblyPath)}\0{Command}");

    private static string PathIdentity(string path)
        => TextIdentity(Path.GetFullPath(path));

    private static string FileIdentity(string path)
        => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(Path.GetFullPath(path))));

    private static string TextIdentity(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private sealed class CrashWorkerWebHostEnvironment(string root) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "FsusBlog.PublicAotCrashWorker";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = root;
        public string EnvironmentName { get; set; } = Environments.Development;
    }
}

internal sealed record PublicAotCrashWorkerRequest(
    string SandboxRoot,
    string CacheRoot,
    PublicAotArtifactCommitState CrashState,
    Guid InvocationId,
    int ParentProcessId);

internal sealed record PublicAotCrashWorkerEvidence(
    string InvocationIdentity,
    string ExecutableIdentity,
    string AssemblyIdentity,
    string CommandIdentity,
    string SandboxRootIdentity,
    string CacheRootIdentity,
    int ChildProcessId,
    int ParentProcessId,
    string CrashState);

internal sealed record PublicAotCrashWorkerHandshake(
    string Schema,
    string InvocationIdentity,
    int ParentProcessId,
    int ChildProcessId,
    string ExecutableIdentity,
    string AssemblyIdentity,
    string CommandIdentity,
    string SandboxRootIdentity,
    string CacheRootIdentity,
    string CrashState);

internal sealed record PublicAotCrashWorkerDurableState(
    string Schema,
    string InvocationIdentity,
    int ChildProcessId,
    string CacheRootIdentity,
    string CrashState);

internal sealed class PublicAotCrashWorkerInputException(string errorCode) : Exception
{
    internal string ErrorCode { get; } = errorCode;
}
