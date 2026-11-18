/** Parse a manually entered positive integer ID without coercion or network access. */
export function parsePositiveId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

export const parseCampaignId = parsePositiveId;
