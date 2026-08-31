using FsusBlog.Server.Infrastructure.PublicAot;

namespace FsusBlog.Server.Tests.TestInfrastructure;

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
