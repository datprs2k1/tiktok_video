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
        const hls = hlsRef.current;
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
  }, []);
  // Track seek completion time to prevent duplicate preload after seek
  const lastSeekTimeRef = useRef<number>(0);
  // Track play state before seeking to resume after seek completes
  const wasPlayingBeforeSeekRef = useRef<boolean>(false);
  // Track if play state was set from manual seek (progress bar)
  const playStateSetFromManualSeekRef = useRef<boolean>(false);
  // Track pending play promise to avoid interruptions
  const pendingPlayPromiseRef = useRef<Promise<void> | null>(null);

  // Position preservation refs for error recovery
  const savedPositionRef = useRef<number>(0);
  const isRecoveringRef = useRef<boolean>(false);

  // Refs for batching timeupdate state updates with requestAnimationFrame
  const rafIdRef = useRef<number | null>(null);
  const pendingTimeUpdateRef = useRef<{ currentTime: number; duration: number; buffered: number } | null>(null);

  // Helper function to save position before error recovery (eliminates duplication)
  const savePositionForRecovery = useCallback((video: HTMLVideoElement | null) => {
    if (video && !isNaN(video.currentTime) && video.currentTime > 0) {
      savedPositionRef.current = video.currentTime;
      isRecoveringRef.current = true;
      debugLog('[HLS] Saved position before recovery:', savedPositionRef.current);
    }
  }, []);

  // Throttled buffer checking - moved to component level for accessibility
  const lastCheckTimeRef = useRef<number>(0);
  const CHECK_INTERVAL = 2000; // Check every 2 seconds (throttled)

  // checkAndPreload function - moved to component level to be accessible from main handlers
  const checkAndPreload = useCallback(() => {
    const video = videoRef.current;
    const hls = hlsRef.current;
    if (!video || !hls) return;

    const currentTime = video.currentTime;

    const buffered = video.buffered;
    let bufferedEnd = 0;

    if (buffered.length > 0) {
      bufferedEnd = buffered.end(buffered.length - 1);
    }

    const bufferAhead = bufferedEnd - currentTime;
    const bufferHealth = bufferAhead; // Current buffer health in seconds

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

    // Normal prefetch logic (only runs when not seeking)
    // Segment duration: 10 seconds per segment (fixed)
    const SEGMENT_DURATION = 10;
    const bufferedSegments = Math.floor(bufferAhead / SEGMENT_DURATION);
    const minSegments = 5; // Minimum 5 segments required (YouTube-like: 4-6 segments)

    // Calculate adaptive prefetch distance based on bandwidth and buffer health
    const prefetchDistance = calculateAdaptivePrefetchDistance(networkBandwidth, bufferHealth);

    // Preload if buffer is less than 5 segments OR less than adaptive distance ahead
    // This ensures minimum 5 segments while keeping adaptive optimization
    // YouTube-like: preload even when paused
    if (bufferedSegments < minSegments || bufferAhead < prefetchDistance) {
      // Trigger HLS to load more segments
      throttledStartLoad();
    }
  }, [networkBandwidth, throttledStartLoad]);

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
              savePositionForRecovery(video);
              throttledStartLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              debugError('[HLS] Fatal media error:', data.details);
              debugError('[HLS] Trying to recover...');
              // Preserve current position before recovery
              savePositionForRecovery(video);
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
        // Note: Event listeners are now handled in main video event handlers to avoid duplicates
        const setupProgressiveLoading = () => {
          // Start buffering immediately
          checkAndPreload();
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
          // Save play state BEFORE pausing to ensure correct state is captured
          // Only update if not already set from manual seek (to preserve state from progress bar)
          if (!playStateSetFromManualSeekRef.current) {
            wasPlayingBeforeSeekRef.current = !video.paused;
          }
          // Cancel any pending play promise
          if (pendingPlayPromiseRef.current) {
            pendingPlayPromiseRef.current = null;
          }
          // Pause video during seeking (will resume in handleSeeked if was playing)
          if (!video.paused) {
            video.pause();
          }
          isSeekingRef.current = true;
          seekTargetRef.current = video.currentTime;
          debugLog(
            '[HLS] Seeking started, target:',
            seekTargetRef.current,
            'wasPlaying:',
            wasPlayingBeforeSeekRef.current
          );
        }
      };

      const handleSeeked = () => {
        const video = videoRef.current;
        if (video && hls) {
          isSeekingRef.current = false;
          const newPosition = video.currentTime;
          const wasPlaying = wasPlayingBeforeSeekRef.current;
          debugLog('[HLS] Seeking completed, new position:', newPosition, 'wasPlaying:', wasPlaying);
          // Track seek completion time to prevent duplicate preload
          lastSeekTimeRef.current = Date.now();
          // Trigger immediate prefetch around seek position
          throttledStartLoad();
          // Resume playback if video was playing before seek
          if (wasPlaying) {
            // Clear any pending play promise
            pendingPlayPromiseRef.current = null;
            // Resume playback - use requestAnimationFrame for better timing
            const resumePlayback = () => {
              const video = videoRef.current;
              if (!video) return;
              
              // Check if video has enough data to play
              if (video.readyState >= 2) {
                // Video has enough data, try to play
                if (video.paused) {
                  const playPromise = video.play();
                  if (playPromise !== undefined) {
                    pendingPlayPromiseRef.current = playPromise;
                    playPromise
                      .then(() => {
                        pendingPlayPromiseRef.current = null;
                        debugLog('[HLS] Playback resumed after seek');
                      })
                      .catch((error) => {
                        pendingPlayPromiseRef.current = null;
                        // Ignore "interrupted" errors as they're expected during seeking
                        if (error.name !== 'AbortError' && error.name !== 'NotAllowedError') {
                          debugWarn('[HLS] Failed to resume playback after seek:', error);
                        }
                      });
                  }
                }
              } else {
                // Video not ready yet, wait for canplay event
                const onCanPlay = () => {
                  video.removeEventListener('canplay', onCanPlay);
                  if (video.paused) {
                    const playPromise = video.play();
                    if (playPromise !== undefined) {
                      pendingPlayPromiseRef.current = playPromise;
                      playPromise
                        .then(() => {
                          pendingPlayPromiseRef.current = null;
                          debugLog('[HLS] Playback resumed after seek (via canplay)');
                        })
                        .catch((error) => {
                          pendingPlayPromiseRef.current = null;
                          if (error.name !== 'AbortError' && error.name !== 'NotAllowedError') {
                            debugWarn('[HLS] Failed to resume playback after seek:', error);
                          }
                        });
                    }
                  }
                };
                video.addEventListener('canplay', onCanPlay, { once: true });
                // Fallback timeout in case canplay doesn't fire
                setTimeout(() => {
                  video.removeEventListener('canplay', onCanPlay);
                  if (video.paused && wasPlayingBeforeSeekRef.current) {
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
          // Reset manual seek flag
          playStateSetFromManualSeekRef.current = false;
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
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
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
      setShowControls(true);
      // Trigger buffer check on pause to maintain buffer
      checkAndPreload();
    };

    const handleTimeUpdate = () => {
      // Store pending update data instead of calling setState immediately
      const currentTime = video.currentTime;
      const duration = video.duration || 0;
      let buffered = 0;
      if (video.buffered.length > 0) {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1);
        buffered = (bufferedEnd / duration) * 100;
      }

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

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('volumechange', handleVolumeChange);
    document.addEventListener('fullscreenchange', handleFullscreenChange);

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('volumechange', handleVolumeChange);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      // Cleanup: cancel pending animation frame
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [resetControlsTimeout, checkAndPreload, throttledCheckAndPreload]);

  // Play/Pause toggle
  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      // Clear any pending play promise
      pendingPlayPromiseRef.current = null;
      const playPromise = video.play();
      if (playPromise !== undefined) {
        pendingPlayPromiseRef.current = playPromise;
        playPromise
          .then(() => {
            pendingPlayPromiseRef.current = null;
          })
          .catch((error) => {
            pendingPlayPromiseRef.current = null;
            // Ignore "interrupted" errors - they're expected if user clicks pause quickly
            if (error.name !== 'AbortError' && error.name !== 'NotAllowedError') {
              debugWarn('[Video] Play failed:', error);
            }
          });
      }
    } else {
      // Cancel any pending play promise before pausing
      if (pendingPlayPromiseRef.current) {
        pendingPlayPromiseRef.current = null;
      }
      video.pause();
    }
    resetControlsTimeout();
  }, [resetControlsTimeout]);

  // Seek handler
  const handleSeek = useCallback(
    (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
      const video = videoRef.current;
      const progressBar = progressBarRef.current;
      if (!video || !progressBar) return;

      // Use offsetX/offsetY when available (relative to element, no layout recalculation)
      // Fallback to getBoundingClientRect for touch events
      let percent: number;
      if ('touches' in e) {
        // Touch event: use getBoundingClientRect
        const rect = progressBar.getBoundingClientRect();
        const clientX = e.touches[0].clientX;
        percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      } else {
        // Mouse event: use offsetX (relative to element, more efficient)
        const offsetX = e.nativeEvent.offsetX ?? e.clientX - progressBar.getBoundingClientRect().left;
        percent = Math.max(0, Math.min(1, offsetX / progressBar.offsetWidth));
      }
      const newTime = percent * duration;

      // Save play state before seeking (important for manual seek via progress bar)
      wasPlayingBeforeSeekRef.current = !video.paused;
      playStateSetFromManualSeekRef.current = true; // Mark that we set this from manual seek

      // Set new time - this will trigger seeking/seeked events
      video.currentTime = newTime;
      setCurrentTime(newTime);
      resetControlsTimeout();
    },
    [duration, resetControlsTimeout]
  );

  // Volume handler
  const handleVolumeChange = useCallback(
    (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
      const video = videoRef.current;
      const volumeBar = volumeBarRef.current;
      if (!video || !volumeBar) return;

      // Use offsetX/offsetY when available (relative to element, no layout recalculation)
      // Fallback to getBoundingClientRect for touch events
      let percent: number;
      if ('touches' in e) {
        // Touch event: use getBoundingClientRect
        const rect = volumeBar.getBoundingClientRect();
        const clientX = e.touches[0].clientX;
        percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      } else {
        // Mouse event: use offsetX (relative to element, more efficient)
        const offsetX = e.nativeEvent.offsetX ?? e.clientX - volumeBar.getBoundingClientRect().left;
        percent = Math.max(0, Math.min(1, offsetX / volumeBar.offsetWidth));
      }

      video.volume = percent;
      setVolume(percent);
      setIsMuted(percent === 0);
      resetControlsTimeout();
    },
    [resetControlsTimeout]
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
          video.currentTime = Math.max(0, video.currentTime - 10);
        } else {
          // Right side - seek forward 10s
          video.currentTime = Math.min(duration, video.currentTime + 10);
        }
        lastTapRef.current = 0;
      } else {
        lastTapRef.current = now;
      }
    },
    [duration]
  );

  // Memoize formatted time strings to avoid recalculating on every render
  const formattedCurrentTime = useMemo(() => formatTime(currentTime), [currentTime]);
  const formattedDuration = useMemo(() => formatTime(duration), [duration]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full group"
      onMouseMove={resetControlsTimeout}
      onMouseLeave={() => isPlaying && setShowControls(false)}
      onTouchStart={resetControlsTimeout}
    >
      {/* Liquid Glass Background Effect */}
      <div className="absolute inset-0 overflow-hidden rounded-2xl">
        <div className="absolute inset-0 liquid-glass-bg" />
        <div className="absolute inset-0 liquid-glass-overlay" />
      </div>

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
        <div className="absolute inset-0 flex items-center justify-center z-30">
          <div className="liquid-glass-card p-8 rounded-2xl">
            <div className="loading-spinner" />
            <p className="mt-4 text-white/90 text-sm font-medium">Đang tải video...</p>
          </div>
        </div>
      )}

      {/* Custom Controls Overlay */}
      <div
        className={`absolute inset-0 z-20 transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Center Play/Pause Button */}
        <div className="absolute inset-0 flex items-center justify-center" onClick={togglePlayPause}>
          <button
            className={`
              liquid-glass-button
              w-20 h-20 md:w-24 md:h-24
              rounded-full
              flex items-center justify-center
              transition-all duration-300
              ${showControls ? 'scale-100 opacity-100' : 'scale-75 opacity-0'}
              ${isPlaying ? 'hidden' : 'block'}
            `}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            <svg className="w-10 h-10 md:w-12 md:h-12 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        </div>

        {/* Bottom Controls Bar */}
        <div className="absolute bottom-0 left-0 right-0 liquid-glass-controls p-3 md:p-4">
          {/* Progress Bar */}
          <div
            ref={progressBarRef}
            className="relative h-1.5 md:h-2 mb-3 md:mb-4 cursor-pointer group/progress"
            onClick={handleSeek}
            onTouchStart={(e) => {
              setIsDragging(true);
              handleSeek(e);
            }}
            onTouchMove={(e) => {
              if (isDragging) handleSeek(e);
            }}
            onTouchEnd={() => setIsDragging(false)}
            onMouseDown={(e) => {
              setIsDragging(true);
              handleSeek(e);
            }}
            onMouseMove={(e) => {
              if (isDragging) handleSeek(e);
            }}
            onMouseUp={() => setIsDragging(false)}
            onMouseLeave={() => setIsDragging(false)}
          >
            {/* Buffered progress */}
            <div className="absolute inset-0 bg-white/20 rounded-full" style={{ width: `${buffered}%` }} />
            {/* Current progress */}
            <div
              className="absolute inset-0 bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-500 rounded-full transition-all duration-150"
              style={{ width: `${(currentTime / duration) * 100}%` }}
            />
            {/* Progress handle */}
            <div
              className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow-lg opacity-0 group-hover/progress:opacity-100 transition-opacity"
              style={{ left: `${(currentTime / duration) * 100}%`, transform: 'translate(-50%, -50%)' }}
            />
          </div>

          {/* Control Buttons */}
          <div className="flex items-center gap-2 md:gap-4">
            {/* Play/Pause */}
            <button
              onClick={togglePlayPause}
              className="liquid-glass-button-icon"
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <svg className="w-5 h-5 md:w-6 md:h-6" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
              ) : (
                <svg className="w-5 h-5 md:w-6 md:h-6" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            {/* Volume Control */}
            <div className="flex items-center gap-2">
              <button
                onClick={toggleMute}
                className="liquid-glass-button-icon"
                aria-label={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted || volume === 0 ? (
                  <svg className="w-5 h-5 md:w-6 md:h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  </svg>
                ) : volume < 0.5 ? (
                  <svg className="w-5 h-5 md:w-6 md:h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M18.83 16h-2.75l-1-1H12v-6h3.08l1-1H18.83v8zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5 md:w-6 md:h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  </svg>
                )}
              </button>

              {/* Volume Slider */}
              <div
                ref={volumeBarRef}
                className="hidden md:flex items-center w-24 h-1.5 cursor-pointer group/volume"
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
                <div className="relative w-full h-full bg-white/20 rounded-full">
                  <div
                    className="absolute inset-0 bg-gradient-to-r from-cyan-400 to-blue-500 rounded-full transition-all"
                    style={{ width: `${(isMuted ? 0 : volume) * 100}%` }}
                  />
                  <div
                    className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-md opacity-0 group-hover/volume:opacity-100 transition-opacity"
                    style={{ left: `${(isMuted ? 0 : volume) * 100}%`, transform: 'translate(-50%, -50%)' }}
                  />
                </div>
              </div>
            </div>

            {/* Time Display */}
            <div className="flex-1 text-white/90 text-xs md:text-sm font-medium tabular-nums">
              {formattedCurrentTime} / {formattedDuration}
            </div>

            {/* Quality Selector */}
            {availableLevels.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setShowQualitySelector(!showQualitySelector)}
                  className="liquid-glass-button-icon"
                  aria-label="Quality settings"
                >
                  <svg className="w-5 h-5 md:w-6 md:h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
                  </svg>
                </button>
                {showQualitySelector && (
                  <div className="absolute bottom-full right-0 mb-2 liquid-glass-card rounded-xl overflow-hidden min-w-[140px] shadow-2xl">
                    <button
                      onClick={() => {
                        if (hlsRef.current) {
                          hlsRef.current.currentLevel = -1;
                          setCurrentLevel(-1);
                          setShowQualitySelector(false);
                        }
                      }}
                      className={`w-full px-4 py-3 text-left text-sm text-white hover:bg-white/10 transition-colors ${
                        currentLevel === -1 ? 'bg-white/20' : ''
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span>Auto</span>
                        {currentLevel === -1 && <span className="text-cyan-400">✓</span>}
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
                        className={`w-full px-4 py-3 text-left text-sm text-white hover:bg-white/10 transition-colors ${
                          currentLevel === index ? 'bg-white/20' : ''
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <span>{level.height}p</span>
                          {currentLevel === index && <span className="text-cyan-400">✓</span>}
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
              className="liquid-glass-button-icon"
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            >
              {isFullscreen ? (
                <svg className="w-5 h-5 md:w-6 md:h-6" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                </svg>
              ) : (
                <svg className="w-5 h-5 md:w-6 md:h-6" fill="currentColor" viewBox="0 0 24 24">
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
