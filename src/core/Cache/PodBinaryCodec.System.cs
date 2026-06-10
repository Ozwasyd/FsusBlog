using System.Buffers;
using System.Runtime.InteropServices;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    public static void WriteSeoConfig(SeoConfigPublicDto dto, IBufferWriter<byte> destination)
    {
        SeoConfigPod pod = CreateSeoConfigPod(dto, out ReadOnlyMemory<byte> payload);
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(pod);
        writer.WriteBytes(payload.Span);
    }

    public static byte[] EncodeSeoConfig(SeoConfigPublicDto dto)
        => EncodeToArray(1024, writer => WriteSeoConfig(dto, writer));

    public static bool TryDecodeSeoConfig(ReadOnlyMemory<byte> bytes, out SeoConfigPublicDto dto)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out SeoConfigPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            dto = new SeoConfigPublicDto();
            return false;
        }

        dto = new SeoConfigPublicDto
        {
            Title = PodUtf8Codec.FromFixed256(pod.Title),
            Description = PodProjector.ReadSlice(pod.Description, payload),
            Keywords = PodUtf8Codec.FromFixed256(pod.Keywords),
            Author = PodUtf8Codec.FromFixed64(pod.Author),
            OgImage = PodUtf8Codec.FromFixed256(pod.OgImage),
            BaseUrl = PodUtf8Codec.FromFixed256(pod.BaseUrl)
        };
        return reader.IsConsumed;
    }

    public static void WritePageContent(PageContentPublicDto dto, IBufferWriter<byte> destination)
    {
        PageContentPod pod = CreatePageContentPod(dto, out ReadOnlyMemory<byte> payload);
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(pod);
        writer.WriteBytes(payload.Span);
    }

    public static byte[] EncodePageContent(PageContentPublicDto dto)
        => EncodeToArray(512 + (dto.Content?.Length ?? 0), writer => WritePageContent(dto, writer));

    public static bool TryDecodePageContent(ReadOnlyMemory<byte> bytes, out PageContentPublicDto dto)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out PageContentPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            dto = new PageContentPublicDto();
            return false;
        }

        dto = new PageContentPublicDto
        {
            Slug = PodUtf8Codec.FromFixed128(pod.Slug),
            Content = PodProjector.ReadSlice(pod.Content, payload)
        };
        return reader.IsConsumed;
    }

    public static void WriteSiteComplianceConfig(SiteComplianceConfigPublicDto dto, IBufferWriter<byte> destination)
    {
        SiteComplianceConfigPod pod = CreateSiteComplianceConfigPod(dto, out ReadOnlyMemory<byte> payload);
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(pod);
        writer.WriteBytes(payload.Span);
    }

    public static byte[] EncodeSiteComplianceConfig(SiteComplianceConfigPublicDto dto)
        => EncodeToArray(1536 + (dto.CopyrightText?.Length ?? 0), writer => WriteSiteComplianceConfig(dto, writer));

    public static bool TryDecodeSiteComplianceConfig(ReadOnlyMemory<byte> bytes, out SiteComplianceConfigPublicDto dto)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out SiteComplianceConfigPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            dto = new SiteComplianceConfigPublicDto();
            return false;
        }

        dto = new SiteComplianceConfigPublicDto
        {
            Enabled = pod.Enabled != 0,
            RegionMode = PodUtf8Codec.FromFixed32(pod.RegionMode),
            CopyrightOwner = PodUtf8Codec.FromFixed128(pod.CopyrightOwner),
            CopyrightStartYear = pod.CopyrightStartYear > 0 ? pod.CopyrightStartYear : null,
            CopyrightText = PodProjector.ReadSlice(pod.CopyrightText, payload),
            ContentLicenseName = PodUtf8Codec.FromFixed128(pod.ContentLicenseName),
            ContentLicenseUrl = PodUtf8Codec.FromFixed256(pod.ContentLicenseUrl),
            IcpRecordNumber = PodUtf8Codec.FromFixed64(pod.IcpRecordNumber),
            IcpRecordUrl = PodUtf8Codec.FromFixed256(pod.IcpRecordUrl),
            PoliceRecordNumber = PodUtf8Codec.FromFixed64(pod.PoliceRecordNumber),
            PoliceRecordUrl = PodUtf8Codec.FromFixed256(pod.PoliceRecordUrl),
            PoliceBadgeIconUrl = PodUtf8Codec.FromFixed256(pod.PoliceBadgeIconUrl),
            OperatorName = PodUtf8Codec.FromFixed128(pod.OperatorName),
            ContactEmail = PodUtf8Codec.FromFixed128(pod.ContactEmail)
        };
        return reader.IsConsumed;
    }

    private static SeoConfigPod CreateSeoConfigPod(SeoConfigPublicDto dto, out ReadOnlyMemory<byte> payload)
    {
        var bytes = new ArrayBufferWriter<byte>(512);
        var mutable = new MutableSeoConfigPod
        {
            Title = PodUtf8Codec.ToFixed256(dto.Title),
            Description = PodUtf8Codec.AppendSlice(dto.Description, bytes),
            Keywords = PodUtf8Codec.ToFixed256(dto.Keywords),
            Author = PodUtf8Codec.ToFixed64(dto.Author),
            OgImage = PodUtf8Codec.ToFixed256(dto.OgImage),
            BaseUrl = PodUtf8Codec.ToFixed256(dto.BaseUrl)
        };

        payload = bytes.WrittenMemory;
        return MemoryMarshal.Read<SeoConfigPod>(MemoryMarshal.AsBytes(new MutableSeoConfigPod[] { mutable }));
    }

    private static PageContentPod CreatePageContentPod(PageContentPublicDto dto, out ReadOnlyMemory<byte> payload)
    {
        var bytes = new ArrayBufferWriter<byte>(1024);
        var mutable = new MutablePageContentPod
        {
            Slug = PodUtf8Codec.ToFixed128(dto.Slug ?? string.Empty),
            Content = PodUtf8Codec.AppendSlice(dto.Content ?? string.Empty, bytes)
        };

        payload = bytes.WrittenMemory;
        return MemoryMarshal.Read<PageContentPod>(MemoryMarshal.AsBytes(new MutablePageContentPod[] { mutable }));
    }

    private static SiteComplianceConfigPod CreateSiteComplianceConfigPod(SiteComplianceConfigPublicDto dto, out ReadOnlyMemory<byte> payload)
    {
        var bytes = new ArrayBufferWriter<byte>(1024);
        var mutable = new MutableSiteComplianceConfigPod
        {
            Enabled = dto.Enabled ? (byte)1 : (byte)0,
            RegionMode = PodUtf8Codec.ToFixed32(dto.RegionMode),
            CopyrightStartYear = dto.CopyrightStartYear ?? 0,
            CopyrightOwner = PodUtf8Codec.ToFixed128(dto.CopyrightOwner),
            CopyrightText = PodUtf8Codec.AppendSlice(dto.CopyrightText, bytes),
            ContentLicenseName = PodUtf8Codec.ToFixed128(dto.ContentLicenseName),
            ContentLicenseUrl = PodUtf8Codec.ToFixed256(dto.ContentLicenseUrl),
            IcpRecordNumber = PodUtf8Codec.ToFixed64(dto.IcpRecordNumber),
            IcpRecordUrl = PodUtf8Codec.ToFixed256(dto.IcpRecordUrl),
            PoliceRecordNumber = PodUtf8Codec.ToFixed64(dto.PoliceRecordNumber),
            PoliceRecordUrl = PodUtf8Codec.ToFixed256(dto.PoliceRecordUrl),
            PoliceBadgeIconUrl = PodUtf8Codec.ToFixed256(dto.PoliceBadgeIconUrl),
            OperatorName = PodUtf8Codec.ToFixed128(dto.OperatorName),
            ContactEmail = PodUtf8Codec.ToFixed128(dto.ContactEmail)
        };

        payload = bytes.WrittenMemory;
        return MemoryMarshal.Read<SiteComplianceConfigPod>(MemoryMarshal.AsBytes(new MutableSiteComplianceConfigPod[] { mutable }));
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableSeoConfigPod
    {
        public Utf8Fixed256 Title;
        public Utf8SliceRef Description;
        public Utf8Fixed256 Keywords;
        public Utf8Fixed64 Author;
        public Utf8Fixed256 OgImage;
        public Utf8Fixed256 BaseUrl;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutablePageContentPod
    {
        public Utf8Fixed128 Slug;
        public Utf8SliceRef Content;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableSiteComplianceConfigPod
    {
        public byte Enabled;
        public Utf8Fixed32 RegionMode;
        public int CopyrightStartYear;
        public Utf8Fixed128 CopyrightOwner;
        public Utf8SliceRef CopyrightText;
        public Utf8Fixed128 ContentLicenseName;
        public Utf8Fixed256 ContentLicenseUrl;
        public Utf8Fixed64 IcpRecordNumber;
        public Utf8Fixed256 IcpRecordUrl;
        public Utf8Fixed64 PoliceRecordNumber;
        public Utf8Fixed256 PoliceRecordUrl;
        public Utf8Fixed256 PoliceBadgeIconUrl;
        public Utf8Fixed128 OperatorName;
        public Utf8Fixed128 ContactEmail;
    }
}
