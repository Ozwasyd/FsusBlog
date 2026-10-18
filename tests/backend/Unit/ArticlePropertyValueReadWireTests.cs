using System.Text.Json;

using FsusBlog.Core.Cache;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "GoldenContract")]
public sealed class ArticlePropertyValueReadWireTests
{
    public static IEnumerable<object[]> WireCases()
    {
        using JsonDocument golden = JsonDocument.Parse(BackendTestPaths.ReadAllTextFromRoot(
            "tests/fixtures/protocol/article-property-value-read-wire-golden.json"));
        return golden.RootElement.GetProperty("cases").EnumerateArray()
            .Select(row => new object[]
            {
                row.GetProperty("name").GetString()!,
                row.GetProperty("payloadHex").GetString()!,
                row.GetProperty("valid").GetBoolean()
            }).ToArray();
    }

    [Theory]
    [MemberData(nameof(WireCases))]
    public void CrossStackGolden_UsesActualTypedCodecAndExactBytes(string name, string payloadHex, bool expectedValid)
    {
        byte[] bytes = Convert.FromHexString(payloadHex);
        bool valid = PodBinaryCodec.TryDecodeArticlePropertyValueReadResponse(bytes, out ArticlePropertyValueReadResponse value);
        Assert.True(valid == expectedValid, name);
        if (valid)
        {
            Assert.Equal(bytes, PodBinaryCodec.EncodeArticlePropertyValueReadResponse(value));
        }
    }

    public static IEnumerable<object[]> MutationWireCases()
    {
        using JsonDocument golden = JsonDocument.Parse(BackendTestPaths.ReadAllTextFromRoot(
            "tests/fixtures/protocol/article-property-mutation-wire-golden.json"));
        return golden.RootElement.GetProperty("cases").EnumerateArray().Select(row => new object[]
        {
            row.GetProperty("record").GetString()!, row.GetProperty("name").GetString()!,
            row.GetProperty("payloadHex").GetString()!, row.GetProperty("valid").GetBoolean()
        }).ToArray();
    }

    [Theory]
    [MemberData(nameof(MutationWireCases))]
    public void MutationGolden_ExecutesCanonicalCodecAndExactBytes(string record, string name, string payloadHex, bool expectedValid)
    {
        byte[] bytes = Convert.FromHexString(payloadHex);
        var decoder = typeof(PodBinaryCodec).GetMethod("TryDecode" + record)!;
        object?[] arguments = [new ReadOnlyMemory<byte>(bytes), null];
        bool valid = (bool)decoder.Invoke(null, arguments)!;
        Assert.True(valid == expectedValid, name);
        if (valid)
        {
            Assert.Equal(bytes, (byte[])typeof(PodBinaryCodec).GetMethod("Encode" + record)!.Invoke(null, [arguments[1]])!);
            for (int length = 0; length < bytes.Length; length++)
            {
                Assert.False((bool)decoder.Invoke(null, [new ReadOnlyMemory<byte>(bytes, 0, length), null])!, name);
            }
        }
    }

    [Fact]
    public void ExactDecimalAndUtcTicks_SurviveBeyondJavaScriptNumberPrecision()
    {
        ArticlePropertyValueReadResponse number = ReadWitness("typed-1");
        var value = Assert.IsType<ArticlePropertyNumberValue>(Assert.Single(number.Current!.Snapshot.Values).Value);
        Assert.Equal(new[] { -1, -1, -1, unchecked((int)0x801c0000) }, decimal.GetBits(value.Number));
        ArticlePropertyValueReadResponse date = ReadWitness("typed-3");
        var utc = Assert.IsType<ArticlePropertyDateValue>(Assert.Single(date.Current!.Snapshot.Values).Value);
        Assert.Equal(638954208000000001L, utc.Utc.Ticks);
        Assert.Equal(DateTimeKind.Utc, utc.Utc.Kind);
        Assert.Equal(9007199254740993L, date.CurrentArticleRevisionId);
    }

    [Fact]
    public void Decoder_RefusesEverySmallWitnessTruncationAndOversizedRoot()
    {
        byte[] bytes = PodBinaryCodec.EncodeArticlePropertyValueReadResponse(ReadWitness("current-1"));
        for (int end = 0; end < bytes.Length; end++)
        {
            Assert.False(PodBinaryCodec.TryDecodeArticlePropertyValueReadResponse(bytes.AsMemory(0, end), out _));
        }
        Assert.False(PodBinaryCodec.TryDecodeArticlePropertyValueReadResponse(
            new byte[ArticlePropertyValueReadWireContract.MaxPayloadBytes + 1], out _));
    }

    [Fact]
    public void Encoder_RefusesUndefinedStatusAndAmbiguousPresence()
    {
        ArticlePropertyValueReadResponse current = ReadWitness("current-1");
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeArticlePropertyValueReadResponse(current with
        {
            Reconciliation = [new ArticlePropertyValueReconciliationRead(Guid.NewGuid(), byte.MaxValue, "invalid")]
        }));
        ArticlePropertyValueEntry entry = Assert.Single(current.Current!.Snapshot.Values);
        var snapshot = new ArticlePropertyValueSnapshot(1, current.Current.Snapshot.Coordinates,
            [entry with { Presence = ArticlePropertyValuePresence.Null }], current.Current.Snapshot.ContentDigest);
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeArticlePropertyValueReadResponse(current with
        {
            Current = current.Current with
            {
                Snapshot = snapshot
            }
        }));
    }

    [Fact]
    public void EmptyScopeAndEveryFact_AreBoundWithoutActorOrHostFallback()
    {
        ArticlePropertyValueReadResponse empty = ReadWitness("current-0");
        Assert.Null(empty.Current);
        Assert.Empty(empty.Definitions);
        Assert.Equal(42L, empty.Scope.DefinitionOwnerUserId);
        Assert.Equal("primary-site", empty.Scope.SiteScope);
        Assert.Equal(ArticlePropertyDefinitionContract.SchemaVersion, empty.Scope.DefinitionSchemaVersion);
        Assert.Null(ReadWitness("empty-site-owner").Scope.DefinitionOwnerUserId);
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeArticlePropertyValueReadResponse(empty with
        {
            Scope = empty.Scope with
            {
                SiteScope = ""
            }
        }));
        ArticlePropertyValueReadResponse current = ReadWitness("current-8");
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeArticlePropertyValueReadResponse(current with
        {
            Scope = current.Scope with
            {
                DefinitionOwnerUserId = null
            }
        }));
        var definitions = current.Definitions.ToArray();
        definitions[^1] = definitions[^1] with
        {
            SiteScope = "secondary-site"
        };
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeArticlePropertyValueReadResponse(current with
        {
            Definitions = definitions
        }));
    }

    private static ArticlePropertyValueReadResponse ReadWitness(string name)
    {
        using JsonDocument golden = JsonDocument.Parse(BackendTestPaths.ReadAllTextFromRoot(
            "tests/fixtures/protocol/article-property-value-read-wire-golden.json"));
        JsonElement row = golden.RootElement.GetProperty("cases").EnumerateArray()
            .Single(item => item.GetProperty("name").GetString() == name);
        Assert.True(PodBinaryCodec.TryDecodeArticlePropertyValueReadResponse(
            Convert.FromHexString(row.GetProperty("payloadHex").GetString()!), out ArticlePropertyValueReadResponse value));
        return value;
    }
}
