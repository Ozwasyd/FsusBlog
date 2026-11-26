using FsusBlog.V2.Core.Extensions;
using FsusBlog.V2.Platform.Extensions;

using static FsusBlog.V2.Tests.SignedExtensionFixture;

namespace FsusBlog.V2.Integration.Tests;

public sealed class ExtensionDocumentReadPostgresTests
{
    [PostgresFact]
    public async Task SignedRangeReadUsesTheCurrentPrivateAuthorRevisionAndOriginalBroker()
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        await using var db = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromMinutes(1));
        var store = new Store(db.DataSource);
        await using var connection = await db.DataSource.OpenConnectionAsync(ct);
        var author = await db.SignIn("Extension author", ct, minutes: 1);
        var peer = await db.SignIn("Extension peer", ct, minutes: 1);
        const string source = "开😀文🧪尾";
        var saved = await Save(0, 0, source);
        var custodian = new ExtensionSavedDocumentCustodian(store, author.Token, author.Handle);
        var owner = await custodian.ResolveOwnerAsync(saved.Id, saved.Revision, ct);
        var wrongSession = new ExtensionSavedDocumentCustodian(store, author.Token, peer.Handle);
        await BusinessAssert.Denied(Rejection.Conflict, () => wrongSession.ResolveOwnerAsync(saved.Id, saved.Revision, ct));
        var peerCustodian = new ExtensionSavedDocumentCustodian(store, peer.Token, peer.Handle);
        await BusinessAssert.Denied(Rejection.NotFound, () => peerCustodian.ResolveOwnerAsync(saved.Id, saved.Revision, ct));

        var root = Directory.CreateTempSubdirectory("fsus-extension-read-");
        if (OperatingSystem.IsMacOS() && root.FullName.StartsWith("/var/", StringComparison.Ordinal))
            root = new("/private" + root.FullName);
        try
        {
            using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var now = DateTimeOffset.UtcNow;
            var archive = MakeArchive(path: "bin/reader.wasm", configure: manifest => manifest with
            {
                SignatureReference = "signature/read",
                TrustPolicyReference = "trust/read",
                Contributions = [manifest.Contributions[0] with
                {
                    Capabilities = [ExtensionCapability.DocumentRangeRead, ExtensionCapability.SelectionRead]
                }],
                Limits = new(TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(10), 4096, 1024, 8, 1, 1, 4, 0, 0, 0, 0)
            });
            var grantSource = new ApprovedExtensionSource("approved-source/read", "provenance/read", "fixture.publisher", "fixture.key",
                Hash(archive), "signature/read", "trust/read");
            using var installations = ExtensionInstallationStore.Create(root, Guid.NewGuid(), RandomNumberGenerator.GetBytes(32),
                [new("fixture.publisher", "fixture.key", [.. key.ExportSubjectPublicKeyInfo()], now.AddHours(-1), now.AddHours(1))],
                [grantSource], TimeProvider.System);
            installations.SetOwner(owner);
            AssertRejected("consent-owner-or-package", () => Issue(owner));
            var signature = Sign(key, archive);
            installations.InstallAndActivate(grantSource.Reference, archive, signature, ExtensionPlatform.ServerLinux, ct);
            var broker = custodian.Bind(installations);
            var grant = Issue(owner);
            var request = ReadRequest(grant, 1, 3);
            using (var operation = installations.Begin(owner, "fixture.read", "preview", request, ct))
            {
                var result = await broker.ReadRangeAsync(operation, ct);
                Assert.Equal(new(request.RequestId, saved.Id, saved.Revision, Hash(Encoding.UTF8.GetBytes("😀文")), 1, 3, "😀文"), result);
            }
            AssertRejected("proposal-scope", () => installations.Begin(owner, "fixture.read", "preview", request, ct));
            await DeniedRange(owner, grant, 0, source.Length, "document-range-scope");
            await DeniedRange(owner, grant, 2, 1, "document-range-encoding");
            await DeniedRange(owner, grant, 0, 4, "document-range-byte-limit");
            await DeniedRange(owner, grant, source.Length, 1, "document-range-scope");
            var selectionGrant = Issue(owner, ExtensionCapability.SelectionRead);
            using (var selection = installations.Begin(owner, "fixture.read", "preview", new ExtensionProposal.ReadSelection(Guid.NewGuid(), selectionGrant), ct))
                await AssertRejectedAsync("document-range-operation-required", () => broker.ReadRangeAsync(selection, ct).AsTask());

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
                AssertRejected("installation-store-broker-busy", () => installations.Deactivate("fixture.extension"));
                installations.RevokeConsent(grant);
                await held.CommitAsync(ct);
                await AssertRejectedAsync("operation-no-longer-current", () => pending);
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
            await BusinessAssert.Denied(Rejection.Conflict, () => broker.ReadRangeAsync(stale, ct).AsTask());
            var currentOwner = await custodian.ResolveOwnerAsync(latest.Id, latest.Revision, ct);
            installations.SetOwner(currentOwner);
            using var ended = NewRange(currentOwner, Issue(currentOwner), 1, 3);
            await db.SignOutAdmin(author.Token, ct);
            await BusinessAssert.Denied(Rejection.Unauthorized, () => broker.ReadRangeAsync(ended, ct).AsTask());
            installations.Deactivate("fixture.extension");

            Guid Issue(ExtensionOwner target, ExtensionCapability capability = ExtensionCapability.DocumentRangeRead) =>
                installations.RecordConsent(new("fixture.extension", "fixture.read", target, "preview", capability, null, 0, now.AddMinutes(2)));

            ExtensionAuthority.Operation NewRange(ExtensionOwner target, Guid consent, int start, int length) => installations.Begin(target,
                "fixture.read", "preview", ReadRequest(consent, start, length), ct);

            async Task DeniedRange(ExtensionOwner target, Guid consent, int start, int length, string code)
            {
                using var operation = NewRange(target, consent, start, length);
                await AssertRejectedAsync(code, () => broker.ReadRangeAsync(operation, ct).AsTask());
            }
        }
        finally { root.Delete(recursive: true); }

        Task<ArticleState> Save(int id, long revision, string body) =>
            PublicationFixture.EditDraft(store, author.Token, ArticleAction.Save, new(id, revision, Guid.NewGuid(), "Private draft", body), ct);

    }

}
