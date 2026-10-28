# Instruções para agentes de IA

Este arquivo é para agentes (Claude Code, Codex, Cursor etc.) que vão **instalar, adaptar ou
modificar** este repositório no computador de alguém. Leia inteiro antes de agir. Para entender o
produto, veja o [README.md](README.md). Para os passos manuais, veja [docs/INSTALACAO.md](docs/INSTALACAO.md).

## Princípios

1. **A pessoa decide; você executa e explica.** Antes de qualquer ação com efeito fora da pasta do
   laboratório, peça confirmação explícita. Isso inclui instalar pacotes do sistema, mudar
   `.wslconfig`/`/etc/wsl.conf`, ligar serviços, criar etiquetas ou issues no GitHub e reiniciar o WSL.
2. **Nunca leia, imprima, copie ou faça commit de segredos.** Não abra `secrets/*.env` nem os
   arquivos de login (`.credentials.json`, `auth.json`). Para saber se existem, use `test -f`. O
   token do GitHub é colado **pela pessoa** no editor; nunca peça que ela o cole no chat.
3. **Não enfraqueça o isolamento** para "fazer funcionar". Não monte o socket Docker do host nas salas,
   não passe o token para as salas, não libere `*` no proxy e não remova `proibido.dominios`. Se algo
   só funciona assim, pare e explique à pessoa.
4. **Não sobrescreva arquivos locais existentes** (`orchestrator/config.json`, `local.env`,
   `config.env`, `secrets/*`). Mostre o diff proposto e peça confirmação.
5. **Fale a língua da pessoa** e explique cada etapa em termos simples. Muita gente que usa isto não é
   programadora.

## Roteiro de instalação

Siga em ordem. Em cada etapa, verifique antes de seguir.

### 1. Diagnóstico (só leitura)

```bash
uname -a; cat /etc/os-release 2>/dev/null | head -3
grep -qi microsoft /proc/version && echo "WSL"
bash --version | head -1; git --version; node -v; docker version --format '{{.Server.Version}}'
systemctl --user show-environment >/dev/null 2>&1 && echo "systemd do usuário OK"
free -g; df -h ~
test -f ~/.claude/.credentials.json && echo "login Claude no Linux"
test -f ~/.codex/auth.json && echo "login Codex no Linux"
ls -d /mnt/c/Users/*/.claude/.credentials.json /mnt/c/Users/*/.codex/auth.json 2>/dev/null
```

Monte um resumo para a pessoa: sistema, o que já existe, o que falta e quanta memória e disco há.

| Situação | Ação |
|---|---|
| Windows sem WSL | Você não consegue instalar o WSL de dentro do Linux. Passe à pessoa o passo "Windows" de `docs/INSTALACAO.md` e espere. |
| Pasta em `/mnt/c/...` | Proponha clonar de novo em `~/laboratorio-agentes`. Em `/mnt/c` os scripts quebram (CRLF) e o modo 600 dos segredos não vale. |
| Sem Docker ou sem acesso ao daemon | Linux: proponha `curl -fsSL https://get.docker.com \| sh` e `usermod -aG docker`. WSL: a pessoa precisa abrir o Docker Desktop e ativar a integração com a distribuição. |
| Node < 22 ou ausente | Proponha nvm + `nvm install 24` (sem sudo). |
| Sem systemd no WSL | Proponha `[boot] systemd=true` em `/etc/wsl.conf` e `wsl --shutdown` (a pessoa roda o último no Windows). |
| Menos de 8 GB livres para o Docker | Mantenha `scheduler.maxConcurrency` em 1. |
| macOS | Suporte experimental: bash do Homebrew; o login do Claude fica no Keychain, então use `secrets/claude.env` (chave de API). |

### 2. Instalar

```bash
cd ~/laboratorio-agentes
./scripts/instalar.sh
```

Leia a saída. Cada linha `falta` traz o que fazer. Rode de novo até terminar sem erros. O script não
sobrescreve nada e pode ser repetido.

### 3. Logins e token (a pessoa faz, você orienta)

- **Agentes:** se faltar login, peça que a pessoa rode `claude` (e depois `/exit`) e/ou `codex login`
  num terminal. Depois confira `local.env`. Só caminhos; ajuste se o instalador não achou.
- **Token do GitHub:** passe as instruções da seção 3 de `docs/INSTALACAO.md` e peça que a pessoa cole
  o valor em `secrets/github-controller.env` com o editor (`nano`). Para confirmar sem ver o token:

  ```bash
  cd orchestrator && node src/check-access.mjs <dono>/<repositorio>
  ```

### 4. Ligar

Peça confirmação e rode `./scripts/install-user-service.sh --ativar`. Sem systemd, explique
`scripts/run-dashboard.sh` e `scripts/run-orchestrator.sh`. Confira:

```bash
systemctl --user is-active laboratorio-painel laboratorio-orquestrador
curl -fsS http://127.0.0.1:7788/api/overview >/dev/null && echo "painel OK"
tail -n 5 logs/orchestrator.jsonl     # procure "started" e "tick_complete"
```

### 5. Primeiro projeto

Guie a pessoa no painel (`http://127.0.0.1:7788`, aba **Projetos**). Se ela pedir que você escreva o
`.laboratorio.json` do projeto dela, siga a seção abaixo.

## Adaptar para o projeto da pessoa

O ponto de adaptação principal é o **`.laboratorio.json` no repositório do projeto**, não o código do
laboratório. Referência completa em [docs/CONFIGURACAO.md](docs/CONFIGURACAO.md).

Para escrever um bom `.laboratorio.json`:

1. Leia o README, o `package.json`/`pyproject.toml`/`go.mod`, o CI existente (`.github/workflows`) e
   os scripts de teste do projeto. Copie os comandos de teste **do CI**; eles são os que a pessoa já
   confia.
2. `dependencias`: os lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `poetry.lock`, `go.sum`...).
3. `instalar`: os mesmos passos do CI para instalar. Para linguagens além de Node, inclua a instalação
   do runtime (`sudo apt-get update && sudo apt-get install -y python3 python3-venv`). Se o projeto
   precisar de algo pesado e fixo, proponha mudar `images/Dockerfile.base` em vez disso.
4. `verificar`: separe em grupos o que pode rodar em paralelo (ex.: frontend e backend). Só inclua
   comandos que **passam hoje na branch principal**. Rode-os localmente para conferir.
5. Serviços (Postgres, Redis, Mongo): os testes devem subi-los com `docker run` dentro da sala (há
   um Docker privado) e a imagem vai em `imagensDeTeste`.
6. `proibido.dominios`: pergunte à pessoa o domínio de produção dela e inclua. Pergunte também por
   pastas e scripts que nunca devem ser executados (deploy, migração de produção).
7. `previa`: os passos para subir o app com dados falsos, escutando em `0.0.0.0`.
8. Valide a partir da raiz do projeto: `node ~/laboratorio-agentes/scripts/validar-config.mjs`
   (imprime `Configuração válida.` ou o campo com problema).

Outras adaptações comuns, sempre com confirmação:

| Pedido | Onde mexer |
|---|---|
| Mais salas ao mesmo tempo | `scheduler.maxConcurrency` em `orchestrator/config.json` (máx. 3) e memória do WSL |
| Salas com mais memória | `config.env` (crie só com as linhas a mudar) |
| Bloquear o domínio de produção em todos os projetos | `rooms.deniedDomains` em `orchestrator/config.json` |
| Liberar um domínio para um projeto | `dominiosExtras` no `.laboratorio.json` |
| Liberar um domínio para todos | `proxy/allowed-domains.txt` + `LAB_ONLY_PROXY=1 ./scripts/build-images.sh` |
| Fuso dos avisos e da cota | `timeZone` em `orchestrator/config.json` |
| Outra versão do Claude Code ou do Codex | `images/Dockerfile.claude` / `images/Dockerfile.codex` (versões fixadas de propósito) |
| Painel em outra porta | `LAB_PAINEL_PORT` no ambiente do serviço |

Depois de mudar `orchestrator/config.json`: `systemctl --user restart laboratorio-orquestrador laboratorio-painel`.

## Modificar o código do laboratório

- Node.js puro (ESM, Node 22+), **sem dependências npm**. Não adicione pacotes.
- Rode `cd orchestrator && npm test` antes e depois de qualquer mudança. Tudo precisa passar.
- Mudanças de comportamento precisam de teste em `orchestrator/test/`.
- Mantenha o estilo do código ao redor: comentários curtos em português explicando o **porquê**,
  nomes em inglês no código, mensagens ao usuário em português.
- Scripts shell: `set -Eeuo pipefail`, variáveis entre aspas e `bash -n` para conferir a sintaxe.
- Arquivos com finais de linha LF (já garantido por `.gitattributes`).
- Pontos sensíveis, com cuidado redobrado: `scripts/create-room.sh` (isolamento),
  `orchestrator/src/redact.mjs` (remoção de segredos dos logs), `orchestrator/src/host-git.mjs`
  (push e merge), `proxy/` (rede das salas).

## Mapa rápido do código

| Arquivo | Papel |
|---|---|
| `orchestrator/src/main.mjs` | Laço principal: carrega config, cria uma instância por projeto e roda os ciclos |
| `orchestrator/src/orchestrator.mjs` | Máquina de estados de cada tarefa: sala → coleta → verificação → entrega |
| `orchestrator/src/domain.mjs` | Regras puras: quais issues começam, áreas, dependências, status do agente |
| `orchestrator/src/room-runner.mjs` | Cria salas, monta o prompt, supervisiona agente e verificação |
| `orchestrator/src/host-git.mjs` | Espelho Git, bundles, merge com a base, push sem force |
| `orchestrator/src/project-manager.mjs` | Projetos adicionados pelo painel, acesso e issue de configuração |
| `orchestrator/src/dashboard.mjs` + `dashboard/index.html` | Painel web |
| `scripts/create-room.sh` | Redes, proxy, DinD e contêiner do agente de uma sala |
| `scripts/build-images.sh` + `scripts/prepare-build.mjs` | Imagens da sala a partir do `.laboratorio.json` |

## O que nunca fazer

- `git push --force`, reescrever histórico ou apagar branches do projeto da pessoa.
- Fazer merge de PRs no lugar da pessoa.
- Rodar o orquestrador apontando para um repositório sem a pessoa ter escolhido aquele repositório.
- Desligar o serviço e deixá-lo desligado esperando uma resposta: se precisar parar
  (`systemctl --user stop laboratorio-orquestrador`), religue assim que terminar.
- Publicar `orchestrator/state/`, `workspaces/`, `logs/` ou `local.env`. Eles têm nomes de
  repositórios, caminhos e trechos de código da pessoa.
