# Instalação passo a passo

Este guia leva do zero até o primeiro PR feito por um agente. Leva de 30 a 60 minutos, a maior parte
esperando downloads. Escolha o seu sistema:

- [Windows 10/11 (com WSL2)](#windows-1011) — o caminho mais comum
- [Linux (Ubuntu/Debian)](#linux-ubuntudebian)
- [macOS (experimental)](#macos-experimental)

Depois, todos seguem a parte comum: [Login dos agentes](#2-login-dos-agentes), [Token do GitHub](#3-token-do-github),
[Instalar o laboratório](#4-instalar-o-laboratório) e [Primeiro projeto](#5-primeiro-projeto).

---

## 1. Preparar o sistema

### Windows 10/11

O laboratório roda dentro do Linux do Windows (WSL2), com o Docker Desktop.

1. **Instale o WSL2 com Ubuntu.** Abra o PowerShell **como administrador** e rode:

   ```powershell
   wsl --install -d Ubuntu
   ```

   Reinicie o PC quando pedir. Na primeira abertura do Ubuntu, crie um usuário e uma senha do Linux.

2. **Ative o systemd no Ubuntu** (para os serviços ligarem sozinhos). No terminal do Ubuntu:

   ```bash
   printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf
   ```

   Depois, no PowerShell: `wsl --shutdown` e abra o Ubuntu de novo.

3. **Dê memória suficiente ao WSL.** Crie o arquivo `C:\Users\<seu-usuario>\.wslconfig` com:

   ```ini
   [wsl2]
   memory=12GB
   processors=6
   ```

   Use cerca de 4 GB por sala que quiser rodar ao mesmo tempo, mais 4 GB de folga. Rode `wsl --shutdown` para aplicar.

4. **Instale o Docker Desktop** (https://www.docker.com/products/docker-desktop/). Em
   *Settings → Resources → WSL integration*, ative a distribuição **Ubuntu**. Deixe o Docker Desktop
   abrindo junto com o Windows (*Settings → General → Start Docker Desktop when you sign in*).

5. **Confira no Ubuntu:**

   ```bash
   docker run --rm hello-world
   ```

6. Siga para [Node.js](#nodejs-todos-os-sistemas).

> **Importante:** trabalhe sempre **dentro do Ubuntu** (`~`), nunca em `/mnt/c/...`. Clonar o
> repositório pelo Windows quebra os scripts (finais de linha) e as permissões dos segredos.

### Linux (Ubuntu/Debian)

1. **Docker Engine** (guia oficial: https://docs.docker.com/engine/install/):

   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker "$USER"
   ```

   Saia e entre de novo na sessão (ou reinicie) para o grupo `docker` valer. Confira com `docker run --rm hello-world`.

2. **Git:** `sudo apt-get update && sudo apt-get install -y git`

3. Siga para [Node.js](#nodejs-todos-os-sistemas).

### macOS (experimental)

Funciona com Docker Desktop, mas não é testado com frequência.

1. Instale o Docker Desktop e o Homebrew (https://brew.sh).
2. `brew install bash git node` (o bash do macOS é antigo demais; os scripts precisam do bash 4.4+).
3. O Claude Code no macOS guarda o login no Keychain, não num arquivo. Use a
   [chave de API](#alternativa-chaves-de-api) para o Claude, ou rode o login dentro de um Linux.
4. Não há systemd: rode o painel e o orquestrador à mão (veja o passo 4).

### Node.js (todos os sistemas)

O laboratório precisa do Node 22 ou mais novo **dentro do Linux/WSL**. O jeito mais simples é o nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 24
node -v   # deve mostrar v24.x
```

---

## 2. Login dos agentes

Você precisa de **pelo menos um** dos dois agentes. O laboratório usa a sua assinatura pelo login da
CLI (o mesmo que você usa no terminal). Instale e faça login **uma vez** no Linux/WSL:

```bash
npm install -g @anthropic-ai/claude-code @openai/codex

claude          # abre o login do Claude Code no navegador; depois digite /exit
codex login     # login do Codex com a conta do ChatGPT
```

Isso cria `~/.claude/.credentials.json` e `~/.codex/auth.json`. O instalador acha esses arquivos
sozinho. No Windows, se você já fez login nas CLIs **pelo Windows**, ele também procura em
`/mnt/c/Users/<usuario>/`.

> Cada sala usa a sua cota normal da assinatura. Quando a cota acaba, o laboratório pausa só aquele
> agente e retoma sozinho no horário de renovação.

### Alternativa: chaves de API

Se preferir pagar por uso, sem assinatura:

```bash
cp secrets/claude.env.example secrets/claude.env   # ANTHROPIC_API_KEY=...
cp secrets/codex.env.example secrets/codex.env     # CODEX_API_KEY=...
chmod 600 secrets/*.env
```

A chave só é usada quando não há login da CLI configurado para aquele agente. Use chaves só do
laboratório, com limite de gasto.

### Várias contas do mesmo agente (opcional)

Para dividir o trabalho entre duas assinaturas, aponte as variáveis com sufixo `_2` a `_9` no
`local.env` para os arquivos de login da outra conta. Exemplo: `LAB_CLAUDE_CREDENTIALS_FILE_2=/caminho/.credentials.json`.

---

## 3. Token do GitHub

O controlador usa **um** token para ler issues, fazer push das branches e abrir PRs. Os agentes nunca o recebem.

1. Abra https://github.com/settings/personal-access-tokens/new (token *fine-grained*).
2. **Token name:** `agentes`. **Expiration:** a que preferir (anote para renovar).
3. **Resource owner:** você (ou a organização dona dos repositórios).
4. **Repository access:** *Only select repositories* → escolha os repositórios que o laboratório vai atender.
5. **Permissions → Repository permissions:**
   - **Contents:** Read and write
   - **Issues:** Read and write
   - **Pull requests:** Read and write
   - **Metadata:** Read-only (já vem marcado)
6. Clique em **Generate token** e copie o valor (`github_pat_...`).

Você vai colar esse valor no passo seguinte. Para atender um repositório novo depois, edite o token
e inclua o repositório. Não é preciso trocar o token.

> O repositório precisa ter **pelo menos um commit** (ex.: um README) e **Issues ativadas**.

---

## 4. Instalar o laboratório

```bash
cd ~
git clone https://github.com/RafaelGoulartP/agentes.git
cd agentes
./scripts/instalar.sh
```

O instalador:

- confere sistema, bash, git, Node e Docker, e diz exatamente o que falta;
- cria `orchestrator/config.json`, `local.env` (com os logins encontrados) e `secrets/github-controller.env`;
- roda os testes do laboratório (uns 10 segundos);
- constrói a imagem do proxy de saída.

Ele nunca apaga nem sobrescreve arquivos que já existem. Pode rodar de novo quantas vezes quiser.

**Cole o token:**

```bash
nano secrets/github-controller.env    # deixe a linha assim: GH_TOKEN=github_pat_...
```

Confira o token num repositório (só leitura, não altera nada):

```bash
cd orchestrator && node src/check-access.mjs <dono>/<repositorio> && cd ..
```

**Ligue o painel e o orquestrador:**

```bash
./scripts/install-user-service.sh --ativar
```

Isso instala dois serviços do usuário (`laboratorio-painel` e `laboratorio-orquestrador`). Eles
ligam com o computador. Sem systemd (macOS, ou WSL sem systemd), rode em dois terminais:

```bash
./scripts/run-dashboard.sh
./scripts/run-orchestrator.sh
```

---

## 5. Primeiro projeto

1. Abra **http://127.0.0.1:7788** (no Windows, use `127.0.0.1`, não `localhost`).
2. Na aba **Projetos**, cole a URL do repositório (ex.: `https://github.com/voce/meu-app`) e clique
   em **Adicionar**. O laboratório confere o acesso e cria as etiquetas (`claude`, `codex`,
   `em-andamento`, `bloqueado`, `pronto-para-revisao`).
3. Se o repositório ainda não tem `.laboratorio.json`, clique em **Gerar configuração**. O laboratório
   abre uma issue "Configurar o laboratório de agentes" e um agente escreve o arquivo para o seu
   projeto. Revise o PR (confira principalmente `instalar` e `verificar`) e faça o merge.
   Se preferir, escreva o arquivo você mesmo (veja [CONFIGURACAO.md](CONFIGURACAO.md)).
4. O laboratório constrói a imagem do projeto (a primeira vez pode levar de 5 a 20 minutos) e o card
   fica **pronto**.
5. Crie uma issue de teste pequena, por exemplo: *"Adicionar uma seção 'Como rodar' ao README"*,
   com as etiquetas `claude` e `area:docs`.
6. Acompanhe na aba **Agora**. Em alguns minutos aparece o PR com a etiqueta `pronto-para-revisao`.

Para os agentes acertarem mais, prepare o repositório com um `AGENTS.md` e issues bem escritas:
veja **[PREPARAR-PROJETO.md](PREPARAR-PROJETO.md)**.

---

## Painel no celular (opcional)

O painel não tem senha e escuta só em `127.0.0.1`. Para abrir no celular sem expor na internet, use
o [Tailscale](https://tailscale.com) (VPN gratuita para uso pessoal):

- **Linux:** instale o Tailscale e rode `sudo tailscale serve --bg http://127.0.0.1:7788`. O painel
  fica em `https://<sua-maquina>.<tailnet>.ts.net`, visível só para os seus aparelhos.
- **Windows + WSL:** instale o Tailscale no Windows. No PowerShell **como administrador**, encaminhe
  a porta para o WSL e libere só a rede do Tailscale:

  ```powershell
  netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=7789 connectaddress=127.0.0.1 connectport=7788
  New-NetFirewallRule -DisplayName "Painel dos Agentes (Tailscale)" -Direction Inbound -Protocol TCP -LocalPort 7789 -Action Allow -RemoteAddress 100.64.0.0/10
  tailscale serve --bg http://127.0.0.1:7789
  ```

  O botão **Celular** do painel mostra os endereços. Pelo endereço `https://` o celular instala o
  painel como app e recebe avisos (Web Push).

---

## Atualizar

```bash
cd ~/agentes
git pull
./scripts/instalar.sh              # confere e roda os testes de novo
systemctl --user restart laboratorio-painel laboratorio-orquestrador
```

Os seus arquivos locais (`config.json`, `local.env`, `secrets/`, estado e execuções) não são versionados
e não são tocados pelo `git pull`.

## Desinstalar

```bash
systemctl --user disable --now laboratorio-painel laboratorio-orquestrador
rm ~/.config/systemd/user/laboratorio-{painel,orquestrador}.service
docker ps -aq --filter label=lab.room | xargs -r docker rm -f -v
docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^(sala-|laboratorio-proxy)' | xargs -r docker rmi
rm -rf ~/agentes
```

Revogue também o token em https://github.com/settings/personal-access-tokens.

---

## Resolvendo problemas

**Ver o que está acontecendo:**

```bash
systemctl --user status laboratorio-orquestrador
journalctl --user -u laboratorio-orquestrador -n 100 --no-pager
tail -n 50 logs/orchestrator.jsonl          # eventos do controlador, um JSON por linha
docker ps --filter label=lab.room           # salas abertas agora
```

| Sintoma | Causa provável e solução |
|---|---|
| `$'\r': command not found` | Repositório clonado pelo Windows. Apague e clone dentro do WSL (`cd ~`). |
| `permission denied while trying to connect to the Docker daemon` | Linux: usuário fora do grupo `docker` (`sudo usermod -aG docker $USER`, depois saia e entre). WSL: Docker Desktop fechado ou sem integração com o Ubuntu. |
| Orquestrador reinicia em laço com "token do controlador ausente" | Crie `secrets/github-controller.env` com `GH_TOKEN=...` (`./scripts/instalar.sh` cria o modelo). |
| Projeto "sem acesso" | O token não inclui o repositório, ou falta escrita em Contents, Issues ou Pull requests. Edite o token e clique em **Verificar de novo**. |
| Projeto "erro: crie o repositório com um README" | O repositório está vazio. Faça um primeiro commit. |
| Issue não começa nunca | Veja a aba **Tarefas**: o painel diz o motivo (área ocupada, dependência, cota, sem vaga...). Confira se a issue tem a etiqueta `claude` ou `codex` e se esse agente tem login (`local.env`). |
| `login do Claude Code nao encontrado` | `LAB_CLAUDE_CREDENTIALS_FILE` no `local.env` não aponta para um arquivo existente. Rode `claude` para fazer login, ou use `secrets/claude.env`. |
| Faixa vermelha "salas novas em pausa" | O painel mostra o motivo: sem internet, provedor fora, pouco disco (< 15 GB) ou várias falhas seguidas. Volta sozinho. |
| Verificação falha sempre no mesmo comando | O comando em `verificar` do `.laboratorio.json` não passa nem na `main`. Corrija na `main` primeiro. |
| Painel não abre | `systemctl --user status laboratorio-painel`. No Windows use `http://127.0.0.1:7788`. Outra porta: `LAB_PAINEL_PORT=7790`. |
| Sala ficou para trás depois de uma queda | `./scripts/destroy-room.sh <codex\|claude> <id>`; o controlador também limpa sozinho ao reiniciar. |

**Teste de fumaça de uma sala** (isolamento de rede, ferramentas e login, sem GitHub):

```bash
LAB_PROJECT_ID=<id-do-projeto> LAB_USE_CLI_AUTH=1 ./scripts/test-room.sh claude
```
