export const ORI_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"; // 30 chars, no 0 1 i l o
const BASE32_ALPHABET = "0123456789abcdefghjkmnopqrstuvwxyz"; // Crockford base32 (no i l o u)
const BASE62_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX_ALPHABET = "0123456789abcdef";

const crypto = globalThis.crypto as unknown as {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
};

function randomChars(alphabet: string, length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export const ORI_ALPHABET_REGEX = new RegExp(`^[${ORI_ALPHABET}]+$`);

/** `or_` + 8 random chars from the ori alphabet. */
export function oriId(): string {
  return `or_${randomChars(ORI_ALPHABET, 8)}`;
}

/** `sak_` + 24 lowercase hex. */
export function apiKeyId(): string {
  return `sak_${randomChars(HEX_ALPHABET, 24)}`;
}

/** `ori_live_` + 40 base62. */
export function apiKeySecret(): string {
  return `ori_live_${randomChars(BASE62_ALPHABET, 40)}`;
}

/** uuid v4. Snapshot ids and prompt-run ids are both plain uuids (see snapshotId/promptRunId). */
export function uuidV4(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const hex = [...b].map((v) => v.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

export const snapshotId = uuidV4;
export const promptRunId = uuidV4;

/** `req_` + 26 base32 (ULID-ish). */
export function requestId(): string {
  return `req_${randomChars(BASE32_ALPHABET, 26)}`;
}

export const ORI_ID_PATTERN = "^or_[23456789abcdefghjkmnpqrstuvwxyz]{8}$";
export const API_KEY_ID_PATTERN = "^sak_[0-9a-f]{24}$";
export const API_KEY_SECRET_PATTERN = "^ori_live_[0-9A-Za-z]{40}$";
export const REQUEST_ID_PATTERN = "^req_[0-9a-z]{26}$";
export const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

export const oriIdRegex = /^or_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
export const apiKeyIdRegex = /^sak_[0-9a-f]{24}$/;
export const apiKeySecretRegex = /^ori_live_[0-9A-Za-z]{40}$/;
export const requestIdRegex = /^req_[0-9a-z]{26}$/;
export const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isOriId(v: unknown): v is string {
  return typeof v === "string" && oriIdRegex.test(v);
}
export function isApiKeyId(v: unknown): v is string {
  return typeof v === "string" && apiKeyIdRegex.test(v);
}
export function isApiKeySecret(v: unknown): v is string {
  return typeof v === "string" && apiKeySecretRegex.test(v);
}
export function isSnapshotId(v: unknown): v is string {
  return typeof v === "string" && uuidRegex.test(v);
}
export function isRequestId(v: unknown): v is string {
  return typeof v === "string" && requestIdRegex.test(v);
}