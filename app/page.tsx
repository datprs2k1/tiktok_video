'use client';

import { useEffect, useRef } from 'react';
import Hls from 'hls.js';

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const hlsUrl = '/api/hls/playlist.m3u8';

    if (Hls.isSupported()) {
      const hls = new Hls({
        xhrSetup: (xhr, url) => {
          // Rewrite segment URLs to use proxy
          if (url.startsWith('/') && !url.startsWith('/api/hls/')) {
            const proxiedUrl = '/api/hls' + url;
            console.log(`[HLS] Rewriting URL: ${url} -> ${proxiedUrl}`);
            xhr.open('GET', proxiedUrl, true);
          } else {
            xhr.open('GET', url, true);
          }
        },
      });
      hlsRef.current = hls;
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // Video is ready, but don't auto-play due to browser autoplay policy
        // User can click play button to start playback
        console.log('HLS manifest parsed, video ready to play');
      });

      return () => {
        hls.destroy();
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      video.src = hlsUrl;
      // Don't auto-play, let user click play button
      console.log('HLS video source set, ready to play');
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
    };
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-black">
      <main className="w-full max-w-7xl p-4">
        <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
          <video ref={videoRef} className="absolute inset-0 h-full w-full rounded-lg" controls playsInline />
        </div>
      </main>
    </div>
  );
}
