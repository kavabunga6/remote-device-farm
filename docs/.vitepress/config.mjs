import { defineConfig } from 'vitepress';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repository, rewriteDocumentationLink } from './links.mjs';
import { prepareDownloads } from './downloads.mjs';

const docsRoot = fileURLToPath(new URL('..', import.meta.url));
await prepareDownloads(docsRoot);

// Keep Cyrillic letters intact so source Markdown and site fragments agree.
const slugify = text => text.normalize('NFC').trim().toLowerCase()
  .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');

export default defineConfig({
  lang: 'ru-RU',
  title: 'Device Farm',
  titleTemplate: ':title · Документация',
  description: 'Руководства по установке, работе с Android-устройствами и автоматизации тестов.',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }]],
  appearance: true,
  cleanUrls: false,
  ignoreDeadLinks: "localhostLinks",
  rewrites: { 'README.md': 'index.md', 'api/README.md': 'api/index.md', 'ci/README.md': 'ci/index.md', 'screenshots/README.md': 'screenshots/index.md' },
  markdown: {
    anchor: { slugify },
    headers: { slugify },
    theme: { light: 'github-light', dark: 'github-dark' },
    config(md) {
      const renderCode = md.renderer.rules.code_inline;
      md.renderer.rules.code_inline = (...args) => renderCode(...args).replace("<code", "<code v-pre");
      const renderLink = md.renderer.rules.link_open;
      md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
        const token = tokens[index];
        const href = token.attrGet('href');
        if (href) {
          const rewritten = rewriteDocumentationLink(href, env.relativePath);
          token.attrSet('href', rewritten);
          if (rewritten.startsWith('/downloads/') && !rewritten.endsWith('/index.html')) token.attrSet('download', '');
        }
        return renderLink(tokens, index, options, env, renderer);
      };
    },
  },
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Device Farm / Docs',
    nav: [
      { text: 'Руководства', link: '/' },
      { text: 'Интеграции', link: '/ci/' },
      { text: 'Исходники', link: repository },
    ],
    sidebar: [
      { text: 'Начало работы', items: [
        { text: 'О документации', link: '/' },
        { text: 'Скриншоты', link: '/screenshots/' },
        { text: 'Проверки и ограничения', link: '/verification' },
        { text: 'Установить сервер', link: '/deployment/server' },
        { text: 'Подключить агент', link: '/deployment/agent' },
      ] },
      { text: 'Работа с устройствами', items: [
        { text: 'Сессии, экран и ADB', link: '/guides/sessions' },
        { text: 'Образы и профили', link: '/guides/images' },
        { text: 'Собственный Docker-образ', link: '/emulator-images' },
        { text: 'Диагностика и ошибки', link: '/troubleshooting' },
      ] },
      { text: 'Администрирование', collapsed: false, items: [
        { text: 'Узлы и пользователи', link: '/guides/administration' },
        { text: 'Образы и очистка', link: '/guides/image-management' },
        { text: 'Физические устройства', link: '/device-providers' },
        { text: 'Очистка USB-устройств', link: '/usb-reset-script' },
        { text: 'Безопасность устройств', link: '/security-audit-devices' },
        { text: 'Чек-лист релиза', link: '/release-checklist' },
      ] },
      { text: 'API и интеграции', collapsed: false, items: [
        { text: 'API и общий CLI', link: '/api/' },
        { text: 'Состав и статус интеграций', link: '/ci/' },
        { text: 'Maestro', link: '/ci/maestro' },
        { text: 'Appium', link: '/ci/appium' },
        { text: 'Jenkins', link: '/ci/jenkins' },
        { text: 'TeamCity', link: '/ci/teamcity' },
        { text: 'GitHub Actions', link: '/ci/github-actions' },
        { text: 'GitLab CI', link: '/ci/gitlab-ci' },
        { text: 'GitLab CI Component', link: '/ci/gitlab-component' },
        { text: 'Jenkins Shared Library', link: '/ci/jenkins-library' },
        { text: 'Gradle-плагин', link: '/ci/gradle' },
      ] },
      { text: 'Разработчикам', collapsed: true, items: [
        { text: 'Локальная разработка', link: '/development' },
        { text: 'Устройство сервера', link: '/reference/server' },
        { text: 'Редактировать документацию', link: '/site' },
      ] },
    ],
    outline: { level: [2, 3], label: 'На этой странице' },
    search: { provider: 'local', options: { translations: {
      button: { buttonText: 'Поиск', buttonAriaLabel: 'Поиск по документации' },
      modal: { displayDetails: 'Показать подробности', resetButtonTitle: 'Очистить поиск', backButtonTitle: 'Закрыть поиск', noResultsText: 'Ничего не найдено', footer: { selectText: 'выбрать', navigateText: 'перейти', closeText: 'закрыть' } },
    } } },
    docFooter: { prev: 'Предыдущая страница', next: 'Следующая страница' },
    editLink: { pattern: `${repository}/edit/main/docs/:path`, text: 'Изменить страницу на GitHub' },
    sidebarMenuLabel: 'Разделы документации',
    returnToTopLabel: 'Наверх',
    darkModeSwitchLabel: 'Тема',
    lightModeSwitchTitle: 'Светлая тема',
    darkModeSwitchTitle: 'Тёмная тема',
    skipToContentLabel: 'Перейти к содержимому',
    notFound: { title: 'Страница не найдена', quote: 'Выберите раздел слева или найдите нужную тему через поиск.', linkLabel: 'Открыть документацию', linkText: 'К началу' },
  },
  vite: { server: { host: '127.0.0.1', port: 5174, strictPort: true, fs: { allow: [docsRoot] } } },
  async buildEnd({ outDir }) {
    await mkdir(path.join(outDir, 'api'), { recursive: true });
    await copyFile(path.join(docsRoot, 'api/openapi.yaml'), path.join(outDir, 'api/openapi.yaml'));
  },
});
