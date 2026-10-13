using System.Security.Cryptography;
using System.Text.Json;

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

    /// <summary>Rejects tampering and foreign scope; valid facts still cannot authorize writes or clean state.</summary>
    public static bool Verify(WindowsVaultRawFact fact, WindowsVaultWatchIdentity expectedIdentity)
        => fact.Schema == WindowsVaultWatcherSchemas.RawFact
            && fact.SchemaVersion == WindowsVaultWatcherSchemas.Version
            && fact.Platform == WindowsVaultWatcherSchemas.Platform
            && fact.Identity == expectedIdentity
            && fact.Sequence > 0
            && Enum.IsDefined(fact.FactClass)
            && Enum.IsDefined(fact.PathDisposition)
            && !fact.WatermarkValid
            && fact.SourceContentDigest is null
            && fact.FileIdDiagnostic is null
            && fact.CookieDiagnostic is null
            && fact.ContentDigest == ComputeContentDigest(fact);
}
