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
- Index integrity: topic write plus index update run under one in-process lock;
  a failed index update is reported, not hidden.
- Cross-process concurrency: only an in-process mutex exists in M1. Two Pi
  processes writing the same store can still race (tracked as issue #8).
- Prompt injection through memory: memory content is model-visible context.
  Treat a compromised store as a prompt-injection vector.
- Secrets: the plugin does not scan memory text for secrets. Do not store
  credentials; the policy instructs the model not to.

## Supported version

Only the latest `main` is supported. The project is at the M1 stage and has no
stable release yet.
