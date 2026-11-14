using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.Windows;

/// <summary>Recomputes the privacy-safe raw fact digest independently of its digest slot.</summary>
public static class WindowsVaultRawFactCodec
{
    public static string ComputeContentDigest(WindowsVaultRawFact fact)
        => Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(
            fact with
            {
                ContentDigest = string.Empty
            })));

    /// <summary>
    /// Rejects tampering, foreign scope and contradictory raw semantics, even after resealing.
    /// Structural path checks grant no native root admission, writes or clean state.
    /// </summary>
    public static bool Verify(WindowsVaultRawFact fact, WindowsVaultWatchIdentity expectedIdentity)
        => fact is not null
            && expectedIdentity is not null
            && fact.Identity is not null
            && fact.Schema == WindowsVaultWatcherSchemas.RawFact
            && fact.SchemaVersion == WindowsVaultWatcherSchemas.Version
            && fact.Platform == WindowsVaultWatcherSchemas.Platform
            && fact.Identity == expectedIdentity
            && fact.Identity.FileSystem == "NTFS"
            && fact.Sequence > 0
            && fact.TimestampUnixMilliseconds > 0
            && fact.MonotonicTimestamp > 0
            && Enum.IsDefined(fact.FactClass)
            && Enum.IsDefined(fact.PathDisposition)
            && !fact.WatermarkValid
            && fact.SourceContentDigest is null
            && fact.FileIdDiagnostic is null
            && fact.CookieDiagnostic is null
            && ValidSemantics(fact)
            && fact.ContentDigest == ComputeContentDigest(fact);

    internal static bool IsReasonCode(string? value)
        => value is { Length: >= 3 and <= 128 }
            && value.All(static character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '_' or '-');

    internal static bool IsRelativeProjection(string? rawPath)
        => rawPath is not null
            && ArticleVaultPathStructureValidator.ValidateRelativePath(rawPath.Replace('\\', '/')).IsValid;

    private static bool ValidSemantics(WindowsVaultRawFact fact)
    {
        bool oldPath = fact.RawOldRelativePath is not null;
        bool newPath = fact.RawNewRelativePath is not null;
        if (oldPath && newPath || fact.NativeError is <= 0)
        {
            return false;
        }

        bool mutation = fact.FactClass is WindowsVaultFactClass.Added or WindowsVaultFactClass.Removed
            or WindowsVaultFactClass.Modified or WindowsVaultFactClass.RenameOldName
            or WindowsVaultFactClass.RenameNewName;
        if (mutation)
        {
            if (fact.RescanRequired || fact.ReasonCode is not null || fact.NativeError is not null
                || fact.PathDisposition is not (WindowsVaultPathDisposition.Source or WindowsVaultPathDisposition.MissingEntry)
                || !IsRelativeProjection(fact.RawOldRelativePath ?? fact.RawNewRelativePath))
            {
                return false;
            }

            return fact.FactClass switch
            {
                WindowsVaultFactClass.Added => fact.NativeAction == 1 && newPath,
                WindowsVaultFactClass.Removed => fact.NativeAction == 2 && oldPath,
                WindowsVaultFactClass.Modified => fact.NativeAction == 3 && newPath,
                WindowsVaultFactClass.RenameOldName => fact.NativeAction == 4 && oldPath,
                WindowsVaultFactClass.RenameNewName => fact.NativeAction == 5 && newPath,
                _ => false
            };
        }

        if (!fact.RescanRequired || !IsReasonCode(fact.ReasonCode))
        {
            return false;
        }

        if (!oldPath && !newPath)
        {
            return fact.NativeAction == 0 && fact.PathDisposition == WindowsVaultPathDisposition.None;
        }

        if (fact.NativeError is not null
            || (fact.NativeAction is 2 or 4 ? !oldPath : !newPath))
        {
            return false;
        }

        // Rejected native names remain auditable only as blocked security facts. They are never
        // interpreted as source paths, paired renames or proof of canonical native admission.
        return fact.FactClass switch
        {
            WindowsVaultFactClass.SecurityBlocked => fact.PathDisposition == WindowsVaultPathDisposition.Blocked,
            WindowsVaultFactClass.Unknown => fact.NativeAction is not (1 or 2 or 3 or 4 or 5)
                && fact.PathDisposition is WindowsVaultPathDisposition.Source or WindowsVaultPathDisposition.MissingEntry
                && IsRelativeProjection(fact.RawNewRelativePath),
            _ => false
        };
    }
}
