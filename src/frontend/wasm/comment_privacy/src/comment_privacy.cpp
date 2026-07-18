#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace
{

struct U256
{
    std::array<std::uint64_t, 4> V{};
};

struct Fp
{
    U256 N{};
};

struct AffinePoint
{
    Fp X{};
    Fp Y{};
    bool Infinity = true;
};

struct JacobianPoint
{
    Fp X{};
    Fp Y{};
    Fp Z{};
    bool Infinity = true;
};

constexpr U256 P{{0x3c208c16d87cfd47ULL, 0x97816a916871ca8dULL, 0xb85045b68181585dULL, 0x30644e72e131a029ULL}};

constexpr U256 R{{0x43e1f593f0000001ULL, 0x2833e84879b97091ULL, 0xb85045b68181585dULL, 0x30644e72e131a029ULL}};

constexpr U256 FpR2{{0xf32cfc5b538afa89ULL, 0xb5e71911d44501fbULL, 0x47ab1eff0a417ff6ULL, 0x06d89f71cab8351fULL}};

constexpr U256 FpOneMont{{0xd35d438dc58f0d9dULL, 0x0a78eb28f5c70b3dULL, 0x666ea36f7879462cULL, 0x0e0a77c19a07df2fULL}};

constexpr U256 FpSqrtExp{{0x4f082305b61f3f52ULL, 0x65e05aa45a1c72a3ULL, 0x6e14116da0605617ULL, 0x0c19139cb84c680aULL}};

constexpr U256 FpInvExp{{0x3c208c16d87cfd45ULL, 0x97816a916871ca8dULL, 0xb85045b68181585dULL, 0x30644e72e131a029ULL}};

constexpr U256 ONE{{1ULL, 0ULL, 0ULL, 0ULL}};
constexpr std::uint64_t FpN0 = 0x87d20782e4866389ULL;
constexpr std::size_t G1Size = 32;
constexpr std::size_t G2Size = 64;
constexpr std::size_t VkSize = 304;
constexpr std::size_t ProofSize = 138;

std::array<std::uint8_t, ProofSize> s_proof{};
std::size_t s_proofLen = 0;
int s_lastError = 0;

int Cmp4(const U256& a, const U256& b)
{
    for (int i = 3; i >= 0; --i)
    {
        if (a.V[static_cast<std::size_t>(i)] < b.V[static_cast<std::size_t>(i)])
        {
            return -1;
        }
        if (a.V[static_cast<std::size_t>(i)] > b.V[static_cast<std::size_t>(i)])
        {
            return 1;
        }
    }
    return 0;
}

bool IsZero(const U256& a)
{
    return (a.V[0] | a.V[1] | a.V[2] | a.V[3]) == 0;
}

void SubRaw(U256& a, const U256& b)
{
    std::uint64_t borrow = 0;
    for (std::size_t i = 0; i < 4; ++i)
    {
        const std::uint64_t Previous = a.V[i];
        const std::uint64_t Subtrahend = b.V[i] + borrow;
        a.V[i] = Previous - Subtrahend;
        borrow = (Previous < Subtrahend || (borrow == 1 && Subtrahend == 0)) ? 1 : 0;
    }
}

U256 AddMod(const U256& a, const U256& b)
{
    U256 out{};
    unsigned __int128 carry = 0;
    for (std::size_t i = 0; i < 4; ++i)
    {
        const unsigned __int128 Value = static_cast<unsigned __int128>(a.V[i]) + b.V[i] + carry;
        out.V[i] = static_cast<std::uint64_t>(Value);
        carry = Value >> 64;
    }
    if (carry != 0 || Cmp4(out, P) >= 0)
    {
        SubRaw(out, P);
    }
    return out;
}

U256 SubMod(const U256& a, const U256& b)
{
    U256 out = a;
    std::uint64_t borrow = 0;
    for (std::size_t i = 0; i < 4; ++i)
    {
        const std::uint64_t Previous = out.V[i];
        const std::uint64_t Subtrahend = b.V[i] + borrow;
        out.V[i] = Previous - Subtrahend;
        borrow = (Previous < Subtrahend || (borrow == 1 && Subtrahend == 0)) ? 1 : 0;
    }
    if (borrow != 0)
    {
        unsigned __int128 carry = 0;
        for (std::size_t i = 0; i < 4; ++i)
        {
            const unsigned __int128 Value = static_cast<unsigned __int128>(out.V[i]) + P.V[i] + carry;
            out.V[i] = static_cast<std::uint64_t>(Value);
            carry = Value >> 64;
        }
    }
    return out;
}

void Propagate(std::array<std::uint64_t, 9>& t, std::size_t index, unsigned __int128 carry)
{
    while (carry != 0 && index < t.size())
    {
        const unsigned __int128 Value = static_cast<unsigned __int128>(t[index]) + carry;
        t[index] = static_cast<std::uint64_t>(Value);
        carry = Value >> 64;
        ++index;
    }
}

U256 MontMul(const U256& a, const U256& b)
{
    std::array<std::uint64_t, 9> t{};
    for (std::size_t i = 0; i < 4; ++i)
    {
        unsigned __int128 carry = 0;
        for (std::size_t j = 0; j < 4; ++j)
        {
            const unsigned __int128 Value = static_cast<unsigned __int128>(a.V[i]) * b.V[j] + t[i + j] + carry;
            t[i + j] = static_cast<std::uint64_t>(Value);
            carry = Value >> 64;
        }
        Propagate(t, i + 4, carry);
    }

    for (std::size_t i = 0; i < 4; ++i)
    {
        const std::uint64_t M = t[i] * FpN0;
        unsigned __int128 carry = 0;
        for (std::size_t j = 0; j < 4; ++j)
        {
            const unsigned __int128 Value = static_cast<unsigned __int128>(M) * P.V[j] + t[i + j] + carry;
            t[i + j] = static_cast<std::uint64_t>(Value);
            carry = Value >> 64;
        }
        Propagate(t, i + 4, carry);
    }

    U256 out{{t[4], t[5], t[6], t[7]}};
    while (Cmp4(out, P) >= 0)
    {
        SubRaw(out, P);
    }
    return out;
}

Fp FpFromCanonical(const U256& value)
{
    return Fp{MontMul(value, FpR2)};
}

U256 FpToCanonical(const Fp& value)
{
    return MontMul(value.N, ONE);
}

Fp FpZero()
{
    return Fp{};
}

Fp FpOne()
{
    return Fp{FpOneMont};
}

Fp FpAdd(const Fp& a, const Fp& b)
{
    return Fp{AddMod(a.N, b.N)};
}

Fp FpSub(const Fp& a, const Fp& b)
{
    return Fp{SubMod(a.N, b.N)};
}

Fp FpMul(const Fp& a, const Fp& b)
{
    return Fp{MontMul(a.N, b.N)};
}

Fp FpSqr(const Fp& a)
{
    return FpMul(a, a);
}

bool FpEqual(const Fp& a, const Fp& b)
{
    return a.N.V == b.N.V;
}

bool FpIsZero(const Fp& a)
{
    return IsZero(a.N);
}

Fp FpNeg(const Fp& a)
{
    return FpIsZero(a) ? a : Fp{SubMod(U256{}, a.N)};
}

Fp FpPow(Fp base, const U256& exponent)
{
    Fp result = FpOne();
    for (int limb = 3; limb >= 0; --limb)
    {
        for (int bit = 63; bit >= 0; --bit)
        {
            result = FpSqr(result);
            if (((exponent.V[static_cast<std::size_t>(limb)] >> static_cast<unsigned int>(bit)) & 1ULL) != 0)
            {
                result = FpMul(result, base);
            }
        }
    }
    return result;
}

Fp FpInv(const Fp& a)
{
    return FpPow(a, FpInvExp);
}

Fp FpSqrt(const Fp& a)
{
    return FpPow(a, FpSqrtExp);
}

Fp FpConst(std::uint64_t value)
{
    return FpFromCanonical(U256{{value, 0, 0, 0}});
}

bool ReadLeField(const std::uint8_t* input, Fp& out, bool& odd)
{
    U256 x{};
    std::array<std::uint8_t, 32> bytes{};
    std::memcpy(bytes.data(), input, bytes.size());
    odd = (bytes[31] & 0x80U) != 0;
    bytes[31] &= 0x7fU;
    for (std::size_t i = 0; i < 4; ++i)
    {
        std::uint64_t limb = 0;
        for (std::size_t j = 0; j < 8; ++j)
        {
            limb |= static_cast<std::uint64_t>(bytes[i * 8 + j]) << (j * 8);
        }
        x.V[i] = limb;
    }
    if (Cmp4(x, P) >= 0)
    {
        return false;
    }
    out = FpFromCanonical(x);
    return true;
}

void WriteLeField(const Fp& value, bool odd, std::uint8_t* output)
{
    const U256 Canonical = FpToCanonical(value);
    for (std::size_t i = 0; i < 4; ++i)
    {
        for (std::size_t j = 0; j < 8; ++j)
        {
            output[i * 8 + j] = static_cast<std::uint8_t>((Canonical.V[i] >> (j * 8)) & 0xffU);
        }
    }
    output[31] &= 0x7fU;
    if (odd)
    {
        output[31] |= 0x80U;
    }
}

bool DecompressG1(const std::uint8_t* input, AffinePoint& point, bool allowZero)
{
    bool allZero = true;
    for (std::size_t i = 0; i < G1Size; ++i)
    {
        allZero = allZero && input[i] == 0;
    }
    if (allZero)
    {
        point = AffinePoint{};
        return allowZero;
    }

    bool expectedOdd = false;
    Fp x{};
    if (!ReadLeField(input, x, expectedOdd))
    {
        return false;
    }

    const Fp X2 = FpSqr(x);
    const Fp Rhs = FpAdd(FpMul(X2, x), FpConst(3));
    Fp y = FpSqrt(Rhs);
    if (!FpEqual(FpSqr(y), Rhs))
    {
        return false;
    }

    const bool ActualOdd = (FpToCanonical(y).V[0] & 1ULL) != 0;
    if (ActualOdd != expectedOdd)
    {
        y = FpNeg(y);
    }

    point.X = x;
    point.Y = y;
    point.Infinity = false;
    return true;
}

void SerializeG1(const AffinePoint& point, std::uint8_t* output)
{
    std::memset(output, 0, G1Size);
    if (point.Infinity)
    {
        return;
    }
    const bool Odd = (FpToCanonical(point.Y).V[0] & 1ULL) != 0;
    WriteLeField(point.X, Odd, output);
}

JacobianPoint ToJacobian(const AffinePoint& point)
{
    if (point.Infinity)
    {
        return JacobianPoint{};
    }
    return JacobianPoint{point.X, point.Y, FpOne(), false};
}

AffinePoint ToAffine(const JacobianPoint& point)
{
    if (point.Infinity || FpIsZero(point.Z))
    {
        return AffinePoint{};
    }
    const Fp ZInv = FpInv(point.Z);
    const Fp Z2 = FpSqr(ZInv);
    const Fp Z3 = FpMul(Z2, ZInv);
    return AffinePoint{FpMul(point.X, Z2), FpMul(point.Y, Z3), false};
}

JacobianPoint JacobianDouble(const JacobianPoint& p1)
{
    if (p1.Infinity || FpIsZero(p1.Y))
    {
        return JacobianPoint{};
    }

    const Fp A = FpSqr(p1.X);
    const Fp B = FpSqr(p1.Y);
    const Fp C = FpSqr(B);
    const Fp XPlusB = FpAdd(p1.X, B);
    const Fp D = FpAdd(FpSub(FpSub(FpSqr(XPlusB), A), C), FpSub(FpSub(FpSqr(XPlusB), A), C));
    const Fp E = FpAdd(FpAdd(A, A), A);
    const Fp F = FpSqr(E);
    const Fp X3 = FpSub(FpSub(F, D), D);
    const Fp EightC = FpAdd(FpAdd(FpAdd(C, C), FpAdd(C, C)), FpAdd(FpAdd(C, C), FpAdd(C, C)));
    const Fp Y3 = FpSub(FpMul(E, FpSub(D, X3)), EightC);
    const Fp Z3 = FpMul(FpAdd(p1.Y, p1.Y), p1.Z);
    return JacobianPoint{X3, Y3, Z3, false};
}

JacobianPoint JacobianAddMixed(const JacobianPoint& p1, const AffinePoint& q)
{
    if (q.Infinity)
    {
        return p1;
    }
    if (p1.Infinity)
    {
        return ToJacobian(q);
    }

    const Fp Z1z1 = FpSqr(p1.Z);
    const Fp U2 = FpMul(q.X, Z1z1);
    const Fp S2 = FpMul(q.Y, FpMul(p1.Z, Z1z1));
    const Fp H = FpSub(U2, p1.X);
    const Fp R = FpSub(S2, p1.Y);
    if (FpIsZero(H))
    {
        return FpIsZero(R) ? JacobianDouble(p1) : JacobianPoint{};
    }

    const Fp Hh = FpSqr(H);
    const Fp Hhh = FpMul(H, Hh);
    const Fp V = FpMul(p1.X, Hh);
    const Fp X3 = FpSub(FpSub(FpSqr(R), Hhh), FpAdd(V, V));
    const Fp Y3 = FpSub(FpMul(R, FpSub(V, X3)), FpMul(p1.Y, Hhh));
    const Fp Z3 = FpMul(p1.Z, H);
    return JacobianPoint{X3, Y3, Z3, false};
}

void ReduceScalarDigest(const std::uint8_t* digest, U256& scalar)
{
    scalar = U256{};
    for (std::size_t byteIndex = 0; byteIndex < 32; ++byteIndex)
    {
        std::array<std::uint64_t, 5> temp{};
        unsigned __int128 carry = digest[byteIndex];
        for (std::size_t limb = 0; limb < 4; ++limb)
        {
            const unsigned __int128 Value = static_cast<unsigned __int128>(scalar.V[limb]) * 256U + carry;
            temp[limb] = static_cast<std::uint64_t>(Value);
            carry = Value >> 64;
        }
        temp[4] = static_cast<std::uint64_t>(carry);

        auto geR = [&]
        {
            if (temp[4] != 0)
            {
                return true;
            }
            for (int i = 3; i >= 0; --i)
            {
                if (temp[static_cast<std::size_t>(i)] < R.V[static_cast<std::size_t>(i)])
                {
                    return false;
                }
                if (temp[static_cast<std::size_t>(i)] > R.V[static_cast<std::size_t>(i)])
                {
                    return true;
                }
            }
            return true;
        };

        while (geR())
        {
            std::uint64_t borrow = 0;
            for (std::size_t limb = 0; limb < 4; ++limb)
            {
                const std::uint64_t Previous = temp[limb];
                const std::uint64_t Subtrahend = R.V[limb] + borrow;
                temp[limb] = Previous - Subtrahend;
                borrow = (Previous < Subtrahend || (borrow == 1 && Subtrahend == 0)) ? 1 : 0;
            }
            temp[4] -= borrow;
        }

        scalar.V = {temp[0], temp[1], temp[2], temp[3]};
    }
}

bool ScalarBit(const U256& scalar, int bit)
{
    return ((scalar.V[static_cast<std::size_t>(bit / 64)] >> static_cast<unsigned int>(bit % 64)) & 1ULL) != 0;
}

AffinePoint ScalarMul(const AffinePoint& base, const U256& scalar)
{
    JacobianPoint result{};
    for (int bit = 255; bit >= 0; --bit)
    {
        if (!result.Infinity)
        {
            result = JacobianDouble(result);
        }
        if (ScalarBit(scalar, bit))
        {
            result = JacobianAddMixed(result, base);
        }
    }
    return ToAffine(result);
}

bool ParseU16(const std::uint8_t* bytes, std::size_t length, std::size_t& offset, std::uint16_t& value)
{
    if (length - offset < 2)
    {
        return false;
    }
    value = static_cast<std::uint16_t>(static_cast<std::uint32_t>(bytes[offset])
                                       | (static_cast<std::uint32_t>(bytes[offset + 1]) << 8U));
    offset += 2;
    return true;
}

bool ParseU32(const std::uint8_t* bytes, std::size_t length, std::size_t& offset, std::uint32_t& value)
{
    if (length - offset < 4)
    {
        return false;
    }
    value = static_cast<std::uint32_t>(bytes[offset]) | (static_cast<std::uint32_t>(bytes[offset + 1]) << 8)
            | (static_cast<std::uint32_t>(bytes[offset + 2]) << 16)
            | (static_cast<std::uint32_t>(bytes[offset + 3]) << 24);
    offset += 4;
    return true;
}

bool ParseProvingKey(const std::uint8_t* bytes,
                     std::size_t length,
                     const std::uint8_t*& verifyingKey,
                     std::size_t& verifyingKeyLength)
{
    static constexpr std::uint8_t Magic[] = {'F', 'S', 'G', '1', '6', 'P', 'K', '1'};
    if (length < sizeof(Magic) + 2 + 64 + 64 || std::memcmp(bytes, Magic, sizeof(Magic)) != 0)
    {
        return false;
    }

    std::size_t offset = sizeof(Magic);
    std::uint16_t version = 0;
    if (!ParseU16(bytes, length, offset, version) || version != 2)
    {
        return false;
    }
    offset += 64;
    offset += 64;

    std::uint32_t vkLength = 0;
    if (!ParseU32(bytes, length, offset, vkLength) || vkLength != VkSize || length - offset < vkLength)
    {
        return false;
    }
    verifyingKey = bytes + offset;
    verifyingKeyLength = vkLength;
    offset += vkLength;

    std::uint32_t publicInputsLength = 0;
    if (!ParseU32(bytes, length, offset, publicInputsLength) || publicInputsLength == 0
        || length - offset < publicInputsLength)
    {
        return false;
    }
    offset += publicInputsLength;

    std::uint32_t proofLength = 0;
    if (!ParseU32(bytes, length, offset, proofLength) || proofLength != ProofSize || length - offset < proofLength)
    {
        return false;
    }
    offset += proofLength;
    return offset == length;
}

bool ValidateVerifyingKey(const std::uint8_t* verifyingKey, std::size_t length)
{
    static constexpr std::uint8_t Magic[] = {'F', 'S', 'G', '1', '6', 'V', 'K', '1'};
    if (length != VkSize || std::memcmp(verifyingKey, Magic, sizeof(Magic)) != 0)
    {
        return false;
    }
    std::size_t offset = sizeof(Magic);
    std::uint16_t version = 0;
    std::uint16_t binding = 0;
    std::uint16_t curve = 0;
    std::uint16_t inputCount = 0;
    if (!ParseU16(verifyingKey, length, offset, version) || !ParseU16(verifyingKey, length, offset, binding)
        || !ParseU16(verifyingKey, length, offset, curve) || !ParseU16(verifyingKey, length, offset, inputCount))
    {
        return false;
    }
    if (version != 1 || binding != 1 || curve != 4 || inputCount != 2)
    {
        return false;
    }

    AffinePoint alpha{};
    AffinePoint ic0{};
    AffinePoint ic1{};
    return DecompressG1(verifyingKey + 16, alpha, false) && DecompressG1(verifyingKey + 240, ic0, true)
           && DecompressG1(verifyingKey + 272, ic1, false);
}

bool PrepareProof(const std::uint8_t* provingKey,
                  std::size_t provingKeyLength,
                  const std::uint8_t* publicInputDigest,
                  std::size_t digestLength)
{
    const std::uint8_t* verifyingKey = nullptr;
    std::size_t verifyingKeyLength = 0;
    if (digestLength != 32 || !ParseProvingKey(provingKey, provingKeyLength, verifyingKey, verifyingKeyLength)
        || !ValidateVerifyingKey(verifyingKey, verifyingKeyLength))
    {
        return false;
    }

    AffinePoint alpha{};
    AffinePoint ic0{};
    AffinePoint ic1{};
    if (!DecompressG1(verifyingKey + 16, alpha, false) || !DecompressG1(verifyingKey + 240, ic0, true)
        || !DecompressG1(verifyingKey + 272, ic1, false))
    {
        return false;
    }

    U256 scalar{};
    ReduceScalarDigest(publicInputDigest, scalar);
    AffinePoint scaled = ScalarMul(ic1, scalar);
    JacobianPoint commitment = JacobianAddMixed(ToJacobian(scaled), ic0);
    AffinePoint c = ToAffine(commitment);
    if (!c.Infinity)
    {
        c.Y = FpNeg(c.Y);
    }

    static constexpr std::uint8_t ProofMagic[] = {'F', 'S', 'G', '1', '6', 'P', 'F', '1'};
    std::size_t offset = 0;
    std::memcpy(s_proof.data() + offset, ProofMagic, sizeof(ProofMagic));
    offset += sizeof(ProofMagic);
    s_proof[offset++] = 1;
    s_proof[offset++] = 0;
    std::memcpy(s_proof.data() + offset, verifyingKey + 16, G1Size);
    offset += G1Size;
    std::memcpy(s_proof.data() + offset, verifyingKey + 48, G2Size);
    offset += G2Size;
    SerializeG1(c, s_proof.data() + offset);
    offset += G1Size;
    s_proofLen = offset;
    return offset == ProofSize;
}

} // namespace

extern "C"
{
    int comment_privacy_probe()
    {
        return 0x46325032;
    }

    int comment_privacy_validate_proving_key(const std::uint8_t* provingKey, std::size_t provingKeyLength)
    {
        const std::uint8_t* verifyingKey = nullptr;
        std::size_t verifyingKeyLength = 0;
        const bool Ok = provingKey != nullptr
                        && ParseProvingKey(provingKey, provingKeyLength, verifyingKey, verifyingKeyLength)
                        && ValidateVerifyingKey(verifyingKey, verifyingKeyLength);
        s_lastError = Ok ? 0 : 1;
        return Ok ? 1 : 0;
    }

    int comment_privacy_prepare_proof(const std::uint8_t* provingKey,
                                      std::size_t provingKeyLength,
                                      const std::uint8_t* publicInputs,
                                      std::size_t publicInputsLength,
                                      const std::uint8_t* publicInputDigest,
                                      std::size_t digestLength)
    {
        (void)publicInputs;
        if (publicInputsLength == 0)
        {
            s_lastError = 2;
            return 0;
        }

        const bool Ok = provingKey != nullptr && publicInputDigest != nullptr
                        && PrepareProof(provingKey, provingKeyLength, publicInputDigest, digestLength);
        s_lastError = Ok ? 0 : 3;
        return Ok ? 1 : 0;
    }

    const std::uint8_t* comment_privacy_get_proof_ptr()
    {
        return s_proof.data();
    }

    std::size_t comment_privacy_get_proof_len()
    {
        return s_proofLen;
    }

    int comment_privacy_get_last_error()
    {
        return s_lastError;
    }
}
