using System.Diagnostics;
using System.Text.Json;
using FsusBlog.V2.Server.Operations;
using Microsoft.AspNetCore.Http;

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
            await Mark("measure-before");
            Assert.Equal(0, observer.SlowRequestStart(4));
            var request = new DefaultHttpContext();
            request.Response.StatusCode = StatusCodes.Status200OK;
            request.Response.ContentLength = 42;
            Assert.NotEqual(0, observer.SlowRequestStart(1));
            var slow = Stopwatch.GetTimestamp() - Stopwatch.Frequency / 10;
            for (int i = 0; i < 4097; i++) observer.CountRequest(request, 1, slow);
            await Mark("measure-after");
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
                    Assert.Equal("detailHtml", observed.GetProperty("Route").GetString());
                    Assert.Equal(42, observed.GetProperty("ContentLength").GetInt64());
                    Assert.Equal(200, observed.GetProperty("Status").GetInt32());
                    Assert.True(observed.GetProperty("Milliseconds").GetDouble() >= 20);
                    Assert.True(observed.GetProperty("StartUtc").GetDateTime() < observed.GetProperty("EndUtc").GetDateTime());
                    retained++;
                }
            }
            Assert.Equal(4096, retained);
            Assert.Equal(1, omitted);
        }
        finally { directory.Delete(recursive: true); }

        async Task Mark(string value)
        {
            var next = Path.Combine(directory.FullName, "runtime.mark.next");
            await File.WriteAllTextAsync(next, value, timeout.Token);
            File.Move(next, Path.Combine(directory.FullName, "runtime.mark"));
            var acknowledgment = Path.Combine(directory.FullName, value + ".ack");
            while (!File.Exists(acknowledgment)) await Task.Delay(10, timeout.Token);
        }
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
                    var nextMark = Path.Combine(directory.FullName, "runtime.mark.next");
                    var mark = Path.Combine(directory.FullName, "runtime.mark");
                    var acknowledgment = Path.Combine(directory.FullName, "drain.ack");
                    await File.WriteAllTextAsync(nextMark, "drain", timeout.Token);
                    File.Move(nextMark, mark);
                    while (!File.Exists(acknowledgment)) await Task.Delay(10, timeout.Token);
                    File.Delete(acknowledgment);
                    data = await File.ReadAllTextAsync(output, timeout.Token);
                } while (!data.Contains("\"SuspensionMilliseconds\"", StringComparison.Ordinal));
                Assert.Contains("\"ResumeMilliseconds\"", data);
            }
        }
        finally { directory.Delete(recursive: true); }
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
        Assert.Equal(clock.AddMilliseconds(3), pauses[0].RestartUtc);
        Assert.Equal(3, pauses[0].SuspensionMilliseconds);
        Assert.Equal(2, pauses[0].ResumeMilliseconds);
        Assert.Equal(5, pauses[0].Milliseconds);
        Assert.Equal(4, pauses[1].SuspensionMilliseconds);
        Assert.Equal(1, pauses[1].ResumeMilliseconds);
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
