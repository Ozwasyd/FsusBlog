import { requestBinaryOnly } from '@/composition/binaryTransport';
import type {
    PageContentAdmin,
    PageContentPublic,
    SeoConfigAdmin,
    SeoConfigPublic,
    SiteComplianceConfigAdmin,
    SiteComplianceConfigPublic
} from '@/contracts/binaryApi';

import { FrameType } from '@wasm/protocol/frame';

import { encodeAedsFrame, encodeStringMutationRequest, writeFixedUtf8 } from './binaryFrame';

import type { ApiRequestConfig } from './requestConfig';

export type { PageContentAdmin, PageContentPublic, SeoConfigAdmin, SeoConfigPublic, SiteComplianceConfigAdmin, SiteComplianceConfigPublic } from '@/contracts/binaryApi';

/**
 * 所有 API 方法接受可选的 config.signal，以支持 AbortController 中断请求。
 */

// 站点 SEO 配置
export const getSiteConfig = (config?: ApiRequestConfig) =>
    requestBinaryOnly<SeoConfigPublic>({
        binaryRoute: { operationId: 'binary_get_system_seo' },
        frameType: FrameType.SeoConfig,
        signal: config?.signal
    });

export const getAdminSiteConfig = (config?: ApiRequestConfig) =>
    requestBinaryOnly<SeoConfigAdmin>({
        binaryRoute: { operationId: 'binary_get_system_admin_seo' },
        frameType: FrameType.SeoConfig,
        signal: config?.signal
    });

/**
 * 更新站点配置
 * 更新请求必须携带 PoW 证明。
 */
export const updateSiteConfig = (data: SeoConfigAdmin, config?: ApiRequestConfig) =>
    requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_put_system_seo' },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.SeoConfigUpdateRequest, encodeSeoConfigPayload(data))
        }
    });

export const getSiteComplianceConfig = (config?: ApiRequestConfig) =>
    requestBinaryOnly<SiteComplianceConfigPublic>({
        binaryRoute: { operationId: 'binary_get_system_compliance' },
        frameType: FrameType.SiteComplianceConfig,
        signal: config?.signal
    });

export const getAdminSiteComplianceConfig = (config?: ApiRequestConfig) =>
    requestBinaryOnly<SiteComplianceConfigAdmin>({
        binaryRoute: { operationId: 'binary_get_system_admin_compliance' },
        frameType: FrameType.SiteComplianceConfig,
        signal: config?.signal
    });

export const updateSiteComplianceConfig = (data: SiteComplianceConfigAdmin, config?: ApiRequestConfig) =>
    requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_put_system_compliance' },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.SiteComplianceConfigUpdateRequest, encodeSiteCompliancePayload(data))
        }
    });

// ================= 动态页面管理 =================

// 动态页面内容
export const getPageData = (slug: string, config?: ApiRequestConfig) =>
    requestBinaryOnly<PageContentPublic>({
        binaryRoute: {
            operationId: 'binary_get_system_page_slug',
            params: { slug }
        },
        frameType: FrameType.PageContent,
        signal: config?.signal
    });

export const getAdminPageData = (slug: string, config?: ApiRequestConfig) =>
    requestBinaryOnly<PageContentAdmin>({
        binaryRoute: {
            operationId: 'binary_get_system_admin_page_slug',
            params: { slug }
        },
        frameType: FrameType.PageContent,
        signal: config?.signal
    });

/**
 * 更新动态页面
 * 安全性保障：防止自动化脚本利用管理权限进行大规模的 SEO 垃圾信息注入
 */
export const updatePageData = (data: PageContentAdmin, config?: ApiRequestConfig) =>
    requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_put_system_page' },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.PageContentUpdateRequest, encodePageContentPayload(data))
        }
    });

export const refreshPageData = (slug: string, config?: ApiRequestConfig) =>
    requestBinaryOnly<null>({
        binaryRoute: {
            operationId: 'binary_post_system_page_refresh_slug',
            params: { slug }
        },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: {
        }
    });

/**
 * 删除文件
 * 删除请求必须携带 PoW 证明。
 */
export const deleteImage = (assetId: string, config?: ApiRequestConfig) =>
    requestBinaryOnly<null>({
        binaryRoute: { operationId: 'binary_delete_file_delete' },
        frameType: FrameType.EmptySuccess,
        signal: config?.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.FileDeleteRequest, encodeStringMutationRequest(assetId))
        }
    });

function encodeSeoConfigPayload(data: SeoConfigAdmin): Uint8Array
{
    const description = new TextEncoder().encode(data.description ?? '');
    const podSize = 5000;
    const bytes = new Uint8Array(podSize + 4 + description.byteLength);
    writeFixedUtf8(bytes, 0, 256, data.title ?? '');
    writeInt32(bytes, 256, 0);
    writeInt32(bytes, 260, description.byteLength);
    writeFixedUtf8(bytes, 264, 256, data.keywords ?? '');
    writeFixedUtf8(bytes, 520, 64, data.author ?? '');
    writeFixedUtf8(bytes, 584, 256, data.ogImage ?? '');
    writeFixedUtf8(bytes, 840, 256, data.baseUrl ?? '');
    writeFixedUtf8(bytes, 1096, 256, data.faviconSvgUrl ?? '');
    writeFixedUtf8(bytes, 1352, 256, data.faviconIcoUrl ?? '');
    writeFixedUtf8(bytes, 1608, 256, data.faviconPngUrl ?? '');
    writeFixedUtf8(bytes, 1864, 256, data.appleTouchIconUrl ?? '');
    writeFixedUtf8(bytes, 2120, 128, data.manifestName ?? '');
    writeFixedUtf8(bytes, 2248, 128, data.manifestShortName ?? '');
    writeFixedUtf8(bytes, 2376, 256, data.pwaIcon192Url ?? '');
    writeFixedUtf8(bytes, 2632, 256, data.pwaIcon512Url ?? '');
    writeFixedUtf8(bytes, 2888, 256, data.pwaMaskableIconUrl ?? '');
    writeFixedUtf8(bytes, 3144, 32, data.themeColor ?? '');
    writeFixedUtf8(bytes, 3176, 32, data.backgroundColor ?? '');
    writeFixedUtf8(bytes, 3208, 256, data.siteLogoUrl ?? '');
    writeFixedUtf8(bytes, 3464, 256, data.siteLogoDarkUrl ?? '');
    writeFixedUtf8(bytes, 3720, 256, data.siteWordmarkUrl ?? '');
    writeFixedUtf8(bytes, 3976, 256, data.adminLogoUrl ?? '');
    writeFixedUtf8(bytes, 4232, 256, data.adminCollapsedIconUrl ?? '');
    writeFixedUtf8(bytes, 4488, 256, data.loginLogoUrl ?? '');
    writeFixedUtf8(bytes, 4744, 256, data.loginIconUrl ?? '');
    writeInt32(bytes, podSize, description.byteLength);
    bytes.set(description, podSize + 4);
    return bytes;
}

function encodePageContentPayload(data: PageContentAdmin): Uint8Array
{
    const content = new TextEncoder().encode(data.content ?? '');
    const bytes = new Uint8Array(136 + 4 + content.byteLength);
    writeFixedUtf8(bytes, 0, 128, data.slug ?? '');
    writeInt32(bytes, 128, 0);
    writeInt32(bytes, 132, content.byteLength);
    writeInt32(bytes, 136, content.byteLength);
    bytes.set(content, 140);
    return bytes;
}

function encodeSiteCompliancePayload(data: SiteComplianceConfigAdmin): Uint8Array
{
    const copyrightText = new TextEncoder().encode(data.copyrightText ?? '');
    const podSize = 1709;
    const bytes = new Uint8Array(podSize + 4 + copyrightText.byteLength);
    bytes[0] = data.enabled ? 1 : 0;
    writeFixedUtf8(bytes, 1, 32, data.regionMode ?? 'global');
    writeInt32(bytes, 33, data.copyrightStartYear ?? 0);
    writeFixedUtf8(bytes, 37, 128, data.copyrightOwner ?? '');
    writeInt32(bytes, 165, 0);
    writeInt32(bytes, 169, copyrightText.byteLength);
    writeFixedUtf8(bytes, 173, 128, data.contentLicenseName ?? '');
    writeFixedUtf8(bytes, 301, 256, data.contentLicenseUrl ?? '');
    writeFixedUtf8(bytes, 557, 64, data.icpRecordNumber ?? '');
    writeFixedUtf8(bytes, 621, 256, data.icpRecordUrl ?? '');
    writeFixedUtf8(bytes, 877, 64, data.policeRecordNumber ?? '');
    writeFixedUtf8(bytes, 941, 256, data.policeRecordUrl ?? '');
    writeFixedUtf8(bytes, 1197, 256, data.policeBadgeIconUrl ?? '');
    writeFixedUtf8(bytes, 1453, 128, data.operatorName ?? '');
    writeFixedUtf8(bytes, 1581, 128, data.contactEmail ?? '');
    writeInt32(bytes, podSize, copyrightText.byteLength);
    bytes.set(copyrightText, podSize + 4);
    return bytes;
}

function writeInt32(target: Uint8Array, offset: number, value: number): void
{
    new DataView(target.buffer, target.byteOffset, target.byteLength).setInt32(offset, value, true);
}
