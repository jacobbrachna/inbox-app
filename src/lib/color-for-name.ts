// Hash a name to a hue (0-359). Stable per name so the same person always
// gets the same color. Used for monogram fallback when no avatar is available.
export function hueForName(name: string | undefined | null): number {
  if (!name) return 220; // default blue-ish if name is missing
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}
