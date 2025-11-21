'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { extractTSFromData } from '../utils/segmentDecoder';

interface VideoPlayerProps {
  src?: string;
  className?: string;
}

export default function VideoPlayer({ src = 'http://127.0.0.1:8080/playlist.m3u8', className = '' }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const volumeSliderRef = useRef<HTMLDivElement>(null);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const seekPreviewRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);
  const [buffered, setBuffered] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [seekPreviewTime, setSeekPreviewTime] = useState<number | null>(null);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [qualityLevels, setQualityLevels] = useState<number[]>([]);
  const [currentQuality, setCurrentQuality] = useState<number | null>(null);

  // Format time helper
  const formatTime = (seconds: number): string => {
    if (!isFinite(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Initialize HLS
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const initHLS = () => {
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 90,
        });

        hlsRef.current = hls;

        hls.loadSource(src);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setIsLoading(false);
          setError(null);

          // Get quality levels
          const levels = hls.levels.map((level, index) => index);
          setQualityLevels(levels);
          setCurrentQuality(hls.currentLevel);
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                setError('Network error. Please check your connection.');
                hls.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                setError('Media error. Attempting to recover...');
                hls.recoverMediaError();
                break;
              default:
                setError('An error occurred. Please try again.');
                hls.destroy();
                break;
            }
          }
        });

        hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
          setCurrentQuality(data.level);
        });

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
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS support (Safari)
        video.src = src;
        setIsLoading(false);
      } else {
        setError('HLS is not supported in this browser.');
      }
    };

    initHLS();

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
    };
  }, [src]);

  // Video event handlers
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      if (video.buffered.length > 0) {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1);
        setBuffered(bufferedEnd);
      }
    };

    const handleLoadedMetadata = () => {
      setDuration(video.duration);
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleWaiting = () => setIsLoading(true);
    const handleCanPlay = () => setIsLoading(false);
    const handleVolumeChange = () => {
      setVolume(video.volume);
      setIsMuted(video.muted);
    };
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('volumechange', handleVolumeChange);
    document.addEventListener('fullscreenchange', handleFullscreenChange);

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('volumechange', handleVolumeChange);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Auto-hide controls
  const resetControlsTimeout = useCallback(() => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    setShowControls(true);
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
      }
    }, 3000);
  }, [isPlaying]);

  useEffect(() => {
    if (isPlaying) {
      resetControlsTimeout();
    }
    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, [isPlaying, resetControlsTimeout]);

  // Play/Pause
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play();
    } else {
      video.pause();
    }
    resetControlsTimeout();
  }, [resetControlsTimeout]);

  // Seek
  const handleSeek = useCallback(
    (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
      const video = videoRef.current;
      const progress = progressRef.current;
      if (!video || !progress) return;

      const rect = progress.getBoundingClientRect();
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const newTime = percent * duration;

      video.currentTime = newTime;
      setCurrentTime(newTime);
      resetControlsTimeout();
    },
    [duration, resetControlsTimeout]
  );

  // Progress bar interaction
  const handleProgressMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      setIsScrubbing(true);
      handleSeek(e);
      const video = videoRef.current;
      if (!video) return;

      const handleMouseMove = (e: MouseEvent) => {
        const progress = progressRef.current;
        if (!progress) return;
        const rect = progress.getBoundingClientRect();
        const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const newTime = percent * duration;
        setCurrentTime(newTime);

        // Show preview tooltip
        if (seekPreviewRef.current) {
          seekPreviewRef.current.style.left = `${percent * 100}%`;
          setSeekPreviewTime(newTime);
        }
      };

      const handleMouseUp = (e: MouseEvent) => {
        const progress = progressRef.current;
        if (!progress) return;
        const rect = progress.getBoundingClientRect();
        const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const newTime = percent * duration;
        video.currentTime = newTime;
        setCurrentTime(newTime);
        setIsScrubbing(false);
        setSeekPreviewTime(null);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [duration, handleSeek]
  );

  // Progress bar hover
  const handleProgressMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isScrubbing) return;
      const progress = progressRef.current;
      if (!progress) return;
      const rect = progress.getBoundingClientRect();
      const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const previewTime = percent * duration;

      if (seekPreviewRef.current) {
        seekPreviewRef.current.style.left = `${percent * 100}%`;
        setSeekPreviewTime(previewTime);
      }
    },
    [duration, isScrubbing]
  );

  const handleProgressMouseLeave = useCallback(() => {
    if (!isScrubbing) {
      setSeekPreviewTime(null);
    }
  }, [isScrubbing]);

  // Volume
  const handleVolumeChange = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const video = videoRef.current;
      const slider = volumeSliderRef.current;
      if (!video || !slider) return;

      const rect = slider.getBoundingClientRect();
      const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      video.volume = percent;
      setVolume(percent);
      setIsMuted(percent === 0);
      resetControlsTimeout();
    },
    [resetControlsTimeout]
  );

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
    resetControlsTimeout();
  }, [resetControlsTimeout]);

  // Fullscreen
  const toggleFullscreen = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;

    try {
      if (!document.fullscreenElement) {
        await container.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
      resetControlsTimeout();
    } catch (err) {
      console.error('Fullscreen error:', err);
    }
  }, [resetControlsTimeout]);

  // Quality selection
  const handleQualityChange = useCallback((level: number) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = level;
      setCurrentQuality(level);
      setShowQualityMenu(false);
    }
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const video = videoRef.current;
      if (!video) return;

      // Ignore if typing in input
      if (e.target instanceof HTMLInputElement) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 10);
          break;
        case 'ArrowRight':
          e.preventDefault();
          video.currentTime = Math.min(duration, video.currentTime + 10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          video.volume = Math.min(1, video.volume + 0.1);
          setVolume(video.volume);
          break;
        case 'ArrowDown':
          e.preventDefault();
          video.volume = Math.max(0, video.volume - 0.1);
          setVolume(video.volume);
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          toggleMute();
          break;
      }
      resetControlsTimeout();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, toggleFullscreen, toggleMute, duration, resetControlsTimeout]);

  // Mouse movement to show controls
  const handleMouseMove = useCallback(() => {
    resetControlsTimeout();
  }, [resetControlsTimeout]);

  const handleMouseLeave = useCallback(() => {
    if (isPlaying) {
      setShowControls(false);
    }
  }, [isPlaying]);

  // Retry on error
  const handleRetry = useCallback(() => {
    setError(null);
    setIsLoading(true);
    if (hlsRef.current) {
      hlsRef.current.startLoad();
    } else if (videoRef.current) {
      videoRef.current.load();
    }
  }, []);

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      className={`video-player-container relative w-full h-full bg-black ${className}`}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <video ref={videoRef} className="w-full h-full" playsInline onClick={togglePlay} />

      {/* Loading Overlay */}
      {isLoading && !error && (
        <div className="video-loading-overlay absolute inset-0 flex items-center justify-center z-20">
          <div className="video-loading-card">
            <div className="video-loading-spinner"></div>
            <div className="video-loading-text">Loading video...</div>
          </div>
        </div>
      )}

      {/* Error Overlay */}
      {error && (
        <div className="video-error-overlay absolute inset-0 flex items-center justify-center z-30">
          <div className="video-error-card">
            <svg className="video-error-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <div className="video-error-text">{error}</div>
            <button className="video-error-close" onClick={handleRetry} aria-label="Retry">
              <svg className="video-error-close-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Controls Overlay */}
      <div
        className={`video-controls-overlay absolute inset-0 pointer-events-none transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* Center Play Button */}
        {!isPlaying && (
          <div className="video-center-control absolute inset-0 flex items-center justify-center">
            <button className="video-play-button" onClick={togglePlay} aria-label="Play">
              <svg className="video-play-icon" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
          </div>
        )}

        {/* Controls Bar */}
        <div className="video-controls-bar absolute bottom-0 left-0 right-0 pointer-events-auto">
          {/* Progress Bar */}
          <div
            ref={progressRef}
            className={`video-progress-container ${isScrubbing ? 'scrubbing' : ''}`}
            onMouseDown={handleProgressMouseDown}
            onMouseMove={handleProgressMouseMove}
            onMouseLeave={handleProgressMouseLeave}
            onClick={handleSeek}
          >
            <div className="video-progress-buffered" style={{ width: `${bufferedPercent}%` }} />
            <div className="video-progress-current" style={{ width: `${progressPercent}%` }} />
            <div className="video-progress-handle" style={{ left: `${progressPercent}%` }} />
            {seekPreviewTime !== null && (
              <div ref={seekPreviewRef} className="video-seek-preview-tooltip" style={{ display: 'block' }}>
                {formatTime(seekPreviewTime)}
              </div>
            )}
          </div>

          {/* Controls Row */}
          <div className="video-controls-row">
            {/* Play/Pause */}
            <button className="video-control-button" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
              <svg className="video-control-icon" fill="currentColor" viewBox="0 0 24 24">
                {isPlaying ? <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" /> : <path d="M8 5v14l11-7z" />}
              </svg>
            </button>

            {/* Volume */}
            <div className="video-volume-container">
              <button className="video-control-button" onClick={toggleMute} aria-label={isMuted ? 'Unmute' : 'Mute'}>
                <svg className="video-control-icon" fill="currentColor" viewBox="0 0 24 24">
                  {isMuted || volume === 0 ? (
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  ) : volume < 0.5 ? (
                    <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
                  ) : (
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  )}
                </svg>
              </button>
              <div ref={volumeSliderRef} className="video-volume-slider" onClick={handleVolumeChange}>
                <div className="video-volume-track">
                  <div className="video-volume-fill" style={{ width: `${volume * 100}%` }} />
                  <div className="video-volume-handle" style={{ left: `${volume * 100}%` }} />
                </div>
              </div>
            </div>

            {/* Time Display */}
            <div className="video-time-display">
              {formatTime(currentTime)} / {formatTime(duration)}
            </div>

            {/* Quality Selector */}
            {qualityLevels.length > 0 && (
              <div className="video-quality-container">
                <button
                  className="video-control-button"
                  onClick={() => setShowQualityMenu(!showQualityMenu)}
                  aria-label="Quality"
                >
                  <svg className="video-control-icon" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 3L2 12h3v8h6v-6h2v6h6v-8h3L12 3zm0 2.84L19 12h-2v6h-2v-6H9v6H7v-6H5l7-7.16z" />
                  </svg>
                </button>
                {showQualityMenu && (
                  <div className="video-quality-menu">
                    {qualityLevels.map((level) => (
                      <button
                        key={level}
                        className={`video-quality-option ${
                          currentQuality === level ? 'video-quality-option-active' : ''
                        }`}
                        onClick={() => handleQualityChange(level)}
                      >
                        <div className="video-quality-option-content">
                          <span>
                            {hlsRef.current?.levels[level]
                              ? `${hlsRef.current.levels[level].height}p`
                              : `Level ${level}`}
                          </span>
                          {currentQuality === level && <span className="video-quality-check">✓</span>}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Fullscreen */}
            <button
              className="video-control-button"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            >
              <svg className="video-control-icon" fill="currentColor" viewBox="0 0 24 24">
                {isFullscreen ? (
                  <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                ) : (
                  <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                )}
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
