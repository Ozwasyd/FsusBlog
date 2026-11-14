using System.Text;
using FsusBlog.V2.Core.Integrity;

namespace FsusBlog.V2.Core.Tests;

public sealed class SiteProofPayloadTests
{
    [Fact]
    public void PreservesTheFixedCanonicalSigningFormat()
    {
        const string hash = "ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD";
        var issued = new DateTimeOffset(2026, 11, 15, 0, 4, 5, TimeSpan.FromHours(8)).AddTicks(6007);
        var actual = SiteProofPayload.Canonicalize("article-rights-proof", "article:12:revision:34:rights:56", hash, issued,
            new Dictionary<string, string>
            {
                ["re\u0301fe\u0301rence\r2026"] = "e\u0301\r\n尾",
                ["publishProofId"] = "99"
            });
        var expected = """
            fsusblog.integrity.publish-proof.v1
            payloadVersion:i:1
            proofKind:s:YXJ0aWNsZS1yaWdodHMtcHJvb2Y=
            subject:s:YXJ0aWNsZToxMjpyZXZpc2lvbjozNDpyaWdodHM6NTY=
            digestSha256:h:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd
            issuedAt:t:2026-11-14T16:04:05.0006007Z
            fieldCount:i:2
            fieldKey:s:cHVibGlzaFByb29mSWQ=
            fieldValue:s:OTk=
            fieldKey:s:csOpZsOpcmVuY2UKMjAyNg==
            fieldValue:s:w6kK5bC+
            """ + "\n";
        Assert.Equal(Encoding.UTF8.GetBytes(expected), actual);
    }

    [Fact]
    public void RejectsAmbiguousOrMalformedSigningInputs()
    {
        var fields = new Dictionary<string, string> { ["e\u0301"] = "first", ["é"] = "second" };
        var issued = DateTimeOffset.UnixEpoch;
        Assert.Throws<ArgumentException>(() => SiteProofPayload.Canonicalize("kind", "subject", new string('0', 64), issued, fields));
        Assert.Throws<ArgumentException>(() => SiteProofPayload.Canonicalize("kind", "subject", new string('g', 64), issued, fields));
    }
}
