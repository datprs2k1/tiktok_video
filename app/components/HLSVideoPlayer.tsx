'use client';

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import Hls from 'hls.js';

// Conditional logging - only log in development
const isDevelopment = process.env.NODE_ENV === 'development';
const debugLog = (...args: any[]) => {
  if (isDevelopment) {
    console.log(...args);
  }
};
const debugError = (...args: any[]) => {
  if (isDevelopment) {
    console.error(...args);
  }
};
const debugWarn = (...args: any[]) => {
  if (isDevelopment) {
    console.warn(...args);
  }
};

interface HLSVideoPlayerProps {
  hlsUrl?: string;
  className?: string;
}

// Network Information API types (not fully supported in all browsers)
interface NetworkInformation extends EventTarget {
  effectiveType?: string;
  downlink?: number;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

interface NavigatorWithConnection extends Navigator {
  connection?: NetworkInformation;
  mozConnection?: NetworkInformation;
  webkitConnection?: NetworkInformation;
}

// HLS Level type
interface HLSLevel {
  width?: number;
  height?: number;
  bitrate?: number;
  name?: string;
  codecs?: string;
}

// Extended HLS type with loading property
interface HLSWithLoading extends Hls {
  loading?: boolean;
}

// Adaptive prefetch distance calculation (moved outside component for performance)
function calculateAdaptivePrefetchDistance(bandwidth: number | null, bufferHealth: number): number {
  // Convert bandwidth from bps to Mbps for easier comparison
  const bandwidthMbps = bandwidth ? bandwidth / 1000000 : 5; // Default to 5 Mbps if null

  let baseDistance: number;

  if (bandwidthMbps > 10) {
    // High bandwidth: prefetch 60+ seconds ahead (YouTube-like)
    baseDistance = 60;
  } else if (bandwidthMbps >= 3) {
    // Medium bandwidth: prefetch 45+ seconds ahead (YouTube-like)
    baseDistance = 45;
  } else {
    // Low bandwidth: prefetch 30+ seconds ahead (YouTube-like)
    baseDistance = 30;
  }

  // Adjust based on buffer health: if buffer is low, increase prefetch distance
  if (bufferHealth < 5) {
    baseDistance *= 1.2; // Increase by 20% if buffer is low
  }

  return Math.round(baseDistance);
}

// Network bandwidth detection utility
function useNetworkBandwidth() {
  // Use initial state instead of setState in effect to avoid cascading renders
  const [bandwidth, setBandwidth] = useState<number | null>(() => {
    // Initialize with default value
    return 5000000; // Default 5 Mbps
  });

  useEffect(() => {
    if ('connection' in navigator) {
      const nav = navigator as NavigatorWithConnection;
      const connection = nav.connection || nav.mozConnection || nav.webkitConnection;
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

          const estimatedBandwidth = downlink || (effectiveType ? bandwidthMap[effectiveType] : undefined) || 5;
          setBandwidth(estimatedBandwidth * 1000000); // Convert to bps
        };

        updateBandwidth();
        connection.addEventListener('change', updateBandwidth);

        return () => {
          connection.removeEventListener('change', updateBandwidth);
        };
      }
    }
  }, []);

  return bandwidth;
}

export default function HLSVideoPlayer({
  hlsUrl = 'https://tiktok.datprs.store/playlist.m3u8',
  className = 'absolute inset-0 h-full w-full rounded-lg',
}: HLSVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  // Loading state management
  const [isLoading, setIsLoading] = useState(true);

  // Quality selection state
  const [availableLevels, setAvailableLevels] = useState<HLSLevel[]>([]);
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
  // Timeout tracking to prevent multiple setTimeout callbacks from accumulating
  const pendingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Track seek completion time to prevent duplicate preload after seek
  const lastSeekTimeRef = useRef<number>(0);
  // Track play state before seeking to resume after seek completes
  const wasPlayingBeforeSeekRef = useRef<boolean>(false);

  // Position preservation refs for error recovery
  const savedPositionRef = useRef<number>(0);
  const isRecoveringRef = useRef<boolean>(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true, // Enable Web Worker for better performance
        lowLatencyMode: false,
        // Adaptive Bitrate Streaming (ABR) configuration
        maxBufferLength: 60, // Maximum buffer length in seconds (YouTube-like)
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
          const video = videoRef.current;
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              debugError('[HLS] Fatal network error:', data.details, 'URL:', data.url);
              debugError('[HLS] Trying to recover...');
              // Preserve current position before recovery
              if (video && !isNaN(video.currentTime) && video.currentTime > 0) {
                savedPositionRef.current = video.currentTime;
                isRecoveringRef.current = true;
                debugLog('[HLS] Saved position before recovery:', savedPositionRef.current);
              }
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              debugError('[HLS] Fatal media error:', data.details);
              debugError('[HLS] Trying to recover...');
              // Preserve current position before recovery
              if (video && !isNaN(video.currentTime) && video.currentTime > 0) {
                savedPositionRef.current = video.currentTime;
                isRecoveringRef.current = true;
                debugLog('[HLS] Saved position before recovery:', savedPositionRef.current);
              }
              hls.recoverMediaError();
              break;
            default:
              debugError('[HLS] Fatal error:', data.type, data.details);
              debugError('[HLS] Destroying instance...');
              hls.destroy();
              break;
          }
        } else {
          debugWarn('[HLS] Non-fatal error:', data.details);
        }
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(video);

      // Throttled wrapper for hls.startLoad() to prevent redundant network requests
      // Defined at useEffect level so it's accessible to all handlers
      const throttledStartLoad = () => {
        // CRITICAL: Check if HLS is already loading to prevent duplicate requests
        // HLS.js has a 'loading' property that TypeScript types may not include
        if (hls && 'loading' in hls && (hls as HLSWithLoading).loading) {
          return; // Already loading, skip to prevent duplicate segment requests
        }

        const now = Date.now();
        const timeSinceLastLoad = now - lastLoadTimeRef.current;
        const minInterval = 500; // Minimum 500ms between calls

        if (timeSinceLastLoad >= minInterval) {
          lastLoadTimeRef.current = now;
          // Cancel any pending timeout before making immediate call
          if (pendingTimeoutRef.current) {
            clearTimeout(pendingTimeoutRef.current);
            pendingTimeoutRef.current = null;
          }
          if (hls) {
            hls.startLoad();
          }
        } else {
          // Schedule delayed call if within throttle window
          // Cancel existing timeout to prevent accumulation
          if (pendingTimeoutRef.current) {
            clearTimeout(pendingTimeoutRef.current);
            pendingTimeoutRef.current = null;
          }
          const remainingTime = minInterval - timeSinceLastLoad;
          pendingTimeoutRef.current = setTimeout(() => {
            pendingTimeoutRef.current = null; // Clear ref when timeout fires
            // Check again if still loading before executing
            if (hls && 'loading' in hls && (hls as HLSWithLoading).loading) {
              return; // Already loading, skip
            }
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
        debugLog('[HLS] Manifest parsed, video ready to play');
        debugLog('[HLS] Levels:', hls.levels);
        setIsLoading(false);
        setAvailableLevels(hls.levels);
        setCurrentLevel(hls.currentLevel);

        // Restore position after error recovery
        if (isRecoveringRef.current && savedPositionRef.current > 0) {
          const video = videoRef.current;
          if (video) {
            // Wait for video to be ready before restoring position
            const restorePosition = () => {
              if (video.readyState >= 2) {
                // Video has enough data to seek
                video.currentTime = savedPositionRef.current;
                isRecoveringRef.current = false;
                debugLog('[HLS] Position restored after recovery:', savedPositionRef.current);
              } else {
                // Wait a bit more for video to load
                setTimeout(restorePosition, 100);
              }
            };
            // Try to restore immediately, or wait if video not ready
            if (video.readyState >= 2) {
              restorePosition();
            } else {
              video.addEventListener('loadeddata', restorePosition, { once: true });
              // Fallback timeout
              setTimeout(() => {
                if (isRecoveringRef.current) {
                  restorePosition();
                }
              }, 1000);
            }
          }
        }

        // Progressive loading: Preload next segments based on playback position
        const setupProgressiveLoading = () => {
          const checkAndPreload = () => {
            if (!video || !hls) return;

            const currentTime = video.currentTime;

            // Integrated seeking detection via time jumps (consolidated from handleTimeUpdate)
            // Skip seeking detection during recovery to avoid false positives from buffer reset
            if (!isRecoveringRef.current) {
              const timeDiff = Math.abs(currentTime - previousTimeRef.current);
              if (timeDiff > 2 && !isSeekingRef.current) {
                // Time jump detected - likely a seek
                isSeekingRef.current = true;
                seekTargetRef.current = currentTime;
                debugLog('[HLS] Seek detected via time jump, target:', seekTargetRef.current);
              }
            }
            previousTimeRef.current = currentTime;

            const buffered = video.buffered;
            let bufferedEnd = 0;

            if (buffered.length > 0) {
              bufferedEnd = buffered.end(buffered.length - 1);
            }

            const bufferAhead = bufferedEnd - currentTime;
            const bufferHealth = bufferAhead; // Current buffer health in seconds

            // Seeking detection: track seeking state for information/logging
            // Note: Seeking-triggered loads are handled by handleSeeked() to prevent duplicates
            if (isSeekingRef.current) {
              const seekTarget = seekTargetRef.current;
              // Check if buffer around seek position is sufficient (for information only)
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
              // Continue to normal prefetch check below (handleSeeked() handles seeking-triggered loads)
            }

            // Skip normal prefetch during seeking to prevent duplicates with handleSeeked()
            if (isSeekingRef.current) {
              return; // handleSeeked() is the sole handler for seeking-triggered loads
            }

            // Skip normal prefetch if seek completed recently (within last 1 second)
            // This prevents checkAndPreload() from triggering load right after seek,
            // giving handleSeeked() exclusive control during immediate post-seek period
            const timeSinceSeek = Date.now() - lastSeekTimeRef.current;
            if (timeSinceSeek < 1000) {
              return; // Skip normal prefetch if seek completed within last 1 second
            }

            // Normal prefetch logic (only runs when not seeking)
            // Segment duration: 10 seconds per segment (fixed)
            const SEGMENT_DURATION = 10;
            const bufferedSegments = Math.floor(bufferAhead / SEGMENT_DURATION);
            const minSegments = 5; // Minimum 5 segments required (YouTube-like: 4-6 segments)

            // Calculate adaptive prefetch distance based on bandwidth and buffer health
            const prefetchDistance = calculateAdaptivePrefetchDistance(networkBandwidth, bufferHealth);

            // Check if HLS is already loading to prevent duplicate segment requests
            // This provides an additional layer of protection beyond throttledStartLoad()
            if (hls && 'loading' in hls && (hls as HLSWithLoading).loading) {
              return; // Already loading, skip to prevent duplicate requests
            }

            // Preload if buffer is less than 5 segments OR less than adaptive distance ahead
            // This ensures minimum 5 segments while keeping adaptive optimization
            // YouTube-like: preload even when paused
            if (bufferedSegments < minSegments || bufferAhead < prefetchDistance) {
              // Trigger HLS to load more segments
              throttledStartLoad();
            }
          };

          // Event-driven buffer checking instead of polling for better performance
          // Use timeupdate event (fires every ~250ms) combined with throttling
          let lastCheckTime = 0;
          const CHECK_INTERVAL = 2000; // Check every 2 seconds (throttled)

          const handleTimeUpdate = () => {
            const now = Date.now();
            if (now - lastCheckTime >= CHECK_INTERVAL) {
              lastCheckTime = now;
              checkAndPreload();
            }
          };

          // Also check on play/pause events for immediate response
          const handlePlay = () => {
            checkAndPreload();
            video.addEventListener('timeupdate', handleTimeUpdate);
          };

          const handlePause = () => {
            video.removeEventListener('timeupdate', handleTimeUpdate);
            // Still check once when paused to maintain buffer
            checkAndPreload();
          };

          // Start buffering immediately
          checkAndPreload();

          // Add event listeners
          video.addEventListener('play', handlePlay);
          video.addEventListener('pause', handlePause);
          if (!video.paused) {
            video.addEventListener('timeupdate', handleTimeUpdate);
          }

          return () => {
            video.removeEventListener('timeupdate', handleTimeUpdate);
            video.removeEventListener('play', handlePlay);
            video.removeEventListener('pause', handlePause);
          };
        };

        // Setup progressive loading after a short delay to ensure video is ready
        setTimeout(setupProgressiveLoading, 1000);
      });

      hls.on(Hls.Events.LEVEL_LOADED, (event, data) => {
        debugLog('[HLS] Level loaded:', data);
        setCurrentLevel(hls.currentLevel);
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
        debugLog('[HLS] Level switched:', data);
        setCurrentLevel(hls.currentLevel);
      });

      // Seeking detection event handlers
      const handleSeeking = () => {
        const video = videoRef.current;
        if (video) {
          // Save play state before seeking to resume after seek completes
          wasPlayingBeforeSeekRef.current = !video.paused;
          // Pause video to ensure both video and audio tracks stop during seek
          video.pause();
          isSeekingRef.current = true;
          seekTargetRef.current = video.currentTime;
          debugLog('[HLS] Seeking started, target:', seekTargetRef.current);
        }
      };

      const handleSeeked = () => {
        const video = videoRef.current;
        if (video && hls) {
          isSeekingRef.current = false;
          const newPosition = video.currentTime;
          debugLog('[HLS] Seeking completed, new position:', newPosition);
          // Track seek completion time to prevent duplicate preload
          lastSeekTimeRef.current = Date.now();
          // Trigger immediate prefetch around seek position
          throttledStartLoad();
          // Resume playback if video was playing before seek
          if (wasPlayingBeforeSeekRef.current) {
            video.play().catch((error) => {
              debugWarn('[HLS] Failed to resume playback after seek:', error);
            });
          }
        }
      };

      video.addEventListener('seeking', handleSeeking);
      video.addEventListener('seeked', handleSeeked);

      return () => {
        video.removeEventListener('seeking', handleSeeking);
        video.removeEventListener('seeked', handleSeeked);
        hls.destroy();
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      video.src = hlsUrl;
      // Don't auto-play, let user click play button
      debugLog('HLS video source set, ready to play');
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
