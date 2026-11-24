namespace FsusBlog.V2.Tests;

internal abstract class AppearancePackageStore
{
    internal static readonly DateTimeOffset Now = new(2026, 11, 15, 0, 0, 0, TimeSpan.Zero);

    internal static byte[] Theme(string color = "#225533", string? member = null, bool link = false)
    {
        using var result = new MemoryStream();
        using (var zip = new ZipArchive(result, ZipArchiveMode.Create, leaveOpen: true))
        {
            var entry = zip.CreateEntry("manifest.json");
            if (link) entry.ExternalAttributes = unchecked((int)0xa1ff0000);
            using (var file = entry.Open()) JsonSerializer.Serialize(file, new
            {
                Format = 1, Id = "summer", Version = "1.0", Kind = "theme", Publisher = "site.operator",
                SignatureReference = "signature/one", TrustPolicyReference = "trust/policy",
                Theme = new { LightAccent = color, LightHover = "#447733", DarkAccent = "#99eeaa", DarkHover = "#cceedd" }
            });
            if (member is not null && !link)
            {
                foreach (var name in new[] { member, "LICENSE.txt" })
                using (var extra = zip.CreateEntry(name).Open()) extra.Write("forbidden"u8);
            }
        }
        return result.ToArray();
    }

    internal static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    internal sealed class TestClock : TimeProvider
    {
        internal DateTimeOffset Now { get; set; } = AppearancePackageStore.Now;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    internal sealed record Descriptor(string Source, string ArchiveSha256, string SignatureSha256, string? Format = null);

    internal Descriptor Add(ECDsa signer, byte[] zip, string id, string? format = null)
    {
        var signed = signer.SignData(zip, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        var manifest = new Descriptor($"approved-source/{id}", Hash(zip), Hash(signed), format);
        var suffix = format switch { "fsfont-v1" => ".fsfont", "fstheme-v1-palette" => ".fstheme", _ => ".zip" };
        Put(manifest.ArchiveSha256 + suffix, zip);
        Put(manifest.SignatureSha256 + ".signature", signed);
        return manifest;
    }

    internal void Configure(ECDsa signer, Descriptor[] packages, string? activeTheme, DateTimeOffset? cutoff = null, string? activeFont = null)
    {
        var config = new
        {
            Keys = new ExtensionPublisherKey[] { new("site.operator", "first", [.. signer.ExportSubjectPublicKeyInfo()], Now.AddHours(-1), Now.AddHours(1), cutoff) },
            Sources = packages.Select(p => new ApprovedExtensionSource(p.Source, "provenance/reviewed", "site.operator", "first", p.ArchiveSha256, "signature/one", "trust/policy")),
            Packages = packages,
            ActiveTheme = activeTheme,
            ActiveFont = activeFont
        };
        Put("appearance.json", JsonSerializer.SerializeToUtf8Bytes(config));
    }

    protected abstract void Put(string name, byte[] bytes);
}
