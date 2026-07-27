using System.Buffers;

using FsusBlog.Core.Cache;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class UserLocalePreferenceCodecAndNormalizeTests
{
    [Theory]
    [InlineData("auto", null)]
    [InlineData("fixed", "ja-JP")]
    [InlineData("fixed", "zh-Hant")]
    [InlineData("fixed", "es-419")]
    public void PreferencePod_RoundTrip_PreservesCanonicalState(string mode, string? fixedLocale)
    {
        var original = new UserLocalePreferenceDto(
            mode,
            fixedLocale,
            7,
            new DateTime(2026, 7, 28, 12, 0, 0, DateTimeKind.Utc));
        var writer = new ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteUserLocalePreference(original, writer);

        Assert.True(PodBinaryCodec.TryDecodeUserLocalePreference(writer.WrittenMemory, out UserLocalePreferenceDto decoded));
        Assert.Equal(original.Mode, decoded.Mode);
        Assert.Equal(original.FixedLocale, decoded.FixedLocale);
        Assert.Equal(original.Revision, decoded.Revision);
        Assert.Equal(original.UpdatedAt, decoded.UpdatedAt);
    }

    [Theory]
    [InlineData("auto", null, 0)]
    [InlineData("fixed", "de-DE", 3)]
    public void UpdateRequestPod_RoundTrip_PreservesFields(string mode, string? fixedLocale, long expectedRevision)
    {
        var original = new UserLocalePreferenceUpdateDto(mode, fixedLocale, expectedRevision);
        var writer = new ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteUserLocalePreferenceUpdateRequest(original, writer);

        Assert.True(PodBinaryCodec.TryDecodeUserLocalePreferenceUpdateRequest(
            writer.WrittenMemory,
            out UserLocalePreferenceUpdateDto decoded));
        Assert.Equal(original.Mode, decoded.Mode);
        Assert.Equal(original.FixedLocale, decoded.FixedLocale);
        Assert.Equal(original.ExpectedRevision, decoded.ExpectedRevision);
    }

    [Fact]
    public void WriteFixedPreference_RejectsAliasLocale()
    {
        var writer = new ArrayBufferWriter<byte>();
        Assert.Throws<ArgumentException>(() =>
            PodBinaryCodec.WriteUserLocalePreference(
                new UserLocalePreferenceDto("fixed", "en", 1, DateTime.UtcNow),
                writer));
    }

    [Fact]
    public async Task UpdateAsync_RejectsInvalidModeAndEleventhLocaleWithoutPersistence()
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        var service = new UserLocalePreferenceService(db, NullLogger<UserLocalePreferenceService>.Instance);

        UserLocalePreferenceUpdateResult invalidMode = await service.UpdateAsync(
            accountId: 9,
            new UserLocalePreferenceUpdateDto("follow-browser", null, 0));
        Assert.Equal(UserLocalePreferenceUpdateOutcome.InvalidMode, invalidMode.Outcome);

        UserLocalePreferenceUpdateResult invalidLocale = await service.UpdateAsync(
            accountId: 9,
            new UserLocalePreferenceUpdateDto("fixed", "xx-YY", 0));
        Assert.Equal(UserLocalePreferenceUpdateOutcome.InvalidLocale, invalidLocale.Outcome);

        UserLocalePreferenceUpdateResult autoWithLocale = await service.UpdateAsync(
            accountId: 9,
            new UserLocalePreferenceUpdateDto("auto", "ja-JP", 0));
        Assert.Equal(UserLocalePreferenceUpdateOutcome.InvalidLocale, autoWithLocale.Outcome);

        UserLocalePreferenceUpdateResult fixedAlias = await service.UpdateAsync(
            accountId: 9,
            new UserLocalePreferenceUpdateDto("fixed", "en", 0));
        Assert.Equal(UserLocalePreferenceUpdateOutcome.InvalidLocale, fixedAlias.Outcome);

        // Normalization rejects before any transaction work.
        Assert.Null(invalidMode.Preference);
        Assert.Null(invalidLocale.Preference);
        Assert.Null(autoWithLocale.Preference);
        Assert.Null(fixedAlias.Preference);
        _ = db;
    }

    [Fact]
    public void LocalePreferenceModes_AreStableContractTokens()
    {
        Assert.Equal("auto", LocalePreferenceModes.Auto);
        Assert.Equal("fixed", LocalePreferenceModes.Fixed);
    }
}
