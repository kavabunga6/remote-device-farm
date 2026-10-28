import './LanguageControl.css';
import { initializeLanguage } from './i18n';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { NotificationsProvider } from './notifications';
import '@fontsource-variable/onest';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import './shell.css';
import './polish-overview.css';
import './polish-account.css';
import './polish-admin.css';
import './polish-session.css';
import './card-navigation.css';
import './SidebarNavigation.css';
import './host-status.css';
import './native-select.css';
import './ux-pass.css';
import './stitch-theme.css';
import './SessionsPage.css';
import './SessionBadge.css';
import './AuthScreens.css';
import './localization.css';
import { restoreUserPreferences } from './user-preferences';

restoreUserPreferences();

void initializeLanguage();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <NotificationsProvider><App /></NotificationsProvider>
  </React.StrictMode>,
);
