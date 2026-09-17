using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.Linux;

/// <summary>Defines the only Linux raw-fact schema emitted by the native watcher.</summary>
public static class LinuxVaultWatcherSchemas
{
    public const string RawFact = "fsusblog.article-vault.linux-raw-fact.v1";
    public const int Version = 1;
    public const string Platform = "linux";
}

/// <summary>Classifies one unnormalized inotify record or watcher failure.</summary>
public enum LinuxVaultFactClass
{
    WatcherRestarted,
    Created,
    Modified,
    AttributesChanged,
    ClosedAfterWrite,
    MovedFrom,
    MovedTo,
    Deleted,
    DeleteSelf,
    MoveSelf,
    Unmounted,
    WatchInvalidated,
    QueueOverflow,
    DynamicWatchFailed,
    PermissionBlocked,
    RootLost,
    Unknown
}

/// <summary>Classifies a raw path without interpreting it as article identity.</summary>
public enum LinuxVaultPathDisposition
{
    None,
    Source,
    ControlTree,
    MissingEntry,
    Blocked
}

/// <summary>Binds the watcher to one Linux mount and its filesystem semantics.</summary>
public sealed record LinuxVaultFilesystemSemantics(
    string FileSystemType,
    int MountIdentity,
    string MountPoint,
    bool CaseSensitive,
    string UnicodeNormalization);

/// <summary>Defines bounded resources for one native watcher session.</summary>
public sealed record LinuxVaultWatcherOptions(int MaxFactsPerRead = 512, int MaxWatches = 4096)
{
    internal void Validate()
    {
        if (MaxFactsPerRead is < 8 or > 16384)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxFactsPerRead));
        }

        if (MaxWatches is < 1 or > 65536)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxWatches));
        }
    }
}

/// <summary>Requests observation of one exact manifest-bound Vault root.</summary>
public sealed record LinuxVaultWatchRequest(
    string RootPath,
    ArticleVaultRootManifest RootManifest,
    string AgentIdentity,
    LinuxVaultWatcherOptions Options);

/// <summary>Binds one watcher instance to its verified Vault and mount identities.</summary>
public sealed record LinuxVaultWatchIdentity(
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    string AgentIdentity,
    string RootIdentity,
    string RootManifestSha256,
    string WatchInstanceIdentity,
    string CanonicalRootPath,
    LinuxVaultFilesystemSemantics Filesystem);

/// <summary>Represents the current raw-event watermark and its fail-closed validity.</summary>
public sealed record LinuxVaultWatermark(
    string WatchInstanceIdentity,
    long LastSequence,
    bool IsValid,
    string? InvalidatedReasonCode,
    string? RescanReceiptSha256);

/// <summary>Records one privacy-safe, content-addressed raw Linux filesystem fact.</summary>
public sealed record LinuxVaultRawFact(
    string Schema,
    int SchemaVersion,
    string Platform,
    string FileSystem,
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    string AgentIdentity,
    string RootIdentity,
    string RootManifestSha256,
    string WatchInstanceIdentity,
    long Sequence,
    uint Mask,
    LinuxVaultFactClass FactClass,
    uint? CookieDiagnostic,
    string? RawOldRelativePath,
    string? RawNewRelativePath,
    long TimestampUnixNanoseconds,
    long MonotonicTimestampNanoseconds,
    LinuxVaultPathDisposition PathDisposition,
    string? ErrorCode,
    bool RescanRequired,
    bool WatermarkValid,
    string ContentSha256);

/// <summary>Reports a stable, machine-readable watcher rejection reason.</summary>
public sealed class LinuxVaultWatcherException(string reasonCode, Exception? innerException = null)
    : IOException(reasonCode, innerException)
{
    public string ReasonCode { get; } = reasonCode;
}
