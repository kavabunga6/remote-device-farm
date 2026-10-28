# Localization

## Languages

The interface and MCP tool descriptions support English, Russian, Simplified Chinese, Hindi, Spanish, Arabic, French, Bengali, Brazilian Portuguese, Urdu, Indonesian and German.

The language menu is available before sign-in and under **Settings → Appearance**. It searches native names, English names and language codes. A choice is saved in the browser and synchronized between tabs. Switching languages preserves an open device and its connections.

Arabic and Urdu use right-to-left layout. Commands, logs, URLs and device coordinates retain their original direction. Dates, numbers and alphabetical sorting follow the selected locale.

## Message files

| File | Contents |
| --- | --- |
| `shared/messages.json` | Source messages in Russian and English; keys remain stable. |
| `shared/locales/<language>.json` | A complete translation for each additional language. |
| `shared/languages.json` | Language names, locale codes, search aliases and text direction. |
| `shared/locales/revisions.json` | Fingerprints of the source and reviewed translations. |
| `shared/diagnostics.json` | Stable English operational diagnostics for server and agent logs. |
| `shared/interface-examples.json` | Literal commands, configuration examples and log labels. |

User data, Android output, Logcat, protocol identifiers and commands retain their original text. Operational diagnostics are not translated. User-facing validation, notifications, hints and accessible labels belong in the translated dictionary.

The browser loads each additional dictionary when needed. A failed download keeps the current language and offers a retry. The server uses `uiMessage()` with its established API language; the browser resolves these messages in the selected language. Agent and MCP packages include generated subsets of the shared catalogs.

## Adding or changing copy

1. Add or update the Russian and English source message. Prefer a descriptive key. Keep existing keys stable.
2. Update all ten additional translations. Do not ship English placeholders for missing prose.
3. Read the caller to establish context: button, status, warning, instruction or diagnostic. Use short, natural product language and consistent terminology. Preserve the meaning of permissions, destructive actions and recovery instructions.
4. Check the rendered interface, including long translations and right-to-left layouts. Keep comparable controls aligned.
5. Review the affected translations, then record their fingerprints and run the checks below.

Use `t(key, parameters)` in the browser. Translate complete sentences instead of concatenating fragments. Parameter names and repetitions must match every language. Use `TranslatedText` when a sentence contains formatted values or links; it allows word order to change without interpreting translation text as HTML.

Build translated lists at render time or use getters. Do not freeze text or date formatters during module initialization. Memoized copy must depend on language. Store message keys where possible; use `localizeText()` for previously created notices and API messages. Use `getLocale()` for dates, numbers and sorting.

Brands, commands, flags, paths and API field names remain unchanged. Use native language names in the language menu. Avoid literal translations that obscure the action, and do not add marketing claims to operational messages.

## Checks

```bash
# Review changed translations before recording them.
node scripts/check-locales.mjs --record-review=zh-Hans,hi,es,ar,fr,bn,pt-BR,ur,id,de
node scripts/check-locales.mjs
node scripts/check-message-sources.mjs
node scripts/sync-device-contract.mjs
node scripts/sync-diagnostics.mjs
node scripts/sync-mcp-resources.mjs
npm --prefix frontend test
npm --prefix frontend run build
cd frontend
npx playwright test e2e/language.spec.ts
```

The source guard rejects visible JSX literals, literal labels and untranslated Russian strings, and checks message references in the UI, server and agent. The dictionary validator rejects missing or extra keys, changed placeholders, control characters and stale translation fingerprints. Static checks cannot prove that every dynamically constructed value is localized; review new display paths as part of feature work.

Browser tests cover language persistence, search, keyboard navigation, download failures, both themes, enlarged text and switching while a device is open. Automated checks do not replace linguistic review.

Docker builds receive the shared directory through the `rdf_ui_messages` build context configured in Compose and CI. Direct server or frontend builds must pass `--build-context rdf_ui_messages=../shared` from the corresponding directory.
