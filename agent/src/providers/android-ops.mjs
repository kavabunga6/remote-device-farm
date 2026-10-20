import { agentMessage } from '../messages.mjs';
// Android actions that only need an adb serial. Emulators and USB phones both speak adb, so both providers
// reuse this table instead of duplicating it behind `if (kind === ...)`.
export function androidOps({ adb, streams, appTransfers }) {
  return {
    adb: (s, p) => adb.command(s.serial, p.argv),
    logcat: (s, p) => adb.logcat(s.serial, p),
    'logcat-apps': (s) => adb.logcatApps(s.serial),
    'logcat-clear': (s) => adb.clearLogcat(s.serial),
    'device-info': (s) => adb.deviceInfo(s.serial),
    screenshot: (s) => adb.screenshot(s.serial),
    input: (s, p, { sessionId }) => streams.input(sessionId, s.serial, p),
    rotate: (s, p) => adb.rotate(s.serial, p.orientation),
    file: (s, p) => adb.file(s.serial, p),
    audio: async (s, p, { sessionId }) => {
      if (typeof p.enabled !== 'boolean') throw new Error(agentMessage('agent.1fa0375b158e'));
      const newlyStarted = p.enabled && !streams.streams.has(sessionId);
      if (newlyStarted) await streams.start(sessionId, s.serial);
      try { return await streams.setAudio(sessionId, p.enabled); }
      catch (error) {
        if (newlyStarted) await streams.stop(sessionId);
        throw error;
      }
    },
    'app-begin': (s, p, { sessionId }) => appTransfers.begin(sessionId, p),
    'app-chunk': (s, p, { sessionId }) => appTransfers.chunk(sessionId, p),
    'app-finish': (s, p, { sessionId }) => appTransfers.finish(sessionId, s.serial, p),
    'app-abort': async (s, p, { sessionId }) => { await appTransfers.abort(sessionId, p?.transferId); return { aborted: true }; },
    'stream-start': (s, p, { sessionId }) => streams.start(sessionId, s.serial),
    'video-keyframe': (s, p, { sessionId }) => streams.requestKeyframe(sessionId, s.serial),
    'stream-stop': async (s, p, { sessionId }) => { await streams.stop(sessionId); return { stopped: true }; },
  };
}
