using System.Buffers.Binary;

using FsusBlog.Core.Cache;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

public sealed class FontThemeAdminPodBinaryCodecTests
{
    private static readonly DateTimeOffset s_installedAt = new(2026, 9, 1, 12, 30, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset s_updatedAt = new(2026, 9, 2, 13, 45, 1, TimeSpan.Zero);

    [Fact]
    public void FontRegistryList_RoundTrip_PreservesClosedRecord()
    {
        var expected = new FontRegistryListResponse([FontSummary()]);

        Assert.True(PodBinaryCodec.TryDecodeFontRegistryList(PodBinaryCodec.EncodeFontRegistryList(expected), out var actual));

        Assert.Equal(expected.Items, actual.Items);
    }

    [Fact]
    public void FontRegistryDetail_RoundTrip_PreservesFacesAndNullableUnicodeRange()
    {
        var font = FontSummary(faceCount: 2, criticalFaceCount: 1, totalSizeBytes: 30);
        var expected = new FontRegistryDetailResponse(
            font,
            "OFL",
            "{\"source\":\"bundled\"}",
            "{\"id\":\"font-a\"}",
            [
                new FontFaceResponse(400, "normal", "regular.woff2", "sha256:a", 10, null, true, "swap"),
                new FontFaceResponse(700, "italic", "bold.woff2", "sha256:b", 20, "U+4E00-9FFF", false, "optional")
            ]);

        Assert.True(PodBinaryCodec.TryDecodeFontRegistryDetail(PodBinaryCodec.EncodeFontRegistryDetail(expected), out var actual));

        Assert.NotNull(actual);
        Assert.Equal(expected.Font, actual.Font);
        Assert.Equal(expected.LicenseText, actual.LicenseText);
        Assert.Equal(expected.LicenseSourceJson, actual.LicenseSourceJson);
        Assert.Equal(expected.ManifestJson, actual.ManifestJson);
        Assert.Equal(expected.Faces, actual.Faces);
    }

    [Fact]
    public void FontActivationList_RoundTrip_PreservesRecord()
    {
        var expected = new FontActivationListResponse([
            new FontActivationResponse("admin", "font-a", "font-a", "font-code", "font-cjk", "font-emoji", 7, s_updatedAt)
        ]);

        Assert.True(PodBinaryCodec.TryDecodeFontActivationList(PodBinaryCodec.EncodeFontActivationList(expected), out var actual));

        Assert.Equal(expected.Items, actual.Items);
    }

    [Fact]
    public void ThemeRegistryList_RoundTrip_PreservesClosedEnum()
    {
        var expected = new ThemeRegistryListResponse([ThemeSummary()]);

        Assert.True(PodBinaryCodec.TryDecodeThemeRegistryList(PodBinaryCodec.EncodeThemeRegistryList(expected), out var actual));

        Assert.Equal(expected.Items, actual.Items);
    }

    [Fact]
    public void ThemeRegistryDetail_RoundTrip_PreservesModesFlagsAndBudgets()
    {
        var expected = new ThemeRegistryDetailResponse(
            ThemeSummary(),
            "{\"id\":\"theme-a\"}",
            "{\"type\":\"object\"}",
            ["light", "dark"],
            new ThemeSupportResponse(true, true, false, true, false, true),
            new ThemeBudgetResponse(100, 200, 300, 4, 5, 600, 700),
            new ThemePermissionResponse(false, true, false));

        Assert.True(PodBinaryCodec.TryDecodeThemeRegistryDetail(PodBinaryCodec.EncodeThemeRegistryDetail(expected), out var actual));

        Assert.NotNull(actual);
        Assert.Equal(expected.Theme, actual.Theme);
        Assert.Equal(expected.ManifestJson, actual.ManifestJson);
        Assert.Equal(expected.ConfigSchemaJson, actual.ConfigSchemaJson);
        Assert.Equal(expected.Modes, actual.Modes);
        Assert.Equal(expected.Supports, actual.Supports);
        Assert.Equal(expected.Budgets, actual.Budgets);
        Assert.Equal(expected.Permissions, actual.Permissions);
    }

    [Fact]
    public void ThemeActivationListAndSingleton_RoundTrip_PreserveNullableFields()
    {
        var populated = new ThemeActivationResponse(
            "public",
            "theme-a",
            "dark",
            Guid.Parse("01234567-89ab-cdef-0123-456789abcdef"),
            "asset-v1",
            9,
            s_updatedAt);
        var missing = new ThemeActivationResponse("admin", null, null, null, null, null, null);

        Assert.True(PodBinaryCodec.TryDecodeThemeActivationList(
            PodBinaryCodec.EncodeThemeActivationList(new ThemeActivationListResponse([populated, missing])),
            out var list));
        Assert.Equal([populated, missing], list.Items);

        Assert.True(PodBinaryCodec.TryDecodeThemeActivation(PodBinaryCodec.EncodeThemeActivation(missing), out var singleton));
        Assert.Equal(missing, singleton);
    }

    [Fact]
    public void ThemeActivationHistory_RoundTrip_PreservesClosedStatusAndNullableFields()
    {
        var item = new ThemeActivationHistoryItemResponse(
            Guid.Parse("fedcba98-7654-3210-fedc-ba9876543210"),
            "public",
            "theme-a",
            null,
            "asset-v2",
            null,
            11,
            null,
            "dark",
            null,
            "Applied",
            null,
            s_installedAt,
            s_updatedAt,
            "admin@example.test");
        var expected = new ThemeActivationHistoryResponse([item]);

        Assert.True(PodBinaryCodec.TryDecodeThemeActivationHistory(PodBinaryCodec.EncodeThemeActivationHistory(expected), out var actual));

        Assert.Equal(expected.Items, actual.Items);
    }

    [Fact]
    public void FontRegistryList_RejectsNonCanonicalEnvelopeEnumUtf8AndSlice()
    {
        byte[] encoded = PodBinaryCodec.EncodeFontRegistryList(new FontRegistryListResponse([FontSummary()]));

        byte[] reserved = [.. encoded];
        reserved[12] = 1;
        Assert.False(PodBinaryCodec.TryDecodeFontRegistryList(reserved, out _));

        byte[] invalidEnum = [.. encoded];
        invalidEnum[16 + 34] = 99;
        Assert.False(PodBinaryCodec.TryDecodeFontRegistryList(invalidEnum, out _));

        byte[] nonCanonicalSlice = [.. encoded];
        BinaryPrimitives.WriteInt32LittleEndian(nonCanonicalSlice.AsSpan(16 + 36, sizeof(int)), 1);
        Assert.False(PodBinaryCodec.TryDecodeFontRegistryList(nonCanonicalSlice, out _));

        byte[] invalidUtf8 = [.. encoded];
        invalidUtf8[16 + 76 + sizeof(int)] = 0xff;
        Assert.False(PodBinaryCodec.TryDecodeFontRegistryList(invalidUtf8, out _));
    }

    [Fact]
    public void ThemeActivation_RejectsNonzeroAbsentSliceAndTrailingBytes()
    {
        byte[] encoded = PodBinaryCodec.EncodeThemeActivation(
            new ThemeActivationResponse("public", null, null, null, null, null, null));

        byte[] absentSlice = [.. encoded];
        BinaryPrimitives.WriteInt32LittleEndian(absentSlice.AsSpan(16 + 32, sizeof(int)), 1);
        Assert.False(PodBinaryCodec.TryDecodeThemeActivation(absentSlice, out _));

        byte[] trailing = [.. encoded, 0];
        Assert.False(PodBinaryCodec.TryDecodeThemeActivation(trailing, out _));
    }

    [Fact]
    public void Writers_RejectUnknownEnumsAndOverlongText()
    {
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeFontRegistryList(
            new FontRegistryListResponse([FontSummary() with { InstallState = "unknown" }])));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeThemeActivationHistory(
            new ThemeActivationHistoryResponse([
                new ThemeActivationHistoryItemResponse(
                    Guid.NewGuid(), "public", null, null, null, null, null, null, null, null,
                    "Unknown", null, s_installedAt, s_updatedAt, "admin")
            ])));
        Assert.Throws<ArgumentOutOfRangeException>(() => PodBinaryCodec.EncodeFontRegistryList(
            new FontRegistryListResponse([FontSummary() with { FontId = new string('x', 257) }])));
    }

    [Fact]
    public void Int64Values_RoundTrip_PreserveFullSignedWidth()
    {
        var font = new FontRegistryListResponse([FontSummary(totalSizeBytes: long.MaxValue)]);
        Assert.True(PodBinaryCodec.TryDecodeFontRegistryList(PodBinaryCodec.EncodeFontRegistryList(font), out var fontResult));
        Assert.Equal(long.MaxValue, Assert.Single(fontResult.Items).TotalSizeBytes);

        var activation = new ThemeActivationResponse("public", null, null, null, null, long.MaxValue, s_updatedAt);
        Assert.True(PodBinaryCodec.TryDecodeThemeActivation(PodBinaryCodec.EncodeThemeActivation(activation), out var actual));
        Assert.Equal(activation, actual);
    }

    [Theory]
    [InlineData("count")]
    [InlineData("version")]
    [InlineData("timestamp")]
    [InlineData("boolean")]
    [InlineData("negative_length")]
    [InlineData("truncated")]
    [InlineData("trailing")]
    public void FontRegistryList_RejectsMalformedWire(string mutation)
    {
        byte[] encoded = PodBinaryCodec.EncodeFontRegistryList(new FontRegistryListResponse([FontSummary()]));
        if (mutation == "count")
        {
            BinaryPrimitives.WriteInt32LittleEndian(encoded.AsSpan(4, 4), int.MaxValue);
        }
        if (mutation == "version")
        {
            BinaryPrimitives.WriteInt32LittleEndian(encoded.AsSpan(0, 4), 2);
        }
        if (mutation == "timestamp")
        {
            BinaryPrimitives.WriteInt64LittleEndian(encoded.AsSpan(16, 8), 253402300800000);
        }
        if (mutation == "boolean")
        {
            encoded[16 + 32] = 2;
        }
        if (mutation == "negative_length")
        {
            BinaryPrimitives.WriteInt32LittleEndian(encoded.AsSpan(16 + 40, 4), -1);
        }
        if (mutation == "truncated")
        {
            encoded = encoded[..^1];
        }
        if (mutation == "trailing")
        {
            encoded = [.. encoded, 0];
        }
        Assert.False(PodBinaryCodec.TryDecodeFontRegistryList(encoded, out _));
    }

    [Fact]
    public void FontFace_RejectsZeroWeightAndWritersRejectMissingCollections()
    {
        var detail = new FontRegistryDetailResponse(FontSummary(), "", "", "",
            [new FontFaceResponse(400, "normal", "regular.woff2", "hash", 10, null, true, "swap")]);
        byte[] encoded = PodBinaryCodec.EncodeFontRegistryDetail(detail);
        BinaryPrimitives.WriteInt32LittleEndian(encoded.AsSpan(16 + 100 + 8, 4), 0);
        Assert.False(PodBinaryCodec.TryDecodeFontRegistryDetail(encoded, out _));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeFontRegistryList(new FontRegistryListResponse(null!)));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeFontRegistryDetail(detail with { Faces = null! }));
    }

    [Fact]
    public void ThemeActivation_RejectsNonCanonicalGuidAndAbsentScalar()
    {
        var activation = new ThemeActivationResponse("public", null, null,
            Guid.Parse("01234567-89ab-cdef-0123-456789abcdef"), null, null, null);
        byte[] encoded = PodBinaryCodec.EncodeThemeActivation(activation);
        int offset = BinaryPrimitives.ReadInt32LittleEndian(encoded.AsSpan(16 + 48, 4));
        encoded[16 + 64 + 4 + offset + 10] = (byte)'A';
        Assert.False(PodBinaryCodec.TryDecodeThemeActivation(encoded, out _));

        byte[] missing = PodBinaryCodec.EncodeThemeActivation(new ThemeActivationResponse("public", null, null, null, null, null, null));
        BinaryPrimitives.WriteInt64LittleEndian(missing.AsSpan(16, 8), 1);
        Assert.False(PodBinaryCodec.TryDecodeThemeActivation(missing, out _));
    }

    private static FontRegistryItemResponse FontSummary(
        int faceCount = 1,
        int criticalFaceCount = 1,
        long totalSizeBytes = 10)
        => new(
            "font-a",
            "Font A",
            "Font Family",
            "sans-serif",
            "1.0.0",
            "installed",
            true,
            false,
            faceCount,
            criticalFaceCount,
            totalSizeBytes,
            s_installedAt,
            s_updatedAt);

    private static ThemeRegistryItemResponse ThemeSummary()
        => new(
            "theme-a",
            "Theme A",
            "1.0.0",
            "FsusBlog",
            "Theme description",
            "visual",
            "Enabled",
            true,
            "sha256:theme",
            "/themes/theme-a",
            s_installedAt,
            s_updatedAt);
}
