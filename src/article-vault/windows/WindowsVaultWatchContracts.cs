namespace FsusBlog.ArticleVault.Windows;

/// <summary>Fixes the versioned raw Windows observer boundary; facts grant no sync admission.</summary>
public static class WindowsVaultWatcherSchemas
{
    public const string RawFact = "fsusblog.article-vault.windows-raw-fact.v1";
    public const int Version = 1;
    public const string Platform = "windows";
}

/// <summary>Retains Windows actions individually; replacement/truncation are not inferred.</summary>
public enum WindowsVaultFactClass
{
    WatcherRestarted,
    Added,
    Removed,
    Modified,
    RenameOldName,
    RenameNewName,
    BufferOverflow,
    SecurityBlocked,
    PermissionBlocked,
    SharingBlocked,
    RootLost,
    WatchInvalidated,
    Unknown
}

/// <summary>Describes native path admission supplied by the canonical root owner.</summary>
public enum WindowsVaultPathDisposition
{
    None,
    Source,
    MissingEntry,
    Blocked
}

/// <summary>Binds an observer to an admitted NTFS root; never identifies an article by path/file ID.</summary>
public sealed record WindowsVaultWatchIdentity(
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    string AgentIdentity,
    string RootIdentity,
    string RootManifestSha256,
    string WatchInstanceIdentity,
    string FileSystem,
    uint VolumeSerialDiagnostic,
    bool CaseSensitive);

/// <summary>Bounds both kernel notification bytes and retained managed facts.</summary>
public sealed record WindowsVaultWatcherOptions(int NativeBufferBytes = 64 * 1024, int QueueCapacity = 512)
{
    internal void Validate()
    {
        if (NativeBufferBytes is < 4096 or > 64 * 1024 || NativeBufferBytes % 4 != 0)
        {
            throw new ArgumentOutOfRangeException(nameof(NativeBufferBytes));
        }

        if (QueueCapacity is < 8 or > 16384)
        {
            throw new ArgumentOutOfRangeException(nameof(QueueCapacity));
        }
    }
}

/// <summary>Reports raw observation progress. Only #2112 can rebuild a verified rescan watermark.</summary>
public sealed record WindowsVaultWatermark(string WatchInstanceIdentity, long LastSequence, bool IsValid, string ReasonCode);

/// <summary>Content-addresses the fact, not Markdown bytes. Native notify records contain no body digest.</summary>
public sealed record WindowsVaultRawFact(
    string Schema,
    int SchemaVersion,
    string Platform,
    WindowsVaultWatchIdentity Identity,
    long Sequence,
    uint NativeAction,
    WindowsVaultFactClass FactClass,
    string? RawOldRelativePath,
    string? RawNewRelativePath,
    string? FileIdDiagnostic,
    string? CookieDiagnostic,
    long TimestampUnixMilliseconds,
    long MonotonicTimestamp,
    WindowsVaultPathDisposition PathDisposition,
    int? NativeError,
    string? ReasonCode,
    bool RescanRequired,
    bool WatermarkValid,
    string? SourceContentDigest,
    string ContentDigest);

internal sealed record WindowsVaultPathAdmission(WindowsVaultPathDisposition Disposition, string? ReasonCode);
internal sealed record WindowsVaultNativeRecord(uint Action, string RelativePath);
