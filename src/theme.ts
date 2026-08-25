// From the "Stremio Fire TV UI" design (claude.ai/design) — grayscale-and-
// glass system with one accent color used only for focus/emphasis. No real
// backdrop-filter blur available without a new native dependency (risk,
// after the FlashList bundler crash — see PLAN.md §9), so "glass" is
// simulated with translucent layering rather than a true Gaussian blur.
export const colors = {
  background: '#0a0a0b',
  backgroundElevated: '#0d0d0e',

  glass: 'rgba(255,255,255,0.07)',
  glassFocused: 'rgba(255,255,255,0.14)',
  glassBorder: 'rgba(255,255,255,0.14)',

  text: '#ffffff',
  textDim: 'rgba(255,255,255,0.6)',
  textFaint: 'rgba(255,255,255,0.38)',

  // The design's single accent — an ice blue, used for focus rings, active
  // states, and progress fills. Primary CTA buttons stay solid white/black
  // per the mockup (Play, Save); the accent marks selection, not action.
  accent: '#a8e0ff',
  accentOn: '#0a0a0b',

  // Solid white pill — the mockup's primary-action style (Play, Save, +Add).
  cta: '#ffffff',
  ctaText: '#0a0a0b',

  focusGlow: 'rgba(168,224,255,0.55)',

  ok: 'rgba(255,255,255,0.85)',
  danger: '#ff453a',

  scrim: 'rgba(0,0,0,0.55)',
  scrimStrong: 'rgba(0,0,0,0.82)',

  posterGradientStart: '#2c2c2f',
  posterGradientEnd: '#0c0c0d',
};

export const spacing = {
  xs: 6,
  sm: 12,
  md: 20,
  lg: 32,
  xl: 48,
  xxl: 64,
};

export const radius = {
  sm: 10,
  md: 14,
  lg: 18,
  xl: 22,
  pill: 999,
};

// The design's focus/selection signature: an ice-blue glow lift.
export const glow = (color: string = colors.focusGlow, opacity = 0.55, blur = 22) => ({
  shadowColor: color,
  shadowOpacity: opacity,
  shadowRadius: blur,
  shadowOffset: { width: 0, height: 0 },
  elevation: 12,
});
