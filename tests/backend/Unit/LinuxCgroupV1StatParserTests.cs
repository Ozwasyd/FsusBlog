using System.Text;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LinuxCgroupV1StatParserTests
{
    private static readonly LinuxCgroupDirectoryIdentity s_identity = new(1, 11, 22, 0, 3);

    [Theory]
    [InlineData("cache", LinuxCgroupCounterUnit.Bytes)]
    [InlineData("rss", LinuxCgroupCounterUnit.Bytes)]
    [InlineData("rss_huge", LinuxCgroupCounterUnit.Bytes)]
    [InlineData("shmem", LinuxCgroupCounterUnit.Bytes)]
    [InlineData("mapped_file", LinuxCgroupCounterUnit.Bytes)]
    [InlineData("swap", LinuxCgroupCounterUnit.Bytes)]
    [InlineData("swapcached", LinuxCgroupCounterUnit.Bytes)]
    [InlineData("dirty", LinuxCgroupCounterUnit.Bytes)]
    [InlineData("writeback", LinuxCgroupCounterUnit.Bytes)]
    [InlineData("inactive_anon", LinuxCgroupCounterUnit.Bytes)]
    [InlineData("active_anon", LinuxCgroupCounterUnit.Bytes)]
    [InlineData("inactive_file", LinuxCgroupCounterUnit.Bytes)]
    [InlineData("active_file", LinuxCgroupCounterUnit.Bytes)]
    [InlineData("unevictable", LinuxCgroupCounterUnit.Bytes)]
    [InlineData("pgpgin", LinuxCgroupCounterUnit.Events)]
    [InlineData("pgpgout", LinuxCgroupCounterUnit.Events)]
    [InlineData("pgfault", LinuxCgroupCounterUnit.Events)]
    [InlineData("pgmajfault", LinuxCgroupCounterUnit.Events)]
    [InlineData("workingset_refault_anon", LinuxCgroupCounterUnit.Events)]
    [InlineData("workingset_refault_file", LinuxCgroupCounterUnit.Events)]
    public void NativeCountersKeepIndependentLocalAndTotalValuesAndUnits(string key, LinuxCgroupCounterUnit unit)
    {
        byte[] input = Encoding.ASCII.GetBytes($"total_{key} 13\nfuture_counter 23\n{key} 7\n");
        AssertCapture(input, key, LinuxCgroupV1StatScope.Local, unit, MemoryObservationState.Available, 7);
        AssertCapture(input, $"total_{key}", LinuxCgroupV1StatScope.HierarchicalTotal, unit,
            MemoryObservationState.Available, 13);
    }

    [Theory]
    [InlineData("hierarchical_memory_limit", 4096L)]
    [InlineData("hierarchical_memsw_limit", 8192L)]
    public void HierarchyLimitsRemainSeparateByteObservations(string key, long value)
    {
        byte[] input = "hierarchical_memsw_limit 8192\nhierarchical_memory_limit 4096\n"u8.ToArray();
        AssertCapture(input, key, LinuxCgroupV1StatScope.HierarchicalLimit, LinuxCgroupCounterUnit.Bytes,
            MemoryObservationState.Available, value);
    }

    [Fact]
    public void RssRetainsAnonymousAndSwapCacheMeaningWithoutV2AliasOrArithmetic()
    {
        byte[] input = "anon 1\nfile 2\nrss 3072\nswapcached 1024\nmapped_file 4096\ntotal_rss 9216\n"u8.ToArray();
        AssertCapture(input, "rss", LinuxCgroupV1StatScope.Local, LinuxCgroupCounterUnit.Bytes,
            MemoryObservationState.Available, 3072);
        AssertCapture(input, "total_rss", LinuxCgroupV1StatScope.HierarchicalTotal, LinuxCgroupCounterUnit.Bytes,
            MemoryObservationState.Available, 9216);
        AssertCapture("anon 3072\nfile 4096\n"u8.ToArray(), "rss", LinuxCgroupV1StatScope.Local,
            LinuxCgroupCounterUnit.Bytes, MemoryObservationState.Unknown, null);
    }

    [Theory]
    [InlineData("", "rss", LinuxCgroupV1StatScope.Local)]
    [InlineData(" \t\r\n\n", "rss", LinuxCgroupV1StatScope.Local)]
    [InlineData("total_rss 99\n", "rss", LinuxCgroupV1StatScope.Local)]
    [InlineData("rss 99\n", "total_rss", LinuxCgroupV1StatScope.HierarchicalTotal)]
    [InlineData("rss_huge 99\n", "rss", LinuxCgroupV1StatScope.Local)]
    [InlineData("swap 99\n", "swapcached", LinuxCgroupV1StatScope.Local)]
    public void MissingKeysStayUnknownWithoutScopeOrSiblingFallback(string input, string key, LinuxCgroupV1StatScope scope)
    {
        AssertCapture(Encoding.ASCII.GetBytes(input), key, scope, LinuxCgroupCounterUnit.Bytes,
            MemoryObservationState.Unknown, null);
    }

    [Theory]
    [InlineData("rss 0\n", 0L)]
    [InlineData(" \trss\t 0007 \t\r\n", 7L)]
    [InlineData("rss 9223372036854775807", long.MaxValue)]
    [InlineData("future_1 5\nfuture_1 6\nrss 7\n", 7L)]
    public void DecimalBoundariesWhitespaceAndFutureRowsRemainRaw(string input, long value)
    {
        AssertCapture(Encoding.ASCII.GetBytes(input), "rss", LinuxCgroupV1StatScope.Local,
            LinuxCgroupCounterUnit.Bytes, MemoryObservationState.Available, value);
    }

    [Theory]
    [InlineData("rss -1\n")]
    [InlineData("rss -0\n")]
    [InlineData("rss +1\n")]
    [InlineData("rss 9223372036854775808\n")]
    [InlineData("rss 18446744073709551615\n")]
    [InlineData("rss 1.0\n")]
    [InlineData("rss 0x10\n")]
    [InlineData("rss 1KiB\n")]
    [InlineData("rss 1 2\n")]
    [InlineData("rss 1\0\n")]
    [InlineData("rss\n")]
    [InlineData("rss \t\n")]
    [InlineData("rss=1\n")]
    [InlineData("rss\r 1\n")]
    [InlineData("rss 1\nfuture -1\n")]
    [InlineData("rss 1\nfuture 9223372036854775808\n")]
    [InlineData("rss 1\nfuture\n")]
    [InlineData("rss 1\nfuture! 2\n")]
    [InlineData("rss 1\n1future 2\n")]
    [InlineData("rss 1\nfuture 2 3\n")]
    public void InvalidRowsRefuseTheWholeInputWithoutPartialValues(string input)
    {
        AssertCapture(Encoding.ASCII.GetBytes(input), "rss", LinuxCgroupV1StatScope.Local,
            LinuxCgroupCounterUnit.Bytes, MemoryObservationState.Malformed, null);
    }

    [Theory]
    [InlineData("rss 1\nrss 1\n", "rss", LinuxCgroupV1StatScope.Local)]
    [InlineData("rss 1\n rss\t2\r\n", "rss", LinuxCgroupV1StatScope.Local)]
    [InlineData("total_rss 1\ntotal_rss 2\n", "total_rss", LinuxCgroupV1StatScope.HierarchicalTotal)]
    [InlineData("hierarchical_memory_limit 1\nhierarchical_memory_limit 2\n",
        "hierarchical_memory_limit", LinuxCgroupV1StatScope.HierarchicalLimit)]
    public void DuplicateTargetKeysAreRefusedEvenWhenValuesAgree(string input, string key, LinuxCgroupV1StatScope scope)
    {
        AssertCapture(Encoding.ASCII.GetBytes(input), key, scope, LinuxCgroupCounterUnit.Bytes,
            MemoryObservationState.Malformed, null);
    }

    [Fact]
    public void NonAsciiAndBomBytesCannotBecomeNativeKeysOrNumbers()
    {
        byte[][] inputs =
        [
            Encoding.UTF8.GetBytes("rss １\n"),
            Encoding.UTF8.GetBytes("rés 1\n"),
            [0xef, 0xbb, 0xbf, (byte)'r', (byte)'s', (byte)'s', (byte)' ', (byte)'1']
        ];
        foreach (byte[] input in inputs)
        {
            AssertCapture(input, "rss", LinuxCgroupV1StatScope.Local, LinuxCgroupCounterUnit.Bytes,
                MemoryObservationState.Malformed, null);
        }
    }

    [Fact]
    public void EntireInputIsBoundedEvenAfterFindingAValidTarget()
    {
        byte[] exact = new byte[LinuxCgroupV1StatParser.MaximumInputBytes];
        Array.Fill(exact, (byte)'\n');
        "rss 7\n"u8.CopyTo(exact);
        AssertCapture(exact, "rss", LinuxCgroupV1StatScope.Local, LinuxCgroupCounterUnit.Bytes,
            MemoryObservationState.Available, 7);
        byte[] oversized = new byte[exact.Length + 1];
        exact.CopyTo(oversized, 0);
        oversized[^1] = (byte)'\n';
        AssertCapture(oversized, "rss", LinuxCgroupV1StatScope.Local, LinuxCgroupCounterUnit.Bytes,
            MemoryObservationState.Malformed, null);
        AssertCapture(oversized, "swap", LinuxCgroupV1StatScope.Local, LinuxCgroupCounterUnit.Bytes,
            MemoryObservationState.Malformed, null);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(2)]
    [InlineData(99)]
    public void NonV1IdentitiesNeverReinterpretV1Fields(int version)
    {
        var identity = s_identity with
        {
            Version = version
        };
        var actual = LinuxCgroupV1StatParser.Parse("rss 1\n"u8, "rss", identity);
        Assert.Equal(MemoryObservationState.Unknown, actual.State);
        Assert.Null(actual.Value);
        Assert.Same(identity, actual.Identity);
        Assert.Equal(MemoryQualification.NotVerified, actual.Qualification);
    }

    [Theory]
    [InlineData("anon")]
    [InlineData("file")]
    [InlineData("total_total_rss")]
    [InlineData("total_hierarchical_memory_limit")]
    [InlineData("RSS")]
    [InlineData("rss ")]
    [InlineData("future_counter")]
    public void UnsupportedSelectorsCannotInventFieldSemantics(string key)
    {
        Assert.Throws<ArgumentException>(() => LinuxCgroupV1StatParser.Parse("rss 1\n"u8, key, s_identity));
    }

    [Fact]
    public void NullArgumentsAreRefusedAndResultsDoNotRetainCallerBytes()
    {
        Assert.Throws<ArgumentNullException>(() => LinuxCgroupV1StatParser.Parse("rss 1"u8, null!, s_identity));
        Assert.Throws<ArgumentException>(() => LinuxCgroupV1StatParser.Parse("rss 1"u8, "", s_identity));
        Assert.Throws<ArgumentNullException>(() => LinuxCgroupV1StatParser.Parse("rss 1"u8, "rss", null!));
        byte[] input = "rss 7\n"u8.ToArray();
        var actual = LinuxCgroupV1StatParser.Parse(input, "rss", s_identity);
        Array.Fill(input, (byte)0);
        Assert.Equal(7L, actual.Value);
        Assert.Equal(MemoryQualification.NotVerified, actual.Qualification);
    }

    private static void AssertCapture(byte[] input, string key, LinuxCgroupV1StatScope scope,
        LinuxCgroupCounterUnit unit, MemoryObservationState state, long? value)
    {
        byte[] original = (byte[])input.Clone();
        var actual = LinuxCgroupV1StatParser.Parse(input, key, s_identity);
        Assert.Equal(key, actual.Key);
        Assert.Equal(scope, actual.Scope);
        Assert.Equal(unit, actual.Unit);
        Assert.Equal(state, actual.State);
        Assert.Equal(value, actual.Value);
        Assert.Same(s_identity, actual.Identity);
        Assert.Equal(MemoryQualification.NotVerified, actual.Qualification);
        Assert.Equal(original, input);
    }
}
