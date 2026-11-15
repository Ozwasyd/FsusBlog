using System.Security.Cryptography;

namespace FsusBlog.V2.Integration.Tests;

internal static class PublicationFixture
{
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
