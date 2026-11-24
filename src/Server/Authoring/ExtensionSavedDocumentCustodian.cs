namespace FsusBlog.V2.Server.Authoring;

internal sealed class ExtensionSavedDocumentCustodian(Store store, string? token, string? currentSession) : IExtensionDocumentCustodian
{
    internal ExtensionDocumentBroker Bind(ExtensionInstallationStore installations) => installations.BindDocumentReader(this);

    internal Task<ExtensionOwner> ResolveOwnerAsync(int document, long revision, CancellationToken cancellationToken) =>
        WithOwnerAsync(document, revision, (owner, _, _) => Task.FromResult(owner), cancellationToken);

    async ValueTask<T> IExtensionDocumentCustodian.WithCurrentAsync<T>(ExtensionOwner expected,
        Func<ExtensionDocumentSnapshot, T> complete, CancellationToken cancellationToken) =>
        await WithOwnerAsync(expected.Document, expected.Revision, async (owner, db, tx) =>
        {
            if (owner != expected) throw new ExtensionRejectedException("document-owner-changed");
            var saved = await RevisionHistoryStore.ReadSource(db, tx, owner.Document, owner.Revision, cancellationToken);
            return complete(new(owner, saved.Body));
        }, cancellationToken);

    private Task<T> WithOwnerAsync<T>(int document, long revision, Func<ExtensionOwner, NpgsqlConnection, NpgsqlTransaction, Task<T>> read,
        CancellationToken cancellationToken) => store.WithSession(token, true, async (db, tx, actor) =>
    {
        var digest = Store.TokenDigest(token)!;
        SiteSessions.RequireCurrent(actor.Id, digest, currentSession);
        await RevisionHistoryStore.LockCurrent(db, tx, actor, document, revision, cancellationToken);
        var site = await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, cancellationToken);
        // The full session handle is checked above. The first 128 bits identify that checked session in the existing owner coordinates.
        var session = new Guid(Convert.FromHexString(currentSession!.AsSpan(0, 32)), bigEndian: true);
        return await read(new(actor.Id, session, actor.Generation, site, document, revision), db, tx);
    }, cancellationToken);
}
