public sealed class RuntimeEvidenceTests
{
    [Fact]
    public async Task RecordsSlowRequestsOnlyInTheMeasurementWindowWithABoundedBuffer()
    {
        var directory = Directory.CreateTempSubdirectory();
        var output = Path.Combine(directory.FullName, "runtime.ndjson");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        try
        {
            await using var observer = new RuntimeEvidence(directory.FullName, output, new HttpContextAccessor(), captureSlowRequests: true);
            Assert.Equal(0, observer.SlowRequestStart(0));
            await MarkAsync(directory, "measure-before", timeout.Token);
            Assert.Equal(0, observer.SlowRequestStart(4));
            var request = new DefaultHttpContext();
            request.Response.StatusCode = StatusCodes.Status200OK;
            request.Response.ContentLength = 42;
            Assert.NotEqual(0, observer.SlowRequestStart(1));
            var slow = Stopwatch.GetTimestamp() - Stopwatch.Frequency / 10;
            for (int i = 0; i < 4097; i++) observer.CountRequest(request, 1, slow);
            await MarkAsync(directory, "measure-after", timeout.Token);
            Assert.Equal(0, observer.SlowRequestStart(1));
            var lines = await File.ReadAllLinesAsync(output, timeout.Token);
            int retained = 0;
            int omitted = 0;
            foreach (var line in lines)
            {
                using var document = JsonDocument.Parse(line);
                var data = document.RootElement;
                omitted = data.GetProperty("slowRequestOmitted").GetInt32();
                foreach (var observed in data.GetProperty("slowRequests").EnumerateArray())
                {
                    Assert.Equal(("detailHtml", 42L, 200), (observed.GetProperty("Route").GetString(),
                        observed.GetProperty("ContentLength").GetInt64(), observed.GetProperty("Status").GetInt32()));
                    Assert.True(observed.GetProperty("Milliseconds").GetDouble() >= 20);
                    Assert.True(observed.GetProperty("StartUtc").GetDateTime() < observed.GetProperty("EndUtc").GetDateTime());
                    retained++;
                }
            }
            Assert.Equal((4096, 1), (retained, omitted));
        }
        finally { directory.Delete(recursive: true); }
    }

    [Fact]
    public async Task CapturesSplitPauseFromTheCurrentClr()
    {
        var directory = Directory.CreateTempSubdirectory();
        var output = Path.Combine(directory.FullName, "runtime.ndjson");
        try
        {
            await using (var observer = new RuntimeEvidence(directory.FullName, output, new Microsoft.AspNetCore.Http.HttpContextAccessor()))
            {
                var baseline = GC.CollectionCount(0);
                GC.Collect(0, GCCollectionMode.Forced, blocking: true);
                Assert.True(GC.CollectionCount(0) > baseline);

                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                string data;
                do
                {
                    // The native event dispatcher is asynchronous, so ask for
                    // another sample until it has delivered the full sequence.
                    File.Delete(await MarkAsync(directory, "drain", timeout.Token));
                    data = await File.ReadAllTextAsync(output, timeout.Token);
                } while (!data.Contains("\"SuspensionMilliseconds\"", StringComparison.Ordinal));
                Assert.Contains("\"ResumeMilliseconds\"", data);
            }
        }
        finally { directory.Delete(recursive: true); }
    }

    private static async Task<string> MarkAsync(DirectoryInfo directory, string value, CancellationToken ct)
    {
        var next = Path.Combine(directory.FullName, "runtime.mark.next");
        await File.WriteAllTextAsync(next, value, ct);
        File.Move(next, Path.Combine(directory.FullName, "runtime.mark"));
        var ack = Path.Combine(directory.FullName, value + ".ack");
        while (!File.Exists(ack)) await Task.Delay(10, ct);
        return ack;
    }

    [Fact]
    public void RecordsSuspensionAndResumePhasesUsingRuntimeInstances()
    {
        var reader = new RuntimeEvidence.PauseSequence();
        var clock = DateTime.UnixEpoch;
        reader.Add(9, 1, [1u, 41u, (ushort)1], clock);
        reader.Add(9, 1, [6u, 30u, (ushort)2], clock.AddMilliseconds(2));
        reader.Add(7, 1, [(ushort)1], clock.AddMilliseconds(3));
        reader.Add(3, 1, [(ushort)1], clock.AddMilliseconds(5));
        reader.Add(7, 1, [(ushort)2], clock.AddMilliseconds(6));
        reader.Add(3, 1, [(ushort)2], clock.AddMilliseconds(7));

        Assert.Equal(0, reader.Unmatched);
        var pauses = reader.Pauses.ToArray();
        Assert.Equal(2, pauses.Length);
        Assert.Equal((clock.AddMilliseconds(3), 3d, 2d, 5d),
            (pauses[0].RestartUtc, pauses[0].SuspensionMilliseconds, pauses[0].ResumeMilliseconds, pauses[0].Milliseconds));
        Assert.Equal((4d, 1d), (pauses[1].SuspensionMilliseconds, pauses[1].ResumeMilliseconds));
    }

    [Fact]
    public void WithholdsMalformedAndNonGarbageCollectionPauses()
    {
        var reader = new RuntimeEvidence.PauseSequence();
        var at = DateTime.UnixEpoch;
        reader.Add(9, 1, [2u, 1u, (ushort)4], at);
        reader.Add(7, 1, [(ushort)4], at.AddMilliseconds(1));
        reader.Add(3, 1, [(ushort)4], at.AddMilliseconds(2));
        reader.Add(9, 1, [1u, 2u, (ushort)4], at);
        reader.Add(3, 1, [(ushort)4], at.AddMilliseconds(2));
        reader.Add(9, 1, [1u, 3u, (ushort)4], at);
        reader.Add(7, 1, [(ushort)4], at.AddMilliseconds(1));
        reader.Add(3, 1, [(ushort)4], at);
        reader.Add(9, 0, [1u, (ushort)4], at);

        Assert.Empty(reader.Pauses);
        Assert.Equal(3, reader.Unmatched);
    }
}
