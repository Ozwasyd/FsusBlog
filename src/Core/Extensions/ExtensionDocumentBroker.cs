using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.V2.Core.Extensions;

public sealed record ExtensionDocumentRange(Guid RequestId, int Document, long Revision, string ValueDigest, int Start, int Length, string Text);

internal sealed record ExtensionDocumentSnapshot(ExtensionOwner Owner, string Body);

// Only the original host custodian may observe source and complete a read under current owner/revision locks.
internal interface IExtensionDocumentCustodian
{
    ValueTask<T> WithCurrentAsync<T>(ExtensionOwner expected, Func<ExtensionDocumentSnapshot, T> complete, CancellationToken cancellationToken);
}

public sealed class ExtensionDocumentBroker
{
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private readonly IExtensionDocumentCustodian _custodian;

    internal ExtensionDocumentBroker(IExtensionDocumentCustodian custodian) => _custodian = custodian;

    public async ValueTask<ExtensionDocumentRange> ReadRangeAsync(ExtensionAuthority.Operation operation, CancellationToken cancellationToken = default)
    {
        if (operation.Proposal is not ExtensionProposal.ReadRange range)
            throw new ExtensionRejectedException("document-range-operation-required");
        var scope = operation.BeginDocumentRead(this, cancellationToken);
        Exception? first = null;
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, scope.Token);
            var result = await _custodian.WithCurrentAsync(scope.Owner, snapshot =>
            {
                var value = Read(snapshot, scope.Owner, range, scope.MaximumResponseBytes);
                return scope.Complete(value, deadline.Token);
            }, deadline.Token);
            deadline.Token.ThrowIfCancellationRequested();
            return result;
        }
        catch (Exception error) { first = error; throw; }
        finally
        {
            try { scope.Dispose(); }
            catch (Exception release) when (first is not null) { throw new AggregateException(first, release); }
        }
    }

    private static ExtensionDocumentRange Read(ExtensionDocumentSnapshot snapshot, ExtensionOwner expected,
        ExtensionProposal.ReadRange range, int maximumResponseBytes)
    {
        var source = snapshot.Body;
        if (snapshot.Owner != expected || range.Start > source.Length || range.Length > source.Length - range.Start ||
            range.Length == source.Length)
            throw new ExtensionRejectedException("document-range-scope");
        var value = source.AsSpan(range.Start, range.Length);
        try
        {
            if (Utf8.GetByteCount(value) > maximumResponseBytes)
                throw new ExtensionRejectedException("document-range-byte-limit");
            var text = value.ToString();
            var digest = Convert.ToHexStringLower(SHA256.HashData(Utf8.GetBytes(text)));
            return new(range.RequestId, expected.Document, expected.Revision, digest, range.Start, range.Length, text);
        }
        catch (EncoderFallbackException)
        {
            throw new ExtensionRejectedException("document-range-encoding");
        }
    }
}
