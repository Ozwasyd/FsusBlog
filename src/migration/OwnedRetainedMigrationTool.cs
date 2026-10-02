using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

internal sealed record RetainedMigrationToolReadConfiguration(
    string SourceRoot, string ArtifactRoot, string SdkRoot, string EvidenceRoot);

internal sealed record RetainedMigrationToolObservation(
    CurrentSchemaVerifierIdentity Identity,
    string AssemblyPath, string AssemblySha256, string ReceiptPath, string ReceiptSha256);

// Only the original producer's actual successful read can create this capability.
// The measured JSON is input data, never an import constructor or a status grant.
internal sealed class OwnedRetainedMigrationTool
{
    private readonly RetainedMigrationToolReadConfiguration _configuration;
    private readonly RetainedMigrationToolObservation _observation;

    private OwnedRetainedMigrationTool(RetainedMigrationToolReadConfiguration configuration,
        RetainedMigrationToolObservation observation)
    {
        _configuration = configuration;
        _observation = observation;
    }

    internal CurrentSchemaVerifierIdentity Identity => _observation.Identity;

    internal static async Task<OwnedRetainedMigrationTool> ReadOriginalAsync(
        string sourceRoot, string artifactRoot, string sdkRoot, string evidenceRoot, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        foreach (string root in new[] { sourceRoot, artifactRoot, sdkRoot, evidenceRoot })
        {
            if (string.IsNullOrEmpty(root) || !Path.IsPathFullyQualified(root) || Path.GetFullPath(root) != root
                || Path.GetPathRoot(root) == root)
            {
                throw new InvalidOperationException("migration_retained_read_roots_must_be_explicit_canonical");
            }
        }
        if (evidenceRoot == artifactRoot || evidenceRoot.StartsWith(artifactRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            || evidenceRoot == sdkRoot || evidenceRoot.StartsWith(sdkRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("migration_retained_read_evidence_cannot_modify_inputs");
        }
        var configuration = new RetainedMigrationToolReadConfiguration(sourceRoot, artifactRoot, sdkRoot, evidenceRoot);
        RetainedMigrationToolObservation observation = await OwnedCurrentSchemaTarget.ReadRetainedMigrationToolAsync(
            configuration, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return new(configuration, observation);
    }

    internal async Task<CurrentSchemaVerifierIdentity> RevalidateAsync(CancellationToken cancellationToken)
    {
        RetainedMigrationToolObservation current = await OwnedCurrentSchemaTarget.ReadRetainedMigrationToolAsync(
            _configuration, cancellationToken).ConfigureAwait(false);
        if (current != _observation)
        {
            throw new InvalidOperationException("migration_retained_original_tool_changed");
        }
        cancellationToken.ThrowIfCancellationRequested();
        return _observation.Identity;
    }
}
