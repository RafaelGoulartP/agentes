---
name: Problema
about: Algo não funciona como deveria
labels: bug
---

**O que aconteceu**

**O que você esperava**

**Como reproduzir**

**Ambiente**
- Sistema: (ex.: Windows 11 + WSL2 Ubuntu 24.04 / Ubuntu 24.04 / macOS)
- Docker: (`docker version --format '{{.Server.Version}}'`)
- Node: (`node -v`)
- Versão do laboratório: (`git rev-parse --short HEAD`)

**Trechos de log** (sem tokens! confira antes de colar)
```
journalctl --user -u laboratorio-orquestrador -n 50 --no-pager
```
