import React from 'react';
import { View } from 'react-native';

// Plain-View icon shapes — no emoji, no SVG lib. Player transport icons were
// rendered as Unicode media-control glyphs (⏮ ⏸ ⏭) which Fire OS's system
// font substitutes with colored emoji (orange), not the plain white glyph we
// wanted. These are geometric shapes built from View borders instead, so
// there's no font/emoji rendering involved at all.

const TRIANGLE_BORDER = (size: number, color: string) => ({
  width: 0,
  height: 0,
  borderTopWidth: size / 2,
  borderBottomWidth: size / 2,
  borderLeftWidth: size * 0.85,
  borderTopColor: 'transparent',
  borderBottomColor: 'transparent',
  borderLeftColor: color,
});

export function IconPlay({ size = 20, color = '#fff' }: { size?: number; color?: string }) {
  return <View style={[TRIANGLE_BORDER(size, color), { marginLeft: size * 0.08 }]} />;
}

export function IconPause({ size = 20, color = '#fff' }: { size?: number; color?: string }) {
  const barWidth = size * 0.3;
  const gap = size * 0.16;
  return (
    <View style={{ flexDirection: 'row', gap }}>
      <View style={{ width: barWidth, height: size, backgroundColor: color, borderRadius: 1 }} />
      <View style={{ width: barWidth, height: size, backgroundColor: color, borderRadius: 1 }} />
    </View>
  );
}

export function IconSkipBack({ size = 20, color = '#fff' }: { size?: number; color?: string }) {
  const tri = TRIANGLE_BORDER(size, color);
  const flipped = { ...tri, borderLeftWidth: 0, borderRightWidth: size * 0.85, borderRightColor: color };
  return (
    <View style={{ flexDirection: 'row', gap: 1 }}>
      <View style={flipped} />
      <View style={flipped} />
    </View>
  );
}

export function IconSkipForward({ size = 20, color = '#fff' }: { size?: number; color?: string }) {
  const tri = TRIANGLE_BORDER(size, color);
  return (
    <View style={{ flexDirection: 'row', gap: 1 }}>
      <View style={tri} />
      <View style={tri} />
    </View>
  );
}

// Closed-captions glyph: an outlined box with two short bars, matching the
// mockup's subtitles icon.
export function IconSubtitles({ size = 20, color = '#fff' }: { size?: number; color?: string }) {
  const w = size * 1.3;
  const h = size * 0.9;
  return (
    <View style={{ width: w, height: h, borderWidth: 1.5, borderColor: color, borderRadius: 2, padding: h * 0.18, justifyContent: 'space-between' }}>
      <View style={{ height: 1.5, width: '70%', backgroundColor: color }} />
      <View style={{ height: 1.5, width: '45%', backgroundColor: color }} />
    </View>
  );
}

// Audio-track glyph: stacked bars, distinct from playback triangle so it
// reads as "tracks/levels" rather than another play button.
export function IconAudio({ size = 20, color = '#fff' }: { size?: number; color?: string }) {
  const bar = (h: number) => ({ width: size * 0.16, height: h, backgroundColor: color, borderRadius: 1 });
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: size * 0.14, height: size }}>
      <View style={bar(size * 0.5)} />
      <View style={bar(size)} />
      <View style={bar(size * 0.7)} />
    </View>
  );
}

// Next-episode glyph: a play triangle against a bar, the standard "skip to
// next track" shape — deliberately distinct from IconSkipForward's double
// triangle, which means "seek forward 10s" here.
export function IconNextEpisode({ size = 20, color = '#fff' }: { size?: number; color?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: size * 0.14 }}>
      <View style={TRIANGLE_BORDER(size, color)} />
      <View style={{ width: size * 0.16, height: size, backgroundColor: color, borderRadius: 1 }} />
    </View>
  );
}

export function IconChevronLeft({ size = 20, color = '#fff' }: { size?: number; color?: string }) {
  return (
    <View
      style={{
        width: size * 0.5,
        height: size * 0.5,
        borderLeftWidth: 2.5,
        borderBottomWidth: 2.5,
        borderColor: color,
        transform: [{ rotate: '45deg' }],
      }}
    />
  );
}
