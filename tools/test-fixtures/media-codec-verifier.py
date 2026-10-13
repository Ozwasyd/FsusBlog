import hashlib
import io
import json
import sys
import warnings

def main():
    import PIL

    if PIL.__version__ != "12.3.0":
        raise ValueError("media codec version drift")
    from PIL import Image, ImageOps, features

    codec = {
        "pillow": PIL.__version__,
        "jpeg": features.version("jpg"),
        "jpegTurbo": features.version_feature("libjpeg_turbo"),
        "webp": features.version("webp"),
        "zlib": features.version("zlib"),
    }
    if codec != {
        "pillow": "12.3.0",
        "jpeg": "6.2",
        "jpegTurbo": "3.1.4.1",
        "webp": "1.6.0",
        "zlib": "1.3.1",
    }:
        raise ValueError("media codec version drift")
    encoded = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
    if not encoded or len(encoded) > 4 * 1024 * 1024:
        raise ValueError("media codec encoded byte budget exceeded")
    Image.MAX_IMAGE_PIXELS = 2_000_000
    warnings.simplefilter("error", Image.DecompressionBombWarning)
    image = Image.open(io.BytesIO(encoded))
    if image.format not in ("JPEG", "PNG", "WEBP"):
        raise ValueError("media codec format unsupported")
    width, height = image.size
    if width > 8192 or height > 8192 or width * height > 2_000_000:
        raise ValueError("media codec dimensions budget exceeded")
    image.load()
    orientation = image.getexif().get(274, 1)
    if orientation not in (1, 3, 6, 8):
        raise ValueError("media codec orientation unsupported")
    alpha = "A" in image.getbands() or "transparency" in image.info
    pixels = image.convert("RGBA")
    oriented = ImageOps.exif_transpose(pixels)
    result = {
        "schema": "fsusblog.media-codec-observation.v1",
        "codec": codec,
        "format": image.format.lower(),
        "width": width,
        "height": height,
        "orientation": orientation,
        "alpha": alpha,
        "pixelDigest": "sha256:" + hashlib.sha256(pixels.tobytes()).hexdigest(),
        "orientedPixelDigest": "sha256:" + hashlib.sha256(oriented.tobytes()).hexdigest(),
    }
    sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(f"media codec refusal: {type(error).__name__}: {error}\n")
        sys.exit(1)
