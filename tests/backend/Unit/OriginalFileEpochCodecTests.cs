using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.IO;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Pure comparison-data conformance, never native FD or parent authority acceptance.</summary>
public sealed class OriginalFileEpochCodecTests
{
    [Fact]
    public void Codec_MatchesExactSharedCrossRuntimeVectorsWithoutIntegerPrecisionLoss()
    {
        byte[] fixture = File.ReadAllBytes(BackendTestPaths.FromRoot(
            "tests", "tools", "fixtures", "original-native-file-epoch-v1.json"));
        Assert.Equal("e3bba6076f3530da2aaf82c11faf145f70a219a91407463e8e447b581ae65464",
            Convert.ToHexStringLower(SHA256.HashData(fixture)));
        using JsonDocument document = JsonDocument.Parse(fixture);
        foreach (JsonElement vector in document.RootElement.EnumerateArray())
        {
            string[] fields = vector.GetProperty("leaf").EnumerateArray().Select(item => item.GetString()!).ToArray();
            OriginalFileEpochData leaf = new(
                U32(fields[0]), U32(fields[1]), U64(fields[2]), U16(fields[3]), U32(fields[4]),
                U32(fields[5]), U32(fields[6]), U64(fields[7]), I64(fields[8]), U32(fields[9]),
                I64(fields[10]), U32(fields[11]));
            OriginalDirectoryEpochData[] directories = vector.GetProperty("ancestors").EnumerateArray()
                .Select(item => item.EnumerateArray().Select(field => field.GetString()!).ToArray())
                .Select(directoryFields => new OriginalDirectoryEpochData(
                    U32(directoryFields[0]), U32(directoryFields[1]), U64(directoryFields[2]), U16(directoryFields[3])))
                .ToArray();
            string path = vector.GetProperty("path").GetString()!;
            byte[] actual = OriginalFileEpochCodec.Encode(path, leaf, directories);
            Assert.Equal(Encoding.UTF8.GetBytes(vector.GetProperty("canonical").GetString()!), actual);
            Assert.Equal(vector.GetProperty("sha256").GetString(), OriginalFileEpochCodec.Hash(path, leaf, directories));
            Assert.NotEqual(OriginalFileEpochCodec.Hash(path, leaf, directories),
                OriginalFileEpochCodec.Hash(path, leaf with { Links = 2 }, directories));
            Assert.NotEqual(OriginalFileEpochCodec.Hash(path, leaf, directories),
                OriginalFileEpochCodec.Hash(path, leaf, directories.Reverse().ToArray()));
        }
    }

    [Fact]
    public void Codec_RejectsAmbiguousPathInvalidNanosecondsAndMissingAncestors()
    {
        OriginalFileEpochData leaf = new(8, 0, 1, 33152, 1, 1000, 1000, 1, -1, 999999999, 0, 0);
        OriginalDirectoryEpochData[] directories = [new(8, 0, 1, 16877)];
        Assert.Throws<InvalidOperationException>(() => OriginalFileEpochCodec.Encode("/file\nleaf:forged", leaf, directories));
        Assert.Throws<InvalidOperationException>(() => OriginalFileEpochCodec.Encode("/file", leaf with { ModifiedNanoseconds = 1000000000 }, directories));
        Assert.Throws<InvalidOperationException>(() => OriginalFileEpochCodec.Encode("/file", leaf, []));
    }

    [Theory]
    [InlineData("relative.env")]
    [InlineData("/owned/../file.env")]
    [InlineData("/owned/./file.env")]
    [InlineData("/owned//file.env")]
    [InlineData("/owned/file.env/")]
    [InlineData("/")]
    public void Codec_RejectsNonCanonicalLinuxPaths(string path)
    {
        OriginalFileEpochData leaf = new(8, 0, 1, 33152, 1, 1000, 1000, 1, 0, 0, 0, 0);
        OriginalDirectoryEpochData[] directories = Enumerable.Repeat(
            new OriginalDirectoryEpochData(8, 0, 1, 16877), path.Split('/', StringSplitOptions.RemoveEmptyEntries).Length).ToArray();
        Assert.Throws<InvalidOperationException>(() => OriginalFileEpochCodec.Encode(path, leaf, directories));
    }

    [Fact]
    public void Codec_RejectsUnpairedSurrogatesAndByteExcessButPreservesValidEmoji()
    {
        OriginalFileEpochData leaf = new(8, 0, 1, 33152, 1, 1000, 1000, 1, 0, 0, 0, 0);
        OriginalDirectoryEpochData[] directories = [new(8, 0, 1, 16877)];
        Assert.Throws<InvalidOperationException>(() => OriginalFileEpochCodec.Encode("/file-" + (char)0xd800, leaf, directories));
        Assert.Throws<InvalidOperationException>(() => OriginalFileEpochCodec.Encode("/file-" + (char)0xdc00, leaf, directories));
        Assert.Throws<InvalidOperationException>(() => OriginalFileEpochCodec.Encode("/" + new string('é', 2048), leaf, directories));
        string encoded = Encoding.UTF8.GetString(OriginalFileEpochCodec.Encode("/file-😀.env", leaf, directories));
        Assert.Contains("\npath:14:/file-😀.env\n", encoded, StringComparison.Ordinal);
        Assert.EndsWith("\n", encoded, StringComparison.Ordinal);
    }

    private static uint U32(string value) => uint.Parse(value, CultureInfo.InvariantCulture);
    private static ushort U16(string value) => ushort.Parse(value, CultureInfo.InvariantCulture);
    private static ulong U64(string value) => ulong.Parse(value, CultureInfo.InvariantCulture);
    private static long I64(string value) => long.Parse(value, CultureInfo.InvariantCulture);
}
