using System.Security.Cryptography;
using FsusBlog.V2.Contracts;

internal static class NativePublicationProofVectors
{
    internal static void Run(string fixtures)
    {
        var publication = new DateTimeOffset(2026, 11, 15, 16, 0, 0, TimeSpan.FromHours(8)).AddTicks(1_200_010);
        var issue = new DateTimeOffset(2026, 11, 15, 8, 10, 0, TimeSpan.Zero).AddTicks(10);
        var proof = new ArticlePublicationProofV2("https://proof.example.test", 42, 9007199254740993, 9007199254741999, 3,
            publication, 9007199254742999, 9007199254743999,
            Convert.FromHexString("24239fad08e881ba50750f3d8d5ced03746a398201e9e68e7036eefdb9c25bb2"),
            Convert.FromHexString("c2bfe4d5c0d344bae54fc17049ee5d4375f3141601d8f60597b8d1ccabd7689a"),
            "rotate-1", 7, Enumerable.Repeat((byte)0x3a, 32).ToArray(), issue);
        var actual = ArticlePublicationProofPayloadV2.Build(proof);
        if (!File.ReadAllBytes(Path.Combine(fixtures, "article-publication-proof-v2.txt")).AsSpan().SequenceEqual(actual) ||
            Convert.ToHexStringLower(SHA256.HashData(actual)) != "8169f3b97e599c57fed6d9180d5de33b781766b03d006995a01832b3c0392ce2")
            throw new InvalidOperationException("Native signing transcript differs from the independent vector.");
        VerifyTransparency(actual);
        foreach (var invalid in new[] { proof with { IssuedAt = issue.AddTicks(1) }, proof with { IssuedAt = publication.AddTicks(-10) },
            proof with { Origin = "https://proof.example.test/private" }, proof with { KeyVersion = 0 } })
        {
            try { ArticlePublicationProofPayloadV2.Build(invalid); }
            catch (ArgumentException) { continue; }
            throw new InvalidOperationException("An invalid signing transcript was accepted.");
        }
    }

    private static void VerifyTransparency(byte[] transcript)
    {
        // SHA-256 fixtures independently computed from the checked-in transcript and 0..63 in both orders.
        var signature = Enumerable.Range(0, 64).Select(static value => (byte)value).ToArray();
        var receipt = PublicationTransparencyV2.ReceiptDigest(transcript, signature);
        var first = PublicationTransparencyV2.EntryDigest(1, new byte[32], receipt);
        Array.Reverse(signature);
        var successor = PublicationTransparencyV2.ReceiptDigest(transcript, signature);
        var second = PublicationTransparencyV2.EntryDigest(2, first, successor);
        if (Convert.ToHexStringLower(receipt) != "5dffc260f61746045a28db99a7ea53539b53e3ea8966a2017cfea2a6c9dd99d3" ||
            Convert.ToHexStringLower(first) != "25cf7e05fb5664cef60be983608af44f766e61071985f9555c665af0874f6378" ||
            Convert.ToHexStringLower(second) != "7fa4d9ff96c8a5324a9f912e1012a2ef686a92ac0308cee6b089191b54c6ddb3")
            throw new InvalidOperationException("Native transparency digests differ from the independent vectors.");
    }
}
