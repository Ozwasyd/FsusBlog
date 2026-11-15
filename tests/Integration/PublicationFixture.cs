using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using Microsoft.AspNetCore.WebUtilities;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

internal static class PublicationFixture
{
    private const string Signing = "IntegrityProof__Signing__";

    internal static DirectoryInfo PrivateScratch(string prefix)
    {
        var parent = OperatingSystem.IsMacOS() ? "/private/tmp" : "/tmp";
        var directory = Directory.CreateDirectory(Path.Combine(parent, $"{prefix}-{Guid.NewGuid():N}"));
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(directory.FullName,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        return directory;
    }

    internal static Dictionary<string, string> NativeSettings(string origin, string keyId, string privateKey) => new()
    {
        ["FSUSBLOG_PUBLIC_ORIGIN"] = origin,
        ["FSUSBLOG_TRUST_LOOPBACK_PROXY"] = "true",
        [Signing + "NativeV2Enabled"] = "true",
        [Signing + "CurrentKeyId"] = keyId,
        [Signing + "NativeV2PrivateKeyFile"] = privateKey,
    };

    internal static void ConfigureKey(Dictionary<string, string> settings, string id, string version, byte[] spki,
        string notBefore = "2020-01-01T00:00:00.000000Z", string notAfter = "2099-01-01T00:00:00.000000Z")
    {
        var prefix = Signing + "Keys__" + id + "__";
        settings[prefix + "Version"] = version;
        settings[prefix + "Algorithm"] = "ECDSA_P256_SHA256";
        settings[prefix + "PublicKey"] = WebEncoders.Base64UrlEncode(spki);
        settings[prefix + "NotBeforeUtc"] = notBefore;
        settings[prefix + "NotAfterUtc"] = notAfter;
    }

    internal static async Task<string> ProofPath(NpgsqlConnection db, int article, CancellationToken ct) =>
        $"/integrity/v2/article/{article}/{await FixtureSql.ScalarAsync(db, null, ct,
            "select publication_id from public.article_publication where article_id=$1", article)}/rights.json";

    internal static async Task<HttpResponseMessage> SendForwarded(ServerProcess server, HttpMethod method, string route,
        string host, string token, byte[]? frame, CancellationToken ct, string transport = "https")
    {
        using var request = SiteAedsFixture.Request(method, route, frame, frame is null ? null : token, handle: null);
        Forward(request, host, transport);
        return await server.Client.SendAsync(request, ct);
    }

    internal static async Task<Draft> Edit(ServerProcess server, string host, string token, string route,
        ArticleCommand command, CancellationToken ct)
    {
        using var response = await SendForwarded(server, HttpMethod.Post, route, host, token, Wire.EncodeArticleCommand(command), ct);
        response.EnsureSuccessStatusCode();
        return Wire.DecodeDraft(await response.Content.ReadAsByteArrayAsync(ct));
    }

    internal static string PrivateKey(DirectoryInfo directory, string name, ECDsa key)
    {
        var path = Path.Combine(directory.FullName, name);
        var bytes = key.ExportPkcs8PrivateKey();
        try { File.WriteAllBytes(path, bytes); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead);
        return path;
    }

    internal static void Forward(HttpRequestMessage request, string host, string transport = "https")
    {
        request.Headers.Host = host;
        request.Headers.Add("X-Forwarded-For", "127.0.0.1");
        request.Headers.Add("X-Forwarded-Proto", transport);
    }

    internal static string Tool(string name)
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var path = Path.Combine(directory.FullName, "tools", name);
            if (File.Exists(path)) return path;
        }
        throw new FileNotFoundException($"Native publication verifier {name} was not found.");
    }
}
