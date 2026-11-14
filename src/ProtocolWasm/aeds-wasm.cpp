#include "aeds-frame.hpp"

namespace {
uint8_t buffer[fsus::wire::header::HeaderSize + fsus::wire::limits::MaxPayloadBytes];
}

extern "C" {
uint8_t* fsus_aeds_buffer() { return buffer; }

uint16_t fsus_aeds_validate(uint32_t length) {
    return length <= sizeof buffer ? fsus::wire::validate(buffer, length) : 0;
}
}
