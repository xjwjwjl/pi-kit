# Sample App Fixture

Small, offline-only TypeScript fixture used by Linear Todo deterministic E2E runs.

- No network access.
- Cache entries expire at `expiresAt`; the deadline is exclusive, so `now === expiresAt` is expired.
- No runtime dependencies.
- `npm test` completes in a few seconds.
- The source contains auth, cache, configuration, and index modules for future multi-file scenarios.
