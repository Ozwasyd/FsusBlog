#include <algorithm>
#include <array>
#include <csetjmp>
#include <cstdint>
#include <cstdlib>
#include <cstring>
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

constexpr const char* KCodecVersion = "fsus-image-codec/0.2.0";
#if defined(__wasm_simd128__)
constexpr const char* kCodecLevel = "simd";
#else
constexpr const char* KCodecLevel = "basic";
#endif

constexpr std::uint32_t Fnv1a(const char* value)
{
    std::uint32_t hash = 2166136261u;
    while (*value != '\0')
    {
        hash ^= static_cast<std::uint8_t>(*value++);
        hash *= 16777619u;
    }
    return hash;
}

constexpr std::uint32_t KFormatPng = Fnv1a("png");
constexpr std::uint32_t KFormatWebp = Fnv1a("webp");
constexpr std::uint32_t KFormatAvif = Fnv1a("avif");
constexpr std::uint32_t KFormatJpeg = Fnv1a("jpeg");
constexpr std::uint32_t KFormatGif = Fnv1a("gif");

constexpr std::uint32_t KSupportPngBit = 1u << 0;
constexpr std::uint32_t KSupportJpegBit = 1u << 1;
constexpr std::uint32_t KSupportWebpBit = 1u << 2;
constexpr std::uint32_t KSupportAvifBit = 1u << 3;
constexpr std::uint32_t KSupportGifBit = 1u << 4;
#ifdef FSUSBLOG_IMAGE_CODEC_ENABLE_JPEG
constexpr std::uint32_t kSupportJpegEnabledBit = kSupportJpegBit;
#else
constexpr std::uint32_t KSupportJpegEnabledBit = 0u;
#endif
#ifdef FSUSBLOG_IMAGE_CODEC_ENABLE_WEBP
constexpr std::uint32_t kSupportWebpEnabledBit = kSupportWebpBit;
#else
constexpr std::uint32_t KSupportWebpEnabledBit = 0u;
#endif
#ifdef FSUSBLOG_IMAGE_CODEC_ENABLE_AVIF
constexpr std::uint32_t kSupportAvifEnabledBit = kSupportAvifBit;
#else
constexpr std::uint32_t KSupportAvifEnabledBit = 0u;
#endif
bool AvifEncoderAvailable()
{
#ifdef FSUSBLOG_IMAGE_CODEC_ENABLE_AVIF
    return avifCodecName(AVIF_CODEC_CHOICE_AUTO, AVIF_CODEC_FLAG_CAN_ENCODE) != nullptr;
#else
    return false;
#endif
}

std::uint32_t BuildSupportedFormatsBitmap()
{
    std::uint32_t bits = KSupportPngBit | KSupportJpegEnabledBit | KSupportWebpEnabledBit;
    if (KSupportAvifEnabledBit != 0u && AvifEncoderAvailable())
    {
        bits |= KSupportAvifBit;
    }
    return bits;
}

thread_local std::vector<std::uint8_t> t_output;
thread_local std::string t_lastError;
thread_local ErrorCode t_lastErrorCode = ErrorCode::None;
const std::uint32_t GSupportedFormatsBitmap = BuildSupportedFormatsBitmap();

void ClearError()
{
    t_lastError.clear();
    t_lastErrorCode = ErrorCode::None;
}

void SetError(ErrorCode code, const char* message)
{
    t_lastErrorCode = code;
    t_lastError = message;
}

void AppendU32Be(std::vector<std::uint8_t>& out, std::uint32_t value)
{
    out.push_back(static_cast<std::uint8_t>((value >> 24) & 0xFFu));
    out.push_back(static_cast<std::uint8_t>((value >> 16) & 0xFFu));
    out.push_back(static_cast<std::uint8_t>((value >> 8) & 0xFFu));
    out.push_back(static_cast<std::uint8_t>(value & 0xFFu));
}

std::uint32_t Crc32(const std::uint8_t* data, std::size_t len)
{
    std::uint32_t crc = 0xFFFFFFFFu;
    for (std::size_t i = 0; i < len; ++i)
    {
        crc ^= static_cast<std::uint32_t>(data[i]);
        for (int b = 0; b < 8; ++b)
        {
            const std::uint32_t Mask = static_cast<std::uint32_t>(-(static_cast<int>(crc & 1u)));
            crc = (crc >> 1) ^ (0xEDB88320u & Mask);
        }
    }
    return ~crc;
}

std::uint32_t Adler32(const std::uint8_t* data, std::size_t len)
{
    constexpr std::uint32_t Mod = 65521u;
    std::uint32_t a = 1u;
    std::uint32_t b = 0u;
    for (std::size_t i = 0; i < len; ++i)
    {
        a = (a + data[i]) % Mod;
        b = (b + a) % Mod;
    }
    return (b << 16) | a;
}

void AppendChunk(std::vector<std::uint8_t>& png, const char type[4], const std::vector<std::uint8_t>& payload)
{
    AppendU32Be(png, static_cast<std::uint32_t>(payload.size()));
    const auto TypeStart = png.size();
    png.push_back(static_cast<std::uint8_t>(type[0]));
    png.push_back(static_cast<std::uint8_t>(type[1]));
    png.push_back(static_cast<std::uint8_t>(type[2]));
    png.push_back(static_cast<std::uint8_t>(type[3]));
    png.insert(png.end(), payload.begin(), payload.end());
    const auto CrcStart = png.data() + TypeStart;
    const auto CrcLen = 4u + static_cast<std::uint32_t>(payload.size());
    AppendU32Be(png, Crc32(CrcStart, CrcLen));
}

bool EncodePngRgba(const std::uint8_t* rgba, std::uint32_t width, std::uint32_t height, std::vector<std::uint8_t>& out)
{
    if (width == 0 || height == 0)
    {
        SetError(ErrorCode::DimensionInvalid, "image_dimension_invalid");
        return false;
    }

    const std::size_t RowBytes = static_cast<std::size_t>(width) * 4u;
    const std::size_t RawLen = (RowBytes + 1u) * static_cast<std::size_t>(height);
    std::vector<std::uint8_t> raw;
    raw.resize(RawLen);

    for (std::uint32_t y = 0; y < height; ++y)
    {
        const std::size_t SrcOffset = static_cast<std::size_t>(y) * RowBytes;
        const std::size_t DstOffset = static_cast<std::size_t>(y) * (RowBytes + 1u);
        raw[DstOffset] = 0u;
        std::memcpy(raw.data() + DstOffset + 1u, rgba + SrcOffset, RowBytes);
    }

    std::vector<std::uint8_t> zlib;
    zlib.reserve(raw.size() + 16u + (raw.size() / 65535u) * 5u);
    zlib.push_back(0x78u);
    zlib.push_back(0x01u);

    std::size_t cursor = 0;
    while (cursor < raw.size())
    {
        const std::size_t Remaining = raw.size() - cursor;
        const std::uint16_t BlockLen = static_cast<std::uint16_t>(std::min<std::size_t>(Remaining, 65535u));
        const bool IsFinal = (cursor + BlockLen) >= raw.size();
        zlib.push_back(IsFinal ? 0x01u : 0x00u);
        zlib.push_back(static_cast<std::uint8_t>(BlockLen & 0xFFu));
        zlib.push_back(static_cast<std::uint8_t>((static_cast<std::uint32_t>(BlockLen) >> 8U) & 0xFFU));
        const std::uint16_t Nlen = static_cast<std::uint16_t>(~BlockLen);
        zlib.push_back(static_cast<std::uint8_t>(Nlen & 0xFFu));
        zlib.push_back(static_cast<std::uint8_t>((static_cast<std::uint32_t>(Nlen) >> 8U) & 0xFFU));
        zlib.insert(zlib.end(),
                    raw.begin() + static_cast<std::ptrdiff_t>(cursor),
                    raw.begin() + static_cast<std::ptrdiff_t>(cursor + BlockLen));
        cursor += BlockLen;
    }

    AppendU32Be(zlib, Adler32(raw.data(), raw.size()));

    out.clear();
    out.reserve(8u + 25u + zlib.size() + 12u);

    const std::array<std::uint8_t, 8> Signature{{0x89u, 0x50u, 0x4Eu, 0x47u, 0x0Du, 0x0Au, 0x1Au, 0x0Au}};
    out.insert(out.end(), Signature.begin(), Signature.end());

    std::vector<std::uint8_t> ihdr;
    ihdr.reserve(13u);
    AppendU32Be(ihdr, width);
    AppendU32Be(ihdr, height);
    ihdr.push_back(8u);
    ihdr.push_back(6u);
    ihdr.push_back(0u);
    ihdr.push_back(0u);
    ihdr.push_back(0u);
    AppendChunk(out, "IHDR", ihdr);
    AppendChunk(out, "IDAT", zlib);
    AppendChunk(out, "IEND", {});
    return true;
}

bool EncodeJpegRgba(
    const std::uint8_t* rgba, std::uint32_t width, std::uint32_t height, int quality, std::vector<std::uint8_t>& out)
{
#ifndef FSUSBLOG_IMAGE_CODEC_ENABLE_JPEG
    (void)rgba;
    (void)width;
    (void)height;
    (void)quality;
    (void)out;
    SetError(ErrorCode::NeedFallback, "codec_need_fallback");
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
        std::jmp_buf setjmpBuffer;
        char message[JMSG_LENGTH_MAX]{};
    };

    auto onJpegError = [](j_common_ptr cinfo)
    {
        auto* err = reinterpret_cast<JpegErrorManager*>(cinfo->err);
        (*cinfo->err->format_message)(cinfo, err->message);
        std::longjmp(err->setjmpBuffer, 1);
    };

    jpeg_compress_struct cinfo{};
    JpegErrorManager jerr{};
    cinfo.err = jpeg_std_error(&jerr.pub);
    jerr.pub.error_exit = onJpegError;
    unsigned char* jpeg_buf = nullptr;
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

bool EncodeWebpRgba(
    const std::uint8_t* rgba, std::uint32_t width, std::uint32_t height, int quality, std::vector<std::uint8_t>& out)
{
#ifndef FSUSBLOG_IMAGE_CODEC_ENABLE_WEBP
    (void)rgba;
    (void)width;
    (void)height;
    (void)quality;
    (void)out;
    SetError(ErrorCode::NeedFallback, "codec_need_fallback");
    return false;
#else
    if (width == 0 || height == 0)
    {
        set_error(ErrorCode::DimensionInvalid, "image_dimension_invalid");
        return false;
    }
    const int normalized_quality = std::clamp(quality <= 0 ? 82 : quality, 1, 100);
    std::uint8_t* webp_buf = nullptr;
    const size_t webp_len = WebPEncodeRGBA(rgba,
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

bool EncodeAvifRgba(
    const std::uint8_t* rgba, std::uint32_t width, std::uint32_t height, int quality, std::vector<std::uint8_t>& out)
{
#ifndef FSUSBLOG_IMAGE_CODEC_ENABLE_AVIF
    (void)rgba;
    (void)width;
    (void)height;
    (void)quality;
    (void)out;
    SetError(ErrorCode::NeedFallback, "codec_need_fallback");
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

    avifImage* image = avifImageCreate(static_cast<int>(width), static_cast<int>(height), 8, AVIF_PIXEL_FORMAT_YUV444);
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

    avifEncoder* encoder = avifEncoderCreate();
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

std::uint32_t ParseFormat(const char* format)
{
    if (format == nullptr || *format == '\0')
    {
        return 0;
    }
    return Fnv1a(format);
}
} // namespace

extern "C"
{
    std::uint8_t* image_codec_alloc_buffer(int size)
    {
        if (size <= 0)
        {
            return nullptr;
        }
        return static_cast<std::uint8_t*>(std::malloc(static_cast<std::size_t>(size)));
    }

    void image_codec_free_buffer(std::uint8_t* ptr)
    {
        if (ptr == nullptr)
        {
            return;
        }
        std::free(ptr);
    }

    int image_codec_encode(const std::uint8_t* rgbaPtr,
                           int rgbaLen,
                           int width,
                           int height,
                           const char* format,
                           int quality,
                           int preserveAlpha)
    {
        (void)preserveAlpha;

        ClearError();
        t_output.clear();

        if (rgbaPtr == nullptr || rgbaLen <= 0 || width <= 0 || height <= 0)
        {
            SetError(ErrorCode::InvalidInput, "codec_invalid_input");
            return 0;
        }

        const auto ExpectedLen = static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 4u;
        if (static_cast<std::size_t>(rgbaLen) != ExpectedLen)
        {
            SetError(ErrorCode::RgbaSizeMismatch, "codec_rgba_size_mismatch");
            return 0;
        }

        const std::uint32_t Fmt = ParseFormat(format);
        if (Fmt == KFormatPng)
        {
            return EncodePngRgba(
                       rgbaPtr, static_cast<std::uint32_t>(width), static_cast<std::uint32_t>(height), t_output)
                       ? 1
                       : 0;
        }

        if (Fmt == KFormatJpeg)
        {
            return EncodeJpegRgba(rgbaPtr,
                                  static_cast<std::uint32_t>(width),
                                  static_cast<std::uint32_t>(height),
                                  quality,
                                  t_output)
                       ? 1
                       : 0;
        }

        if (Fmt == KFormatWebp)
        {
            return EncodeWebpRgba(rgbaPtr,
                                  static_cast<std::uint32_t>(width),
                                  static_cast<std::uint32_t>(height),
                                  quality,
                                  t_output)
                       ? 1
                       : 0;
        }

        if (Fmt == KFormatAvif)
        {
            if ((GSupportedFormatsBitmap & KSupportAvifBit) == 0u)
            {
                SetError(ErrorCode::NeedFallback, "codec_need_fallback");
                return 0;
            }
            return EncodeAvifRgba(rgbaPtr,
                                  static_cast<std::uint32_t>(width),
                                  static_cast<std::uint32_t>(height),
                                  quality,
                                  t_output)
                       ? 1
                       : 0;
        }

        if (Fmt == KFormatGif)
        {
            SetError(ErrorCode::NeedFallback, "codec_need_fallback");
            return 0;
        }

        SetError(ErrorCode::FormatNotSupported, "codec_format_not_supported");
        return 0;
    }

    int image_codec_get_last_output_ptr()
    {
        if (t_output.empty())
        {
            return 0;
        }
        return static_cast<int>(reinterpret_cast<std::uintptr_t>(t_output.data()));
    }

    int image_codec_get_last_output_len()
    {
        return static_cast<int>(t_output.size());
    }

    int image_codec_get_last_error_ptr()
    {
        if (t_lastError.empty())
        {
            return 0;
        }
        return static_cast<int>(reinterpret_cast<std::uintptr_t>(t_lastError.data()));
    }

    int image_codec_get_last_error_len()
    {
        return static_cast<int>(t_lastError.size());
    }

    int image_codec_get_last_error_code()
    {
        return static_cast<int>(t_lastErrorCode);
    }

    int image_codec_get_level_ptr()
    {
        return static_cast<int>(reinterpret_cast<std::uintptr_t>(KCodecLevel));
    }

    int image_codec_get_level_len()
    {
        return static_cast<int>(std::strlen(KCodecLevel));
    }

    int image_codec_get_version_ptr()
    {
        return static_cast<int>(reinterpret_cast<std::uintptr_t>(KCodecVersion));
    }

    int image_codec_get_version_len()
    {
        return static_cast<int>(std::strlen(KCodecVersion));
    }

    int image_codec_get_supported_formats_bitmap()
    {
        return static_cast<int>(GSupportedFormatsBitmap);
    }
}
