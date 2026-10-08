# Contributing

This project is an **alpha**. Please keep changes focused and explain the
problem, expected behavior and how you verified the result. Discuss large
architectural changes in an issue before implementing them.

## Development

Use Node.js 24 and `npm ci` in the component you are changing. The frontend
can run against the mock API; Linux, Docker and KVM are required for real devices.
See [development](docs/development.md) and [architecture](docs/reference/server.md).

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run e2e
npm --prefix server test
npm --prefix server run build
npm --prefix agent test
node scripts/check-public-content.mjs --self-test
node scripts/check-public-content.mjs
node scripts/check-repository-privacy.mjs
```

Browser tests require Playwright's browser installation. CI also runs real
nginx, Docker permission checks, OpenAPI validation and WebRTC/H264 checks.
A mock test does not verify emulator boot, GPU rendering or a physical wipe.
State which hardware/runtime you used and what remains unverified.

## Pull requests

- Include regression coverage for behavior/security changes.
- Keep all user-facing RU/EN strings in `shared/messages.json` and update both
  languages. Check desktop layouts in light/dark themes and larger text sizes.
- Document API/config changes, update OpenAPI and deployment examples.
- Do not include credentials, private keys, local deployment addresses or APKs.
- Keep documentation focused on service behavior and configuration. Local task notes, conversation records and one-off deployment reports do not belong in version control.
- Preserve isolation and fail-closed cleanup. Avoid Docker-wide prune commands.

Use issues for bugs and proposals; include versions and sanitized reproduction
steps. Use the private process in [SECURITY.md](SECURITY.md) for vulnerabilities.
Contributions are provided under [Apache-2.0](LICENSE); retain third-party
attribution and confirm you have the right to submit your changes.

The content and privacy checks also accept `--staged` to inspect the exact files in the next commit, including forced additions and changes staged before later edits.
