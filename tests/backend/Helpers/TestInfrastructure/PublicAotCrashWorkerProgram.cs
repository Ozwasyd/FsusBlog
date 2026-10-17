using System.Diagnostics;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.PublicAot;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal static partial class PublicAotCrashWorkerProgram
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
        if (args.Length == 1 && string.Equals(args[0], AuthoringStateProcessWorker.Command, StringComparison.Ordinal))
        {
            return await AuthoringStateProcessWorker.RunAsync();
        }
        if (args.Length > 0 && string.Equals(args[0], ChallengeV2AdmissionProcessIssue2040Worker.Command, StringComparison.Ordinal))
        {
            return await ChallengeV2AdmissionProcessIssue2040Worker.RunAsync(args.AsSpan(1).ToArray());
        }
        if (args.Length > 0 && string.Equals(args[0], SecurityRiskAdmissionProcessIssue2040Worker.Command, StringComparison.Ordinal))
        {
            return await SecurityRiskAdmissionProcessIssue2040Worker.RunAsync(args.AsSpan(1).ToArray());
        }
        if (args.Length > 0 && string.Equals(args[0], AdminAuditAdmissionProcessIssue2040Worker.Command, StringComparison.Ordinal))
        {
            return await AdminAuditAdmissionProcessIssue2040Worker.RunAsync(args.AsSpan(1).ToArray());
        }
        if (args.Length > 0 && string.Equals(args[0], AuditDurableAdmissionProcessWorker.Command, StringComparison.Ordinal))
        {
            return await AuditDurableAdmissionProcessWorker.RunAsync(args.AsSpan(1).ToArray());
        }
        if (args.Length > 0
            && string.Equals(args[0], ArticleBulkFileJournalProcessWorker.Command, StringComparison.Ordinal))
        {
            return await ArticleBulkFileJournalProcessWorker.RunAsync(args.AsSpan(1).ToArray());
        }
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
}
