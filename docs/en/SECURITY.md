# Security

## Threat model

The lab assumes that **the agent and the content of the issues are not trusted**: an agent can make
mistakes, be manipulated by malicious text in an issue (prompt injection) or run hostile code coming
from a dependency. The protections exist to limit the damage to a disposable room.

| Protection | How |
|---|---|
| No GitHub credentials in the room | Code goes in and out as a `git bundle`; only the controller, on the host, has the token and pushes. |
| No force push | The controller only does a plain `git push` and checks that the commits descend from the starting point. |
| Controlled network | Internal network with no direct route; outbound traffic only through a Squid proxy with a domain allowlist. Forbidden domains are denied before any allow rule. |
| No host Docker | Each room has its own Docker-in-Docker. The host socket is never mounted. |
| Resource limits | Memory, CPU and processes limited per container; maximum time and idle time per task. |
| Independent verification | The result runs again in a clean room, without credentials, with the commands from the main branch (not from the PR). |
| Sanitized logs | Known tokens (GitHub, Anthropic, OpenAI, private keys) are removed before logs, comments and PRs. |
| Protected workflows | Changes to `.github/workflows` block delivery. |
| Human review | The lab never merges. |

## Known limits

- The agent receives **the CLI login** (Claude/Codex) inside the room, because it needs it to work.
  A compromised agent can use your quota while the room exists. Prefer accounts or keys dedicated to
  the lab, with a spending limit.
- The Docker-in-Docker sidecar runs with `--privileged` (required to create containers). It doesn't
  have the host socket, but the final isolation is that of Docker and the kernel on your machine.
- The agent has `sudo` **inside** the room, to install tools.
- The dashboard has no authentication and listens only on `127.0.0.1`. It checks the `Host` header
  (against DNS rebinding) and requires a custom header on actions. Don't expose it to the internet; use a VPN.
- The domains allowed by default include GitHub, npm, PyPI and Docker Hub. An agent could, in theory,
  send data to a public repository on these services. Don't use the lab with code that must not leave
  your machine without reviewing `proxy/allowed-domains.txt`.

## Good practices

- Use a *fine-grained* token with only the repositories you need, and an expiration date.
- Never put production secrets in the project repository or in `.laboratorio.json`.
- List your production domain in `proibido.dominios` or in `rooms.deniedDomains`.
- Review every PR before merging, especially changes to test scripts, `package.json` and
  configuration (the PR already highlights these files).

## Reporting a vulnerability

Don't open a public issue. Use **Security → Report a vulnerability** (GitHub's private advisory) in
this repository, with steps to reproduce. You'll get a first response within 7 days. Reports in
English are welcome.
