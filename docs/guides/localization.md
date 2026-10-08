# Interface localization

The complete RU/EN dictionary is `shared/messages.json`. Each key contains `ru` and `en`; browser copy, server notifications, accessible labels, hints, validation and API explanations use this file. Server code uses `uiMessage()` and keeps the established wire language; the browser resolves stored messages in the selected language. User data, Android/Logcat output, protocol names and actual commands are not translated.

Use `t(key, parameters)` from `i18n.ts`. New keys should describe their purpose; migrated `ui.*` keys remain stable. Use placeholders for values instead of concatenating translated fragments. Keep identical placeholders in both languages. Use `getLocale()` for dates and numbers.

Language is stored in browser localStorage (`rdf.language`), available before sign-in, and synchronized between tabs. React subscriptions update copy without remounting the running device. Build translated lists at render time (or use getters), not once during module initialization. Memoized UI text must depend on the language. For already-created interface errors and notifications, use `localizeText()`; retain raw diagnostics in technical details.

Checks:

```bash
npm --prefix frontend test
npm --prefix frontend run build
cd frontend
npx playwright test e2e/language.spec.ts
```

The dictionary test checks complete language coverage, placeholders and keys, and rejects Russian string literals or visible JSX text outside the dictionary. Browser checks cover both themes at desktop widths, enlarged text, language persistence, signed-out access and switching on a live session.

Docker builds receive the shared directory via the `rdf_ui_messages` build context, configured in both Compose files and CI. Direct builds must pass `--build-context rdf_ui_messages=../shared` when run inside `server` or `frontend`.
