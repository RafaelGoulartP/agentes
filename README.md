# Laboratório de Agentes

Rode **Claude Code** e **Codex** como desenvolvedores do seu repositório no GitHub, na sua própria máquina,
cada tarefa numa sala Docker isolada e descartável. Você escreve uma issue, coloca uma etiqueta e recebe
um pull request já testado, pronto para a sua revisão.

> **English summary:** a self-hosted orchestrator that turns labeled GitHub issues into verified pull
> requests using Claude Code and Codex CLI. Each task runs in a disposable Docker "room" with its own
> network, egress proxy and Docker-in-Docker; agents never receive GitHub credentials. Results are
> re-verified in a clean room before the controller pushes and opens the PR. The UI and docs are in
> Brazilian Portuguese. See [docs/INSTALACAO.md](docs/INSTALACAO.md) to get started.

```
 Issue no GitHub              Sua máquina (Linux ou Windows + WSL2)                         GitHub
 ┌──────────────┐   ┌──────────────────────────────────────────────────────────────┐   ┌───────────┐
 │ #42 Corrigir │   │  Orquestrador (Node, sem dependências npm)                   │   │           │
 │ o login      │──▶│   1. lê issues com etiqueta  claude / codex                  │   │  PR #57   │
 │ [claude]     │   │   2. abre uma SALA para o agente ──┐                         │──▶│  pronto   │
 │ [area:auth]  │   │   3. coleta os commits (bundle)    │  sala: agente + Docker  │   │  para     │
 └──────────────┘   │   4. verifica numa SALA LIMPA      │  privado + proxy com    │   │  revisão  │
                    │   5. faz push e abre o PR          │  lista de domínios      │   └───────────┘
                    │  Painel web em 127.0.0.1:7788 ◀────┘                         │
                    └──────────────────────────────────────────────────────────────┘
```

## O que ele faz

- **Fila a partir das issues.** Toda issue aberta com a etiqueta `claude` ou `codex` vira uma tarefa.
  Com as duas etiquetas, vai para o agente menos ocupado.
- **Salas isoladas.** Cada tarefa ganha uma rede interna sem rota para a internet, um proxy de saída
  (Squid) que só libera domínios de uma lista, um Docker próprio (Docker-in-Docker) para bancos e
  serviços de teste, e limites de CPU, memória e processos. O socket Docker da sua máquina nunca entra na sala.
- **O agente nunca vê o token do GitHub.** O código entra e sai da sala como `git bundle`. Só o
  controlador, fora das salas, faz `push` (nunca `--force`) e abre o PR.
- **Verificação independente.** O resultado do agente é testado de novo numa sala limpa, sem
  credenciais, com os comandos definidos na branch principal do projeto (o agente não consegue
  enfraquecer os testes). Se falhar, o agente recebe o log e tenta corrigir.
- **Resiliência.** Novas tentativas com espera crescente, pausa automática quando a cota do agente acaba
  (inclusive com várias contas), disjuntor para falhas de ambiente, fila persistente de comentários e
  etiquetas, recuperação depois de reiniciar o PC.
- **Organização do trabalho.** Etiquetas `area:<nome>` evitam duas tarefas mexendo na mesma parte do
  código ao mesmo tempo. `depende de #N` na issue espera a outra terminar, ou constrói em cima dela.
- **Painel web** com tarefas, salas (CPU/memória), logs sanitizados, eventos, botão "tentar
  novamente", pedido de ajuste num PR, prévia do app para testar antes do merge e avisos no celular
  (Web Push, opcional).
- **Vários projetos.** Adicione repositórios pela aba **Projetos** do painel. Cada um tem estado,
  imagens e salas separados, e as vagas são divididas entre eles.

## Requisitos

| | Mínimo | Observação |
|---|---|---|
| Sistema | Linux (Ubuntu 22.04+, Debian 12+) ou **Windows 10/11 com WSL2** | macOS: experimental |
| Docker | Docker Engine 24+ ou Docker Desktop | no Windows, Docker Desktop com integração WSL |
| Node.js | 22 ou mais novo | dentro do Linux/WSL |
| Memória | 8 GB livres para 1 sala; 16 GB para 3 salas | cada sala usa até 4 GiB e 2 CPUs |
| Disco | 30 GB livres | imagens das salas e cópias dos testes |
| Agentes | Assinatura do **Claude** (Pro/Max) e/ou do **ChatGPT** (Plus/Pro), ou chaves de API | basta um dos dois |
| GitHub | Um token *fine-grained* com acesso aos repositórios | veja o passo a passo |

## Começo rápido

O passo a passo completo, do zero, está em **[docs/INSTALACAO.md](docs/INSTALACAO.md)**.
Resumo para quem já tem Docker e Node:

```bash
git clone https://github.com/<voce>/laboratorio-agentes.git ~/laboratorio-agentes
cd ~/laboratorio-agentes
./scripts/instalar.sh            # confere tudo, cria os arquivos locais e roda os testes
nano secrets/github-controller.env   # cole o token do GitHub em GH_TOKEN=
./scripts/install-user-service.sh --ativar   # liga painel e orquestrador (systemd)
```

Abra **http://127.0.0.1:7788**, vá na aba **Projetos** e adicione o seu repositório. O laboratório
confere o acesso e cria as etiquetas. Se o repositório ainda não tem `.laboratorio.json`, clique em
**Gerar configuração**: o laboratório abre uma issue para o Codex escrever esse arquivo. Revise e faça
o merge do PR. O laboratório constrói a imagem do projeto e passa a atender as issues.

## Como usar no dia a dia

1. Crie uma issue descrevendo o que quer, com critérios de aceitação claros.
2. Coloque a etiqueta do agente: `claude`, `codex` ou as duas.
3. Coloque uma ou mais etiquetas de área, como `area:frontend` ou `area:api`. Issues da mesma área
   nunca rodam ao mesmo tempo. Sem área, a issue usa `area:geral`.
4. Para encadear tarefas, escreva `depende de #12` no corpo. A issue espera a #12 ser concluída, ou
   é construída em cima da etapa já verificada.
5. Acompanhe pelo painel. Quando o PR aparecer com a etiqueta `pronto-para-revisao`, revise e faça o merge.

| Etiqueta | Quem coloca | Significado |
|---|---|---|
| `claude` / `codex` | você | qual agente faz a tarefa |
| `area:<nome>` | você | parte do código; trava outras issues da mesma área |
| `em-andamento` | laboratório | uma sala está trabalhando nela |
| `pronto-para-revisao` | laboratório | PR aberto esperando você |
| `bloqueado` | laboratório | parou depois de várias falhas; **tire a etiqueta** para tentar de novo |

O agente só entrega quando declara `STATUS: COMPLETO` e a verificação passa. Solução parcial não vira
PR: o trabalho fica guardado e a próxima tentativa continua de onde parou.

## Configuração de cada projeto: `.laboratorio.json`

Fica na raiz do **seu** repositório e diz ao laboratório como instalar e testar o projeto. O próprio
laboratório pede ao agente que o escreva na primeira vez. Exemplo para um app Node:

```json
{
  "dependencias": ["package-lock.json"],
  "instalar": ["npm ci"],
  "verificar": [["npm run lint", "npm test", "npm run build"]],
  "leia": ["AGENTS.md", "README.md"],
  "proibido": { "dominios": ["meusite.com.br"], "portas": [], "pastas": [], "texto": "nunca use dados reais" },
  "imagensDeTeste": ["postgres:16"],
  "dominiosExtras": [],
  "previa": { "porta": 5173, "passos": [{ "rodar": "npm run dev -- --host 0.0.0.0", "esperar": "http://127.0.0.1:5173/" }], "logins": "" }
}
```

Referência de todos os campos: [docs/CONFIGURACAO.md](docs/CONFIGURACAO.md).

## Segurança, em resumo

- Os agentes rodam com permissões amplas (`--dangerously-skip-permissions`), mas **dentro da sala**:
  sem o token do GitHub, sem o Docker da máquina e com internet só pelos domínios liberados em
  [proxy/allowed-domains.txt](proxy/allowed-domains.txt).
- Domínios de produção listados em `proibido.dominios` (ou em `rooms.deniedDomains`) são **negados
  antes** de qualquer liberação no proxy.
- O login das CLIs é **copiado** para a sala, nunca montado. Logs passam por um filtro que remove
  tokens antes de ir para o painel, para comentários ou para o PR.
- O merge é sempre humano. O laboratório não altera `.github/workflows`.
- O painel não tem senha e escuta só em `127.0.0.1`. Para abrir no celular, use uma VPN como o
  Tailscale (veja [docs/INSTALACAO.md](docs/INSTALACAO.md#painel-no-celular-opcional)).

Detalhes e como relatar problemas: [SECURITY.md](SECURITY.md).

## Estrutura

```
orchestrator/        controlador e painel (Node.js puro, sem npm install)
  src/main.mjs         laço principal do orquestrador
  src/dashboard.mjs    painel web (127.0.0.1:7788)
  config.example.json  configuração padrão (copiada para config.json, fora do Git)
  test/                testes (npm test)
scripts/             instalação, salas (create/destroy/inspect), imagens, prévia, serviços
images/              Dockerfiles das salas (base do projeto + Claude Code / Codex)
proxy/               proxy de saída (Squid) e lista de domínios liberados
systemd/             modelos dos serviços do usuário
secrets/             SÓ modelos *.example; os arquivos reais ficam fora do Git
docs/                instalação, configuração e decisões
```

## Para agentes de IA

Se você é um agente (Claude Code, Codex etc.) e vai instalar ou adaptar este repositório para alguém,
leia primeiro **[AGENTS.md](AGENTS.md)**.

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| `bash\r: No such file` ou `$'\r': command not found` | O clone foi feito no Windows. Clone **dentro do WSL** (`cd ~ && git clone ...`). |
| `permission denied ... docker.sock` | Linux: `sudo usermod -aG docker $USER` e entre de novo. WSL: abra o Docker Desktop e ative a integração com a distribuição. |
| Painel não abre no Windows | Use `http://127.0.0.1:7788`, não `localhost`. |
| Projeto fica "sem acesso" | O token não inclui o repositório ou falta permissão de escrita em Contents, Issues ou Pull requests. |
| `imagem sala-... ausente` | O projeto ainda não terminou de construir as imagens. Veja a aba Projetos. |
| Tarefa "bloqueada" | Abra o painel, leia o motivo, ajuste a issue e **tire a etiqueta `bloqueado`**. |

Mais diagnósticos em [docs/INSTALACAO.md](docs/INSTALACAO.md#resolvendo-problemas).

## Testes

```bash
cd orchestrator && npm test                                   # unidade e integração local (~10 s)
LAB_DOCKER_TEST=1 node --test test/docker-integration.test.mjs  # salas reais com agente falso (~3 min)
```

## Licença

[MIT](LICENSE).
