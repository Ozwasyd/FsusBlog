using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Platform;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

using Xunit.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LinuxCgroupCounterParserTests
{
    private readonly ITestOutputHelper _output;

    public LinuxCgroupCounterParserTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Theory]
    [InlineData("future 19\nfile 23\nanon 0\n", LinuxCgroupCounter.AnonymousBytes, MemoryObservationState.Available, 0L)]
    [InlineData("anon 17\nfile 23\n", LinuxCgroupCounter.FileBytes, MemoryObservationState.Available, 23L)]
    [InlineData("pgmajfault 9223372036854775807\n", LinuxCgroupCounter.MajorFaults, MemoryObservationState.Available, long.MaxValue)]
    [InlineData("high 19\nmax 31\n", LinuxCgroupCounter.LocalHighEvents, MemoryObservationState.Available, 19L)]
    [InlineData("high 19\nmax 31\n", LinuxCgroupCounter.LocalMaxEvents, MemoryObservationState.Available, 31L)]
    [InlineData("oom 0\noom_kill 2\n", LinuxCgroupCounter.LocalOutOfMemoryEvents, MemoryObservationState.Available, 0L)]
    [InlineData("oom 0\noom_kill 2\n", LinuxCgroupCounter.LocalOutOfMemoryKillEvents, MemoryObservationState.Available, 2L)]
    [InlineData("some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n", LinuxCgroupCounter.PressureSomeMicroseconds, MemoryObservationState.Available, 0L)]
    [InlineData("full total=123 avg300=100.00 avg60=12.34 avg10=0.00\n", LinuxCgroupCounter.PressureFullMicroseconds, MemoryObservationState.Available, 123L)]
    [InlineData("full avg10=0.00 avg60=0.00 avg300=0.00 total=9223372036854775807\n", LinuxCgroupCounter.PressureFullMicroseconds, MemoryObservationState.Available, long.MaxValue)]
    [InlineData("file 0\n", LinuxCgroupCounter.AnonymousBytes, MemoryObservationState.Unknown, null)]
    [InlineData("anon\n", LinuxCgroupCounter.AnonymousBytes, MemoryObservationState.Malformed, null)]
    [InlineData("anon 0\nanon 0\n", LinuxCgroupCounter.AnonymousBytes, MemoryObservationState.Malformed, null)]
    [InlineData("anon -1\n", LinuxCgroupCounter.AnonymousBytes, MemoryObservationState.Malformed, null)]
    [InlineData("anon max\n", LinuxCgroupCounter.AnonymousBytes, MemoryObservationState.Malformed, null)]
    [InlineData("anon 9223372036854775808\n", LinuxCgroupCounter.AnonymousBytes, MemoryObservationState.Malformed, null)]
    [InlineData("anon 0 kB\n", LinuxCgroupCounter.AnonymousBytes, MemoryObservationState.Malformed, null)]
    [InlineData("some avg10=0.00 total=0\n", LinuxCgroupCounter.PressureSomeMicroseconds, MemoryObservationState.Malformed, null)]
    [InlineData("some avg10=0.00 avg60=0.00 avg300=0.00 total=0 total=0\n", LinuxCgroupCounter.PressureSomeMicroseconds, MemoryObservationState.Malformed, null)]
    [InlineData("some avg10=0.00 avg60=0.00 avg300=0.00 total=-1\n", LinuxCgroupCounter.PressureSomeMicroseconds, MemoryObservationState.Malformed, null)]
    [InlineData("some avg10=100.01 avg60=0.00 avg300=0.00 total=0\n", LinuxCgroupCounter.PressureSomeMicroseconds, MemoryObservationState.Malformed, null)]
    [InlineData("some avg10=0.0 avg60=0.00 avg300=0.00 total=0\n", LinuxCgroupCounter.PressureSomeMicroseconds, MemoryObservationState.Malformed, null)]
    [InlineData("some avg10=0.00 avg60=0.00 avg300=0.00 total=0 future=0\n", LinuxCgroupCounter.PressureSomeMicroseconds, MemoryObservationState.Malformed, null)]
    public void KeyedFieldsAndPsiKeepNativeUnitsAndRejectUnknownTargetFormats(string content,
        LinuxCgroupCounter counter, MemoryObservationState state, long? value)
    {
        var identity = new LinuxCgroupDirectoryIdentity(2, 11, 22, 0, 3);
        var actual = LinuxCgroupCounterParser.Parse(Encoding.UTF8.GetBytes(content), counter, identity);
        Assert.Equal(state, actual.State);
        Assert.Equal(value, actual.Value);
        Assert.Equal(counter, actual.Counter);
        Assert.Equal(LinuxCgroupCounterParser.Unit(counter), actual.Unit);
        Assert.Same(identity, actual.Identity);
        Assert.Equal(MemoryQualification.NotVerified, actual.Qualification);
    }

    [Fact]
    public void VersionAndFileSelectionNeverReinterpretCombinedLegacyRssOrHierarchicalEvents()
    {
        var legacy = new LinuxCgroupDirectoryIdentity(1, 11, 22, 0, 3);
        var result = LinuxCgroupCounterParser.Parse("rss 4096\n"u8, LinuxCgroupCounter.AnonymousBytes, legacy);
        Assert.Equal(MemoryObservationState.Unknown, result.State);
        Assert.Null(result.Value);
        Assert.Equal("memory.events.local", LinuxCgroupCounterParser.FileName(LinuxCgroupCounter.LocalHighEvents));
        Assert.Equal("memory.stat", LinuxCgroupCounterParser.FileName(LinuxCgroupCounter.MajorFaults));
        Assert.Equal("memory.pressure", LinuxCgroupCounterParser.FileName(LinuxCgroupCounter.PressureSomeMicroseconds));
        Assert.Equal(LinuxCgroupCounterUnit.Events, LinuxCgroupCounterParser.Unit(LinuxCgroupCounter.MajorFaults));
        Assert.Equal(LinuxCgroupCounterUnit.Microseconds, LinuxCgroupCounterParser.Unit(LinuxCgroupCounter.PressureSomeMicroseconds));
        Assert.Throws<ArgumentOutOfRangeException>(() => LinuxCgroupCounterParser.Parse("anon 0"u8, (LinuxCgroupCounter)999, legacy));
    }

    [Fact]
    public void RealBoundedNativeCounterReadsKeepIdentityClearScratchAndDoNotCertifyProcessHeadroom()
    {
        Assert.True(OperatingSystem.IsLinux());
        string line = Assert.Single(File.ReadAllLines("/proc/self/mountinfo"), item => item.Contains(" - cgroup2 ", StringComparison.Ordinal));
        string path = line.Split(' ')[4].Replace("\\040", " ", StringComparison.Ordinal)
            .Replace("\\011", "\t", StringComparison.Ordinal).Replace("\\012", "\n", StringComparison.Ordinal)
            .Replace("\\134", "\\", StringComparison.Ordinal);
        var identity = LinuxCgroupDirectoryReader.TryInspectDirectory(path, 2).Value!;
        var opened = LinuxCgroupDirectoryReader.TryOpenObservedDirectory(path, identity, 4096);
        Assert.True(opened.Succeeded);
        using LinuxCgroupDirectoryReader reader = opened.Value!;
        byte[] scratch = new byte[4097];
        var captures = new List<LinuxCgroupCounterCapture>();
        foreach (LinuxCgroupCounter counter in Enum.GetValues<LinuxCgroupCounter>())
        {
            Array.Fill(scratch, (byte)0xcc);
            var capture = reader.CaptureCounter(counter, scratch);
            captures.Add(capture);
            Assert.Equal(MemoryObservationState.Available, capture.State);
            Assert.True(capture.Value >= 0);
            Assert.Equal(identity, capture.Identity);
            Assert.Equal(MemoryQualification.NotVerified, capture.Qualification);
            Assert.All(scratch, item => Assert.Equal((byte)0, item));
        }
        using (LinuxCgroupDirectoryReader small = LinuxCgroupDirectoryReader.TryOpenObservedDirectory(path, identity, 1).Value!)
        {
            byte[] tiny = new byte[2];
            Assert.Equal(MemoryObservationState.Malformed, small.CaptureCounter(LinuxCgroupCounter.AnonymousBytes, tiny).State);
            Assert.All(tiny, item => Assert.Equal((byte)0, item));
        }
        _output.WriteLine(JsonSerializer.Serialize(new
        {
            ProcessId = Environment.ProcessId,
            CapturedAt = DateTimeOffset.UtcNow,
            ActualMountRecord = line,
            Captures = captures,
            ProcessBindingQualified = false,
            SwapThrashingClassified = false,
            GrowthAuthorized = false
        }));
        reader.Dispose();
        Assert.Throws<ObjectDisposedException>(() => reader.CaptureCounter(LinuxCgroupCounter.AnonymousBytes, scratch));
    }
}
