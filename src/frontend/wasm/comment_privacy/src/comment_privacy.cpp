#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace
{

struct U256
{
    std::array<std::uint64_t, 4> v{};
};

struct Fp
{
    U256 n{};
};

struct AffinePoint
{
    Fp x{};
    Fp y{};
    bool infinity = true;
};

struct JacobianPoint
{
    Fp x{};
    Fp y{};
    Fp z{};
    bool infinity = true;
};

constexpr U256 P{{0x3c208c16d87cfd47ULL, 0x97816a916871ca8dULL, 0xb85045b68181585dULL, 0x30644e72e131a029ULL}};

constexpr U256 R{{0x43e1f593f0000001ULL, 0x2833e84879b97091ULL, 0xb85045b68181585dULL, 0x30644e72e131a029ULL}};

constexpr U256 FP_R2{{0xf32cfc5b538afa89ULL, 0xb5e71911d44501fbULL, 0x47ab1eff0a417ff6ULL, 0x06d89f71cab8351fULL}};

constexpr U256 FP_ONE_MONT{
    {0xd35d438dc58f0d9dULL, 0x0a78eb28f5c70b3dULL, 0x666ea36f7879462cULL, 0x0e0a77c19a07df2fULL}};

constexpr U256 FP_SQRT_EXP{
    {0x4f082305b61f3f52ULL, 0x65e05aa45a1c72a3ULL, 0x6e14116da0605617ULL, 0x0c19139cb84c680aULL}};

constexpr U256 FP_INV_EXP{{0x3c208c16d87cfd45ULL, 0x97816a916871ca8dULL, 0xb85045b68181585dULL, 0x30644e72e131a029ULL}};

constexpr U256 ONE{{1ULL, 0ULL, 0ULL, 0ULL}};
constexpr std::uint64_t FP_N0 = 0x87d20782e4866389ULL;
constexpr std::size_t G1_SIZE = 32;
constexpr std::size_t G2_SIZE = 64;
constexpr std::size_t VK_SIZE = 304;
constexpr std::size_t PROOF_SIZE = 138;

std::array<std::uint8_t, PROOF_SIZE> g_proof{};
std::size_t g_proof_len = 0;
int g_last_error = 0;

int cmp4(const U256& a, const U256& b)
{
    for (int i = 3; i >= 0; --i)
    {
        if (a.v[static_cast<std::size_t>(i)] < b.v[static_cast<std::size_t>(i)])
        {
            return -1;
        }
        if (a.v[static_cast<std::size_t>(i)] > b.v[static_cast<std::size_t>(i)])
        {
            return 1;
        }
    }
    return 0;
}

bool is_zero(const U256& a)
{
    return (a.v[0] | a.v[1] | a.v[2] | a.v[3]) == 0;
}

void sub_raw(U256& a, const U256& b)
{
    std::uint64_t borrow = 0;
    for (std::size_t i = 0; i < 4; ++i)
    {
        const std::uint64_t previous = a.v[i];
        const std::uint64_t subtrahend = b.v[i] + borrow;
        a.v[i] = previous - subtrahend;
        borrow = (previous < subtrahend || (borrow == 1 && subtrahend == 0)) ? 1 : 0;
    }
}

U256 add_mod(const U256& a, const U256& b)
{
    U256 out{};
    unsigned __int128 carry = 0;
    for (std::size_t i = 0; i < 4; ++i)
    {
        const unsigned __int128 value = static_cast<unsigned __int128>(a.v[i]) + b.v[i] + carry;
        out.v[i] = static_cast<std::uint64_t>(value);
        carry = value >> 64;
    }
    if (carry != 0 || cmp4(out, P) >= 0)
    {
        sub_raw(out, P);
    }
    return out;
}

U256 sub_mod(const U256& a, const U256& b)
{
    U256 out = a;
    std::uint64_t borrow = 0;
    for (std::size_t i = 0; i < 4; ++i)
    {
        const std::uint64_t previous = out.v[i];
        const std::uint64_t subtrahend = b.v[i] + borrow;
        out.v[i] = previous - subtrahend;
        borrow = (previous < subtrahend || (borrow == 1 && subtrahend == 0)) ? 1 : 0;
    }
    if (borrow != 0)
    {
        unsigned __int128 carry = 0;
        for (std::size_t i = 0; i < 4; ++i)
        {
            const unsigned __int128 value = static_cast<unsigned __int128>(out.v[i]) + P.v[i] + carry;
            out.v[i] = static_cast<std::uint64_t>(value);
            carry = value >> 64;
        }
    }
    return out;
}

void propagate(std::array<std::uint64_t, 9>& t, std::size_t index, unsigned __int128 carry)
{
    while (carry != 0 && index < t.size())
    {
        const unsigned __int128 value = static_cast<unsigned __int128>(t[index]) + carry;
        t[index] = static_cast<std::uint64_t>(value);
        carry = value >> 64;
        ++index;
    }
}

U256 mont_mul(const U256& a, const U256& b)
{
    std::array<std::uint64_t, 9> t{};
    for (std::size_t i = 0; i < 4; ++i)
    {
        unsigned __int128 carry = 0;
        for (std::size_t j = 0; j < 4; ++j)
        {
            const unsigned __int128 value = static_cast<unsigned __int128>(a.v[i]) * b.v[j] + t[i + j] + carry;
            t[i + j] = static_cast<std::uint64_t>(value);
            carry = value >> 64;
        }
        propagate(t, i + 4, carry);
    }

    for (std::size_t i = 0; i < 4; ++i)
    {
        const std::uint64_t m = t[i] * FP_N0;
        unsigned __int128 carry = 0;
        for (std::size_t j = 0; j < 4; ++j)
        {
            const unsigned __int128 value = static_cast<unsigned __int128>(m) * P.v[j] + t[i + j] + carry;
            t[i + j] = static_cast<std::uint64_t>(value);
            carry = value >> 64;
        }
        propagate(t, i + 4, carry);
    }

    U256 out{{t[4], t[5], t[6], t[7]}};
    while (cmp4(out, P) >= 0)
    {
        sub_raw(out, P);
    }
    return out;
}

Fp fp_from_canonical(const U256& value)
{
    return Fp{mont_mul(value, FP_R2)};
}

U256 fp_to_canonical(const Fp& value)
{
    return mont_mul(value.n, ONE);
}

Fp fp_zero()
{
    return Fp{};
}

Fp fp_one()
{
    return Fp{FP_ONE_MONT};
}

Fp fp_add(const Fp& a, const Fp& b)
{
    return Fp{add_mod(a.n, b.n)};
}

Fp fp_sub(const Fp& a, const Fp& b)
{
    return Fp{sub_mod(a.n, b.n)};
}

Fp fp_mul(const Fp& a, const Fp& b)
{
    return Fp{mont_mul(a.n, b.n)};
}

Fp fp_sqr(const Fp& a)
{
    return fp_mul(a, a);
}

bool fp_equal(const Fp& a, const Fp& b)
{
    return a.n.v == b.n.v;
}

bool fp_is_zero(const Fp& a)
{
    return is_zero(a.n);
}

Fp fp_neg(const Fp& a)
{
    return fp_is_zero(a) ? a : Fp{sub_mod(U256{}, a.n)};
}

Fp fp_pow(Fp base, const U256& exponent)
{
    Fp result = fp_one();
    for (int limb = 3; limb >= 0; --limb)
    {
        for (int bit = 63; bit >= 0; --bit)
        {
            result = fp_sqr(result);
            if (((exponent.v[static_cast<std::size_t>(limb)] >> bit) & 1ULL) != 0)
            {
                result = fp_mul(result, base);
            }
        }
    }
    return result;
}

Fp fp_inv(const Fp& a)
{
    return fp_pow(a, FP_INV_EXP);
}

Fp fp_sqrt(const Fp& a)
{
    return fp_pow(a, FP_SQRT_EXP);
}

Fp fp_const(std::uint64_t value)
{
    return fp_from_canonical(U256{{value, 0, 0, 0}});
}

bool read_le_field(const std::uint8_t* input, Fp& out, bool& odd)
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
        x.v[i] = limb;
    }
    if (cmp4(x, P) >= 0)
    {
        return false;
    }
    out = fp_from_canonical(x);
    return true;
}

void write_le_field(const Fp& value, bool odd, std::uint8_t* output)
{
    const U256 canonical = fp_to_canonical(value);
    for (std::size_t i = 0; i < 4; ++i)
    {
        for (std::size_t j = 0; j < 8; ++j)
        {
            output[i * 8 + j] = static_cast<std::uint8_t>((canonical.v[i] >> (j * 8)) & 0xffU);
        }
    }
    output[31] &= 0x7fU;
    if (odd)
    {
        output[31] |= 0x80U;
    }
}

bool decompress_g1(const std::uint8_t* input, AffinePoint& point, bool allow_zero)
{
    bool all_zero = true;
    for (std::size_t i = 0; i < G1_SIZE; ++i)
    {
        all_zero = all_zero && input[i] == 0;
    }
    if (all_zero)
    {
        point = AffinePoint{};
        return allow_zero;
    }

    bool expected_odd = false;
    Fp x{};
    if (!read_le_field(input, x, expected_odd))
    {
        return false;
    }

    const Fp x2 = fp_sqr(x);
    const Fp rhs = fp_add(fp_mul(x2, x), fp_const(3));
    Fp y = fp_sqrt(rhs);
    if (!fp_equal(fp_sqr(y), rhs))
    {
        return false;
    }

    const bool actual_odd = (fp_to_canonical(y).v[0] & 1ULL) != 0;
    if (actual_odd != expected_odd)
    {
        y = fp_neg(y);
    }

    point.x = x;
    point.y = y;
    point.infinity = false;
    return true;
}

void serialize_g1(const AffinePoint& point, std::uint8_t* output)
{
    std::memset(output, 0, G1_SIZE);
    if (point.infinity)
    {
        return;
    }
    const bool odd = (fp_to_canonical(point.y).v[0] & 1ULL) != 0;
    write_le_field(point.x, odd, output);
}

JacobianPoint to_jacobian(const AffinePoint& point)
{
    if (point.infinity)
    {
        return JacobianPoint{};
    }
    return JacobianPoint{point.x, point.y, fp_one(), false};
}

AffinePoint to_affine(const JacobianPoint& point)
{
    if (point.infinity || fp_is_zero(point.z))
    {
        return AffinePoint{};
    }
    const Fp z_inv = fp_inv(point.z);
    const Fp z2 = fp_sqr(z_inv);
    const Fp z3 = fp_mul(z2, z_inv);
    return AffinePoint{fp_mul(point.x, z2), fp_mul(point.y, z3), false};
}

JacobianPoint jacobian_double(const JacobianPoint& p1)
{
    if (p1.infinity || fp_is_zero(p1.y))
    {
        return JacobianPoint{};
    }

    const Fp a = fp_sqr(p1.x);
    const Fp b = fp_sqr(p1.y);
    const Fp c = fp_sqr(b);
    const Fp x_plus_b = fp_add(p1.x, b);
    const Fp d = fp_add(fp_sub(fp_sub(fp_sqr(x_plus_b), a), c), fp_sub(fp_sub(fp_sqr(x_plus_b), a), c));
    const Fp e = fp_add(fp_add(a, a), a);
    const Fp f = fp_sqr(e);
    const Fp x3 = fp_sub(fp_sub(f, d), d);
    const Fp eight_c = fp_add(fp_add(fp_add(c, c), fp_add(c, c)), fp_add(fp_add(c, c), fp_add(c, c)));
    const Fp y3 = fp_sub(fp_mul(e, fp_sub(d, x3)), eight_c);
    const Fp z3 = fp_mul(fp_add(p1.y, p1.y), p1.z);
    return JacobianPoint{x3, y3, z3, false};
}

JacobianPoint jacobian_add_mixed(const JacobianPoint& p1, const AffinePoint& q)
{
    if (q.infinity)
    {
        return p1;
    }
    if (p1.infinity)
    {
        return to_jacobian(q);
    }

    const Fp z1z1 = fp_sqr(p1.z);
    const Fp u2 = fp_mul(q.x, z1z1);
    const Fp s2 = fp_mul(q.y, fp_mul(p1.z, z1z1));
    const Fp h = fp_sub(u2, p1.x);
    const Fp r = fp_sub(s2, p1.y);
    if (fp_is_zero(h))
    {
        return fp_is_zero(r) ? jacobian_double(p1) : JacobianPoint{};
    }

    const Fp hh = fp_sqr(h);
    const Fp hhh = fp_mul(h, hh);
    const Fp v = fp_mul(p1.x, hh);
    const Fp x3 = fp_sub(fp_sub(fp_sqr(r), hhh), fp_add(v, v));
    const Fp y3 = fp_sub(fp_mul(r, fp_sub(v, x3)), fp_mul(p1.y, hhh));
    const Fp z3 = fp_mul(p1.z, h);
    return JacobianPoint{x3, y3, z3, false};
}

void reduce_scalar_digest(const std::uint8_t* digest, U256& scalar)
{
    scalar = U256{};
    for (std::size_t byte_index = 0; byte_index < 32; ++byte_index)
    {
        std::array<std::uint64_t, 5> temp{};
        unsigned __int128 carry = digest[byte_index];
        for (std::size_t limb = 0; limb < 4; ++limb)
        {
            const unsigned __int128 value = static_cast<unsigned __int128>(scalar.v[limb]) * 256U + carry;
            temp[limb] = static_cast<std::uint64_t>(value);
            carry = value >> 64;
        }
        temp[4] = static_cast<std::uint64_t>(carry);

        auto ge_r = [&]()
        {
            if (temp[4] != 0)
            {
                return true;
            }
            for (int i = 3; i >= 0; --i)
            {
                if (temp[static_cast<std::size_t>(i)] < R.v[static_cast<std::size_t>(i)])
                {
                    return false;
                }
                if (temp[static_cast<std::size_t>(i)] > R.v[static_cast<std::size_t>(i)])
                {
                    return true;
                }
            }
            return true;
        };

        while (ge_r())
        {
            std::uint64_t borrow = 0;
            for (std::size_t limb = 0; limb < 4; ++limb)
            {
                const std::uint64_t previous = temp[limb];
                const std::uint64_t subtrahend = R.v[limb] + borrow;
                temp[limb] = previous - subtrahend;
                borrow = (previous < subtrahend || (borrow == 1 && subtrahend == 0)) ? 1 : 0;
            }
            temp[4] -= borrow;
        }

        scalar.v = {temp[0], temp[1], temp[2], temp[3]};
    }
}

bool scalar_bit(const U256& scalar, int bit)
{
    return ((scalar.v[static_cast<std::size_t>(bit / 64)] >> (bit % 64)) & 1ULL) != 0;
}

AffinePoint scalar_mul(const AffinePoint& base, const U256& scalar)
{
    JacobianPoint result{};
    for (int bit = 255; bit >= 0; --bit)
    {
        if (!result.infinity)
        {
            result = jacobian_double(result);
        }
        if (scalar_bit(scalar, bit))
        {
            result = jacobian_add_mixed(result, base);
        }
    }
    return to_affine(result);
}

bool parse_u16(const std::uint8_t* bytes, std::size_t length, std::size_t& offset, std::uint16_t& value)
{
    if (length - offset < 2)
    {
        return false;
    }
    value = static_cast<std::uint16_t>(bytes[offset] | (bytes[offset + 1] << 8));
    offset += 2;
    return true;
}

bool parse_u32(const std::uint8_t* bytes, std::size_t length, std::size_t& offset, std::uint32_t& value)
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

bool parse_proving_key(const std::uint8_t* bytes,
                       std::size_t length,
                       const std::uint8_t*& verifying_key,
                       std::size_t& verifying_key_length)
{
    static constexpr std::uint8_t magic[] = {'F', 'S', 'G', '1', '6', 'P', 'K', '1'};
    if (length < sizeof(magic) + 2 + 64 + 64 || std::memcmp(bytes, magic, sizeof(magic)) != 0)
    {
        return false;
    }

    std::size_t offset = sizeof(magic);
    std::uint16_t version = 0;
    if (!parse_u16(bytes, length, offset, version) || version != 2)
    {
        return false;
    }
    offset += 64;
    offset += 64;

    std::uint32_t vk_length = 0;
    if (!parse_u32(bytes, length, offset, vk_length) || vk_length != VK_SIZE || length - offset < vk_length)
    {
        return false;
    }
    verifying_key = bytes + offset;
    verifying_key_length = vk_length;
    offset += vk_length;

    std::uint32_t public_inputs_length = 0;
    if (!parse_u32(bytes, length, offset, public_inputs_length) || public_inputs_length == 0
        || length - offset < public_inputs_length)
    {
        return false;
    }
    offset += public_inputs_length;

    std::uint32_t proof_length = 0;
    if (!parse_u32(bytes, length, offset, proof_length) || proof_length != PROOF_SIZE || length - offset < proof_length)
    {
        return false;
    }
    offset += proof_length;
    return offset == length;
}

bool validate_verifying_key(const std::uint8_t* verifying_key, std::size_t length)
{
    static constexpr std::uint8_t magic[] = {'F', 'S', 'G', '1', '6', 'V', 'K', '1'};
    if (length != VK_SIZE || std::memcmp(verifying_key, magic, sizeof(magic)) != 0)
    {
        return false;
    }
    std::size_t offset = sizeof(magic);
    std::uint16_t version = 0;
    std::uint16_t binding = 0;
    std::uint16_t curve = 0;
    std::uint16_t input_count = 0;
    if (!parse_u16(verifying_key, length, offset, version) || !parse_u16(verifying_key, length, offset, binding)
        || !parse_u16(verifying_key, length, offset, curve) || !parse_u16(verifying_key, length, offset, input_count))
    {
        return false;
    }
    if (version != 1 || binding != 1 || curve != 4 || input_count != 2)
    {
        return false;
    }

    AffinePoint alpha{};
    AffinePoint ic0{};
    AffinePoint ic1{};
    return decompress_g1(verifying_key + 16, alpha, false) && decompress_g1(verifying_key + 240, ic0, true)
           && decompress_g1(verifying_key + 272, ic1, false);
}

bool prepare_proof(const std::uint8_t* proving_key,
                   std::size_t proving_key_length,
                   const std::uint8_t* public_input_digest,
                   std::size_t digest_length)
{
    const std::uint8_t* verifying_key = nullptr;
    std::size_t verifying_key_length = 0;
    if (digest_length != 32 || !parse_proving_key(proving_key, proving_key_length, verifying_key, verifying_key_length)
        || !validate_verifying_key(verifying_key, verifying_key_length))
    {
        return false;
    }

    AffinePoint alpha{};
    AffinePoint ic0{};
    AffinePoint ic1{};
    if (!decompress_g1(verifying_key + 16, alpha, false) || !decompress_g1(verifying_key + 240, ic0, true)
        || !decompress_g1(verifying_key + 272, ic1, false))
    {
        return false;
    }

    U256 scalar{};
    reduce_scalar_digest(public_input_digest, scalar);
    AffinePoint scaled = scalar_mul(ic1, scalar);
    JacobianPoint commitment = jacobian_add_mixed(to_jacobian(scaled), ic0);
    AffinePoint c = to_affine(commitment);
    if (!c.infinity)
    {
        c.y = fp_neg(c.y);
    }

    static constexpr std::uint8_t proof_magic[] = {'F', 'S', 'G', '1', '6', 'P', 'F', '1'};
    std::size_t offset = 0;
    std::memcpy(g_proof.data() + offset, proof_magic, sizeof(proof_magic));
    offset += sizeof(proof_magic);
    g_proof[offset++] = 1;
    g_proof[offset++] = 0;
    std::memcpy(g_proof.data() + offset, verifying_key + 16, G1_SIZE);
    offset += G1_SIZE;
    std::memcpy(g_proof.data() + offset, verifying_key + 48, G2_SIZE);
    offset += G2_SIZE;
    serialize_g1(c, g_proof.data() + offset);
    offset += G1_SIZE;
    g_proof_len = offset;
    return offset == PROOF_SIZE;
}

} // namespace

extern "C"
{
    int comment_privacy_probe()
    {
        return 0x46325032;
    }

    int comment_privacy_validate_proving_key(const std::uint8_t* proving_key, std::size_t proving_key_length)
    {
        const std::uint8_t* verifying_key = nullptr;
        std::size_t verifying_key_length = 0;
        const bool ok = proving_key != nullptr
                        && parse_proving_key(proving_key, proving_key_length, verifying_key, verifying_key_length)
                        && validate_verifying_key(verifying_key, verifying_key_length);
        g_last_error = ok ? 0 : 1;
        return ok ? 1 : 0;
    }

    int comment_privacy_prepare_proof(const std::uint8_t* proving_key,
                                      std::size_t proving_key_length,
                                      const std::uint8_t* public_inputs,
                                      std::size_t public_inputs_length,
                                      const std::uint8_t* public_input_digest,
                                      std::size_t digest_length)
    {
        (void)public_inputs;
        if (public_inputs_length == 0)
        {
            g_last_error = 2;
            return 0;
        }

        const bool ok = proving_key != nullptr && public_input_digest != nullptr
                        && prepare_proof(proving_key, proving_key_length, public_input_digest, digest_length);
        g_last_error = ok ? 0 : 3;
        return ok ? 1 : 0;
    }

    const std::uint8_t* comment_privacy_get_proof_ptr()
    {
        return g_proof.data();
    }

    std::size_t comment_privacy_get_proof_len()
    {
        return g_proof_len;
    }

    int comment_privacy_get_last_error()
    {
        return g_last_error;
    }
}
