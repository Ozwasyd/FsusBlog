using System.Reflection;
using System.Security.Cryptography;

using FsusBlog.Contracts.AuthoringWorkspace;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Server-selected source binding; no request, fixture or configuration override.</summary>
public sealed class AuthoringWorkspaceSnapshotSourceIdentity
{
    public AuthoringWorkspaceSnapshotSourceIdentity()
    {
        SourceDigest = Compute(
            typeof(AuthoringWorkspaceSnapshotStore).Assembly,
            typeof(AuthoringWorkspaceSnapshotContract).Assembly);
    }

    public string SourceDigest { get; }

    internal static string Compute(Assembly server, Assembly shared)
    {
        string?[] commits = [.. server.GetCustomAttributes<AssemblyMetadataAttribute>()
            .Where(static attribute => attribute.Key == "FsusBlog.SourceCommit")
            .Select(static attribute => attribute.Value)];
        if (commits.Length != 1 || commits[0] is not { Length: 40 } commit
            || commit.All(static value => value == '0')
            || commit.Any(static value => value is not (>= '0' and <= '9' or >= 'a' and <= 'f')))
        {
            throw new InvalidOperationException("authoring_workspace_snapshot_build_source_identity_required");
        }

        return AuthoringWorkspaceSnapshotContract.Digest(new
        {
            SourceContract = AuthoringWorkspaceSnapshotContract.SourceContract,
            SchemaVersion = AuthoringWorkspaceSnapshotContract.SchemaVersion,
            ServerSourceCommit = commit,
            ServerArtifactDigest = HashAssemblyArtifact(server),
            SharedArtifactDigest = HashAssemblyArtifact(shared)
        });
    }

    private static string HashAssemblyArtifact(Assembly assembly)
    {
        // This runtime adapter requires on-disk compiled artifacts. Single-file/AOT
        // hosts without them require a separately accepted build-bound owner.
        if (assembly.IsDynamic || string.IsNullOrEmpty(assembly.Location))
        {
            throw new InvalidOperationException("authoring_workspace_snapshot_build_artifact_required");
        }
        using FileStream stream = File.OpenRead(assembly.Location);
        return Convert.ToHexStringLower(SHA256.HashData(stream));
    }
}
