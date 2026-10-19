/** Lowercase, strip Vietnamese diacritics (incl. đ/Đ) and collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// VND has no minor unit in practice; prices such as 286363.64 (pre-VAT) are shown rounded.
const VND = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });

/** Format a VND amount the way Vietnamese readers expect: `1.250.000 ₫`. Empty string for non-numbers. */
export function formatVnd(amount: unknown): string {
  const n =
    typeof amount === 'number' ? amount : typeof amount === 'string' && amount.trim() ? Number(amount) : Number.NaN;
  if (!Number.isFinite(n)) return '';
  return `${VND.format(n)} ₫`;
}
