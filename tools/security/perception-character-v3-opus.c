#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct OpusEncoder OpusEncoder;
extern OpusEncoder *opus_encoder_create(int32_t, int, int, int *);
extern int opus_encoder_ctl(OpusEncoder *, int, ...);
extern int32_t opus_encode(OpusEncoder *, const int16_t *, int, unsigned char *, int32_t);
extern void opus_encoder_destroy(OpusEncoder *);

enum { OPUS_OK = 0, OPUS_APPLICATION_VOIP = 2048, OPUS_SET_BITRATE_REQUEST = 4002,
       OPUS_SET_VBR_REQUEST = 4006, OPUS_SET_COMPLEXITY_REQUEST = 4010 };

static int write_u16(FILE *output, uint16_t value)
{
    unsigned char bytes[2] = { (unsigned char)(value & 255), (unsigned char)(value >> 8) };
    return fwrite(bytes, 1, sizeof bytes, output) == sizeof bytes;
}

int main(int argc, char **argv)
{
    if (argc != 3) return 64;
    FILE *input = fopen(argv[1], "rb");
    FILE *output = fopen(argv[2], "wb");
    if (input == NULL || output == NULL) return 65;
    int error = 0;
    OpusEncoder *encoder = opus_encoder_create(48000, 1, OPUS_APPLICATION_VOIP, &error);
    if (encoder == NULL || error != OPUS_OK ||
        opus_encoder_ctl(encoder, OPUS_SET_BITRATE_REQUEST, 16000) != OPUS_OK ||
        opus_encoder_ctl(encoder, OPUS_SET_VBR_REQUEST, 0) != OPUS_OK ||
        opus_encoder_ctl(encoder, OPUS_SET_COMPLEXITY_REQUEST, 5) != OPUS_OK) return 66;
    int status = 0;
    int16_t samples[960];
    unsigned char packet[512];
    for (;;)
    {
        size_t count = fread(samples, sizeof *samples, 960, input);
        if (count == 0) break;
        if (count != 960) { status = 67; break; }
        int32_t length = opus_encode(encoder, samples, 960, packet, sizeof packet);
        if (length <= 0 || length >= 255 || !write_u16(output, (uint16_t)length) ||
            fwrite(packet, 1, (size_t)length, output) != (size_t)length) { status = 68; break; }
    }
    opus_encoder_destroy(encoder);
    if (ferror(input) || fclose(input) != 0 || fclose(output) != 0) return 69;
    return status;
}
