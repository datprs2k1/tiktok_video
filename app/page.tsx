import HLSVideoPlayer from './components/HLSVideoPlayer';

export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-black">
      <main className="w-full max-w-7xl p-4">
        <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
          <HLSVideoPlayer />
        </div>
      </main>
    </div>
  );
}
