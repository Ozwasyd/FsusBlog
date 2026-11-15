using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Extensions;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Authoring;
using FsusBlog.V2.Server.Sessions;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class ExtensionDocumentReadPostgresTests
{
    [PostgresFact]
    public async Task SignedRangeReadUsesTheCurrentPrivateAuthorRevisionAndOriginalBroker()
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(1));
        var ct = deadline.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var store = new Store(db.DataSource);
        await using var connection = await db.DataSource.OpenConnectionAsync(ct);
        var author = await Login("Extension author");
        var peer = await Login("Extension peer");
        const string source = "开😀文🧪尾";
        var saved = await Save(0, 0, source);
        var custodian = new ExtensionSavedDocumentCustodian(store, author.Token, author.Handle);
        var owner = await custodian.ResolveOwnerAsync(saved.Id, saved.Revision, ct);
        var wrongSession = new ExtensionSavedDocumentCustodian(store, author.Token, peer.Handle);
        var switched = await Assert.ThrowsAsync<BusinessException>(() => wrongSession.ResolveOwnerAsync(saved.Id, saved.Revision, ct));
        Assert.Equal(Rejection.Conflict, switched.Rejection);
        var peerCustodian = new ExtensionSavedDocumentCustodian(store, peer.Token, peer.Handle);
        var foreign = await Assert.ThrowsAsync<BusinessException>(() => peerCustodian.ResolveOwnerAsync(saved.Id, saved.Revision, ct));
        Assert.Equal(Rejection.NotFound, foreign.Rejection);

        var root = Directory.CreateTempSubdirectory("fsus-extension-read-");
        if (OperatingSystem.IsMacOS() && root.FullName.StartsWith("/var/", StringComparison.Ordinal))
            root = new("/private" + root.FullName);
        try
        {
            using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var now = DateTimeOffset.UtcNow;
            var archive = CreatePackage();
            var grantSource = new ApprovedExtensionSource("approved-source/read", "provenance/read", "fixture.publisher", "fixture.key",
                Digest(archive), "signature/read", "trust/read");
            using var installations = ExtensionInstallationStore.Create(root, Guid.NewGuid(), RandomNumberGenerator.GetBytes(32),
                [new("fixture.publisher", "fixture.key", [.. key.ExportSubjectPublicKeyInfo()], now.AddHours(-1), now.AddHours(1))],
                [grantSource], TimeProvider.System);
            installations.SetOwner(owner);
            var unsigned = Assert.Throws<ExtensionRejectedException>(() => Issue(owner));
            Assert.Equal("consent-owner-or-package", unsigned.Code);
            var signature = key.SignData(archive, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
            installations.InstallAndActivate(grantSource.Reference, archive, signature, ExtensionPlatform.ServerLinux, ct);
            var broker = custodian.Bind(installations);
            var grant = Issue(owner);
            var request = new ExtensionProposal.ReadRange(Guid.NewGuid(), grant, 1, 3);
            using (var operation = installations.Begin(owner, "fixture.read", "preview", request, ct))
            {
                var result = await broker.ReadRangeAsync(operation, ct);
                Assert.Equal(new(request.RequestId, saved.Id, saved.Revision, Digest(Encoding.UTF8.GetBytes("😀文")), 1, 3, "😀文"), result);
            }
            var duplicate = Assert.Throws<ExtensionRejectedException>(() => installations.Begin(owner, "fixture.read", "preview", request, ct));
            Assert.Equal("proposal-scope", duplicate.Code);
            await DeniedRange(owner, grant, 0, source.Length, "document-range-scope");
            await DeniedRange(owner, grant, 2, 1, "document-range-encoding");
            await DeniedRange(owner, grant, 0, 4, "document-range-byte-limit");
            await DeniedRange(owner, grant, source.Length, 1, "document-range-scope");
            var selectionGrant = Issue(owner, ExtensionCapability.SelectionRead);
            using (var selection = installations.Begin(owner, "fixture.read", "preview", new ExtensionProposal.ReadSelection(Guid.NewGuid(), selectionGrant), ct))
            {
                var denied = await Assert.ThrowsAsync<ExtensionRejectedException>(() => broker.ReadRangeAsync(selection, ct).AsTask());
                Assert.Equal("document-range-operation-required", denied.Code);
            }

            var otherSite = owner with { Site = Guid.NewGuid() };
            installations.SetOwner(otherSite);
            await DeniedRange(otherSite, Issue(otherSite), 1, 3, "document-owner-changed");
            installations.SetOwner(owner);
            grant = Issue(owner);
            using (var operation = NewRange(owner, grant, 1, 3))
            {
                await using var held = await connection.BeginTransactionAsync(ct);
                await using var take = Store.Sql(connection, held, "select id from public.article where id=$1 for update", saved.Id);
                await take.ExecuteScalarAsync(ct);
                var pending = broker.ReadRangeAsync(operation, ct).AsTask();
                var busy = Assert.Throws<ExtensionRejectedException>(() => installations.Deactivate("fixture.extension"));
                Assert.Equal("installation-store-broker-busy", busy.Code);
                installations.RevokeConsent(grant);
                await held.CommitAsync(ct);
                var revoked = await Assert.ThrowsAsync<ExtensionRejectedException>(() => pending);
                Assert.Equal("operation-no-longer-current", revoked.Code);
            }

            grant = Issue(owner);
            using (var operation = NewRange(owner, grant, 1, 3))
            {
                await using var held = await connection.BeginTransactionAsync(ct);
                await FixtureSql.ScalarAsync(connection, held, ct, "select id from public.article where id=$1 for update", saved.Id);
                using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(ct);
                var pending = broker.ReadRangeAsync(operation, cancellation.Token).AsTask();
                cancellation.Cancel();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
                await held.CommitAsync(ct);
            }

            using var stale = NewRange(owner, grant, 1, 3);
            var latest = await Save(saved.Id, saved.Revision, "Newest private source");
            var conflict = await Assert.ThrowsAsync<BusinessException>(() => broker.ReadRangeAsync(stale, ct).AsTask());
            Assert.Equal(Rejection.Conflict, conflict.Rejection);
            var currentOwner = await custodian.ResolveOwnerAsync(latest.Id, latest.Revision, ct);
            installations.SetOwner(currentOwner);
            using var ended = NewRange(currentOwner, Issue(currentOwner), 1, 3);
            await store.SignOut(author.Token, ct);
            var signedOut = await Assert.ThrowsAsync<BusinessException>(() => broker.ReadRangeAsync(ended, ct).AsTask());
            Assert.Equal(Rejection.Unauthorized, signedOut.Rejection);
            installations.Deactivate("fixture.extension");

            Guid Issue(ExtensionOwner target, ExtensionCapability capability = ExtensionCapability.DocumentRangeRead) =>
                installations.RecordConsent(new("fixture.extension", "fixture.read", target, "preview", capability, null, 0, now.AddMinutes(2)));

            ExtensionAuthority.Operation NewRange(ExtensionOwner target, Guid consent, int start, int length) => installations.Begin(target,
                "fixture.read", "preview", new ExtensionProposal.ReadRange(Guid.NewGuid(), consent, start, length), ct);

            async Task DeniedRange(ExtensionOwner target, Guid consent, int start, int length, string code)
            {
                using var operation = NewRange(target, consent, start, length);
                var rejected = await Assert.ThrowsAsync<ExtensionRejectedException>(() => broker.ReadRangeAsync(operation, ct).AsTask());
                Assert.Equal(code, rejected.Code);
            }
        }
        finally { root.Delete(recursive: true); }

        async Task<ArticleState> Save(int id, long revision, string body) =>
            (await store.WithSession(author.Token, true, (conn, tx, actor) => Store.Execute(conn, tx, actor, ArticleAction.Save,
                new(id, revision, Guid.NewGuid(), "Private draft", body), ct), ct)).Article;

        async Task<(string Token, string Handle)> Login(string name)
        {
            var account = Guid.NewGuid();
            var ticket = RandomNumberGenerator.GetBytes(32);
            await FixtureSql.ExecuteAsync(connection, null, ct, "insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,true,true,1)", account, name);
            await FixtureSql.ExecuteAsync(connection, null, ct, "insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,now()+interval '1 minute')", SHA256.HashData(ticket), account);
            var token = (await store.SignIn(Convert.ToHexStringLower(ticket), ct)).Token;
            return (token, SiteSessions.Id(account, Store.TokenDigest(token)!));
        }
    }

    private static byte[] CreatePackage()
    {
        const string entrypoint = "bin/reader.wasm";
        byte[] wasm = [0, 97, 115, 109, 1, 0, 0, 0];
        var name = Frame(Encoding.UTF8.GetBytes(entrypoint));
        var manifest = new ExtensionManifest(1, 1, "fixture.extension", "1.0",
            Digest([.. "fsusblog.authoring-package.payload.v1\0"u8, .. name, .. Frame(wasm)]),
            Digest([.. name, .. SHA256.HashData(wasm)]), "fixture.publisher", "signature/read", "trust/read", new(1, 1),
            [ExtensionPlatform.ServerLinux], [new("fixture.read", 1, 1, new(1, entrypoint, Digest(wasm)),
                [ExtensionCapability.DocumentRangeRead, ExtensionCapability.SelectionRead])],
            new(TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(10), 4096, 1024, 8, 1, 1, 4, 0, 0, 0, 0), 1, 1, 0, 0, 0, false);
        using var output = new MemoryStream();
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            using (var file = zip.CreateEntry("manifest.json").Open()) file.Write(JsonSerializer.SerializeToUtf8Bytes(manifest));
            using (var file = zip.CreateEntry(entrypoint).Open()) file.Write(wasm);
        }
        return output.ToArray();
    }

    private static byte[] Frame(byte[] bytes)
    {
        var framed = new byte[4 + bytes.Length];
        BinaryPrimitives.WriteInt32BigEndian(framed, bytes.Length);
        bytes.CopyTo(framed, 4);
        return framed;
    }

    private static string Digest(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
}
