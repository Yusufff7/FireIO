import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { KeplerVideoView } from '@amazon-devices/react-native-w3cmedia';
import {
  getTrailer,
  subscribeTrailer,
  surfaceMounted,
  TRAILER_FADE_MS,
  type TrailerState,
} from '../player/trailerController';

// Shows the current trailer (see player/trailerController) when it belongs
// to `itemId`: fades in once the trailer is actually playing and out when
// it ends. The Home hero and the Detail screen each render one, so opening a
// title whose trailer is playing carries the same video over full screen.
export function TrailerSurface({
  itemId,
  style,
  onPlayingChange,
}: {
  itemId: string;
  style?: StyleProp<ViewStyle>;
  // Lets the caller ease its overlays back while video is showing.
  onPlayingChange?: (playing: boolean) => void;
}) {
  const [trailer, setTrailer] = useState<TrailerState | null>(getTrailer);
  useEffect(() => subscribeTrailer(setTrailer), []);
  const mine = trailer && trailer.itemId === itemId ? trailer : null;
  const playing = mine?.phase === 'playing';

  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, {
      toValue: playing ? 1 : 0,
      duration: playing ? 500 : TRAILER_FADE_MS,
      easing: Easing.inOut(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [playing, opacity]);

  const onPlayingRef = useRef(onPlayingChange);
  onPlayingRef.current = onPlayingChange;
  useEffect(() => {
    onPlayingRef.current?.(playing);
  }, [playing]);

  const player = mine?.player ?? null;
  if (!player) return null;
  return (
    <Animated.View style={[styles.wrap, style, { opacity }]} pointerEvents="none">
      <SurfaceRegistration />
      <KeplerVideoView
        videoPlayer={player}
        style={StyleSheet.absoluteFill}
        showControls={false}
        showCaptions={false}
        // Crop to cover, the way the backdrop art does.
        scalingmode="fill"
      />
    </Animated.View>
  );
}

// Tells the controller a video view exists, for as long as it does.
function SurfaceRegistration() {
  useEffect(() => surfaceMounted(), []);
  return null;
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', overflow: 'hidden' },
});
