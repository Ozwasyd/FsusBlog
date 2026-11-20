using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Operations;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed record AdminLiveSession(Guid Id, byte[] Digest, AdminSessionSnapshot Snapshot);

// The single administrator session and transaction gate. Each call opens one InstanceLease-protected
// transaction, re-verifies the live session there, runs the caller inside it, and commits only after
// the caller succeeds. Domain stores take this gate as an explicit dependency.
internal sealed class AdminSessionGate(NpgsqlDataSource source, InstanceLease? lease)
{
    private static readonly byte[] PermissionSessionDomain = "FsusBlog v2 administrator permission session"u8.ToArray();

    internal Task<(AdminSessionSnapshot Snapshot, string PermissionSession)> SessionWithPermissionBinding(
        string? token, CancellationToken ct) =>
        WithLiveAdmin(token, (_, _, admin) => Task.FromResult((admin.Snapshot, PermissionBinding(admin.Digest))), ct);

    internal static string PermissionBinding(byte[] digest)
    {
        Span<byte> material = stackalloc byte[PermissionSessionDomain.Length + 32];
        PermissionSessionDomain.CopyTo(material);
        digest.CopyTo(material[PermissionSessionDomain.Length..]);
        return Convert.ToHexStringLower(SHA256.HashData(material));
    }

    internal Task<T> WithSession<T>(string? token,
        Func<NpgsqlConnection, NpgsqlTransaction, AdminSessionSnapshot, Task<T>> use, CancellationToken ct) =>
        WithLiveAdmin(token, (db, tx, actor) => use(db, tx, actor.Snapshot), ct);

    internal async Task<T> WithLiveAdmin<T>(string? token,
        Func<NpgsqlConnection, NpgsqlTransaction, AdminLiveSession, Task<T>> use, CancellationToken ct)
    {
        var digest = Store.TokenDigest(token) ?? throw Denied();
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        var actor = await Store.VerifyLiveAdminAsync(db, tx, digest, ct);
        var expiration = actor.ExpiresAt.ToUnixTimeMilliseconds();
        var result = await use(db, tx, new AdminLiveSession(actor.Id, digest, new AdminSessionSnapshot(actor.Name, actor.Generation, expiration)));
        if (expiration <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) throw Denied();
        await InstanceLease.CommitProtected(tx, lease, ct);
        return result;
    }

    internal async Task SignOut(string? token, CancellationToken ct)
    {
        if (Store.TokenDigest(token) is not { } digest) return;
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        await AdminSignInHistory.RetireAsync(db, tx, null, digest, ct);
        await InstanceLease.CommitProtected(tx, lease, ct);
    }

    internal static BusinessException Denied() => new(Rejection.Unauthorized, "Administrator verification failed or expired.");
}
