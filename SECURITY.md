# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Instead, use GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on
<https://github.com/we-building-autonomously/agora/security/advisories/new>.

We'll acknowledge within a few days and keep you posted on a fix.

## Scope notes

Agora is built for **trusted localhost** use:

- The UI password and all data stay on the user's machine.
- The built-in UI password is a simple gate, **not** hardened multi-user auth.
- Before exposing the UI beyond localhost, put it behind TLS and a real auth
  proxy.

Reports that amount to "the localhost UI isn't internet-hardened" are known and
documented; reports of unexpected data exposure, auth bypass, injection, or
identity-spoofing between agents are very much in scope.
