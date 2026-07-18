using System.Reflection;

using FsusBlog.Shared;

namespace FsusBlog.Shared.Contracts.Validation;

public static class AedsProtocolMetadata
{
    public const int SchemaVersion = 1;

    public static readonly byte FrameVersion = AedsFrameHeader.VersionValue;

    public static readonly int FrameHeaderSize = AedsFrameHeader.Size;

    public static readonly IReadOnlyDictionary<string, ushort> FrameTypes = BuildFrameTypes();

    public static readonly IReadOnlyDictionary<string, int> PodSizes = BuildPodSizes();

    private static IReadOnlyDictionary<string, ushort> BuildFrameTypes()
    {
        Dictionary<string, ushort> frameTypes = new(StringComparer.Ordinal);
        foreach (AedsFrameType frameType in Enum.GetValues<AedsFrameType>())
        {
            string name = Enum.GetName(frameType) ?? ((ushort)frameType).ToString();
            frameTypes[name] = (ushort)frameType;
        }

        return frameTypes;
    }

    private static IReadOnlyDictionary<string, int> BuildPodSizes()
    {
        Dictionary<string, int> podSizes = new(StringComparer.Ordinal);
        FieldInfo[] fields = typeof(PodSizeCatalog).GetFields(BindingFlags.Public | BindingFlags.Static);
        for (int i = 0; i < fields.Length; i++)
        {
            FieldInfo field = fields[i];
            if (field.FieldType != typeof(int))
            {
                continue;
            }

            podSizes[field.Name] = (int)(field.GetValue(null) ?? 0);
        }

        return podSizes;
    }
}
