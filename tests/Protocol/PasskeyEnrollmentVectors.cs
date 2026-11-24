internal static class PasskeyEnrollmentVectors
{
    internal static void Run(string fixtures)
    {
        var token = new string('Q', 43);
        var user = Enumerable.Range(0, 32).Select(i => (byte)i).ToArray();
        var challenge = Enumerable.Range(160, 32).Select(i => (byte)i).ToArray();
        int[] algorithms = [-7, -257];
        byte[][] excluded = [[0, 255, 123], [12, 11, 10]];
        Compare("site-passkey-bootstrap", PasskeyWire.ProvisionBegin(token, 120_000, "example.test", "FsusBlog", "site-account",
            "Primary", user, challenge, algorithms));
        Compare("site-passkey-enrollment", Encode(excluded));
        Reject(() => Encode([]));
        Reject(() => Encode([excluded[0], excluded[0].ToArray()]));
        Reject(() => Encode([new byte[WireLimits.PasskeyCredentialIdBytes + 1]]));
        Reject(() => Encode(Enumerable.Range(0, WireLimits.SitePasskeyListSize).Select(value => new[] { (byte)value }).ToArray()));
        Encode(Enumerable.Range(0, WireLimits.SitePasskeyListSize - 1).Select(value => new[] { (byte)value }).ToArray());

        var adminFlow = Aeds.Decode(PasskeyWire.AuthenticatedAdministrator(), FrameType.AuthLoginFlow);
        if (adminFlow.Length != WireLayouts.PasskeyAuthLoginFlowSize ||
            System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(adminFlow) != 1 ||
            adminFlow[4] != 1 || adminFlow[5] != 0 || adminFlow[6] != 0 || adminFlow[7] != 1 ||
            !adminFlow.Slice(8, 13).SequenceEqual("administrator"u8) ||
            adminFlow[21..].ContainsAnyExcept((byte)0))
            throw new InvalidOperationException("Administrator AuthLoginFlow frame layout is invalid.");

        byte[] Encode(byte[][] ids) => PasskeyWire.EnrollmentBegin(token, 120_000, "example.test", "FsusBlog", "site-account",
            "Primary", user, challenge, algorithms, ids);

        void Compare(string name, byte[] actual) =>
            VectorFixture.Equal(VectorFixture.Hex(fixtures, name + ".hex"), actual,
                "Passkey registration options differ from the independent vector");
    }

    private static void Reject(Action action) =>
        ProtocolRejection.Assert(action, "Invalid enrollment exclusion list was accepted");
}
