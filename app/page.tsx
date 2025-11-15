"use client";

import { useEffect, useRef } from "react";
import Hls from "hls.js";

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const hlsUrl = "http://127.0.0.1:8080/playlist.m3u8";

    if (Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch((error) => {
          console.error("Error playing video:", error);
        });
      });

      return () => {
        hls.destroy();
      };
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native HLS support (Safari)
      video.src = hlsUrl;
      video.play().catch((error) => {
        console.error("Error playing video:", error);
      });
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
        <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
          <video
            ref={videoRef}
            className="absolute inset-0 h-full w-full rounded-lg"
            controls
            playsInline
          />
        </div>
      </main>
    </div>
  );
}
