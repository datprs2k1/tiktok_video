'use client';

import { useEffect, useRef } from 'react';
import Hls from 'hls.js';

interface HLSVideoPlayerProps {
  hlsUrl?: string;
  className?: string;
}

export default function HLSVideoPlayer({
  hlsUrl = 'http://127.0.0.1:8080/playlist.m3u8',
  className = 'absolute inset-0 h-full w-full rounded-lg',
}: HLSVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: false,
        lowLatencyMode: false,
      });
      hlsRef.current = hls;

      // Error handling
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.error('[HLS] Fatal network error:', data.details, 'URL:', data.url);
              console.error('[HLS] Trying to recover...');
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.error('[HLS] Fatal media error:', data.details);
              console.error('[HLS] Trying to recover...');
              hls.recoverMediaError();
              break;
            default:
              console.error('[HLS] Fatal error:', data.type, data.details);
              console.error('[HLS] Destroying instance...');
              hls.destroy();
              break;
          }
        } else {
          console.warn('[HLS] Non-fatal error:', data.details);
        }
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('[HLS] Manifest parsed, video ready to play');
        console.log('[HLS] Levels:', hls.levels);
      });

      hls.on(Hls.Events.LEVEL_LOADED, (event, data) => {
        console.log('[HLS] Level loaded:', data);
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
  }, [hlsUrl]);

  return (
    <div className="relative w-full h-full">
      {/* Glassmorphism Container - Mobile optimized */}
      <div className="
        relative w-full h-full
        backdrop-blur-md
        bg-white/5 dark:bg-black/20
        border border-white/10 dark:border-white/20
        rounded-xl md:rounded-2xl
        shadow-lg md:shadow-2xl
        overflow-hidden
        transition-all duration-300
      ">
        {/* Video Element */}
        <video 
          ref={videoRef} 
          className={className}
          controls 
          playsInline
        />
        
        {/* Optional: Glass overlay for enhanced effect on desktop */}
        <div className="
          hidden md:block
          absolute inset-0
          pointer-events-none
          bg-gradient-to-br from-white/5 to-transparent
          rounded-xl md:rounded-2xl
        " />
      </div>
    </div>
  );
}
