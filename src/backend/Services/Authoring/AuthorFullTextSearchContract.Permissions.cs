using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

using static FsusBlog.Server.Services.Authoring.SqlAuthorRecentArticleHistoryPermissionAuthority;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Canonical metadata only; an encoding is never a live permission grant.</summary>
internal readonly record struct AuthorSearchPermissionIdentity(
    int UserId, string SiteScope, long PermissionRevision, string PermissionPolicyDigest);

public static partial class AuthorFullTextSearchContract
{
    private static readonly UTF8Encoding s_permissionUtf8 = new(false, true);

    /// <summary>
    /// Sole Search encoding of the SQL owner's original facts. Principal xmin is the
    /// revision coordinate, not a new globally monotonic epoch. Exact actor/session
    /// policy facts are separately bound; live issuer revalidation remains mandatory.
    /// Policy digest keeps the existing sha256: wire prefix over the v1 domain,
    /// IndexOwner, scope/visibility, Int64 actor, Int32 user, exact site/session,
    /// both generations, status/root/raw permissions, nullable revocation and expiry
    /// UTC ticks, in that order. Signed integers are little endian; strict UTF8 strings
    /// have Int32 byte lengths. No normalization, request ID or article cohort enters it.
    /// </summary>
    internal static AuthorSearchPermissionIdentity EncodePermissionIdentity(FullTextQueryPermissionObservation observation)
    {
        ArgumentNullException.ThrowIfNull(observation);
        long actor = observation.Owner.AdminPrincipalId;
        FullTextActorState state = observation.ActorState;
        Require(actor is > 0 and <= int.MaxValue && actor == observation.ActorContext.PrincipalId
            && observation.Owner.SiteScope == observation.ActorContext.SiteScope
            && !string.IsNullOrWhiteSpace(observation.Owner.SiteScope)
            && !string.IsNullOrWhiteSpace(observation.ActorContext.SessionId)
            && state.PrincipalGeneration > 0 && state.SessionGeneration > 0
            && state.Status is not null && state.Permissions is not null,
            "author_search_permission_identity_invalid");
        int userId = checked((int)actor);
        using var stream = new MemoryStream();
        Add("fsusblog.author-search-permission-policy.v1");
        Add(IndexOwner);
        AddInt32((int)AuthorSearchScope.CurrentArticle);
        AddInt32((int)AuthorSearchVisibilityScope.AuthorOnly);
        AddInt64(actor);
        AddInt32(userId);
        Add(observation.Owner.SiteScope);
        Add(observation.ActorContext.SessionId);
        AddInt64(state.PrincipalGeneration);
        AddInt64(state.SessionGeneration);
        Add(state.Status!);
        stream.WriteByte(state.IsRoot ? (byte)1 : (byte)0);
        Add(state.Permissions!);
        stream.WriteByte(state.RevokedAtUtc.HasValue ? (byte)1 : (byte)0);
        if (state.RevokedAtUtc.HasValue)
        {
            AddUtc(state.RevokedAtUtc.Value);
        }
        AddUtc(state.IdleExpiresAtUtc);
        AddUtc(state.AbsoluteExpiresAtUtc);
        return new(userId, observation.Owner.SiteScope, state.PrincipalGeneration,
            "sha256:" + Convert.ToHexStringLower(SHA256.HashData(stream.ToArray())));

        void Add(string value)
        {
            byte[] bytes = s_permissionUtf8.GetBytes(value);
            AddInt32(bytes.Length);
            stream.Write(bytes);
        }
        void AddInt32(int value)
        {
            Span<byte> bytes = stackalloc byte[4];
            BinaryPrimitives.WriteInt32LittleEndian(bytes, value);
            stream.Write(bytes);
        }
        void AddInt64(long value)
        {
            Span<byte> bytes = stackalloc byte[8];
            BinaryPrimitives.WriteInt64LittleEndian(bytes, value);
            stream.Write(bytes);
        }
        void AddUtc(DateTime value)
        {
            Require(value.Kind == DateTimeKind.Utc, "author_search_permission_identity_invalid");
            AddInt64(value.Ticks);
        }
    }
}
