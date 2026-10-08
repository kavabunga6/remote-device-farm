import { t } from './i18n';
import type { IconName } from './icons';

export type AdminSection = 'sessions' | 'nodes' | 'profiles' | 'images' | 'users' | 'roles' | 'ops' | 'journal';

export const adminSections: ReadonlyArray<{ id: AdminSection; label: string; icon: IconName }> = [
  { id: 'sessions', get label() { return t('ui.156552b7ff38'); }, icon: 'phone' },
  { id: 'nodes', get label() { return t('ui.f3a46c2f2b5c'); }, icon: 'server' },
  { id: 'profiles', get label() { return t('ui.4d8dc88b1785'); }, icon: 'grid' },
  { id: 'images', get label() { return t('images.title'); }, icon: 'server' },
  { id: 'users', get label() { return t('ui.845595d6e899'); }, icon: 'user' },
  { id: 'roles', get label() { return t('roles.title'); }, icon: 'shield' },
  { id: 'ops', get label() { return t('ui.37663aa93839'); }, icon: 'bolt' },
  { id: 'journal', get label() { return t('ui.97c459a6bb7c'); }, icon: 'terminal' },
];

export const adminSectionInfo: Record<AdminSection, { title: string; description: string }> = {
  sessions: { get title() { return t('ui.156552b7ff38'); }, get description() { return t('ui.b10863dcd471'); } },
  nodes: { get title() { return t('ui.f3a46c2f2b5c'); }, get description() { return t('ui.2b13a0c9b52a'); } },
  profiles: { get title() { return t('ui.4d8dc88b1785'); }, get description() { return t('ui.8f0cba415d75'); } },
  images: { get title() { return t('images.title'); }, get description() { return t('images.description'); } },
  users: { get title() { return t('ui.845595d6e899'); }, get description() { return t('ui.bdfbfd2b9a51'); } },
  roles: { get title() { return t('roles.title'); }, get description() { return t('roles.description'); } },
  ops: { get title() { return t('ui.37663aa93839'); }, get description() { return t('ui.fabbaaa3283b'); } },
  journal: { get title() { return t('ui.97c459a6bb7c'); }, get description() { return t('ui.ace7b869cf5a'); } },
};

export const sectionPermission: Record<AdminSection, string> = { sessions: 'sessions.viewAll', nodes: 'nodes.view', profiles: 'profiles.view', images: 'images.view', users: 'users.view', roles: 'roles.view', ops: 'ops.view', journal: 'logs.view' };

export function adminSectionFromHash(hash: string): AdminSection {
  const path = hash.replace(/^#\/?/, '').split('?')[0];
  if (path === 'admin/agents') return 'nodes';
  return adminSections.find(item => path === 'admin/' + item.id)?.id ?? 'sessions';
}
