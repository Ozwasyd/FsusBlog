using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.MacOS;

/// <summary>Defines the versioned native observation schema; no fact authorizes a write.</summary>
public static class MacVaultWatcherSchemas
{
    public const string RawFact = "fsusblog.article-vault.macos-raw-fact.v1";
    public const int Version = 1;
}

/// <summary>Separates native records from adapter failures without interpreting editor saves.</summary>
public enum MacVaultFactClass
{
    NativeEvent,
    WatcherRestarted,
    DeliveryOverflow,
    BlockedPath,
    StreamError
}

/// <summary>Records structural classification after independent Darwin path admission.</summary>
public enum MacVaultPathDisposition
{
    None,
    SourceProjection,
    ControlTree,
    MissingEntry,
    Blocked
}

/// <summary>Binds actual APFS comparison semantics and native mount/root diagnostics.</summary>
public sealed record MacVaultFilesystemSemantics(
    string FileSystem,
    string VolumeIdentity,
    bool CaseSensitive,
    string UnicodeComparison,
    uint DeviceDiagnostic,
    ulong RootFileIdDiagnostic);

/// <summary>Bounds pending records and each native callback; overflow requires rescan.</summary>
public sealed record MacVaultWatcherOptions(int MaxPendingFacts = 512, int MaxNativeBatch = 512)
{
    internal void Validate()
    {
        if (MaxPendingFacts is < 8 or > 16384 || MaxNativeBatch is < 8 or > 16384)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxPendingFacts));
        }
    }
}

/// <summary>Selects one root at session creation, never per-command absolute paths.</summary>
public sealed record MacVaultWatchRequest(
    string RootPath,
    ArticleVaultRootManifest RootManifest,
    string AgentIdentity,
    MacVaultWatcherOptions Options);

/// <summary>Seals the manifest scope, actual filesystem and a fresh watch instance.</summary>
public sealed record MacVaultWatchIdentity(
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    string AgentIdentity,
    string RootIdentitySha256,
    string RootManifestSha256,
    string WatchInstanceIdentity,
    MacVaultFilesystemSemantics Filesystem);

/// <summary>Remains invalid until the canonical rescan owner supplies an implemented admission API.</summary>
public sealed record MacVaultWatermark(
    string WatchInstanceIdentity,
    long LastSequence,
    ulong? LastNativeEventId,
    bool IsValid,
    string InvalidatedReasonCode);

/// <summary>
/// Retains raw flags and one observed spelling. FSEvents supplies no rename pair, operation time,
/// truncate length or body digest: those absent facts stay null and are never guessed from mtime.
/// </summary>
public sealed record MacVaultRawFact(
    string Schema,
    int SchemaVersion,
    string Platform,
    MacVaultWatchIdentity Identity,
    long Sequence,
    ulong? NativeEventId,
    uint NativeFlags,
    MacVaultFactClass FactClass,
    string? RawObservedRelativePath,
    string? RawOldRelativePath,
    string? RawNewRelativePath,
    ulong? FileIdDiagnostic,
    long ObservedUnixMilliseconds,
    long ObservedMonotonicTicks,
    MacVaultPathDisposition PathDisposition,
    string? ErrorCode,
    bool RescanRequired,
    bool WatermarkValid,
    string ContentSha256);

/// <summary>Exposes a stable reason, excluding native exception paths or private data.</summary>
public sealed class MacVaultWatcherException(string reasonCode) : IOException(reasonCode)
{
    public string ReasonCode { get; } = reasonCode;
}
