import { useEffect } from 'react';
import { Brain } from './components/Brain.tsx';
import { Header, SearchPill } from './components/Hud.tsx';
import { ProjectList, ProjectPanel, StatusBar } from './components/Projects.tsx';
import { RecallOverlay } from './components/Recall.tsx';
import { Browse } from './components/Browse.tsx';
import { Timeline } from './components/Timeline.tsx';
import { ReplayBar } from './components/Replay.tsx';
import { useUI } from './lib/neural.ts';
import { startLive } from './lib/live.ts';

export function App() {
  useEffect(() => startLive(), []);
  const replaying = useUI((s) => s.replayDay !== null);
  return (
    <main className="relative h-full w-full overflow-hidden">
      <Brain />
      <Header />
      <StatusBar />
      <ProjectList />
      <ProjectPanel />
      {replaying ? <ReplayBar /> : <SearchPill />}
      <RecallOverlay />
      <Browse />
      <Timeline />
    </main>
  );
}
