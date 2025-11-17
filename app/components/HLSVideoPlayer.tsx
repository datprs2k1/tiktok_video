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

// Format time helper
const formatTime = (seconds: number): string => {
  if (isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
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
// Returns number of segments to prefetch based on bandwidth and buffer health
function calculateAdaptivePrefetchSegments(
  bandwidth: number | null,
  bufferHealthSegments: number,
  segmentDuration: number
): number {
  // Convert bandwidth from bps to Mbps for easier comparison
  const bandwidthMbps = bandwidth ? bandwidth / 1000000 : 5; // Default to 5 Mbps if null

  let baseSegments: number;

  if (bandwidthMbps > 10) {
    // High bandwidth: prefetch 6+ segments ahead (60+ seconds, YouTube-like)
    baseSegments = Math.ceil(60 / segmentDuration);
  } else if (bandwidthMbps >= 3) {
    // Medium bandwidth: prefetch 5+ segments ahead (45+ seconds, YouTube-like)
    baseSegments = Math.ceil(45 / segmentDuration);
  } else {
    // Low bandwidth: prefetch 3+ segments ahead (30+ seconds, YouTube-like)
    baseSegments = Math.ceil(30 / segmentDuration);
  }

  // Adjust based on buffer health (in segments): if buffer is low, increase prefetch distance more aggressively
  if (bufferHealthSegments < 1) {
    // Very low buffer (< 1 segment): double the prefetch distance for aggressive buffering
    baseSegments *= 2.0;
  } else if (bufferHealthSegments < 2) {
    // Low buffer (< 2 segments): increase by 50% for faster recovery
    baseSegments *= 1.5;
  }

  return Math.round(baseSegments);
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
  const seekTargetRef = useRef<number>(0);

  // Debouncing ref for hls.startLoad() calls
  const lastLoadTimeRef = useRef<number>(0);
  // Timeout tracking to prevent multiple setTimeout callbacks from accumulating
  const pendingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Throttled wrapper for hls.startLoad() - moved to component level
  const throttledStartLoad = useCallback(() => {
    const hls = hlsRef.current;
    if (!hls) return;
    // CRITICAL: Check if HLS is already loading to prevent duplicate requests
    if ('loading' in hls && (hls as HLSWithLoading).loading) {
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
      hls.startLoad();
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
        const hls = hlsRef.current;
        if (!hls) return;
        if ('loading' in hls && (hls as HLSWithLoading).loading) {
          return; // Already loading, skip
        }
        const now = Date.now();
        if (now - lastLoadTimeRef.current >= minInterval) {
          lastLoadTimeRef.current = now;
          hls.startLoad();
        }
      }, remainingTime);
    }
  }, []);
  // Track seek completion time to prevent duplicate preload after seek
  const lastSeekTimeRef = useRef<number>(0);
  // Track play state before seeking to resume after seek completes
  const wasPlayingBeforeSeekRef = useRef<boolean>(false);
  // Track if play state was explicitly set by manual seek (to prevent handleSeeking from overwriting)
  const playStateExplicitlySetRef = useRef<boolean>(false);
  // Track pending play promise to avoid interruptions
  const pendingPlayPromiseRef = useRef<Promise<void> | null>(null);

  // Refs for tracking timeouts to enable cleanup
  const setupProgressiveLoadingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const resumePlaybackTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Refs for batching timeupdate state updates with requestAnimationFrame
  const rafIdRef = useRef<number | null>(null);
  const pendingTimeUpdateRef = useRef<{ currentTime: number; duration: number; buffered: number } | null>(null);

  // Helper function to get buffered end time (eliminates duplication)
  const getBufferedEnd = useCallback((video: HTMLVideoElement): number => {
    const buffered = video.buffered;
    if (buffered.length > 0) {
      return buffered.end(buffered.length - 1);
    }
    return 0;
  }, []);

  // Helper function to check if video has enough data (eliminates duplication)
  const isVideoReady = useCallback((video: HTMLVideoElement): boolean => {
    return video.readyState >= 2; // HAVE_CURRENT_DATA or higher
  }, []);

  // Helper function to calculate percent from mouse/touch event (eliminates duplication)
  const calculatePercentFromEvent = useCallback(
    (element: HTMLElement, e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>): number => {
      // Use offsetX/offsetY when available (relative to element, no layout recalculation)
      // Fallback to getBoundingClientRect for touch events
      if ('touches' in e) {
        // Touch event: use getBoundingClientRect
        const rect = element.getBoundingClientRect();
        const clientX = e.touches[0].clientX;
        return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      } else {
        // Mouse event: use offsetX (relative to element, more efficient)
        const offsetX = e.nativeEvent.offsetX ?? e.clientX - element.getBoundingClientRect().left;
        return Math.max(0, Math.min(1, offsetX / element.offsetWidth));
      }
    },
    []
  );

  // Helper function to play video with promise handling (eliminates duplication)
  const playVideoWithPromise = useCallback(
    (video: HTMLVideoElement, onSuccess?: () => void, onError?: (error: Error) => void) => {
      // Clear any pending play promise
      pendingPlayPromiseRef.current = null;
      const playPromise = video.play();
      if (playPromise !== undefined) {
        pendingPlayPromiseRef.current = playPromise;
        playPromise
          .then(() => {
            pendingPlayPromiseRef.current = null;
            if (onSuccess) onSuccess();
          })
          .catch((error) => {
            pendingPlayPromiseRef.current = null;
            // Ignore "interrupted" errors as they're expected during seeking or quick user actions
            if (error.name !== 'AbortError' && error.name !== 'NotAllowedError') {
              if (onError) {
                onError(error);
              } else {
                debugWarn('[Video] Play failed:', error);
              }
            }
          });
      }
    },
    []
  );

  // Helper function to save play state before seeking (eliminates duplication)
  const savePlayStateBeforeSeek = useCallback((video: HTMLVideoElement) => {
    wasPlayingBeforeSeekRef.current = !video.paused;
    playStateExplicitlySetRef.current = true; // Mark as explicitly set by manual seek
  }, []);

  // Throttled buffer checking - moved to component level for accessibility
  const lastCheckTimeRef = useRef<number>(0);
  const CHECK_INTERVAL = 1000; // Check every 1 second (reduced from 2s for faster response to buffer depletion)
  // Flag to prevent duplicate execution of checkAndPreload when multiple event handlers fire simultaneously
  const isCheckingPreloadRef = useRef<boolean>(false);
  // Interval ref for automatic preload during buffering
  const bufferingPreloadIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // Timeout ref for delayed interval start (to avoid duplicate with immediate call)
  const bufferingPreloadStartTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // checkAndPreload function - moved to component level to be accessible from main handlers
  // Works entirely with segments for HLS streaming (not seconds)
  //
  // CONFLICT PREVENTION: This function has multiple guards to prevent duplicate processing:
  // 1. isCheckingPreloadRef: Prevents concurrent execution when multiple handlers fire simultaneously
  // 2. HLS loading check: Prevents duplicate segment requests when HLS is already loading
  // 3. isSeekingRef: Prevents execution during seeking (handleSeeked handles seek-triggered loads)
  // 4. lastSeekTimeRef: Prevents execution immediately after seek (1.5s window for handleSeeked)
  // 5. throttledStartLoad: Additional throttling at the HLS.startLoad() level (500ms minimum interval)
  const checkAndPreload = useCallback(() => {
    // Prevent duplicate execution when multiple event handlers fire simultaneously
    // (e.g., handleWaiting and handleStalled can fire at the same time)
    if (isCheckingPreloadRef.current) {
      return; // Already checking, skip to prevent duplicate calculations
    }

    try {
      isCheckingPreloadRef.current = true;

      const video = videoRef.current;
      const hls = hlsRef.current;
      if (!video || !hls) return;

      // Early exit: Check if HLS is already loading to prevent duplicate preload calls
      // This check happens before any calculations to avoid unnecessary work
      if ('loading' in hls && (hls as HLSWithLoading).loading) {
        return; // Already loading, skip to prevent duplicate segment requests
      }

      // Skip normal prefetch during seeking to prevent duplicates with handleSeeked()
      if (isSeekingRef.current) {
        return; // handleSeeked() is the sole handler for seeking-triggered loads
      }

      // Skip normal prefetch if seek completed recently (within last 1.5 seconds)
      // This prevents checkAndPreload() from triggering load right after seek,
      // giving handleSeeked() exclusive control during immediate post-seek period
      const timeSinceSeek = Date.now() - lastSeekTimeRef.current;
      if (timeSinceSeek < 1500) {
        return; // Skip normal prefetch if seek completed within last 1.5 seconds
      }

      // Normal prefetch logic (only runs when not seeking and not already loading)
      // Segment duration: 10 seconds per segment (fixed)
      const SEGMENT_DURATION = 10;
      const currentTime = video.currentTime;
      const bufferedEnd = getBufferedEnd(video);
      const bufferAhead = bufferedEnd - currentTime;

      // Calculate buffered segments directly (segment-based calculation)
      const bufferedSegments = Math.floor(bufferAhead / SEGMENT_DURATION);
      const minSegments = 5; // Minimum 5 segments required (YouTube-like: 4-6 segments)

      // Calculate adaptive prefetch segments based on bandwidth and buffer health (both in segments)
      const prefetchSegments = calculateAdaptivePrefetchSegments(networkBandwidth, bufferedSegments, SEGMENT_DURATION);

      // Preload if buffer is less than minimum segments OR less than adaptive prefetch segments
      // All comparisons are segment-based for consistency with HLS streaming
      // YouTube-like: preload even when paused
      if (bufferedSegments < minSegments || bufferedSegments < prefetchSegments) {
        // Trigger HLS to load more segments
        throttledStartLoad();
      }
    } finally {
      // Always reset flag, even if function returns early or throws
      isCheckingPreloadRef.current = false;
    }
  }, [networkBandwidth, throttledStartLoad, getBufferedEnd]);

  // Throttled wrapper for checkAndPreload to prevent excessive calls
  const throttledCheckAndPreload = useCallback(() => {
    const now = Date.now();
    if (now - lastCheckTimeRef.current >= CHECK_INTERVAL) {
      lastCheckTimeRef.current = now;
      checkAndPreload();
    }
  }, [checkAndPreload]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true, // Enable Web Worker for better performance
        lowLatencyMode: false,
        // Adaptive Bitrate Streaming (ABR) configuration
        maxBufferLength: 120, // Maximum buffer length in seconds (increased to accommodate preload requirements)
        maxMaxBufferLength: 120, // Maximum max buffer length in seconds (increased to accommodate preload requirements)
        maxBufferSize: 60 * 1024 * 1024, // Maximum buffer size in bytes (60MB) - prevents memory issues
        maxBufferHole: 0.5, // Maximum gap tolerance in seconds - allows small gaps without stalling
        minAutoBitrate: 100000, // Minimum bitrate for auto quality (100kbps) - quality floor
        startLevel: -1, // Auto-select initial quality level (-1 = auto)
        capLevelToPlayerSize: true, // Cap quality to player size
        abrEwmaDefaultEstimate: networkBandwidth || 1000000, // Use detected bandwidth or default 1Mbps (improved from 500kbps)
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
              setErrorMessage('Lỗi kết nối mạng. Đang thử kết nối lại...');
              throttledStartLoad();
              // Clear error message after recovery attempt
              setTimeout(() => setErrorMessage(null), 5000);
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              debugError('[HLS] Fatal media error:', data.details);
              debugError('[HLS] Trying to recover...');
              setErrorMessage('Lỗi phát video. Đang thử khôi phục...');
              hls.recoverMediaError();
              // Clear error message after recovery attempt
              setTimeout(() => setErrorMessage(null), 5000);
              break;
            default:
              debugError('[HLS] Fatal error:', data.type, data.details);
              debugError('[HLS] Destroying instance...');
              setErrorMessage('Đã xảy ra lỗi khi phát video. Vui lòng thử lại.');
              hls.destroy();
              break;
          }
        } else {
          debugWarn('[HLS] Non-fatal error:', data.details);
        }
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        debugLog('[HLS] Manifest parsed, video ready to play');
        debugLog('[HLS] Levels:', hls.levels);
        setIsLoading(false);
        setAvailableLevels(hls.levels);
        setCurrentLevel(hls.currentLevel);

        // Progressive loading: Preload next segments based on playback position
        // Note: Event listeners are now handled in main video event handlers to avoid duplicates
        const setupProgressiveLoading = () => {
          // Start buffering immediately
          checkAndPreload();
        };

        // Clear existing timeout before creating new one
        if (setupProgressiveLoadingTimeoutRef.current) {
          clearTimeout(setupProgressiveLoadingTimeoutRef.current);
        }
        // Setup progressive loading after a short delay to ensure video is ready
        setupProgressiveLoadingTimeoutRef.current = setTimeout(() => {
          setupProgressiveLoadingTimeoutRef.current = null;
          setupProgressiveLoading();
        }, 1000);
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
          // Save play state BEFORE pausing to ensure correct state is captured
          // Only update if play state wasn't explicitly set by manual seek (handleSeek or handleDoubleTap)
          // This preserves the value set by manual seek handlers and only updates for programmatic seeks
          if (!playStateExplicitlySetRef.current) {
            wasPlayingBeforeSeekRef.current = !video.paused;
          }
          // Cancel any pending play promise
          if (pendingPlayPromiseRef.current) {
            pendingPlayPromiseRef.current = null;
          }
          // Pause video during seeking (will resume in handleSeeked if was playing)
          // BUT: Don't pause when scrubbing - allow smooth scrubbing to work
          if (!video.paused && !isScrubbingRef.current) {
            video.pause();
          }
          isSeekingRef.current = true;
          seekTargetRef.current = video.currentTime;
          // Pause buffering interval during seeking to avoid unnecessary checkAndPreload calls
          // The interval callback already checks isSeekingRef, but pausing is more efficient
          // The interval will resume automatically when buffering continues after seek (if still buffering)
          debugLog(
            '[HLS] Seeking started, target:',
            seekTargetRef.current,
            'wasPlaying:',
            wasPlayingBeforeSeekRef.current,
            'video.paused:',
            video.paused,
            'isScrubbing:',
            isScrubbingRef.current
          );
        }
      };

      const handleSeeked = () => {
        const video = videoRef.current;
        if (video && hls) {
          const newPosition = video.currentTime;
          // Capture wasPlaying value before any other operations
          const wasPlaying = wasPlayingBeforeSeekRef.current;
          // Reset flag for next seek operation
          playStateExplicitlySetRef.current = false;
          // Track seek completion time to prevent duplicate preload (set before isSeekingRef to prevent race condition)
          lastSeekTimeRef.current = Date.now();
          isSeekingRef.current = false;
          debugLog(
            '[HLS] Seeking completed, new position:',
            newPosition,
            'wasPlaying:',
            wasPlaying,
            'video.paused:',
            video.paused
          );
          // Trigger immediate prefetch around seek position
          throttledStartLoad();
          // Resume playback if video was playing before seek
          if (wasPlaying) {
            // Resume playback - use requestAnimationFrame for better timing
            const resumePlayback = () => {
              const video = videoRef.current;
              if (!video) return;

              // Check if video has enough data to play
              if (isVideoReady(video)) {
                // Video has enough data, try to play
                if (video.paused) {
                  playVideoWithPromise(
                    video,
                    () => debugLog('[HLS] Playback resumed after seek'),
                    (error) => debugWarn('[HLS] Failed to resume playback after seek:', error)
                  );
                }
              } else {
                // Video not ready yet, wait for canplay event
                const onCanPlay = () => {
                  // { once: true } automatically removes listener, no need to manually remove
                  if (video.paused) {
                    playVideoWithPromise(
                      video,
                      () => debugLog('[HLS] Playback resumed after seek (via canplay)'),
                      (error) => debugWarn('[HLS] Failed to resume playback after seek:', error)
                    );
                  }
                };
                video.addEventListener('canplay', onCanPlay, { once: true });
                // Clear existing timeout before creating new one
                if (resumePlaybackTimeoutRef.current) {
                  clearTimeout(resumePlaybackTimeoutRef.current);
                }
                // Fallback timeout in case canplay doesn't fire
                // Note: If canplay fires, listener is auto-removed by { once: true }
                resumePlaybackTimeoutRef.current = setTimeout(() => {
                  resumePlaybackTimeoutRef.current = null;
                  if (video.paused && wasPlaying) {
                    resumePlayback();
                  }
                }, 1000);
              }
            };

            // Use requestAnimationFrame for better timing
            requestAnimationFrame(() => {
              resumePlayback();
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
        // Set ref to null to prevent duplicate destroy in outer cleanup
        if (hlsRef.current === hls) {
          hlsRef.current = null;
        }
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      video.src = hlsUrl;
      // Don't auto-play, let user click play button
      debugLog('HLS video source set, ready to play');
      setIsLoading(false);
    }

    return () => {
      // Cleanup all pending timeouts to prevent memory leaks
      if (pendingTimeoutRef.current) {
        clearTimeout(pendingTimeoutRef.current);
        pendingTimeoutRef.current = null;
      }
      if (setupProgressiveLoadingTimeoutRef.current) {
        clearTimeout(setupProgressiveLoadingTimeoutRef.current);
        setupProgressiveLoadingTimeoutRef.current = null;
      }
      if (resumePlaybackTimeoutRef.current) {
        clearTimeout(resumePlaybackTimeoutRef.current);
        resumePlaybackTimeoutRef.current = null;
      }
      // Only destroy if ref still points to an HLS instance (not already destroyed by inner cleanup)
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [hlsUrl, networkBandwidth, throttledStartLoad, checkAndPreload, isVideoReady]);

  // Player state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isVolumeDragging, setIsVolumeDragging] = useState(false);
  const [buffered, setBuffered] = useState(0);
  const [seekPreviewTime, setSeekPreviewTime] = useState<number | null>(null);
  const [isBuffering, setIsBuffering] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastScrubTimeRef = useRef<number>(0);
  const isScrubbingRef = useRef<boolean>(false);
  // Track pending requestAnimationFrame for seek drag to prevent duplicate seeking events
  const seekDragRafRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const volumeBarRef = useRef<HTMLDivElement>(null);

  // Hide controls after inactivity
  const resetControlsTimeout = useCallback(() => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    setShowControls(true);
    if (isPlaying) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
      }, 3000);
    }
  }, [isPlaying]);

  // Video event handlers
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => {
      setIsPlaying(true);
      resetControlsTimeout();
      // Trigger buffer check on play
      checkAndPreload();
    };

    const handlePause = () => {
      setIsPlaying(false);
      // Use resetControlsTimeout for consistent controls visibility logic
      // This will set showControls to true and won't set timeout since isPlaying is now false
      resetControlsTimeout();
      // Trigger buffer check on pause to maintain buffer
      checkAndPreload();
    };

    const handleTimeUpdate = () => {
      // Store pending update data instead of calling setState immediately
      const currentTime = video.currentTime;
      const duration = video.duration || 0;
      const bufferedEnd = getBufferedEnd(video);
      const buffered = duration > 0 ? (bufferedEnd / duration) * 100 : 0;

      pendingTimeUpdateRef.current = { currentTime, duration, buffered };

      // Cancel previous animation frame if pending
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }

      // Batch state updates using requestAnimationFrame (max 60 updates/second)
      rafIdRef.current = requestAnimationFrame(() => {
        if (pendingTimeUpdateRef.current) {
          const { currentTime, duration, buffered } = pendingTimeUpdateRef.current;
          setCurrentTime(currentTime);
          setDuration(duration);
          setBuffered(buffered);
          pendingTimeUpdateRef.current = null;
        }
        rafIdRef.current = null;
      });

      // Trigger throttled buffer check
      throttledCheckAndPreload();
    };

    const handleLoadedMetadata = () => {
      setDuration(video.duration || 0);
      setVolume(video.volume);
      setIsMuted(video.muted);
    };

    const handleVolumeChange = () => {
      setVolume(video.volume);
      setIsMuted(video.muted);
    };

    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    const handleWaiting = () => {
      // Video is waiting for data (buffering)
      setIsBuffering(true);
      debugLog('[Video] Buffering...');
      // Trigger immediate aggressive preload to recover from buffer depletion
      // checkAndPreload() already calls throttledStartLoad() internally, no need to call it again
      checkAndPreload();
    };

    const handlePlaying = () => {
      // Video has enough data and is playing
      setIsBuffering(false);
      debugLog('[Video] Playing');
    };

    const handleStalled = () => {
      // Video element has stalled (stopped downloading)
      setIsBuffering(true);
      debugLog('[Video] Stalled - triggering immediate preload');
      // Trigger immediate aggressive preload to recover from stall
      // checkAndPreload() already calls throttledStartLoad() internally, no need to call it again
      checkAndPreload();
    };

    const handleProgress = () => {
      // Progress event fires during buffering - use for proactive buffer management
      // Check buffer health and trigger preload if needed (throttled to avoid excessive calls)
      throttledCheckAndPreload();
    };

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('volumechange', handleVolumeChange);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('stalled', handleStalled);
    video.addEventListener('progress', handleProgress);
    document.addEventListener('fullscreenchange', handleFullscreenChange);

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('volumechange', handleVolumeChange);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('stalled', handleStalled);
      video.removeEventListener('progress', handleProgress);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      // Cleanup: cancel pending animation frame
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [resetControlsTimeout, checkAndPreload, throttledCheckAndPreload, throttledStartLoad, getBufferedEnd]);

  // Automatic preload during buffering - continuously preload segments while buffering is active
  useEffect(() => {
    if (isBuffering) {
      // Start aggressive preload interval when buffering begins
      // Use 500ms interval (faster than normal CHECK_INTERVAL) to build buffer quickly
      const BUFFERING_PRELOAD_INTERVAL = 500;
      // Delay interval start to avoid duplicate with immediate call in handleWaiting/handleStalled
      // Immediate call provides fast response, then interval takes over after delay
      const INTERVAL_START_DELAY = 300;

      // Clear any existing interval and timeout first
      if (bufferingPreloadIntervalRef.current) {
        clearInterval(bufferingPreloadIntervalRef.current);
        bufferingPreloadIntervalRef.current = null;
      }
      if (bufferingPreloadStartTimeoutRef.current) {
        clearTimeout(bufferingPreloadStartTimeoutRef.current);
        bufferingPreloadStartTimeoutRef.current = null;
      }

      // Delay interval start to allow immediate call in handleWaiting/handleStalled to complete first
      // This avoids duplicate calls too close together while maintaining fast response
      // Note: If isBuffering changes during delay, useEffect cleanup will clear this timeout
      bufferingPreloadStartTimeoutRef.current = setTimeout(() => {
        bufferingPreloadStartTimeoutRef.current = null;

        // Start interval to continuously preload while buffering
        // Note: checkAndPreload() will skip execution during seeking (via isSeekingRef check),
        // but we pause the interval during seeking to avoid unnecessary function calls
        bufferingPreloadIntervalRef.current = setInterval(() => {
          // Skip interval callback if currently seeking (handleSeeked will handle preload after seek)
          if (isSeekingRef.current) {
            return;
          }
          checkAndPreload();
        }, BUFFERING_PRELOAD_INTERVAL);

        debugLog('[Video] Started automatic preload interval during buffering');
      }, INTERVAL_START_DELAY);

      debugLog('[Video] Scheduled automatic preload interval (delayed start)');
    } else {
      // Clear interval and timeout when buffering stops
      if (bufferingPreloadIntervalRef.current) {
        clearInterval(bufferingPreloadIntervalRef.current);
        bufferingPreloadIntervalRef.current = null;
      }
      if (bufferingPreloadStartTimeoutRef.current) {
        clearTimeout(bufferingPreloadStartTimeoutRef.current);
        bufferingPreloadStartTimeoutRef.current = null;
      }
      debugLog('[Video] Stopped automatic preload (buffering ended)');
    }

    // Cleanup: clear interval and timeout on unmount or when isBuffering changes
    return () => {
      if (bufferingPreloadIntervalRef.current) {
        clearInterval(bufferingPreloadIntervalRef.current);
        bufferingPreloadIntervalRef.current = null;
      }
      if (bufferingPreloadStartTimeoutRef.current) {
        clearTimeout(bufferingPreloadStartTimeoutRef.current);
        bufferingPreloadStartTimeoutRef.current = null;
      }
    };
  }, [isBuffering, checkAndPreload]);

  // Play/Pause toggle
  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      playVideoWithPromise(video);
    } else {
      // Cancel any pending play promise before pausing
      if (pendingPlayPromiseRef.current) {
        pendingPlayPromiseRef.current = null;
      }
      video.pause();
    }
    resetControlsTimeout();
  }, [resetControlsTimeout, playVideoWithPromise]);

  // Seek handler for click (immediate seek)
  const handleSeekClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
      const video = videoRef.current;
      const progressBar = progressBarRef.current;
      if (!video || !progressBar) return;

      const percent = calculatePercentFromEvent(progressBar, e);
      const newTime = percent * duration;

      // Save play state before seeking (important for manual seek via progress bar)
      savePlayStateBeforeSeek(video);

      // Set new time - this will trigger seeking/seeked events
      // Note: setCurrentTime is handled by handleTimeUpdate, no need to set it here
      video.currentTime = newTime;
      resetControlsTimeout();
    },
    [duration, resetControlsTimeout, calculatePercentFromEvent, savePlayStateBeforeSeek]
  );

  // Seek handler for drag (smooth scrubbing with throttling)
  const handleSeekDrag = useCallback(
    (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
      const video = videoRef.current;
      const progressBar = progressBarRef.current;
      if (!video || !progressBar) return;

      const percent = calculatePercentFromEvent(progressBar, e);
      const newTime = percent * duration;

      // Throttle scrub updates using requestAnimationFrame (max 60 updates/second)
      const now = performance.now();
      const timeSinceLastScrub = now - lastScrubTimeRef.current;
      const minScrubInterval = 16; // ~60fps (16.67ms per frame)

      // Cancel any pending requestAnimationFrame to prevent duplicate seeking events
      // This ensures only the latest seek position is applied
      if (seekDragRafRef.current !== null) {
        cancelAnimationFrame(seekDragRafRef.current);
        seekDragRafRef.current = null;
      }

      if (timeSinceLastScrub >= minScrubInterval) {
        lastScrubTimeRef.current = now;
        // Update video time for smooth scrubbing
        video.currentTime = newTime;
      } else {
        // Schedule update for next frame
        seekDragRafRef.current = requestAnimationFrame(() => {
          seekDragRafRef.current = null; // Clear ref when callback fires
          const video = videoRef.current;
          if (video && isScrubbing) {
            video.currentTime = newTime;
            lastScrubTimeRef.current = performance.now();
          }
        });
      }

      // Update seek preview
      setSeekPreviewTime(newTime);
    },
    [duration, calculatePercentFromEvent, isScrubbing]
  );

  // Seek preview handler (shows time on hover/drag)
  const handleSeekPreview = useCallback(
    (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
      const progressBar = progressBarRef.current;
      if (!progressBar || duration === 0) {
        setSeekPreviewTime(null);
        return;
      }

      const percent = calculatePercentFromEvent(progressBar, e);
      const previewTime = percent * duration;
      setSeekPreviewTime(previewTime);
    },
    [duration, calculatePercentFromEvent]
  );

  // Volume handler
  const handleVolumeChange = useCallback(
    (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
      const video = videoRef.current;
      const volumeBar = volumeBarRef.current;
      if (!video || !volumeBar) return;

      const percent = calculatePercentFromEvent(volumeBar, e);

      video.volume = percent;
      setVolume(percent);
      setIsMuted(percent === 0);
      resetControlsTimeout();
    },
    [resetControlsTimeout, calculatePercentFromEvent]
  );

  // Toggle mute
  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
    resetControlsTimeout();
  }, [resetControlsTimeout]);

  // Toggle fullscreen
  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
    resetControlsTimeout();
  }, [resetControlsTimeout]);

  // Double tap to seek (mobile)
  const lastTapRef = useRef(0);
  const handleDoubleTap = useCallback(
    (e: React.TouchEvent) => {
      const video = videoRef.current;
      if (!video) return;

      const now = Date.now();
      const DOUBLE_TAP_DELAY = 300;

      if (now - lastTapRef.current < DOUBLE_TAP_DELAY) {
        const rect = video.getBoundingClientRect();
        const touch = e.changedTouches[0];
        const x = touch.clientX - rect.left;
        const width = rect.width;

        if (x < width / 2) {
          // Left side - seek backward 10s
          savePlayStateBeforeSeek(video);
          video.currentTime = Math.max(0, video.currentTime - 10);
        } else {
          // Right side - seek forward 10s
          savePlayStateBeforeSeek(video);
          video.currentTime = Math.min(duration, video.currentTime + 10);
        }
        lastTapRef.current = 0;
      } else {
        lastTapRef.current = now;
      }
    },
    [duration, savePlayStateBeforeSeek]
  );

  // Keyboard shortcuts handler
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore keyboard shortcuts when user is typing in an input field
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return;
      }

      const video = videoRef.current;
      if (!video) return;

      switch (e.key) {
        case ' ': // Space - Play/Pause
          e.preventDefault();
          togglePlayPause();
          break;
        case 'ArrowLeft': // Left Arrow - Seek backward 5 seconds
          e.preventDefault();
          savePlayStateBeforeSeek(video);
          video.currentTime = Math.max(0, video.currentTime - 5);
          break;
        case 'ArrowRight': // Right Arrow - Seek forward 5 seconds
          e.preventDefault();
          savePlayStateBeforeSeek(video);
          video.currentTime = Math.min(duration, video.currentTime + 5);
          break;
        case 'ArrowUp': // Up Arrow - Increase volume 5%
          e.preventDefault();
          video.volume = Math.min(1, video.volume + 0.05);
          setVolume(video.volume);
          setIsMuted(video.volume === 0);
          break;
        case 'ArrowDown': // Down Arrow - Decrease volume 5%
          e.preventDefault();
          video.volume = Math.max(0, video.volume - 0.05);
          setVolume(video.volume);
          setIsMuted(video.volume === 0);
          break;
        case 'm':
        case 'M': // M - Toggle mute
          e.preventDefault();
          toggleMute();
          break;
        case 'f':
        case 'F': // F - Toggle fullscreen
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'Escape': // Escape - Exit fullscreen
          if (document.fullscreenElement) {
            e.preventDefault();
            document.exitFullscreen();
          }
          break;
      }
    };

    container.addEventListener('keydown', handleKeyDown);
    // Also listen on window for when container doesn't have focus
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      container.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [togglePlayPause, toggleMute, toggleFullscreen, duration, savePlayStateBeforeSeek]);

  // Memoize formatted time strings to avoid recalculating on every render
  const formattedCurrentTime = useMemo(() => formatTime(currentTime), [currentTime]);
  const formattedDuration = useMemo(() => formatTime(duration), [duration]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full group video-player-container"
      tabIndex={0}
      onMouseMove={resetControlsTimeout}
      onMouseLeave={() => isPlaying && setShowControls(false)}
      onTouchStart={resetControlsTimeout}
    >
      {/* Video Element */}
      <video
        ref={videoRef}
        className={className}
        playsInline
        onDoubleClick={toggleFullscreen}
        onTouchEnd={handleDoubleTap}
      />

      {/* Loading indicator */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center z-30 video-loading-overlay">
          <div className="video-loading-card">
            <div className="video-loading-spinner" />
            <p className="video-loading-text">Đang tải video...</p>
          </div>
        </div>
      )}

      {/* Buffering indicator */}
      {isBuffering && !isLoading && (
        <div className="absolute inset-0 flex items-center justify-center z-30 video-buffering-overlay">
          <div className="video-buffering-card">
            <div className="video-buffering-spinner" />
            <p className="video-buffering-text">Đang tải dữ liệu...</p>
          </div>
        </div>
      )}

      {/* Error message overlay */}
      {errorMessage && (
        <div className="absolute inset-0 flex items-center justify-center z-30 video-error-overlay">
          <div className="video-error-card">
            <svg className="video-error-icon" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
            </svg>
            <p className="video-error-text">{errorMessage}</p>
            <button onClick={() => setErrorMessage(null)} className="video-error-close" aria-label="Đóng thông báo lỗi">
              <svg className="video-error-close-icon" fill="currentColor" viewBox="0 0 24 24">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Custom Controls Overlay */}
      <div
        className={`absolute inset-0 z-20 video-controls-overlay transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Center Play/Pause Button */}
        <div
          className="absolute inset-0 flex items-center justify-center video-center-control"
          onClick={togglePlayPause}
        >
          <button
            className={`
              video-play-button
              transition-all duration-300 ease-out
              ${showControls && !isPlaying ? 'scale-100 opacity-100' : 'scale-75 opacity-0 pointer-events-none'}
            `}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            <svg className="video-play-icon" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        </div>

        {/* Bottom Controls Bar */}
        <div className="absolute bottom-0 left-0 right-0 video-controls-bar">
          {/* Progress Bar */}
          <div
            ref={progressBarRef}
            className={`video-progress-container ${isScrubbing ? 'scrubbing' : ''}`}
            onClick={handleSeekClick}
            onTouchStart={(e) => {
              setIsDragging(true);
              setIsScrubbing(true);
              isScrubbingRef.current = true;
              lastScrubTimeRef.current = performance.now();
              handleSeekClick(e);
            }}
            onTouchMove={(e) => {
              if (isDragging) {
                handleSeekDrag(e);
              } else {
                handleSeekPreview(e);
              }
            }}
            onTouchEnd={(e) => {
              if (isDragging) {
                // Final seek to exact position
                handleSeekClick(e);
              }
              setIsDragging(false);
              setIsScrubbing(false);
              isScrubbingRef.current = false;
              // Cancel any pending seek drag animation frame
              if (seekDragRafRef.current !== null) {
                cancelAnimationFrame(seekDragRafRef.current);
                seekDragRafRef.current = null;
              }
              setSeekPreviewTime(null);
            }}
            onMouseDown={(e) => {
              setIsDragging(true);
              setIsScrubbing(true);
              isScrubbingRef.current = true;
              lastScrubTimeRef.current = performance.now();
              handleSeekClick(e);
            }}
            onMouseMove={(e) => {
              if (isDragging) {
                handleSeekDrag(e);
              } else {
                handleSeekPreview(e);
              }
            }}
            onMouseUp={(e) => {
              if (isDragging) {
                // Final seek to exact position
                handleSeekClick(e);
              }
              setIsDragging(false);
              setIsScrubbing(false);
              isScrubbingRef.current = false;
              // Cancel any pending seek drag animation frame
              if (seekDragRafRef.current !== null) {
                cancelAnimationFrame(seekDragRafRef.current);
                seekDragRafRef.current = null;
              }
              setSeekPreviewTime(null);
            }}
            onMouseLeave={(e) => {
              if (isDragging) {
                // Final seek to exact position when leaving
                handleSeekClick(e);
              }
              setIsDragging(false);
              setIsScrubbing(false);
              isScrubbingRef.current = false;
              // Cancel any pending seek drag animation frame
              if (seekDragRafRef.current !== null) {
                cancelAnimationFrame(seekDragRafRef.current);
                seekDragRafRef.current = null;
              }
              setSeekPreviewTime(null);
            }}
          >
            {/* Buffered progress */}
            <div className="video-progress-buffered" style={{ width: `${buffered}%` }} />
            {/* Current progress */}
            <div className="video-progress-current" style={{ width: `${(currentTime / duration) * 100}%` }} />
            {/* Progress handle */}
            <div className="video-progress-handle" style={{ left: `${(currentTime / duration) * 100}%` }} />
            {/* Seek preview tooltip */}
            {seekPreviewTime !== null && (
              <div className="video-seek-preview-tooltip" style={{ left: `${(seekPreviewTime / duration) * 100}%` }}>
                {formatTime(seekPreviewTime)}
              </div>
            )}
          </div>

          {/* Control Buttons */}
          <div className="video-controls-row">
            {/* Play/Pause */}
            <button
              onClick={togglePlayPause}
              className="video-control-button"
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <svg className="video-control-icon" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
              ) : (
                <svg className="video-control-icon" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            {/* Volume Control */}
            <div className="video-volume-container">
              <button onClick={toggleMute} className="video-control-button" aria-label={isMuted ? 'Unmute' : 'Mute'}>
                {isMuted || volume === 0 ? (
                  <svg className="video-control-icon" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  </svg>
                ) : volume < 0.5 ? (
                  <svg className="video-control-icon" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M18.83 16h-2.75l-1-1H12v-6h3.08l1-1H18.83v8zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  </svg>
                ) : (
                  <svg className="video-control-icon" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  </svg>
                )}
              </button>

              {/* Volume Slider */}
              <div
                ref={volumeBarRef}
                className="video-volume-slider"
                onClick={handleVolumeChange}
                onMouseDown={(e) => {
                  setIsVolumeDragging(true);
                  handleVolumeChange(e);
                }}
                onMouseMove={(e) => {
                  if (isVolumeDragging) handleVolumeChange(e);
                }}
                onMouseUp={() => setIsVolumeDragging(false)}
                onMouseLeave={() => setIsVolumeDragging(false)}
              >
                <div className="video-volume-track">
                  <div className="video-volume-fill" style={{ width: `${(isMuted ? 0 : volume) * 100}%` }} />
                  <div className="video-volume-handle" style={{ left: `${(isMuted ? 0 : volume) * 100}%` }} />
                </div>
              </div>
            </div>

            {/* Time Display */}
            <div className="video-time-display">
              {formattedCurrentTime} / {formattedDuration}
            </div>

            {/* Quality Selector */}
            {availableLevels.length > 0 && (
              <div className="video-quality-container">
                <button
                  onClick={() => setShowQualitySelector(!showQualitySelector)}
                  className="video-control-button"
                  aria-label="Quality settings"
                >
                  <svg className="video-control-icon" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
                  </svg>
                </button>
                {showQualitySelector && (
                  <div className="video-quality-menu">
                    <button
                      onClick={() => {
                        if (hlsRef.current) {
                          hlsRef.current.currentLevel = -1;
                          setCurrentLevel(-1);
                          setShowQualitySelector(false);
                        }
                      }}
                      className={`video-quality-option ${currentLevel === -1 ? 'video-quality-option-active' : ''}`}
                    >
                      <span className="video-quality-option-content">
                        <span>Auto</span>
                        {currentLevel === -1 && <span className="video-quality-check">✓</span>}
                      </span>
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
                        className={`video-quality-option ${
                          currentLevel === index ? 'video-quality-option-active' : ''
                        }`}
                      >
                        <span className="video-quality-option-content">
                          <span>{level.height}p</span>
                          {currentLevel === index && <span className="video-quality-check">✓</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Fullscreen */}
            <button
              onClick={toggleFullscreen}
              className="video-control-button"
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            >
              {isFullscreen ? (
                <svg className="video-control-icon" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                </svg>
              ) : (
                <svg className="video-control-icon" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
