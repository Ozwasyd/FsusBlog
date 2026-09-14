import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import 'dayjs/locale/zh-cn';

// 插件初始化与全局配置
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

export type TimeRenderOptions = Readonly<{
    now?: string | Date | number | null;
    timeZone?: string | null;
    locale?: string | null;
}>;

function resolveDisplayTimeZone(options?: TimeRenderOptions): string | null
{
    const value = options?.timeZone?.trim();
    return value && value.length > 0 ? value : null;
}

function applyDisplayTimeZone(value: dayjs.Dayjs, options?: TimeRenderOptions): dayjs.Dayjs
{
    const timeZone = resolveDisplayTimeZone(options);
    const localized = timeZone ? value.tz(timeZone) : value.local();
    const locale = options?.locale?.trim().toLowerCase();
    if (!locale)
    {
        return localized;
    }
    if (locale === 'zh-cn' || locale === 'zh-hans' || locale.startsWith('zh-cn-'))
    {
        return localized.locale('zh-cn');
    }
    if (locale === 'en' || locale.startsWith('en-'))
    {
        return localized.locale('en');
    }
    return localized.locale(locale);
}

/**
 * 时间处理工具类。
 * 所有输入经 _parse 统一解析；数字时间戳区分秒/毫秒，字符串按 UTC 解析。
 * 智能格式化使用分钟级差值，非法或未来输入使用稳定回退。
 */
export const TimeUtils = {

    /**
     * 统一解析入口，收敛时区、秒/毫秒和非法输入处理。
     */
    _parse(input: string | Date | number | null | undefined): dayjs.Dayjs | null
    {
        if (!input)
        {
            return null;
        }

        let instance: dayjs.Dayjs;

        if (typeof input === 'number')
        {
            // 10 位数量级按 Unix 秒解析，更大的时间戳按毫秒解析。
            instance = input < 10000000000 ? dayjs.unix(input) : dayjs(input);
        }
        else if (typeof input === 'string')
        {
            // 无显式时区的服务端 ISO 字符串按 UTC 解释；显式偏移由 dayjs.utc 保留其时间点。
            instance = dayjs.utc(input);
        }
        else
        {
            instance = dayjs(input);
        }

        return instance.isValid() ? instance : null;
    },

    /**
     * 将 UTC 时间转换为相对时间（如：3分钟前）
     */
    toRelative(utcTime: string | Date | number, options?: TimeRenderOptions): string
    {
        const d = this._parse(utcTime);
        if (!d)
        {
            return '时间未知';
        }
        const now = options?.now == null ? null : this._parse(options.now);
        const displayTime = applyDisplayTimeZone(d, options);
        return now ? displayTime.from(applyDisplayTimeZone(now, options)) : displayTime.fromNow();
    },

    /**
     * 将 UTC 时间转换为本地标准格式
     */
    toFullLocalString(utcTime: string | Date | number, options?: TimeRenderOptions): string
    {
        const d = this._parse(utcTime);
        if (!d)
        {
            return '时间格式错误';
        }
        return applyDisplayTimeZone(d, options).format('YYYY-MM-DD HH:mm:ss');
    },

    /**
     * 相对时间格式化，使用分钟级差值并处理未来时间与非法输入。
     */
    toSmartTime(utcTime: string | Date | number, options?: TimeRenderOptions): string
    {
        const target = this._parse(utcTime);
        if (!target)
        {
            return '-';
        }

        const localTarget = applyDisplayTimeZone(target, options);
        const parsedNow = options?.now == null ? null : this._parse(options.now);
        const now = applyDisplayTimeZone(parsedNow ?? dayjs(), options);

        // 使用分钟级差值计算相对时间。
        const diffInMinutes = now.diff(localTarget, 'minute');

        // 客户端时钟快于服务器时回退到绝对时间。
        if (diffInMinutes < -1)
        {
            return localTarget.format('YYYY-MM-DD HH:mm');
        }

        // 2. 极短时间内 (1分钟内)
        if (diffInMinutes <= 0)
        {
            return '刚刚';
        }

        // 3. 24小时内 (使用相对时间)
        if (diffInMinutes < 1440)
        {
            return localTarget.from(now);
        }

        // 4. 跨年处理
        const formatStr = now.year() === localTarget.year() ? 'MM-DD HH:mm' : 'YYYY-MM-DD HH:mm';
        return localTarget.format(formatStr);
    }
};
