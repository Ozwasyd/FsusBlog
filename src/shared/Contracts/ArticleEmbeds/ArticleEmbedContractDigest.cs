using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds;

/// <summary>Canonical length-prefixed digest shared by every embed-contract consumer.</summary>
public static class ArticleEmbedContractDigest
{
    public static string ComputeRequest(ArticleEmbedProviderRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        return Compute(writer =>
        {
            writer.Add(request.Schema);
            writer.Add(request.SchemaVersion);
            writer.Add(request.RequestId);
            writer.Add(request.HostPortableArticleIdentity);
            writer.Add(request.HostDocument.Id);
            writer.Add(request.HostDocument.Epoch);
            writer.Add(request.SourceRevision);
            writer.Add(request.Directive.ParserContract);
            writer.Add(request.Directive.TargetToken);
            writer.Add((byte)request.Directive.Mode);
            writer.Add(request.Directive.RawRange.Start);
            writer.Add(request.Directive.RawRange.End);
            AddTarget(writer, request.Target);
            writer.Add((byte)request.RequestedScope);
            writer.Add(request.Actor.ActorIdentity);
            writer.Add(request.Actor.SiteIdentity);
            writer.Add(request.Actor.PermissionContextDigest);
            writer.Add(request.Runtime.ProviderId);
            writer.Add(request.Runtime.ProviderVersion);
            writer.Add(request.Runtime.RuntimeVersion);
            writer.Add(request.Runtime.RuntimeDigest);
            writer.Add(request.ContentDigest);
        });
    }

    public static string ComputeDependency(ArticleEmbedDependencyCoordinate coordinate)
    {
        ArgumentNullException.ThrowIfNull(coordinate);
        return Compute(writer =>
        {
            writer.Add(coordinate.Schema);
            writer.Add(coordinate.SchemaVersion);
            AddTarget(writer, coordinate.Target);
            writer.Add(coordinate.ResolvedRevision);
            writer.Add(coordinate.TargetVersionIdentity);
            writer.Add(coordinate.ProjectionIdentity);
            writer.Add(coordinate.ProjectionDigest);
        });
    }

    public static string ComputeResult(ArticleEmbedProviderResult result)
    {
        ArgumentNullException.ThrowIfNull(result);
        return Compute(writer =>
        {
            writer.Add(result.Schema);
            writer.Add(result.SchemaVersion);
            writer.Add(result.RequestId);
            writer.Add(result.RequestDigest);
            writer.Add((byte)result.Status);
            writer.Add(result.Coordinate is not null);
            if (result.Coordinate is not null)
            {
                writer.Add(result.Coordinate.DependencyDigest);
            }
            writer.Add(result.Projection is not null);
            if (result.Projection is not null)
            {
                writer.Add((byte)result.Projection.Kind);
                writer.Add(result.Projection.ProjectionIdentity);
                writer.Add(result.Projection.ContentDigest);
            }
            writer.Add(result.Attribution is not null);
            if (result.Attribution is not null)
            {
                writer.Add(result.Attribution.SourcePortableArticleIdentity);
                writer.Add(result.Attribution.SourceRevision);
                writer.Add(result.Attribution.DisplayText);
                writer.Add(result.Attribution.AttributionDigest);
            }
            writer.Add((byte)result.Visibility);
            writer.Add((byte)result.Lifecycle);
            writer.Add((byte)result.Permission);
            writer.Add(result.Budgets.Depth);
            writer.Add(result.Budgets.Nodes);
            writer.Add(result.Budgets.Bytes);
            writer.Add(result.Budgets.ElapsedMilliseconds);
            writer.Add(result.Error is not null);
            if (result.Error is not null)
            {
                writer.Add((byte)result.Error.Code);
                writer.Add(result.Error.SafeReasonCode);
            }
        });
    }

    public static bool IsSha256(string? value)
    {
        if (value is null || value.Length != 64)
        {
            return false;
        }
        foreach (char character in value)
        {
            if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')))
            {
                return false;
            }
        }
        return true;
    }

    /// <summary>Canonical typed-attribution digest shared by authoring resolution and verification.</summary>
    public static string ComputeAttribution(string sourcePortableArticleIdentity, long sourceRevision, string displayText)
        => Compute(writer =>
        {
            writer.Add("fsusblog.article-embed-attribution.v1");
            writer.Add(sourcePortableArticleIdentity);
            writer.Add(sourceRevision);
            writer.Add(displayText);
        });

    private static void AddTarget(CanonicalWriter writer, ArticleEmbedTargetIdentity target)
    {
        writer.Add(target.PortableArticleIdentity);
        writer.Add((byte)target.Kind);
        writer.Add(target.HeadingIdentity);
        writer.Add(target.BlockAnchor);
    }

    /// <summary>The single canonical length-prefixed UTF-8 serialization reused by every embed slice digest.</summary>
    internal static string Compute(Action<CanonicalWriter> write)
    {
        using var stream = new MemoryStream();
        var writer = new CanonicalWriter(stream);
        write(writer);
        return Convert.ToHexStringLower(SHA256.HashData(stream.GetBuffer().AsSpan(0, checked((int)stream.Length))));
    }

    internal sealed class CanonicalWriter(MemoryStream stream)
    {
        public void Add(string? value)
        {
            if (value is null)
            {
                Add(-1);
                return;
            }
            byte[] bytes = Encoding.UTF8.GetBytes(value);
            Add(bytes.Length);
            stream.Write(bytes);
        }

        public void Add(bool value) => stream.WriteByte(value ? (byte)1 : (byte)0);

        public void Add(byte value) => stream.WriteByte(value);

        public void Add(int value)
        {
            Span<byte> bytes = stackalloc byte[sizeof(int)];
            BinaryPrimitives.WriteInt32BigEndian(bytes, value);
            stream.Write(bytes);
        }

        public void Add(long value)
        {
            Span<byte> bytes = stackalloc byte[sizeof(long)];
            BinaryPrimitives.WriteInt64BigEndian(bytes, value);
            stream.Write(bytes);
        }
    }
}
