/** Parse a manually entered campaign ID without coercion or network access. */
export function parseCampaignId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return value;
}
