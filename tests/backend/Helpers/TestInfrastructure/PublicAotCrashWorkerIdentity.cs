using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal static partial class PublicAotCrashWorkerProgram
{
    private static T ParseSingleRecord<T>(string output, string prefix)
    {
        string[] payloads = output
            .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)
            .Where(line => line.StartsWith(prefix, StringComparison.Ordinal))
            .Select(line => line[prefix.Length..])
            .ToArray();
        if (payloads.Length != 1)
        {
            throw new InvalidDataException($"Expected exactly one {prefix.Trim()} record.");
        }

        return JsonSerializer.Deserialize<T>(payloads[0], s_jsonOptions)
            ?? throw new InvalidDataException($"The {prefix.Trim()} record is invalid.");
    }

    private static string CommandIdentity(string executablePath, string assemblyPath)
        => TextIdentity($"{FileIdentity(executablePath)}\0{FileIdentity(assemblyPath)}\0{Command}");

    private static string PathIdentity(string path)
        => TextIdentity(Path.GetFullPath(path));

    private static string FileIdentity(string path)
        => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(Path.GetFullPath(path))));

    private static string TextIdentity(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private sealed class CrashWorkerWebHostEnvironment(string root) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "FsusBlog.PublicAotCrashWorker";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = root;
        public string EnvironmentName { get; set; } = Environments.Development;
    }
}
