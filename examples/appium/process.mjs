import { spawn } from 'node:child_process';

// Every spawn settles, including failures which emit "error" without "exit".
export function startProcess(command, args, options) {
  const child = spawn(command, args, options);
  let result;
  let error;
  let stopping;
  let onClose;
  const onError = (cause) => { error = cause; };
  child.on('error', onError);
  const completion = new Promise((resolve) => {
    onClose = (code, signal) => {
      result = { code, signal, error };
      child.off('error', onError);
      resolve(result);
    };
    child.once('close', onClose);
  });
  function waitForClose(ms) {
    if (result) return Promise.resolve(result);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), ms);
      completion.then((value) => { clearTimeout(timer); resolve(value); });
    });
  }
  function stop(graceMs = 3000) {
    return stopping ??= (async () => {
      if (result) return result;
      if (child.pid) child.kill('SIGTERM');
      let closed = await waitForClose(graceMs);
      if (closed) return closed;
      if (child.pid) child.kill('SIGKILL');
      // A failed log destination may have unpiped and paused either stream.
      child.stdout?.resume();
      child.stderr?.resume();
      closed = await waitForClose(2000);
      if (closed) return closed;
      throw new Error(`Process ${child.pid ?? command} did not close after termination`);
    })();
  }
  return { child, completion, stop, get result() { return result; } };
}
