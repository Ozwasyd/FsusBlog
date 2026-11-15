using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.V2.Core.Integrity;
using FsusBlog.V2.Server.Content;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.V2.Integration.Tests;

public sealed class IntegrityKeysTests
{
    private const string Prefix = "IntegrityProof:Signing";
    private const string Algorithm = "ECDSA_P256_SHA256";

    [Fact]
    public void EmitsOnlyValidatedPublicKeysInWireOrder()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var spki = WebEncoders.Base64UrlEncode(key.ExportSubjectPublicKeyInfo());
        var sensitive = WebEncoders.Base64UrlEncode(key.ExportPkcs8PrivateKey());
        using var manifest = JsonDocument.Parse(IntegrityKeys.ReadManifest(Configuration(new()
        {
            [$"{Prefix}:CurrentKeyId"] = " new-key ",
            [$"{Prefix}:Keys:new-key:Version"] = "2",
            [$"{Prefix}:Keys:new-key:PrivateKey"] = sensitive,
            [$"{Prefix}:Keys:new-key:PublicKey"] = spki,
            [$"{Prefix}:Keys:new-key:Algorithm"] = Algorithm,
            [$"{Prefix}:Keys:prior-key:PublicKey"] = spki,
            [$"{Prefix}:Keys:prior-key:Algorithm"] = "ecdsa-p256-sha256",
            [$"{Prefix}:Keys:prior-key:RevokedAtUtc"] = "2026-09-01T00:00:00Z",
            [$"{Prefix}:Keys:prior-key:CompromisedAtUtc"] = "2026-09-01T12:00:00.0000000+00:00",
            [$"{Prefix}:Keys:unconfigured:PrivateKey"] = sensitive,
        })));
        var root = manifest.RootElement;
        Assert.Equal(new[] { "manifestVersion", "kind", "hashAlgorithm", "currentKeyId", "keys" }, root.EnumerateObject().Select(p => p.Name));
        Assert.Equal(1, root.GetProperty("manifestVersion").GetInt32());
        Assert.Equal("integrity-key-registry", root.GetProperty("kind").GetString());
        Assert.Equal("sha256", root.GetProperty("hashAlgorithm").GetString());
        Assert.Equal("new-key", root.GetProperty("currentKeyId").GetString());
        var rows = root.GetProperty("keys").EnumerateArray().ToArray();
        Assert.Equal(new[] { "new-key", "prior-key" }, rows.Select(row => row.GetProperty("keyId").GetString()));
        Assert.Equal(new[] { "keyId", "algorithm", "version", "publicKey" }, rows[0].EnumerateObject().Select(p => p.Name));
        Assert.Equal(2, rows[0].GetProperty("version").GetInt32());
        Assert.Equal(Algorithm, rows[1].GetProperty("algorithm").GetString());
        Assert.Equal("2026-09-01T00:00:00Z", rows[1].GetProperty("revokedAtUtc").GetString());
        Assert.Equal("2026-09-01T12:00:00.0000000+00:00", rows[1].GetProperty("compromisedAtUtc").GetString());
        Assert.False(root.GetRawText().Contains(sensitive, StringComparison.Ordinal), "The manifest included private key material.");
        Assert.Equal(spki, rows[0].GetProperty("publicKey").GetString());
    }

    [Fact]
    public void EmptyRegistryOmitsAnUnresolvableCurrentId()
    {
        using var result = JsonDocument.Parse(IntegrityKeys.ReadManifest(Configuration(new()
        {
            [$"{Prefix}:CurrentKeyId"] = "missing",
        })));
        Assert.False(result.RootElement.TryGetProperty("currentKeyId", out _));
        Assert.Equal(0, result.RootElement.GetProperty("keys").GetArrayLength());
    }

    [Fact]
    public void InvalidPublicMaterialCannotBecomeVerificationAuthority()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP384);
        var p384 = WebEncoders.Base64UrlEncode(key.ExportSubjectPublicKeyInfo());
        using var p256 = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var publicBytes = p256.ExportSubjectPublicKeyInfo();
        var privateBytes = p256.ExportPkcs8PrivateKey();
        var publicKey = $"{Prefix}:Keys:site:PublicKey";
        var algorithm = $"{Prefix}:Keys:site:Algorithm";
        var settings = new Dictionary<string, string?> { [algorithm] = Algorithm, [publicKey] = p384 };
        Reject();
        settings[publicKey] = WebEncoders.Base64UrlEncode([.. publicBytes, 0]);
        Reject();
        settings[publicKey] = WebEncoders.Base64UrlEncode(privateBytes);
        Reject();
        settings[publicKey] = WebEncoders.Base64UrlEncode(publicBytes);
        settings[$"{Prefix}:Keys:site:RevokedAtUtc"] = "junk";
        Reject();

        void Reject()
        {
            var error = Assert.Throws<InvalidOperationException>(() => IntegrityKeys.ReadManifest(Configuration(settings)));
            Assert.Equal("Invalid public integrity verification key configuration.", error.Message);
        }
    }

    [PostgresFact]
    public async Task PublicRegistryServesRealSpkiWithoutCookiesOrPrivateKey()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromMinutes(1));
        using var signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var spki = WebEncoders.Base64UrlEncode(signer.ExportSubjectPublicKeyInfo());
        var pkcs = WebEncoders.Base64UrlEncode(signer.ExportPkcs8PrivateKey());
        await using var server = await ServerProcess.Start(db.ConnectionString, ct, new Dictionary<string, string>
        {
            ["IntegrityProof__Signing__CurrentKeyId"] = "live",
            ["IntegrityProof__Signing__Keys__live__Algorithm"] = Algorithm,
            ["IntegrityProof__Signing__Keys__live__Version"] = "3",
            ["IntegrityProof__Signing__Keys__live__PublicKey"] = spki,
            ["IntegrityProof__Signing__Keys__live__PrivateKey"] = pkcs,
        });
        using var response = await server.Client.GetAsync("/integrity/keys.json", ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("utf-8", response.Content.Headers.ContentType?.CharSet);
        Assert.Equal(TimeSpan.FromSeconds(60), response.Headers.CacheControl?.MaxAge);
        Assert.Contains("Accept-Encoding", response.Headers.Vary);
        Assert.False(response.Headers.Contains("Set-Cookie"));
        var json = await response.Content.ReadAsStringAsync(ct);
        Assert.False(json.Contains(pkcs, StringComparison.Ordinal), "The HTTP response included private key material.");
        using var manifest = JsonDocument.Parse(json);
        var key = manifest.RootElement.GetProperty("keys")[0].GetProperty("publicKey").GetString()!;
        using var verifier = ECDsa.Create();
        verifier.ImportSubjectPublicKeyInfo(WebEncoders.Base64UrlDecode(key), out _);
        var payload = SiteProofPayload.Canonicalize("article-rights-proof", "article:1:revision:2:rights:3",
            Convert.ToHexString(SHA256.HashData("Synthetic test proof"u8)), DateTimeOffset.UnixEpoch,
            new Dictionary<string, string> { ["publishProofId"] = "4" });
        var signature = signer.SignData(payload, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        Assert.True(verifier.VerifyData(payload, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
        Assert.False(verifier.VerifyData("Different proof"u8, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
    }

    private static IConfigurationSection Configuration(Dictionary<string, string?> entries) =>
        new ConfigurationBuilder().AddInMemoryCollection(entries).Build().GetSection(Prefix);
}
