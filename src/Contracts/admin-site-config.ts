import { encodeFrame, ProtocolError } from './aeds.ts';
import { proveAndSubmitAdminPow } from './admin-step-up.ts';
import { request } from './client.ts';
import {
  decodeAdminSiteConfigState,
  encodeAdminSiteConfigCommand,
  FrameType,
  WireLimits,
  WireRoutes,
  type AdminSiteConfigCommand,
  type AdminSiteConfigState,
} from './wire.generated.ts';

export type { AdminSiteConfigCommand, AdminSiteConfigState };

const encoder = new TextEncoder();
const hexDigestPattern = /^[a-f0-9]{64}$/;
const hexColorPattern = /^#[0-9a-fA-F]{6}$/;
const emailPattern = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const assetSegmentPattern = /^[A-Za-z0-9._-]+$/;

export type SiteConfigFieldError =
  | 'required'
  | 'tooLong'
  | 'invalidChars'
  | 'invalidUrl'
  | 'invalidAssetUrl'
  | 'invalidColor'
  | 'invalidYear'
  | 'invalidEmail'
  | 'requiresLabel';

export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

export function hasInvalidControlChars(text: string, allowWhitespaceControls = false): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0xfffe || code === 0xffff) return true;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (isControl && !(allowWhitespaceControls && (code === 0x0a || code === 0x0d || code === 0x09)))
      return true;
  }
  return false;
}

export function validSiteText(text: string, maxBytes: number, required = false, allowWhitespaceControls = false): SiteConfigFieldError | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return required ? 'required' : null;
  if (hasInvalidControlChars(trimmed, allowWhitespaceControls)) return 'invalidChars';
  if (utf8Length(trimmed) > maxBytes) return 'tooLong';
  return null;
}

export function validSiteUrl(value: string, options: { asset?: boolean; label?: string } = {}): SiteConfigFieldError | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (options.label !== undefined && options.label.trim().length === 0) return 'requiresLabel';
  if (hasInvalidControlChars(trimmed)) return 'invalidChars';
  if (utf8Length(trimmed) > WireLimits.SiteConfigUrlBytes) return 'tooLong';
  if (/\s|\\/.test(trimmed)) return options.asset ? 'invalidAssetUrl' : 'invalidUrl';
  if (options.asset && trimmed.startsWith('/assets/')) {
    const rest = trimmed.slice('/assets/'.length);
    if (rest.length > 0 && rest.split('/').every(seg => seg.length > 0 && seg !== '.' && seg !== '..' && assetSegmentPattern.test(seg)))
      return null;
    return 'invalidAssetUrl';
  }
  if (/[@?#]/.test(trimmed)) return options.asset ? 'invalidAssetUrl' : 'invalidUrl';
  const parsed = URL.parse(trimmed);
  if (parsed && parsed.protocol === 'https:' && parsed.hostname.length > 0 && !parsed.username && !parsed.password)
    return null;
  return options.asset ? 'invalidAssetUrl' : 'invalidUrl';
}

export function validSiteColor(value: string): SiteConfigFieldError | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return hexColorPattern.test(trimmed) ? null : 'invalidColor';
}

export function validSiteEmail(value: string): SiteConfigFieldError | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (utf8Length(trimmed) > WireLimits.SiteConfigShortTextBytes) return 'tooLong';
  return emailPattern.test(trimmed) ? null : 'invalidEmail';
}

export function validCopyrightStartYear(year: number | null, currentYear = new Date().getUTCFullYear()): SiteConfigFieldError | null {
  if (year === null || year === 0) return null;
  if (!Number.isInteger(year) || year < 1990 || year > currentYear) return 'invalidYear';
  return null;
}

export function readAdminSiteConfig(signal: AbortSignal): Promise<AdminSiteConfigState> {
  return request(WireRoutes.AdminSiteConfig, FrameType.AdminSiteConfigState, payload => {
    const state = decodeAdminSiteConfigState(payload);
    if (state.revision < 0n || !hexDigestPattern.test(state.digest) ||
        (state.regionMode !== 'global' && state.regionMode !== 'mainland-cn') ||
        state.copyrightStartYear < 0 || state.copyrightStartYear > 9999)
      throw new ProtocolError('Invalid administrator site configuration state');
    return state;
  }, signal);
}

export function saveAdminSiteConfig(command: AdminSiteConfigCommand, signal: AbortSignal): Promise<void> {
  if (command.expectedRevision < 0n || !hexDigestPattern.test(command.expectedDigest) ||
      (command.regionMode !== 'global' && command.regionMode !== 'mainland-cn'))
    throw new ProtocolError('Invalid administrator site configuration command');
  return proveAndSubmitAdminPow({
    begin: WireRoutes.AdminSiteConfigStepUpBegin,
    complete: WireRoutes.AdminSiteConfigStepUpComplete,
    pow: WireRoutes.AdminSiteConfigPow,
    submit: WireRoutes.AdminSiteConfigSave,
  }, encodeFrame(FrameType.AdminSiteConfigCommand, encodeAdminSiteConfigCommand(command)), signal);
}
