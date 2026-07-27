using System.Buffers;
using System.Runtime.InteropServices;

using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Shared.Contracts.Localization;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    public static void WriteUserLocalePreference(
        UserLocalePreferenceDto preference,
        IBufferWriter<byte> destination)
    {
        bool fixedMode = string.Equals(preference.Mode, "fixed", StringComparison.Ordinal);
        LocaleDescriptor? locale = null;
        if (fixedMode
            && (!LocaleCatalog.TryParse(preference.FixedLocale, out locale)
                || !string.Equals(preference.FixedLocale, locale.Code, StringComparison.Ordinal)))
        {
            throw new ArgumentException("fixed locale preference must use a canonical enabled locale", nameof(preference));
        }

        var mutable = new MutableUserLocalePreferencePod
        {
            Revision = preference.Revision,
            UpdatedAtUnixMs = PodTimeCodec.ToUnixMs(preference.UpdatedAt),
            Mode = fixedMode ? (byte)2 : (byte)1,
            HasFixedLocale = fixedMode ? (byte)1 : (byte)0,
            FixedLocale = fixedMode ? (byte)locale!.Locale : (byte)0,
            Reserved0 = 0,
            Reserved1 = 0
        };
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastLocalePod<MutableUserLocalePreferencePod, UserLocalePreferencePod>(mutable));
    }

    public static bool TryDecodeUserLocalePreference(
        ReadOnlyMemory<byte> source,
        out UserLocalePreferenceDto preference)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out UserLocalePreferencePod pod)
            || !TryReadFields(
                pod.Mode,
                pod.HasFixedLocale,
                pod.FixedLocale,
                pod.Reserved0,
                pod.Reserved1,
                out string mode,
                out string? fixedLocale))
        {
            preference = default;
            return false;
        }

        preference = new UserLocalePreferenceDto(
            mode,
            fixedLocale,
            pod.Revision,
            PodTimeCodec.FromUnixMs(pod.UpdatedAtUnixMs));
        return reader.IsConsumed;
    }

    public static void WriteUserLocalePreferenceUpdateRequest(
        UserLocalePreferenceUpdateDto request,
        IBufferWriter<byte> destination)
    {
        bool fixedMode = string.Equals(request.Mode, "fixed", StringComparison.Ordinal);
        LocaleDescriptor? locale = null;
        if (fixedMode
            && (!LocaleCatalog.TryParse(request.FixedLocale, out locale)
                || !string.Equals(request.FixedLocale, locale.Code, StringComparison.Ordinal)))
        {
            throw new ArgumentException("fixed locale preference must use a canonical enabled locale", nameof(request));
        }

        var mutable = new MutableUserLocalePreferenceUpdateRequestPod
        {
            ExpectedRevision = request.ExpectedRevision,
            Mode = fixedMode ? (byte)2 : (byte)1,
            HasFixedLocale = fixedMode ? (byte)1 : (byte)0,
            FixedLocale = fixedMode ? (byte)locale!.Locale : (byte)0,
            Reserved0 = 0,
            Reserved1 = 0
        };
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastLocalePod<MutableUserLocalePreferenceUpdateRequestPod, UserLocalePreferenceUpdateRequestPod>(mutable));
    }

    public static bool TryDecodeUserLocalePreferenceUpdateRequest(
        ReadOnlyMemory<byte> source,
        out UserLocalePreferenceUpdateDto request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out UserLocalePreferenceUpdateRequestPod pod)
            || !TryReadFields(
                pod.Mode,
                pod.HasFixedLocale,
                pod.FixedLocale,
                pod.Reserved0,
                pod.Reserved1,
                out string mode,
                out string? fixedLocale))
        {
            request = default;
            return false;
        }

        request = new UserLocalePreferenceUpdateDto(mode, fixedLocale, pod.ExpectedRevision);
        return reader.IsConsumed;
    }

    private static bool TryReadFields(
        byte modeValue,
        byte hasFixedLocale,
        byte localeValue,
        byte reserved0,
        uint reserved1,
        out string mode,
        out string? fixedLocale)
    {
        mode = string.Empty;
        fixedLocale = null;
        if (reserved0 != 0 || reserved1 != 0 || hasFixedLocale > 1)
        {
            return false;
        }

        if (modeValue == 1 && hasFixedLocale == 0 && localeValue == 0)
        {
            mode = "auto";
            return true;
        }

        LocaleDescriptor? descriptor = LocaleCatalog.Enabled.FirstOrDefault(
            candidate => (byte)candidate.Locale == localeValue);
        if (modeValue != 2 || hasFixedLocale != 1 || descriptor is null)
        {
            return false;
        }

        mode = "fixed";
        fixedLocale = descriptor.Code;
        return true;
    }

    private static TTo CastLocalePod<TFrom, TTo>(TFrom source)
        where TFrom : unmanaged
        where TTo : unmanaged
    {
        ReadOnlySpan<TFrom> from = MemoryMarshal.CreateReadOnlySpan(ref source, 1);
        return MemoryMarshal.Cast<byte, TTo>(MemoryMarshal.AsBytes(from))[0];
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableUserLocalePreferencePod
    {
        public long Revision;
        public long UpdatedAtUnixMs;
        public byte Mode;
        public byte HasFixedLocale;
        public byte FixedLocale;
        public byte Reserved0;
        public uint Reserved1;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableUserLocalePreferenceUpdateRequestPod
    {
        public long ExpectedRevision;
        public byte Mode;
        public byte HasFixedLocale;
        public byte FixedLocale;
        public byte Reserved0;
        public uint Reserved1;
    }
}
