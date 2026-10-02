namespace FsusBlog.Contracts.Migration;

/// <summary>The explicit database dialect; no connection-string or release inference selects it.</summary>
public enum CurrentSchemaProviderKind
{
    PostgreSql,
    MySql,
    Sqlite
}

/// <summary>Identity observed from the selected database, not a release, slot, or display name.</summary>
public sealed record CurrentSchemaDatabaseIdentity(
    CurrentSchemaProviderKind Provider,
    string InstanceId,
    string DatabaseId);

/// <summary>Exact immutable artifact reference and digest; a path or latest selector alone is insufficient.</summary>
public sealed record CurrentSchemaArtifactReference(string Reference, string Sha256);

/// <summary>Source, worktree, executable closure, and configuration identity observed by their existing owners.</summary>
public sealed record CurrentSchemaVerifierIdentity(
    string SourceRevision,
    string WorktreeDigest,
    string ToolchainDigest,
    string ConfigurationDigest);

/// <summary>Owner-computed current target identity, independent of migration descriptors and source baselines.</summary>
public sealed record CurrentSchemaTargetIdentity(
    string ModelVersion,
    string ExtractorVersion,
    string GeneratorVersion,
    string SourceDigest,
    string ContentDigest);
