# Security

## Reporting

Report a vulnerability privately through GitHub Security Advisories:

https://github.com/escapeWu/pi-cc-memory/security/advisories/new

Do not open a public issue for a vulnerability that could expose memory content,
paths outside the store, or credentials.

## Scope

`pi-cc-memory` writes model-authored Markdown into a project store and, when
enabled, a global store. Security-relevant areas:

- Path handling: topic paths must stay inside the store. Absolute paths,
  traversal, hidden paths, non-Markdown targets, `MEMORY.md`, symlinked topics and
  real paths resolving outside the store are rejected.
- Index integrity: store mutations share a cross-process lock. Failed index
  updates are reported; forget/restore roll back known topic changes on failure.
- Local concurrency: the lock uses a heartbeat, stale expiration and bounded
  acquisition wait. All writers must use the same lock policy. This is not a
  database transaction across process/machine crashes or a distributed contract.
- Recoverable deletion: `.recovery/` retains exact topic bytes and index pointers.
  Those private snapshots are excluded from recall/search, and restore refuses
  newer conflicting topics. There is no automatic snapshot purge or encryption.
- Settings: only the `ccMemory` namespace is read, with strict validation. Project
  settings cannot override store paths. Error messages do not include file contents.
- Prompt injection through memory: memory content is model-visible context.
  Treat a compromised store as a prompt-injection vector.
- Secrets: the plugin does not scan memory text for secrets. Do not store
  credentials; the policy instructs the model not to.

## Supported version

Only the latest `main` is supported. The project is in early milestone development
and has no stable release yet.
