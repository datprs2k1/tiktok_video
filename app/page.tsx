import VideoPlayer from './components/VideoPlayer';

export default function Home() {
  return (
    <div className="h-screen w-screen bg-black overflow-hidden">
      <div className="relative w-full h-full md:p-0 p-2">
        <VideoPlayer />
      </div>
    </div>
  );
}
