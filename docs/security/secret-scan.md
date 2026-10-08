# Secrets and repository privacy

Credentials, ADB private keys, certificates, backups and local diagnostic files must remain outside version control. Configuration examples use reserved documentation addresses and example domains. Demo hardware values are synthetic.

## Checks

```bash
node scripts/check-repository-privacy.mjs --self-test
node scripts/check-repository-privacy.mjs
node scripts/check-public-content.mjs
gitleaks git --log-opts=--all --redact=100 --no-banner
```

The privacy check examines tracked and new non-ignored files for personal filesystem paths, private addresses in public examples, deployment identifiers in acceptance reports and sensitive filenames. It also rejects PNG text, EXIF and timestamp metadata in published screenshots. Screenshots must come from the mock API with demo data; metadata checks cannot inspect all information visible in image pixels.

Gitleaks 8.30.1 scans fetched Git history in CI with redacted output. The binary version and SHA256 are pinned; the workflow has read-only repository access. No detection exceptions are configured. File digests and pinned upstream image references are public build metadata, not credentials.
