using System.Buffers.Binary;
using FsusBlog.V2.Contracts;

internal static class SitePasskeyNameVectors
{
    internal static void Run(string fixtures)
    {
        const string current = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        const string other = "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf";
        const long revision = 9_007_199_254_740_999;
        var first = new SitePasskeyRow(1800000000123, 1800000000987, true, true, true);
        var second = new SitePasskeyRow(1800000001122, null, false, false, false);
        var firstNamed = new SitePasskeyManagedRow(current, 0, "", first);
        var secondNamed = new SitePasskeyManagedRow(other, revision, "工作钥匙 🐈", second);
        var rename = new SitePasskeyRename(other, revision, " 工位 🔑 ");
        Equal("site-passkey-management", Wire.EncodeSitePasskeyManagement([firstNamed, secondNamed]));
        var intent = Fixture("site-passkey-rename");
        Equal("site-passkey-rename", Wire.EncodeSitePasskeyRename(rename));
        if (Wire.DecodeSitePasskeyRename(intent) != rename)
            throw new InvalidOperationException("Site Passkey rename differs from the independent vector");

        Reject(() => Wire.EncodeSitePasskeyManagement([firstNamed, secondNamed with { Reference = current }]));
        Reject(() => Wire.EncodeSitePasskeyManagement([firstNamed, secondNamed with { Revision = 0 }]));
        Reject(() => Wire.EncodeSitePasskeyManagement([firstNamed, secondNamed with { Name = " 工位" }]));
        Reject(() => Wire.EncodeSitePasskeyManagement([firstNamed, secondNamed with { Name = "键\0" }]));
        Reject(() => Wire.DecodeSitePasskeyRename(intent.AsSpan(0, intent.Length - 1)));
        var body = Aeds.Decode(intent, FrameType.SitePasskeyRename).ToArray();
        Reject(() => Wire.DecodeSitePasskeyRename(Aeds.Encode(FrameType.SitePasskeyRename, [.. body, 0])));
        BinaryPrimitives.WriteInt64LittleEndian(body.AsSpan(WireLimits.SitePasskeyReferenceBytes), -1);
        Reject(() => Wire.DecodeSitePasskeyRename(Aeds.Encode(FrameType.SitePasskeyRename, body)));

        var original = Wire.EncodeSitePasskeys([first, second]);
        if (!Aeds.Decode(original, FrameType.SitePasskeys).SequenceEqual(Convert.FromHexString(
            "020000007b505c18a3010000db535c18a301000001010162545c18a30100000000000000000000000000")))
            throw new InvalidOperationException("Original Site Passkey list payload changed");

        byte[] Fixture(string name) => Convert.FromHexString(File.ReadAllText(Path.Combine(fixtures, name + ".hex")).Trim());
        void Equal(string name, byte[] actual)
        {
            if (!actual.AsSpan().SequenceEqual(Fixture(name)))
                throw new InvalidOperationException("Site Passkey AEDS bytes differ from independent vector");
        }
    }

    private static void Reject(Action action)
    {
        try { action(); }
        catch (ProtocolException) { return; }
        throw new InvalidOperationException("Invalid site Passkey data was accepted");
    }
}
