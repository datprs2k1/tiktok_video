'use client';

import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

interface HLSVideoPlayerProps {
  hlsUrl?: string;
  className?: string;
}

// Network bandwidth detection utility
function useNetworkBandwidth() {
  const [bandwidth, setBandwidth] = useState<number | null>(null);

  useEffect(() => {
    if ('connection' in navigator) {
      const connection =
        (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;
      if (connection) {
        const updateBandwidth = () => {
          // Get effective bandwidth estimate (in Mbps)
          const effectiveType = connection.effectiveType;
          const downlink = connection.downlink; // Mbps

          // Map effective type to approximate bandwidth
          const bandwidthMap: { [key: string]: number } = {
            'slow-2g': 0.5,
            '2g': 1.5,
            '3g': 3.5,
            '4g': 10,
          };

          const estimatedBandwidth = downlink || bandwidthMap[effectiveType] || 5;
          setBandwidth(estimatedBandwidth * 1000000); // Convert to bps
        };

        updateBandwidth();
        connection.addEventListener('change', updateBandwidth);

        return () => {
          connection.removeEventListener('change', updateBandwidth);
        };
      }
    }

    // Fallback: estimate based on HLS.js bandwidth
    setBandwidth(5000000); // Default 5 Mbps
  }, []);

  return bandwidth;
}

export default function HLSVideoPlayer({
  hlsUrl = 'http://160.250.181.190:8080/playlist.m3u8',
  className = 'absolute inset-0 h-full w-full rounded-lg',
}: HLSVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  // Loading state management
  const [isLoading, setIsLoading] = useState(true);
  const [isBuffering, setIsBuffering] = useState(false);
  const [bufferingProgress, setBufferingProgress] = useState(0);

  // Quality selection state
  const [availableLevels, setAvailableLevels] = useState<any[]>([]);
  const [currentLevel, setCurrentLevel] = useState<number>(-1);
  const [showQualitySelector, setShowQualitySelector] = useState(false);

  // Network bandwidth detection
  const networkBandwidth = useNetworkBandwidth();

  // Seeking detection refs
  const isSeekingRef = useRef<boolean>(false);
  const previousTimeRef = useRef<number>(0);
  const seekTargetRef = useRef<number>(0);

  // Debouncing ref for hls.startLoad() calls
  const lastLoadTimeRef = useRef<number>(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: false,
        lowLatencyMode: false,
        // Adaptive Bitrate Streaming (ABR) configuration
        maxBufferLength: 30, // Maximum buffer length in seconds
        maxMaxBufferLength: 60, // Maximum max buffer length in seconds
        startLevel: -1, // Auto-select initial quality level (-1 = auto)
        capLevelToPlayerSize: true, // Cap quality to player size
        abrEwmaDefaultEstimate: networkBandwidth || 500000, // Use detected bandwidth or default 500kbps
        abrBandWidthFactor: 0.95, // Bandwidth factor for ABR
        abrBandWidthUpFactor: 0.7, // Bandwidth up factor for ABR
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

      // Throttled wrapper for hls.startLoad() to prevent redundant network requests
      // Defined at useEffect level so it's accessible to all handlers
      const throttledStartLoad = () => {
        const now = Date.now();
        const timeSinceLastLoad = now - lastLoadTimeRef.current;
        const minInterval = 500; // Minimum 500ms between calls

        if (timeSinceLastLoad >= minInterval) {
          lastLoadTimeRef.current = now;
          if (hls) {
            hls.startLoad();
          }
        } else {
          // Schedule delayed call if within throttle window
          const remainingTime = minInterval - timeSinceLastLoad;
          setTimeout(() => {
            const now = Date.now();
            if (now - lastLoadTimeRef.current >= minInterval) {
              lastLoadTimeRef.current = now;
              if (hls) {
                hls.startLoad();
              }
            }
          }, remainingTime);
        }
      };

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('[HLS] Manifest parsed, video ready to play');
        console.log('[HLS] Levels:', hls.levels);
        setIsLoading(false);
        setAvailableLevels(hls.levels);
        setCurrentLevel(hls.currentLevel);

        // Progressive loading: Preload next segments based on playback position
        // Adaptive prefetch distance calculation based on network bandwidth
        const calculateAdaptivePrefetchDistance = (bandwidth: number | null, bufferHealth: number): number => {
          // Convert bandwidth from bps to Mbps for easier comparison
          const bandwidthMbps = bandwidth ? bandwidth / 1000000 : 5; // Default to 5 Mbps if null

          let baseDistance: number;

          if (bandwidthMbps > 10) {
            // High bandwidth: prefetch 30-60s ahead
            baseDistance = 45;
          } else if (bandwidthMbps >= 3) {
            // Medium bandwidth: prefetch 15-30s ahead
            baseDistance = 22.5;
          } else {
            // Low bandwidth: prefetch 10-15s ahead
            baseDistance = 12.5;
          }

          // Adjust based on buffer health: if buffer is low, increase prefetch distance
          if (bufferHealth < 5) {
            baseDistance *= 1.2; // Increase by 20% if buffer is low
          }

          return Math.round(baseDistance);
        };
        const setupProgressiveLoading = () => {
          const checkAndPreload = () => {
            if (!video || !hls) return;

            const currentTime = video.currentTime;

            // Integrated seeking detection via time jumps (consolidated from handleTimeUpdate)
            const timeDiff = Math.abs(currentTime - previousTimeRef.current);
            if (timeDiff > 2 && !isSeekingRef.current) {
              // Time jump detected - likely a seek
              isSeekingRef.current = true;
              seekTargetRef.current = currentTime;
              console.log('[HLS] Seek detected via time jump, target:', seekTargetRef.current);
            }
            previousTimeRef.current = currentTime;

            const buffered = video.buffered;
            let bufferedEnd = 0;

            if (buffered.length > 0) {
              bufferedEnd = buffered.end(buffered.length - 1);
            }

            const bufferAhead = bufferedEnd - currentTime;
            const bufferHealth = bufferAhead; // Current buffer health in seconds

            // Optimized seeking-aware prefetch: only check when actually seeking
            if (isSeekingRef.current) {
              const seekTarget = seekTargetRef.current;
              // Optimized: Check if buffer around seek position is sufficient (early exit)
              let hasBufferAroundSeek = false;
              for (let i = 0; i < buffered.length; i++) {
                const start = buffered.start(i);
                const end = buffered.end(i);
                // Check if seek target is within buffered range or close (within 5s)
                if (seekTarget >= start - 5 && seekTarget <= end + 5) {
                  hasBufferAroundSeek = true;
                  break; // Early exit when found
                }
              }

              // If no buffer around seek position, trigger immediate load and return early
              if (!hasBufferAroundSeek) {
                throttledStartLoad();
                return; // Early return - no need to check normal prefetch
              }
              // If buffer exists around seek, continue to normal prefetch check below
            }

            // Normal prefetch logic (only runs if not seeking or if seeking but buffer exists)
            // Calculate adaptive prefetch distance based on bandwidth and buffer health
            const prefetchDistance = calculateAdaptivePrefetchDistance(networkBandwidth, bufferHealth);

            // Preload if buffer is less than adaptive distance ahead
            if (bufferAhead < prefetchDistance && !video.paused) {
              // Trigger HLS to load more segments
              throttledStartLoad();
            }
          };

          // Check buffer every 2 seconds during playback
          const interval = setInterval(() => {
            if (video && !video.paused) {
              checkAndPreload();
            }
          }, 2000);

          // Also check on timeupdate for more responsive preloading
          video.addEventListener('timeupdate', checkAndPreload);

          return () => {
            clearInterval(interval);
            video.removeEventListener('timeupdate', checkAndPreload);
          };
        };

        // Setup progressive loading after a short delay to ensure video is ready
        setTimeout(setupProgressiveLoading, 1000);
      });

      hls.on(Hls.Events.LEVEL_LOADED, (event, data) => {
        console.log('[HLS] Level loaded:', data);
        setCurrentLevel(hls.currentLevel);
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
        console.log('[HLS] Level switched:', data);
        setCurrentLevel(hls.currentLevel);
      });

      // Buffer monitoring event handlers
      hls.on(Hls.Events.BUFFER_APPENDING, (event, data) => {
        setIsBuffering(true);
        console.log('[HLS] Buffer appending:', data);
      });

      hls.on(Hls.Events.BUFFER_APPENDED, (event, data) => {
        const video = videoRef.current;
        if (video) {
          const buffered = video.buffered;
          if (buffered.length > 0) {
            const bufferedEnd = buffered.end(buffered.length - 1);
            const currentTime = video.currentTime;
            const bufferedAmount = bufferedEnd - currentTime;
            const progress = Math.min((bufferedAmount / 30) * 100, 100); // 30s buffer target
            setBufferingProgress(progress);

            if (bufferedAmount > 5) {
              // Buffer is healthy (>5s ahead)
              setIsBuffering(false);
            }
          }
        }
        console.log('[HLS] Buffer appended:', data);
      });

      // Monitor video element buffering state
      const handleWaiting = () => {
        setIsBuffering(true);
      };

      const handleCanPlay = () => {
        setIsBuffering(false);
      };

      video.addEventListener('waiting', handleWaiting);
      video.addEventListener('canplay', handleCanPlay);

      // Seeking detection event handlers
      const handleSeeking = () => {
        const video = videoRef.current;
        if (video) {
          isSeekingRef.current = true;
          seekTargetRef.current = video.currentTime;
          console.log('[HLS] Seeking started, target:', seekTargetRef.current);
        }
      };

      const handleSeeked = () => {
        const video = videoRef.current;
        if (video && hls) {
          isSeekingRef.current = false;
          const newPosition = video.currentTime;
          console.log('[HLS] Seeking completed, new position:', newPosition);
          // Trigger immediate prefetch around seek position
          throttledStartLoad();
        }
      };

      video.addEventListener('seeking', handleSeeking);
      video.addEventListener('seeked', handleSeeked);

      return () => {
        video.removeEventListener('waiting', handleWaiting);
        video.removeEventListener('canplay', handleCanPlay);
        video.removeEventListener('seeking', handleSeeking);
        video.removeEventListener('seeked', handleSeeked);
        hls.destroy();
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      video.src = hlsUrl;
      // Don't auto-play, let user click play button
      console.log('HLS video source set, ready to play');
      setIsLoading(false);
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
    };
  }, [hlsUrl, networkBandwidth]);

  return (
    <div className="absolute inset-0">
      {/* Glassmorphism Container - Mobile optimized */}
      <div
        className="
        relative w-full h-full
        backdrop-blur-md
        bg-white/5 dark:bg-black/20
        border border-white/10 dark:border-white/20
        rounded-xl md:rounded-2xl
        shadow-lg md:shadow-2xl
        overflow-hidden
        transition-all duration-300
      "
      >
        {/* Video Element */}
        <video ref={videoRef} className={className} controls playsInline />

        {/* Loading indicator */}
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10">
            <div className="text-white">Loading video...</div>
          </div>
        )}

        {/* Buffering indicator */}
        {isBuffering && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30 z-10">
            <div className="text-white">Buffering... {Math.round(bufferingProgress)}%</div>
          </div>
        )}

        {/* Quality selector */}
        {availableLevels.length > 0 && (
          <div className="absolute top-4 right-4 z-20">
            <button
              onClick={() => setShowQualitySelector(!showQualitySelector)}
              className="px-3 py-2 bg-black/70 text-white rounded-lg text-sm hover:bg-black/90 transition-colors"
            >
              Quality {currentLevel === -1 ? 'Auto' : availableLevels[currentLevel]?.height + 'p'}
            </button>
            {showQualitySelector && (
              <div className="absolute top-full right-0 mt-2 bg-black/90 rounded-lg overflow-hidden min-w-[120px]">
                <button
                  onClick={() => {
                    if (hlsRef.current) {
                      hlsRef.current.currentLevel = -1;
                      setCurrentLevel(-1);
                      setShowQualitySelector(false);
                    }
                  }}
                  className={`w-full px-4 py-2 text-left text-sm text-white hover:bg-white/10 ${
                    currentLevel === -1 ? 'bg-white/20' : ''
                  }`}
                >
                  Auto
                </button>
                {availableLevels.map((level, index) => (
                  <button
                    key={index}
                    onClick={() => {
                      if (hlsRef.current) {
                        hlsRef.current.currentLevel = index;
                        setCurrentLevel(index);
                        setShowQualitySelector(false);
                      }
                    }}
                    className={`w-full px-4 py-2 text-left text-sm text-white hover:bg-white/10 ${
                      currentLevel === index ? 'bg-white/20' : ''
                    }`}
                  >
                    {level.height}p
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Optional: Glass overlay for enhanced effect on desktop */}
        <div
          className="
          hidden md:block
          absolute inset-0
          pointer-events-none
          bg-gradient-to-br from-white/5 to-transparent
          rounded-xl md:rounded-2xl
        "
        />
      </div>
    </div>
  );
}
