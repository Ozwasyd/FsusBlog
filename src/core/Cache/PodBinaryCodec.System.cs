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
}
