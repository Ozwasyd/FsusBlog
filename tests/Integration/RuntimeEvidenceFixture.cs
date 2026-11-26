namespace FsusBlog.V2.Integration.Tests;

internal sealed class RuntimeEvidenceFixture(string prefix) : IDisposable
{
    private readonly DirectoryInfo directory = Directory.CreateTempSubdirectory(prefix);
    internal string DirectoryPath => directory.FullName;
    internal string OutputPath => Path.Combine(DirectoryPath, "runtime.ndjson");

    internal Task<ServerProcess> Start(string connectionString, CancellationToken ct,
        IReadOnlyDictionary<string, string>? settings = null)
    {
        Dictionary<string, string> values = settings is null ? new() : new(settings);
        values["FSUSBLOG_RUNTIME_EVIDENCE_CONTROL"] = DirectoryPath;
        values["FSUSBLOG_RUNTIME_EVIDENCE_OUTPUT"] = OutputPath;
        return ServerProcess.Start(connectionString, ct, values);
    }

    internal async Task<string> PublishMark(string name, CancellationToken ct, int pollMilliseconds = 20)
    {
        var staging = Path.Combine(DirectoryPath, "runtime.mark.next");
        await File.WriteAllTextAsync(staging, name, ct);
        File.Move(staging, Path.Combine(DirectoryPath, "runtime.mark"));
        var acknowledgement = Path.Combine(DirectoryPath, name + ".ack");
        while (!File.Exists(acknowledgement)) await Task.Delay(pollMilliseconds, ct);
        return acknowledgement;
    }

    internal async Task<JsonElement> Mark(string name, CancellationToken ct)
    {
        await PublishMark(name, ct);
        var matches = new List<JsonElement>();
        foreach (var line in await File.ReadAllLinesAsync(OutputPath, ct))
        {
            using var row = JsonDocument.Parse(line);
            if (row.RootElement.GetProperty("mark").GetString() == name) matches.Add(row.RootElement.Clone());
        }
        return Assert.Single(matches);
    }

    internal static long Count(JsonElement marker, string counter) =>
        marker.GetProperty(counter).GetProperty("otherHttp").GetInt64();

    internal static void AssertNoDatabaseActivity(JsonElement before, JsonElement after)
    {
        Assert.Equal(Count(before, "dbCommandStarts"), Count(after, "dbCommandStarts"));
        Assert.Equal(Count(before, "dbPhysicalOpenStarts"), Count(after, "dbPhysicalOpenStarts"));
    }

    public void Dispose() => directory.Delete(recursive: true);
}
