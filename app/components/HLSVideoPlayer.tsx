'use client';

import { useEffect, useRef } from 'react';
import Hls from 'hls.js';

interface HLSVideoPlayerProps {
  hlsUrl?: string;
  className?: string;
}

export default function HLSVideoPlayer({
  hlsUrl = '/api/hls/playlist.m3u8',
  className = 'absolute inset-0 h-full w-full rounded-lg',
}: HLSVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      const hls = new Hls({
        xhrSetup: (xhr, url) => {
          // Rewrite URLs to use proxy
          let proxiedUrl = url;

          console.log(`[HLS] Original URL: ${url}`);

          // Handle absolute URLs from HLS server
          if (url.startsWith('http://127.0.0.1:8080/') || url.startsWith('https://127.0.0.1:8080/')) {
            proxiedUrl = url.replace(/https?:\/\/127\.0\.0\.1:8080\//, '/api/hls/');
            console.log(`[HLS] Rewriting absolute URL: ${url} -> ${proxiedUrl}`);
          }
          // Handle relative paths starting with /
          else if (url.startsWith('/') && !url.startsWith('/api/hls/')) {
            proxiedUrl = '/api/hls' + url;
            console.log(`[HLS] Rewriting relative URL: ${url} -> ${proxiedUrl}`);
          }

          xhr.open('GET', proxiedUrl, true);
        },
        enableWorker: false, // Disable worker to avoid CORS issues
        lowLatencyMode: false,
      });
      hlsRef.current = hls;

      // Error handling
      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error('[HLS Error]', {
          type: data.type,
          details: data.details,
          fatal: data.fatal,
          url: data.url,
          error: data.error,
          response: data.response,
        });

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

  return <video ref={videoRef} className={className} controls playsInline />;
}

