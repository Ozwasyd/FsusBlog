#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <setjmp.h>
#include <string>
#include <vector>
#ifdef FSUSBLOG_IMAGE_CODEC_ENABLE_JPEG
#include <jpeglib.h>
#endif
#ifdef FSUSBLOG_IMAGE_CODEC_ENABLE_WEBP
#include <webp/encode.h>
#endif
#ifdef FSUSBLOG_IMAGE_CODEC_ENABLE_AVIF
#include <avif/avif.h>
#endif

namespace
{
enum class ErrorCode : std::uint8_t
{
    None = 0,
    InvalidInput = 1,
    DimensionInvalid = 2,
    RgbaSizeMismatch = 3,
    FormatNotSupported = 4,
    NeedFallback = 5,
    EncodeFailed = 6
};

constexpr const char *kCodecVersion = "fsus-image-codec/0.2.0";
#if defined(__wasm_simd128__)
constexpr const char *kCodecLevel = "simd";
#else
constexpr const char *kCodecLevel = "basic";
#endif

constexpr std::uint32_t fnv1a(const char *value)
{
    std::uint32_t hash = 2166136261u;
    while (*value != '\0')
    {
        hash ^= static_cast<std::uint8_t>(*value++);
        hash *= 16777619u;
    }
    return hash;
}

constexpr std::uint32_t kFormatPng = fnv1a("png");
constexpr std::uint32_t kFormatWebp = fnv1a("webp");
constexpr std::uint32_t kFormatAvif = fnv1a("avif");
constexpr std::uint32_t kFormatJpeg = fnv1a("jpeg");
constexpr std::uint32_t kFormatGif = fnv1a("gif");

constexpr std::uint32_t kSupportPngBit = 1u << 0;
constexpr std::uint32_t kSupportJpegBit = 1u << 1;
constexpr std::uint32_t kSupportWebpBit = 1u << 2;
constexpr std::uint32_t kSupportAvifBit = 1u << 3;
constexpr std::uint32_t kSupportGifBit = 1u << 4;
#ifdef FSUSBLOG_IMAGE_CODEC_ENABLE_JPEG
constexpr std::uint32_t kSupportJpegEnabledBit = kSupportJpegBit;
#else
constexpr std::uint32_t kSupportJpegEnabledBit = 0u;
#endif
#ifdef FSUSBLOG_IMAGE_CODEC_ENABLE_WEBP
constexpr std::uint32_t kSupportWebpEnabledBit = kSupportWebpBit;
#else
constexpr std::uint32_t kSupportWebpEnabledBit = 0u;
#endif
#ifdef FSUSBLOG_IMAGE_CODEC_ENABLE_AVIF
constexpr std::uint32_t kSupportAvifEnabledBit = kSupportAvifBit;
#else
constexpr std::uint32_t kSupportAvifEnabledBit = 0u;
#endif
bool avif_encoder_available()
{
#ifdef FSUSBLOG_IMAGE_CODEC_ENABLE_AVIF
    return avifCodecName(AVIF_CODEC_CHOICE_AUTO, AVIF_CODEC_FLAG_CAN_ENCODE) != nullptr;
#else
    return false;
#endif
}

std::uint32_t build_supported_formats_bitmap()
{
    std::uint32_t bits = kSupportPngBit | kSupportJpegEnabledBit | kSupportWebpEnabledBit;
    if (kSupportAvifEnabledBit != 0u && avif_encoder_available())
    {
        bits |= kSupportAvifBit;
    }
    return bits;
}

thread_local std::vector<std::uint8_t> g_output;
thread_local std::string g_last_error;
thread_local ErrorCode g_last_error_code = ErrorCode::None;
const std::uint32_t g_supported_formats_bitmap = build_supported_formats_bitmap();

void clear_error()
{
    g_last_error.clear();
    g_last_error_code = ErrorCode::None;
}

void set_error(ErrorCode code, const char *message)
{
    g_last_error_code = code;
    g_last_error = message;
}

void append_u32_be(std::vector<std::uint8_t> &out, std::uint32_t value)
{
    out.push_back(static_cast<std::uint8_t>((value >> 24) & 0xFFu));
    out.push_back(static_cast<std::uint8_t>((value >> 16) & 0xFFu));
    out.push_back(static_cast<std::uint8_t>((value >> 8) & 0xFFu));
    out.push_back(static_cast<std::uint8_t>(value & 0xFFu));
}

std::uint32_t crc32(const std::uint8_t *data, std::size_t len)
{
    std::uint32_t crc = 0xFFFFFFFFu;
    for (std::size_t i = 0; i < len; ++i)
    {
        crc ^= static_cast<std::uint32_t>(data[i]);
        for (int b = 0; b < 8; ++b)
        {
            const std::uint32_t mask = static_cast<std::uint32_t>(-(static_cast<int>(crc & 1u)));
            crc = (crc >> 1) ^ (0xEDB88320u & mask);
        }
    }
    return ~crc;
}

std::uint32_t adler32(const std::uint8_t *data, std::size_t len)
{
    constexpr std::uint32_t mod = 65521u;
    std::uint32_t a = 1u;
    std::uint32_t b = 0u;
    for (std::size_t i = 0; i < len; ++i)
    {
        a = (a + data[i]) % mod;
        b = (b + a) % mod;
    }
    return (b << 16) | a;
}

void append_chunk(std::vector<std::uint8_t> &png, const char type[4], const std::vector<std::uint8_t> &payload)
{
    append_u32_be(png, static_cast<std::uint32_t>(payload.size()));
    const auto type_start = png.size();
    png.push_back(static_cast<std::uint8_t>(type[0]));
    png.push_back(static_cast<std::uint8_t>(type[1]));
    png.push_back(static_cast<std::uint8_t>(type[2]));
    png.push_back(static_cast<std::uint8_t>(type[3]));
    png.insert(png.end(), payload.begin(), payload.end());
    const auto crc_start = png.data() + type_start;
    const auto crc_len = 4u + static_cast<std::uint32_t>(payload.size());
    append_u32_be(png, crc32(crc_start, crc_len));
}

bool encode_png_rgba(const std::uint8_t *rgba, std::uint32_t width, std::uint32_t height, std::vector<std::uint8_t> &out)
{
    if (width == 0 || height == 0)
    {
        set_error(ErrorCode::DimensionInvalid, "image_dimension_invalid");
        return false;
    }

    const std::size_t row_bytes = static_cast<std::size_t>(width) * 4u;
    const std::size_t raw_len = (row_bytes + 1u) * static_cast<std::size_t>(height);
    std::vector<std::uint8_t> raw;
    raw.resize(raw_len);

    for (std::uint32_t y = 0; y < height; ++y)
    {
        const std::size_t src_offset = static_cast<std::size_t>(y) * row_bytes;
        const std::size_t dst_offset = static_cast<std::size_t>(y) * (row_bytes + 1u);
        raw[dst_offset] = 0u;
        std::memcpy(raw.data() + dst_offset + 1u, rgba + src_offset, row_bytes);
    }

    std::vector<std::uint8_t> zlib;
    zlib.reserve(raw.size() + 16u + (raw.size() / 65535u) * 5u);
    zlib.push_back(0x78u);
    zlib.push_back(0x01u);

    std::size_t cursor = 0;
    while (cursor < raw.size())
    {
        const std::size_t remaining = raw.size() - cursor;
        const std::uint16_t block_len = static_cast<std::uint16_t>(std::min<std::size_t>(remaining, 65535u));
        const bool is_final = (cursor + block_len) >= raw.size();
        zlib.push_back(is_final ? 0x01u : 0x00u);
        zlib.push_back(static_cast<std::uint8_t>(block_len & 0xFFu));
        zlib.push_back(static_cast<std::uint8_t>((block_len >> 8) & 0xFFu));
        const std::uint16_t nlen = static_cast<std::uint16_t>(~block_len);
        zlib.push_back(static_cast<std::uint8_t>(nlen & 0xFFu));
        zlib.push_back(static_cast<std::uint8_t>((nlen >> 8) & 0xFFu));
        zlib.insert(zlib.end(), raw.begin() + static_cast<std::ptrdiff_t>(cursor), raw.begin() + static_cast<std::ptrdiff_t>(cursor + block_len));
        cursor += block_len;
    }

    append_u32_be(zlib, adler32(raw.data(), raw.size()));

    out.clear();
    out.reserve(8u + 25u + zlib.size() + 12u);

    const std::array<std::uint8_t, 8> signature{{0x89u, 0x50u, 0x4Eu, 0x47u, 0x0Du, 0x0Au, 0x1Au, 0x0Au}};
    out.insert(out.end(), signature.begin(), signature.end());

    std::vector<std::uint8_t> ihdr;
    ihdr.reserve(13u);
    append_u32_be(ihdr, width);
    append_u32_be(ihdr, height);
    ihdr.push_back(8u);
    ihdr.push_back(6u);
    ihdr.push_back(0u);
    ihdr.push_back(0u);
    ihdr.push_back(0u);
    append_chunk(out, "IHDR", ihdr);
    append_chunk(out, "IDAT", zlib);
    append_chunk(out, "IEND", {});
    return true;
}

bool encode_jpeg_rgba(
    const std::uint8_t *rgba,
    std::uint32_t width,
    std::uint32_t height,
    int quality,
    std::vector<std::uint8_t> &out)
{
#ifndef FSUSBLOG_IMAGE_CODEC_ENABLE_JPEG
    (void)rgba;
    (void)width;
    (void)height;
    (void)quality;
    (void)out;
    set_error(ErrorCode::NeedFallback, "codec_need_fallback");
    return false;
#else
    if (width == 0 || height == 0)
    {
        set_error(ErrorCode::DimensionInvalid, "image_dimension_invalid");
        return false;
    }

    const std::size_t rgb_len = static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 3u;
    std::vector<std::uint8_t> rgb(rgb_len);
    for (std::size_t i = 0, j = 0; i < rgb_len; i += 3u, j += 4u)
    {
        rgb[i] = rgba[j];
        rgb[i + 1u] = rgba[j + 1u];
        rgb[i + 2u] = rgba[j + 2u];
    }

    struct JpegErrorManager
    {
        jpeg_error_mgr pub;
        jmp_buf setjmpBuffer;
        char message[JMSG_LENGTH_MAX]{};
    };

    auto onJpegError = [](j_common_ptr cinfo) {
        auto *err = reinterpret_cast<JpegErrorManager *>(cinfo->err);
        (*cinfo->err->format_message)(cinfo, err->message);
        longjmp(err->setjmpBuffer, 1);
    };

    jpeg_compress_struct cinfo{};
    JpegErrorManager jerr{};
    cinfo.err = jpeg_std_error(&jerr.pub);
    jerr.pub.error_exit = onJpegError;
    unsigned char *jpeg_buf = nullptr;
    unsigned long jpeg_len = 0;
    if (setjmp(jerr.setjmpBuffer))
    {
        if (jpeg_buf != nullptr)
        {
            std::free(jpeg_buf);
            jpeg_buf = nullptr;
        }
        jpeg_destroy_compress(&cinfo);
        set_error(ErrorCode::EncodeFailed, jerr.message[0] != '\0' ? jerr.message : "codec_encode_failed");
        return false;
    }
    jpeg_create_compress(&cinfo);

    jpeg_mem_dest(&cinfo, &jpeg_buf, &jpeg_len);

    cinfo.image_width = width;
    cinfo.image_height = height;
    cinfo.input_components = 3;
    cinfo.in_color_space = JCS_RGB;
    jpeg_set_defaults(&cinfo);

    const int normalized_quality = std::clamp(quality <= 0 ? 85 : quality, 1, 100);
    jpeg_set_quality(&cinfo, normalized_quality, TRUE);

    jpeg_start_compress(&cinfo, TRUE);
    JSAMPROW row[1];
    const std::size_t row_stride = static_cast<std::size_t>(width) * 3u;
    while (cinfo.next_scanline < cinfo.image_height)
    {
        row[0] = const_cast<JSAMPROW>(rgb.data() + static_cast<std::size_t>(cinfo.next_scanline) * row_stride);
        jpeg_write_scanlines(&cinfo, row, 1);
    }
    jpeg_finish_compress(&cinfo);

    if (jpeg_buf == nullptr || jpeg_len == 0)
    {
        if (jpeg_buf != nullptr)
        {
            std::free(jpeg_buf);
        }
        jpeg_destroy_compress(&cinfo);
        set_error(ErrorCode::EncodeFailed, "codec_encode_failed");
        return false;
    }

    out.assign(jpeg_buf, jpeg_buf + jpeg_len);
    std::free(jpeg_buf);
    jpeg_destroy_compress(&cinfo);
    return true;
#endif
}

bool encode_webp_rgba(
    const std::uint8_t *rgba,
    std::uint32_t width,
    std::uint32_t height,
    int quality,
    std::vector<std::uint8_t> &out)
{
#ifndef FSUSBLOG_IMAGE_CODEC_ENABLE_WEBP
    (void)rgba;
    (void)width;
    (void)height;
    (void)quality;
    (void)out;
    set_error(ErrorCode::NeedFallback, "codec_need_fallback");
    return false;
#else
    if (width == 0 || height == 0)
    {
        set_error(ErrorCode::DimensionInvalid, "image_dimension_invalid");
        return false;
    }
    const int normalized_quality = std::clamp(quality <= 0 ? 82 : quality, 1, 100);
    std::uint8_t *webp_buf = nullptr;
    const size_t webp_len = WebPEncodeRGBA(
        rgba,
        static_cast<int>(width),
        static_cast<int>(height),
        static_cast<int>(width * 4u),
        static_cast<float>(normalized_quality),
        &webp_buf);
    if (webp_len == 0 || webp_buf == nullptr)
    {
        set_error(ErrorCode::EncodeFailed, "codec_encode_failed");
        return false;
    }
    out.assign(webp_buf, webp_buf + webp_len);
    WebPFree(webp_buf);
    return true;
#endif
}

bool encode_avif_rgba(
    const std::uint8_t *rgba,
    std::uint32_t width,
    std::uint32_t height,
    int quality,
    std::vector<std::uint8_t> &out)
{
#ifndef FSUSBLOG_IMAGE_CODEC_ENABLE_AVIF
    (void)rgba;
    (void)width;
    (void)height;
    (void)quality;
    (void)out;
    set_error(ErrorCode::NeedFallback, "codec_need_fallback");
    return false;
#else
    if (width == 0 || height == 0)
    {
        set_error(ErrorCode::DimensionInvalid, "image_dimension_invalid");
        return false;
    }
    if (!avif_encoder_available())
    {
        set_error(ErrorCode::NeedFallback, "codec_need_fallback");
        return false;
    }

    avifImage *image = avifImageCreate(static_cast<int>(width), static_cast<int>(height), 8, AVIF_PIXEL_FORMAT_YUV444);
    if (image == nullptr)
    {
        set_error(ErrorCode::EncodeFailed, "codec_encode_failed");
        return false;
    }

    avifRGBImage rgb;
    avifRGBImageSetDefaults(&rgb, image);
    rgb.depth = 8;
    rgb.format = AVIF_RGB_FORMAT_RGBA;
    rgb.rowBytes = width * 4u;
    avifResult allocResult = avifRGBImageAllocatePixels(&rgb);
    if (allocResult != AVIF_RESULT_OK)
    {
        avifImageDestroy(image);
        set_error(ErrorCode::EncodeFailed, "codec_encode_failed");
        return false;
    }
    std::memcpy(rgb.pixels, rgba, static_cast<std::size_t>(rgb.rowBytes) * height);

    avifResult rgbToYuvResult = avifImageRGBToYUV(image, &rgb);
    avifRGBImageFreePixels(&rgb);
    if (rgbToYuvResult != AVIF_RESULT_OK)
    {
        avifImageDestroy(image);
        set_error(ErrorCode::EncodeFailed, "codec_encode_failed");
        return false;
    }

    avifEncoder *encoder = avifEncoderCreate();
    if (encoder == nullptr)
    {
        avifImageDestroy(image);
        set_error(ErrorCode::EncodeFailed, "codec_encode_failed");
        return false;
    }

    const int normalized_quality = std::clamp(quality <= 0 ? 60 : quality, 1, 100);
    encoder->quality = normalized_quality;
    encoder->qualityAlpha = normalized_quality;
    encoder->maxThreads = 1;

    avifRWData output = AVIF_DATA_EMPTY;
    avifResult finishResult = avifEncoderWrite(encoder, image, &output);
    avifEncoderDestroy(encoder);
    avifImageDestroy(image);
    if (finishResult != AVIF_RESULT_OK || output.size == 0 || output.data == nullptr)
    {
        if (output.data != nullptr)
        {
            avifRWDataFree(&output);
        }
        set_error(ErrorCode::EncodeFailed, "codec_encode_failed");
        return false;
    }

    out.assign(output.data, output.data + output.size);
    avifRWDataFree(&output);
    return true;
#endif
}

std::uint32_t parse_format(const char *format)
{
    if (format == nullptr || *format == '\0')
    {
        return 0;
    }
    return fnv1a(format);
}
} // namespace

extern "C"
{
std::uint8_t *image_codec_alloc_buffer(int size)
{
    if (size <= 0)
    {
        return nullptr;
    }
    return static_cast<std::uint8_t *>(std::malloc(static_cast<std::size_t>(size)));
}

void image_codec_free_buffer(std::uint8_t *ptr)
{
    if (ptr == nullptr)
    {
        return;
    }
    std::free(ptr);
}

int image_codec_encode(
    const std::uint8_t *rgba_ptr,
    int rgba_len,
    int width,
    int height,
    const char *format,
    int quality,
    int preserve_alpha)
{
    (void)preserve_alpha;

    clear_error();
    g_output.clear();

    if (rgba_ptr == nullptr || rgba_len <= 0 || width <= 0 || height <= 0)
    {
        set_error(ErrorCode::InvalidInput, "codec_invalid_input");
        return 0;
    }

    const auto expected_len = static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 4u;
    if (static_cast<std::size_t>(rgba_len) != expected_len)
    {
        set_error(ErrorCode::RgbaSizeMismatch, "codec_rgba_size_mismatch");
        return 0;
    }

    const std::uint32_t fmt = parse_format(format);
    if (fmt == kFormatPng)
    {
        return encode_png_rgba(rgba_ptr, static_cast<std::uint32_t>(width), static_cast<std::uint32_t>(height), g_output) ? 1 : 0;
    }

    if (fmt == kFormatJpeg)
    {
        return encode_jpeg_rgba(rgba_ptr, static_cast<std::uint32_t>(width), static_cast<std::uint32_t>(height), quality, g_output) ? 1 : 0;
    }

    if (fmt == kFormatWebp)
    {
        return encode_webp_rgba(rgba_ptr, static_cast<std::uint32_t>(width), static_cast<std::uint32_t>(height), quality, g_output) ? 1 : 0;
    }

    if (fmt == kFormatAvif)
    {
        if ((g_supported_formats_bitmap & kSupportAvifBit) == 0u)
        {
            set_error(ErrorCode::NeedFallback, "codec_need_fallback");
            return 0;
        }
        return encode_avif_rgba(rgba_ptr, static_cast<std::uint32_t>(width), static_cast<std::uint32_t>(height), quality, g_output) ? 1 : 0;
    }

    if (fmt == kFormatGif)
    {
        set_error(ErrorCode::NeedFallback, "codec_need_fallback");
        return 0;
    }

    set_error(ErrorCode::FormatNotSupported, "codec_format_not_supported");
    return 0;
}

int image_codec_get_last_output_ptr()
{
    if (g_output.empty())
    {
        return 0;
    }
    return static_cast<int>(reinterpret_cast<std::uintptr_t>(g_output.data()));
}

int image_codec_get_last_output_len()
{
    return static_cast<int>(g_output.size());
}

int image_codec_get_last_error_ptr()
{
    if (g_last_error.empty())
    {
        return 0;
    }
    return static_cast<int>(reinterpret_cast<std::uintptr_t>(g_last_error.data()));
}

int image_codec_get_last_error_len()
{
    return static_cast<int>(g_last_error.size());
}

int image_codec_get_last_error_code()
{
    return static_cast<int>(g_last_error_code);
}

int image_codec_get_level_ptr()
{
    return static_cast<int>(reinterpret_cast<std::uintptr_t>(kCodecLevel));
}

int image_codec_get_level_len()
{
    return static_cast<int>(std::strlen(kCodecLevel));
}

int image_codec_get_version_ptr()
{
    return static_cast<int>(reinterpret_cast<std::uintptr_t>(kCodecVersion));
}

int image_codec_get_version_len()
{
    return static_cast<int>(std::strlen(kCodecVersion));
}

int image_codec_get_supported_formats_bitmap()
{
    return static_cast<int>(g_supported_formats_bitmap);
}
}
