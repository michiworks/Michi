/**
 * Chromium features Michi switches off, merged into `--disable-features`
 * before the app is ready (a repeated switch would replace the earlier one).
 *
 * VSync-aligned presentation (macOS, on by default): Chromium holds frames
 * that handle interaction until the next DisplayLink callback, and sometimes
 * presents one without its backdrop-filter layers, so ⌘K, menus and modals
 * lose their glass for a frame, over and over. Turning it off stopped the
 * same single-frame flashes in another Electron app (pingdotgg/t3code#25552).
 * Chromium 146 (Electron 41) calls it VSyncAlignedPresent; Chromium 152
 * renamed it VSyncAlignedPresentationForScrolling. Both are listed: Chromium
 * ignores names it doesn't know, so an Electron upgrade keeps it off. A
 * workaround, not a fix, and the flag may go away.
 * MICHI_KEEP_VSYNC_PRESENTATION=1 keeps Chromium's default, to compare.
 */
export const GLASS_FLICKER_FEATURES = ['VSyncAlignedPresent', 'VSyncAlignedPresentationForScrolling'] as const;

/**
 * ANGLE's Metal backend (macOS default) under window vibrancy: macOS now and
 * then shows a frame Chromium has not finished drawing. The transcript that
 * changed is there, the layers drawn above it are not, so Settings, ⌘K, the
 * scrim and menus vanish for one frame while a reply streams. Frozen glass
 * cannot help: these frames lack the overlay itself, not just its blur.
 *
 * Measured with a 2000×1080 vibrancy window and a reply streaming under ⌘K
 * and Settings, recorded at 60 fps (Electron 41, Chromium 146, macOS 27):
 * 9–26 such frames per 36 s on the default backend, 1–5 with only Skia
 * Graphite off, 0 in each of 4 runs on ANGLE's OpenGL backend (Graphite needs
 * Metal, so it goes off too), with the same GPU-process CPU. An opaque window
 * showed none on the default backend, so this applies only with vibrancy.
 * SkiaGraphite is listed as well in case a later Chromium decouples the two.
 * MICHI_KEEP_ANGLE_METAL=1 keeps Chromium's default, to compare.
 *
 * In real use this only lowers the rate: with an agent running and the
 * Background work drawer open, the OpenGL backend still lost the overlay about
 * twice a second on a 360 Hz display. Turning window glass off (Settings →
 * Appearance, see windowGlass.ts) is what stops it.
 */
export const VIBRANCY_TEARING_FEATURES = ['DefaultANGLEMetal', 'SkiaGraphite'] as const;

/**
 * `vibrancy` is whether windows open with vibrancy: off with
 * MICHI_NO_VIBRANCY=1 or when window glass was turned off. A live switch keeps
 * the backend chosen at launch.
 */
export function michiDisabledFeatures(
  platform: string,
  env: Record<string, string | undefined>,
  vibrancy = env.MICHI_NO_VIBRANCY !== '1',
): string[] {
  if (platform !== 'darwin') return [];
  const features: string[] = [];
  if (env.MICHI_KEEP_VSYNC_PRESENTATION !== '1') features.push(...GLASS_FLICKER_FEATURES);
  if (vibrancy && env.MICHI_KEEP_ANGLE_METAL !== '1') features.push(...VIBRANCY_TEARING_FEATURES);
  return features;
}

/** `existing` (a `--disable-features` value, possibly empty) plus `add`, without duplicates. */
export function mergeFeatureList(existing: string, add: readonly string[]): string {
  const features = existing.split(',').map((feature) => feature.trim()).filter(Boolean);
  for (const feature of add) if (!features.includes(feature)) features.push(feature);
  return features.join(',');
}
