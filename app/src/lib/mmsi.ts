/**
 * AIS MMSI validation (#25): a Maritime Mobile Service Identity is exactly 9
 * decimal digits. Kept a string throughout the app so leading zeros (valid for
 * coast-station / group identifiers, form 00MIDxxxx) survive; a numeric type
 * would silently drop them.
 */
export function isValidMmsi(value: string): boolean {
  return /^\d{9}$/.test(value);
}
