import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Focusable } from './Focusable';
import { IconHome, IconSearch } from './NavIcons';
import { colors, spacing } from '../theme';

// Library and Settings are gone. Library duplicated Continue Watching, and
// with focus-driven navigation it was unreachable anyway: landing on any nav
// item navigates immediately, so you could never move *across* the bar to
// reach the far items. Settings only held addon URLs, which come from
// localDefaults.
type Route = 'Home' | 'Search';

type IconComponent = (props: { size?: number; color?: string }) => React.ReactElement;

const ITEMS: Array<{ route: Route; Icon: IconComponent; label: string }> = [
  { route: 'Home', Icon: IconHome, label: 'Home' },
  { route: 'Search', Icon: IconSearch, label: 'Search' },
];

const ICON_ACTIVE = '#ffffff';
const ICON_IDLE = 'rgba(255,255,255,0.55)';

export function TopNav({
  active,
  onNavigate,
  overlay,
}: {
  active: Route;
  onNavigate: (route: Route) => void;
  // Floats the nav over the content below it (a gradient instead of a solid
  // bar) so a full-bleed backdrop image can show through underneath — used
  // on Home, where Hero fills the whole top of the screen. Other screens
  // keep the plain solid-background bar since they have no art behind it.
  overlay?: boolean;
}) {
  return (
    <View style={[styles.wrap, overlay && styles.wrapOverlay]}>
      {/* Home's overlay sits directly over Hero's own art — the logo was
          just extra clutter on top of a poster/backdrop image already
          carrying the brand. Kept on the plain solid-bar screens, where
          there's no art behind it to compete with. An empty spacer keeps
          the icons anchored to the right either way, matching their
          position on every other screen. */}
      {overlay ? <View /> : <Text style={styles.brand}>STREMIO</Text>}
      <View style={styles.items}>
        {ITEMS.map(item => {
          const isActive = item.route === active;
          return (
            // Focus-driven, not press-driven — moving the D-pad highlight
            // onto an item switches straight to it, no separate select
            // press needed. Four items, one row: fast to scan past, and
            // matches how several TV apps already treat a top tab bar.
            <Focusable
              key={item.route}
              // Never re-navigate to the screen you're already on — focus
              // landing on the active item should be a no-op, not a reload.
              onFocus={() => {
                if (!isActive) onNavigate(item.route);
              }}
              style={styles.item}>
              <item.Icon size={20} color={isActive ? ICON_ACTIVE : ICON_IDLE} />
              <Text style={[styles.label, isActive && styles.labelActive]}>{item.label}</Text>
              <View style={[styles.underline, isActive && styles.underlineActive]} />
            </Focusable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  // Visual only — positioning/animation is owned by the caller (see
  // HomeScreen, which wraps this in its own absolutely-positioned Animated
  // container so it can fade the whole bar out on scroll). Needs a real
  // explicit height, not just padding around the content: a gradient
  // stretched over only the icons' own intrinsic height doesn't have enough
  // room to visibly fade to transparent before the box simply ends.
  wrapOverlay: {
    height: 150,
    paddingTop: spacing.lg,
    experimental_backgroundImage: 'linear-gradient(180deg, rgba(10,10,11,0.92) 0%, rgba(10,10,11,0.55) 45%, transparent 100%)',
  },
  brand: { color: colors.text, fontSize: 18, fontWeight: '800', letterSpacing: 1.5 },
  items: { flexDirection: 'row', gap: spacing.xl },
  item: { alignItems: 'center', gap: spacing.xs, borderWidth: 0, padding: spacing.xs },
  label: { color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: '700' },
  labelActive: { color: colors.text },
  underline: { width: 22, height: 2, backgroundColor: 'transparent', marginTop: 2 },
  underlineActive: { backgroundColor: colors.accent },
});
