'use client';

import { useEffect, useRef } from 'react';
import Hls from 'hls.js';
import { extractTSFromData } from '../utils/segmentDecoder';

interface VideoPlayerProps {
  src?: string;
  className?: string;
}

export default function VideoPlayer({ src = 'http://127.0.0.1:8080/playlist.m3u8', className = '' }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  // Initialize HLS
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
      });

      hlsRef.current = hls;

      hls.loadSource(src);
      hls.attachMedia(video);

      // Decode segments that are wrapped with markers
      hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
        if (data.payload && data.payload instanceof ArrayBuffer) {
          try {
            // Convert ArrayBuffer to Uint8Array for decoding
            const segmentBytes = new Uint8Array(data.payload);
            const decodedData = extractTSFromData(segmentBytes);

            // If markers were found and data was extracted, replace the payload
            if (decodedData !== null) {
              // Convert decoded Uint8Array back to ArrayBuffer
              // Create a new ArrayBuffer with the exact size of decoded data
              const newBuffer = new ArrayBuffer(decodedData.length);
              const newView = new Uint8Array(newBuffer);
              newView.set(decodedData);
              data.payload = newBuffer;
            }
            // If markers not found, use original payload (defensive approach)
          } catch (error) {
            // If decoding fails, use original payload
            console.warn('Segment decoding failed, using original data:', error);
          }
        }
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.error('HLS Network error');
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.error('HLS Media error');
              hls.recoverMediaError();
              break;
            default:
              console.error('HLS error:', data);
              hls.destroy();
              break;
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      video.src = src;
    } else {
      console.error('HLS is not supported in this browser.');
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
    };
  }, [src]);

  return (
    <div className={`w-full h-full bg-black ${className}`}>
      <video ref={videoRef} className="w-full h-full" controls playsInline />
    </div>
  );
}
