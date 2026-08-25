import React from 'react';
import { View } from 'react-native';

// Same rule as PlayerIcons: geometry built from Views, never Unicode glyphs.
// The nav bar was still using text characters (⌂ ⌕ ▤ ⚙), which Fire OS's
// system font renders inconsistently — the gear in particular came out as a
// colored emoji rather than a flat monochrome icon, which is exactly the
// mismatch the player icons were rebuilt to avoid.

type IconProps = { size?: number; color?: string };

export function IconHome({ size = 20, color = '#fff' }: IconProps) {
  const roof = size * 0.58;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {/* Roof: a border-built triangle, same trick as the play glyph. */}
      <View
        style={{
          width: 0,
          height: 0,
          borderLeftWidth: roof,
          borderRightWidth: roof,
          borderBottomWidth: roof * 0.72,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderBottomColor: color,
        }}
      />
      <View
        style={{
          width: size * 0.72,
          height: size * 0.42,
          borderWidth: 1.8,
          borderTopWidth: 0,
          borderColor: color,
        }}
      />
    </View>
  );
}

export function IconSearch({ size = 20, color = '#fff' }: IconProps) {
  const ring = size * 0.66;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          width: ring,
          height: ring,
          borderRadius: ring / 2,
          borderWidth: 1.8,
          borderColor: color,
          marginTop: -size * 0.08,
          marginLeft: -size * 0.08,
        }}
      />
      {/* Handle, angled off the lower-right of the ring. */}
      <View
        style={{
          position: 'absolute',
          width: 1.8,
          height: size * 0.34,
          backgroundColor: color,
          right: size * 0.14,
          bottom: size * 0.04,
          transform: [{ rotate: '-45deg' }],
        }}
      />
    </View>
  );
}

// Two upright volumes side by side — reads as a shelf rather than as a
// generic hamburger, which is what the old ▤ glyph looked like.
export function IconLibrary({ size = 20, color = '#fff' }: IconProps) {
  const h = size * 0.82;
  const book = (width: number, height: number, rotate?: string) => ({
    width,
    height,
    borderWidth: 1.7,
    borderColor: color,
    borderRadius: 1,
    transform: rotate ? [{ rotate }] : undefined,
  });
  return (
    <View style={{ width: size, height: size, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: size * 0.1 }}>
      <View style={book(size * 0.24, h)} />
      <View style={book(size * 0.24, h)} />
      <View style={book(size * 0.24, h * 0.88, '10deg')} />
    </View>
  );
}

// Gear: a ring plus teeth on the diagonals and axes. Six bars rotated around
// the centre gives the silhouette without needing SVG.
export function IconSettings({ size = 20, color = '#fff' }: IconProps) {
  const ring = size * 0.56;
  const toothLength = size * 0.94;
  const toothWidth = size * 0.16;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {[0, 60, 120].map(deg => (
        <View
          key={deg}
          style={{
            position: 'absolute',
            width: toothWidth,
            height: toothLength,
            backgroundColor: color,
            borderRadius: 1,
            transform: [{ rotate: `${deg}deg` }],
          }}
        />
      ))}
      {/* Ring drawn over the teeth, with a hub knocked out of the middle. */}
      <View
        style={{
          width: ring,
          height: ring,
          borderRadius: ring / 2,
          borderWidth: size * 0.13,
          borderColor: color,
          backgroundColor: 'transparent',
        }}
      />
    </View>
  );
}
