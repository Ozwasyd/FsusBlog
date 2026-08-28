using System.Diagnostics;

using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Security;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal static partial class PublicAotCrashWorkerProgram
{
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
}
