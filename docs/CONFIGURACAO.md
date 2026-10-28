# Configuração

*[English](en/CONFIGURATION.md)*

O laboratório tem quatro lugares de configuração. Só o `.laboratorio.json` fica no repositório do
**seu projeto**. Os outros ficam na pasta do laboratório, e só os modelos (`*.example`) vão para o Git.

| Arquivo | Onde | Para quê |
|---|---|---|
| `.laboratorio.json` | raiz do seu projeto | como instalar, testar e pré-visualizar o projeto |
| `orchestrator/config.json` | laboratório (fora do Git) | comportamento do orquestrador: vagas, tentativas, prazos, agentes |
| `config.env` | laboratório (fora do Git, opcional) | limites de CPU/memória das salas e imagens base |
| `local.env` | laboratório (fora do Git) | caminhos dos logins das CLIs |
| `secrets/*.env` | laboratório (fora do Git, modo 600) | token do GitHub e chaves de API opcionais |

---

## `.laboratorio.json` (no seu projeto)

Os comandos vêm sempre da **branch principal** do projeto. Um PR de agente que mude este arquivo só
passa a valer depois do merge, então o agente não consegue enfraquecer a própria verificação.

```json
{
  "dependencias": ["package-lock.json"],
  "instalar": ["npm ci", "npx playwright install --with-deps chromium"],
  "reinstalar": ["npm ci --no-audit --no-fund"],
  "verificar": [
    ["npm run lint", "npm run build", "npm test"],
    ["npm run test:e2e"]
  ],
  "leia": ["AGENTS.md", "docs/TESTES.md"],
  "proibido": {
    "dominios": ["meusite.com.br"],
    "portas": [5432],
    "pastas": ["scripts/producao"],
    "texto": "nunca use credenciais ou bancos de produção"
  },
  "imagensDeTeste": ["postgres:16"],
  "dominiosExtras": ["registry.meuempresa.com"],
  "previa": {
    "porta": 5173,
    "passos": [
      { "rodar": "docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=teste postgres:16" },
      { "rodar": "npm run dev:api", "esperar": "http://127.0.0.1:3000/health" },
      { "rodar": "npm run dev -- --host 0.0.0.0", "esperar": "http://127.0.0.1:5173/" }
    ],
    "logins": "admin@teste.local / senha-de-teste"
  }
}
```

| Campo | Obrigatório | Descrição |
|---|---|---|
| `dependencias` | sim (pode ser `[]`) | Arquivos que definem as dependências (lockfiles). Entram na imagem da sala; quando mudam na `main`, a imagem é reconstruída. Workspaces do npm são incluídos sozinhos. |
| `instalar` | sim (pode ser `[]`) | Comandos para instalar dependências, rodados **no build da imagem**, com internet direta. |
| `reinstalar` | não | Comandos rodados **na sala** quando a branch do agente muda as dependências. Sem este campo, usa `instalar`. |
| `verificar` | sim | Lista de **grupos**. Os grupos rodam em paralelo; os comandos de cada grupo, em ordem. Todos precisam passar para virar PR. |
| `leia` | sim (pode ser `[]`) | Arquivos que o agente deve ler antes de trabalhar (ex.: `AGENTS.md`). |
| `proibido.dominios` | sim (pode ser `[]`) | Domínios (e subdomínios) **bloqueados** no proxy das salas e citados nas instruções do agente. |
| `proibido.portas` / `pastas` / `texto` | sim | Avisos ao agente sobre o que nunca tocar. |
| `imagensDeTeste` | sim (pode ser `[]`) | Imagens Docker que os testes usam (ex.: `postgres:16`). São baixadas uma vez no host e carregadas na sala de verificação, sem depender da rede. |
| `dominiosExtras` | sim (pode ser `[]`) | Domínios liberados no proxy além da lista padrão. |
| `previa` | sim | Como subir o app para você testar um PR antes do merge (botão **Prévia** no painel). `porta`: porta do app na sala. `passos`: comandos em ordem; `esperar` é uma URL local que precisa responder antes do próximo passo. `logins`: só usuários de teste. |

Regras: caminhos relativos e sem `..`; um comando por linha; nada de segredos neste arquivo.

**Dentro da sala** há Node 24 (Debian bookworm), git, gh, jq, ripgrep, tmux, Docker (o daemon privado
da sala) e `sudo apt-get` liberado. Para outras linguagens (Python, Go, Java...), instale em
`instalar` (ex.: `sudo apt-get update && sudo apt-get install -y python3-venv`) ou adapte
`images/Dockerfile.base`.

---

## `orchestrator/config.json`

Criado pelo instalador a partir de `orchestrator/config.example.json`. Caminhos relativos partem da
pasta do laboratório. Os principais campos:

| Campo | Padrão | Descrição |
|---|---|---|
| `enabled` | `true` (no config.json criado) | `false` faz o orquestrador sair sem fazer nada. |
| `scheduler.maxConcurrency` | `1` | Salas ao mesmo tempo, somando todos os projetos (máximo 3). Cada sala usa até 4 GiB e 2 CPUs. |
| `scheduler.pollSeconds` | `60` | Intervalo entre leituras completas do GitHub. |
| `scheduler.defaultArea` | `geral` | Área das issues sem etiqueta `area:`. |
| `scheduler.holdAreaWhilePrOpen` | `true` | Não começa outra tarefa da mesma área enquanto houver PR aberto dela (evita conflitos). |
| `retry.maxAttempts` | `4` | Falhas reais antes de marcar `bloqueado`. Falhas de rede e cota não contam. |
| `retry.baseSeconds` / `maxSeconds` | `300` / `3600` | Espera entre tentativas (dobra a cada falha, até o teto). |
| `rooms.agentTimeoutMinutes` | `240` | Tempo máximo de um agente numa tarefa. |
| `rooms.agentIdleMinutes` | `25` | Agente sem atividade por esse tempo é encerrado. |
| `rooms.verifyTimeoutMinutes` | `60` | Tempo máximo da verificação. |
| `rooms.branchPrefix` | `agente` | Branches criadas: `agente/<agente>/issue-<n>`. |
| `rooms.deniedDomains` | `[]` | Domínios bloqueados em **todos** os projetos (ex.: o seu domínio de produção). |
| `agents.claude.command` / `agents.codex.command` | ver arquivo | Linha de comando de cada agente na sala. O prompt chega como último argumento. |
| `health.minFreeGb` | `15` | Abaixo disso de disco livre, salas novas esperam. |
| `cleanup.days` | `7` | Execuções antigas (logs, bundles) são apagadas depois desse prazo. |
| `timeZone` | fuso do sistema | Fuso usado para horários de renovação de cota e nos avisos (ex.: `America/Sao_Paulo`). |
| `labels.*` | ver arquivo | Nomes das etiquetas do fluxo. |

Variáveis de ambiente úteis: `LAB_PAINEL_PORT` (porta do painel, padrão 7788), `LAB_PREVIEW_PORT`
(porta da prévia, padrão 8601), `LAB_ORCHESTRATOR_CONFIG` (outro config.json), `LAB_NTFY_URL`
(avisos via ntfy quando `notify.enabled` é `true`).

---

## `config.env`

Opcional. O padrão está em `config.env.example`; crie `config.env` só com as linhas que quer mudar.

| Variável | Padrão | Descrição |
|---|---|---|
| `LAB_MEMORY_AGENT` / `LAB_CPUS_AGENT` | `3g` / `1.5` | Limites do contêiner do agente. |
| `LAB_MEMORY_DIND` / `LAB_CPUS_DIND` | `768m` / `0.4` | Limites do Docker privado da sala. |
| `LAB_VERIFY_*` | — | Os mesmos limites para a sala de verificação (mais folga para bancos de teste). |
| `LAB_PROXY_IMAGE` | `laboratorio-proxy:local` | Nome da imagem do proxy. |
| `LAB_DIND_IMAGE` | `docker:29-dind` | Imagem do Docker privado. |

---

## `local.env`

Só caminhos, nunca o conteúdo dos logins. O instalador preenche sozinho quando encontra os arquivos.

| Variável | Descrição |
|---|---|
| `LAB_CLAUDE_CREDENTIALS_FILE` | Login do Claude Code (`~/.claude/.credentials.json`). |
| `LAB_CLAUDE_STATE_FILE` | Opcional: `~/.claude.json`, evita perguntas da primeira execução. |
| `LAB_CODEX_AUTH_FILE` | Login do Codex (`~/.codex/auth.json`). |
| `..._2` a `..._9` | Contas extras do mesmo agente. O laboratório alterna entre elas e só pausa o agente quando todas estão sem cota. |

---

## Domínios liberados nas salas

[proxy/allowed-domains.txt](../proxy/allowed-domains.txt) lista o que as salas podem acessar: os
provedores dos agentes, GitHub, npm, Docker Hub, PyPI, repositórios apt e as CDNs do Playwright. Um
domínio por linha; com `.` na frente, inclui os subdomínios. Para um projeto específico, prefira
`dominiosExtras` no `.laboratorio.json`. Depois de mudar a lista, reconstrua o proxy:

```bash
LAB_ONLY_PROXY=1 ./scripts/build-images.sh
```
