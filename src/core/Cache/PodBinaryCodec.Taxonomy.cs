using System.Buffers;
using System.Runtime.InteropServices;

using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    public static void WriteCategoryList(IReadOnlyList<CategoryListItemResponse> categories, IBufferWriter<byte> destination)
    {
        var blob = new List<byte>(Math.Max(128, categories.Count * 48));
        var names = new List<Utf8SliceRef>(categories.Count);
        foreach (var category in categories)
        {
            names.Add(PodUtf8Codec.AppendSlice(category.Name, blob));
        }

        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(categories.Count);
        writer.WriteBytes(CollectionsMarshal.AsSpan(blob));
        for (int i = 0; i < categories.Count; i++)
        {
            writer.WriteInt32(categories[i].Id);
            writer.WriteInt32(categories[i].ArticleCount);
            writer.WriteSliceRef(names[i]);
        }
    }

    public static byte[] EncodeCategoryList(IReadOnlyList<CategoryListItemResponse> categories)
        => EncodeToArray(64 + categories.Count * 24, writer => WriteCategoryList(categories, writer));

    public static bool TryDecodeCategoryList(ReadOnlyMemory<byte> source, out List<CategoryListItemResponse> categories)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadInt32(out int count) || count < 0 || !reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            categories = [];
            return false;
        }

        categories = new List<CategoryListItemResponse>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadInt32(out int id) ||
                !reader.TryReadInt32(out int articleCount) ||
                !reader.TryReadSliceRef(out Utf8SliceRef name))
            {
                categories = [];
                return false;
            }

            categories.Add(new CategoryListItemResponse
            {
                Id = id,
                Name = PodUtf8Codec.ReadSlice(name, blob),
                ArticleCount = articleCount
            });
        }

        return reader.IsConsumed;
    }

    public static void WriteTagWithCountList(IReadOnlyList<TagWithCountDto> tags, IBufferWriter<byte> destination)
    {
        var blob = new List<byte>(Math.Max(128, tags.Count * 48));
        var names = new List<Utf8SliceRef>(tags.Count);
        foreach (var tag in tags)
        {
            names.Add(PodUtf8Codec.AppendSlice(tag.Name, blob));
        }

        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(tags.Count);
        writer.WriteBytes(CollectionsMarshal.AsSpan(blob));
        for (int i = 0; i < tags.Count; i++)
        {
            writer.WriteInt32(tags[i].Id);
            writer.WriteInt32(tags[i].ArticleCount);
            writer.WriteSliceRef(names[i]);
        }
    }

    public static byte[] EncodeTagWithCountList(IReadOnlyList<TagWithCountDto> tags)
        => EncodeToArray(64 + tags.Count * 24, writer => WriteTagWithCountList(tags, writer));

    public static bool TryDecodeTagWithCountList(ReadOnlyMemory<byte> source, out List<TagWithCountDto> tags)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadInt32(out int count) || count < 0 || !reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            tags = [];
            return false;
        }

        tags = new List<TagWithCountDto>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadInt32(out int id) ||
                !reader.TryReadInt32(out int articleCount) ||
                !reader.TryReadSliceRef(out Utf8SliceRef name))
            {
                tags = [];
                return false;
            }

            tags.Add(new TagWithCountDto(id, PodUtf8Codec.ReadSlice(name, blob), articleCount));
        }

        return reader.IsConsumed;
    }

    private static CategoryPod CreateCategoryPod(int id, string name, int articleCount)
        => MemoryMarshal.Read<CategoryPod>(MemoryMarshal.AsBytes(new MutableCategoryPod[]
        {
            new()
            {
                Id = id,
                Name = PodUtf8Codec.ToFixed128(name),
                ArticleCount = articleCount
            }
        }));

    private static TagWithCountPod CreateTagWithCountPod(int id, string name, int articleCount)
        => MemoryMarshal.Read<TagWithCountPod>(MemoryMarshal.AsBytes(new MutableTagWithCountPod[]
        {
            new()
            {
                Id = id,
                Name = PodUtf8Codec.ToFixed128(name),
                ArticleCount = articleCount
            }
        }));

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableCategoryPod
    {
        public int Id;
        public Utf8Fixed128 Name;
        public int ArticleCount;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableTagWithCountPod
    {
        public int Id;
        public Utf8Fixed128 Name;
        public int ArticleCount;
    }
}
