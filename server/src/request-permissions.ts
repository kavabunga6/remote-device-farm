// HTTP authorization is independent of hidden or disabled controls.
export function requestPermission(method: string, path: string): string | undefined {
 path = path.toLowerCase().replace(/\/+$/, '');
 const read = method === 'GET' || method === 'HEAD';
 if (/^\/api\/admin\/roles(?:\/|$)/.test(path)) return read ? 'roles.view' : 'roles.manage';
 if (/^\/api\/admin\/users\/[^/]+\/role$/.test(path)) return 'roles.manage';
 if (path.startsWith('/api/admin/users')) return read ? 'users.view' : method === 'DELETE' ? 'users.delete' : path.endsWith('/password') ? 'users.password' : 'users.manage';
 if (path.startsWith('/api/admin/tokens')) return 'tokens.system';
 if (path.startsWith('/api/admin/agents') || path.startsWith('/api/admin/agent-bundle')) return 'nodes.credentials';
 if (path.startsWith('/api/admin/hosts/') && path.endsWith('/image-builder')) return 'images.settings';
 if (path.startsWith('/api/admin/hosts')) return read ? 'nodes.view' : 'nodes.manage';
 if (path.startsWith('/api/admin/launch-settings')) return read ? 'profiles.view' : 'profiles.manage';
 if (path.startsWith('/api/admin/profiles')) return read ? 'profiles.view' : 'profiles.manage';
 if(path.startsWith('/api/admin/image-management'))return read || path.endsWith('/preview') ? 'images.view' : path.endsWith('/policy') ? 'images.settings' : 'images.view';
 if (path.startsWith('/api/admin/registry')) return read ? 'images.view' : 'images.settings';
 if (path.startsWith('/api/admin/emulator-images')) return read ? 'images.view' : 'images.build';
 if (path.startsWith('/api/admin/teams')) return read ? 'teams.view' : 'teams.manage';
 if (path.startsWith('/api/admin/ops')) return 'ops.view';
 if (/^\/api\/admin\/(audit|rentals|logs|session-diagnostics|application-log)(?:\/|$)/.test(path)) return 'logs.view';
 if (path === '/api/sessions') return read ? 'sessions.view' : 'sessions.create';
 const session = /^\/api\/sessions\/[^/]+(?:\/(.*))?$/.exec(path);
 if (session) {
  const action = session[1] ?? '';
  if (!action) return read ? 'sessions.view' : method === 'DELETE' ? 'sessions.stop' : 'sessions.control';
  if (action === 'kill') return 'sessions.manageAll';
  if (action === 'shares' || action.startsWith('shares/')) return 'sessions.share';
  if (action === 'webviews' || action === 'network-inspector' || action.startsWith('network-inspector/')) return 'sessions.console';
  if (action.startsWith('appium/')) return 'sessions.console';
  if (action === 'adb') return 'sessions.console';
  if (action === 'ui') return read ? 'sessions.view' : 'sessions.control';
  if (action.startsWith('ui/')) return 'sessions.control';
  if (action.startsWith('adb-')) return 'sessions.adb';
  if (action === 'files' || action.startsWith('apps/')) return 'sessions.files';
  if (action === 'camera' || action.startsWith('camera/')) return 'sessions.env';
  if (action === 'env') return 'sessions.env';
  if (action.startsWith('logcat')) return 'sessions.logcat';
  if (action === 'device-info' || action === 'screenshot' || action === 'stream' || action === 'keepalive') return 'sessions.view';
  return 'sessions.control';
 }
 if (path.startsWith('/api/shares')) return 'sessions.view';
 if (path === '/api/queue' && !read) return 'sessions.create';
 if (path.startsWith('/api/tokens') || path.startsWith('/api/me/webhooks')) return 'tokens.personal';
 if (path.startsWith('/api/apps')) return 'sessions.files';
 if (path.startsWith('/api/me/adb-')) return 'sessions.adb';
 return undefined;
}
