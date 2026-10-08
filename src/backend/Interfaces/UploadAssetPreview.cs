namespace FsusBlog.Server.Interfaces;

/// <summary>Bytes retained from the same original file observation; never reopens a URL or storage path.</summary>
public sealed record UploadAssetPreview(UploadAssetObservation Observation, ReadOnlyMemory<byte> Bytes);
