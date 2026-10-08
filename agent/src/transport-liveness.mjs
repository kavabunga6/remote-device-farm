// Metrics heartbeats may contain slow host probes. Transport liveness must not.
export function watchBrokerSocket(socket, { intervalMs = 2000, timeoutMs = 8000, now = Date.now } = {}) {
  let lastPong = now();
  let timer;
  const pong = () => { lastPong = now(); };
  const start = () => {
    lastPong = now();
    clearInterval(timer);
    timer = setInterval(() => {
      if (socket.readyState !== 1) return;
      if (now() - lastPong >= timeoutMs) socket.terminate();
      else socket.ping();
    }, intervalMs);
    timer.unref?.();
  };
  const close = () => {
    clearInterval(timer);
    socket.off('pong', pong);
    socket.off('open', start);
    socket.off('close', close);
  };
  socket.on('pong', pong);
  socket.once('open', start);
  socket.once('close', close);
  if (socket.readyState === 1) start();
  return close;
}
