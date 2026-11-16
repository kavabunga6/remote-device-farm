import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { imagesApi, type BuildJob } from './images-api';

/** Cheap, serial job snapshots; catalog preparation is never part of this poll. */
export function useBuildMonitor(hostId: string | undefined, active: boolean, revision: MutableRefObject<number>, onJobs: (jobs: BuildJob[], hostId: string) => void) {
  const receive = useRef(onJobs); receive.current = onJobs;
  const [now, setNow] = useState(Date.now), [contact, setContact] = useState(Date.now), [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false); setContact(Date.now());
    if (!hostId || !active) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const sentAtRevision = revision.current; let stale = false;
      try {
        const next = await imagesApi.buildJobs(hostId, controller.signal);
        if (controller.signal.aborted) return;
        stale = sentAtRevision !== revision.current;
        if (!stale) {
          if (next.builder.id !== hostId || !Array.isArray(next.jobs)) throw Error('invalid_build_snapshot');
          setFailed(false); setContact(Date.now()); receive.current(next.jobs, hostId);
        }
      } catch {
        if (controller.signal.aborted) return;
        if (sentAtRevision === revision.current) setFailed(true);
      }
      if (!controller.signal.aborted) {
        if (stale) void poll();
        else timer = setTimeout(() => void poll(), 4000);
      }
    };
    timer = setTimeout(() => void poll(), 4000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { controller.abort(); clearTimeout(timer); clearInterval(clock); };
  }, [hostId, active, revision]);
  return { now, contact, unconfirmed: active && (failed || now - contact > 20_000),
    confirmed: () => { const at = Date.now(); setContact(at); setNow(at); setFailed(false); } };
}
