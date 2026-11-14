#pragma once

#include "wire.generated.hpp"

namespace fsus::wire {

inline uint32_t readLe(const uint8_t* bytes, size_t width) {
    uint32_t value = 0;
    for (size_t index = 0; index < width; ++index) {
        value |= uint32_t{bytes[index]} << (8 * index);
    }
    return value;
}

inline uint16_t crc16(const uint8_t* bytes, size_t length) {
    auto crc = header::CrcInitial;
    for (size_t index = 0; index < length; ++index) {
        crc ^= bytes[index];
        for (int bit = 0; bit < 8; ++bit) {
            crc = (crc >> 1) ^ ((crc & 1) == 0 ? 0 : header::CrcPolynomial);
        }
    }
    return static_cast<uint16_t>(crc);
}

inline uint16_t validate(const uint8_t* bytes, size_t length) {
    if (length < header::HeaderSize ||
        length - header::HeaderSize > limits::MaxPayloadBytes ||
        readLe(bytes, 4) != header::Magic ||
        bytes[header::VersionOffset] != header::Version ||
        bytes[header::LengthOffset] != header::HeaderSize ||
        readLe(bytes + header::FlagsOffset, 2) != 0) {
        return 0;
    }

    const auto type = static_cast<uint16_t>(readLe(bytes + header::TypeOffset, 2));
    const auto payloadSize = length - header::HeaderSize;
    if (!known(static_cast<FrameType>(type)) || readLe(bytes + header::PayloadLengthOffset, 4) != payloadSize ||
        readLe(bytes + header::CrcOffset, 2) != crc16(bytes + header::HeaderSize, payloadSize)) {
        return 0;
    }

    return type;
}

}
