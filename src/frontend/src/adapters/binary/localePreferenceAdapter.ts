import { readByte, readInt64Number, readIsoDate64 } from '@/codecs/binary/reader';
import type { UserLocalePreference } from '@/contracts/binaryApi';
import type { SupportedLocale } from '@/locales/localeCatalog';
import { AppErrorCode, createAppError } from '@/utils/appError';

import { USER_LOCALE_PREFERENCE_POD_SIZE } from './types';

const LOCALE_BY_WIRE_VALUE: Readonly<Record<number, SupportedLocale>> = Object.freeze({
    1: 'zh-CN',
    2: 'en-US',
    3: 'zh-Hant',
    4: 'ja-JP',
    5: 'ko-KR',
    6: 'es-419',
    7: 'fr-FR',
    8: 'de-DE',
    9: 'pt-BR',
    10: 'ru-RU'
});

export function mapUserLocalePreferenceFromPayload(payload: Uint8Array): UserLocalePreference
{
    if (payload.byteLength !== USER_LOCALE_PREFERENCE_POD_SIZE)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'locale_preference_payload_invalid');
    }

    const mode = readByte(payload, 16);
    const hasFixedLocale = readByte(payload, 17);
    const localeValue = readByte(payload, 18);
    const reserved0 = readByte(payload, 19);
    const hasNonZeroReserved1 = payload.subarray(20, 24).some((value) => value !== 0);
    if (reserved0 !== 0 || hasNonZeroReserved1 || hasFixedLocale > 1)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'locale_preference_reserved_invalid');
    }

    if (mode === 1 && hasFixedLocale === 0 && localeValue === 0)
    {
        return {
            mode: 'auto',
            fixedLocale: null,
            revision: readInt64Number(payload, 0),
            updatedAt: readIsoDate64(payload, 8)
        };
    }

    const fixedLocale = LOCALE_BY_WIRE_VALUE[localeValue];
    if (mode !== 2 || hasFixedLocale !== 1 || !fixedLocale)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'locale_preference_state_invalid');
    }
    return {
        mode: 'fixed',
        fixedLocale,
        revision: readInt64Number(payload, 0),
        updatedAt: readIsoDate64(payload, 8)
    };
}
