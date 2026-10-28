# Créditos e componentes de terceiros

O código deste repositório foi escrito para este projeto; nenhum código de outro repositório foi
copiado para cá. Mas ele só existe graças a ferramentas e ideias de muita gente. Obrigado!

## Ideias e inspiração

Antes de escrever o orquestrador, estudamos estes projetos (veja
[DECISAO-ORQUESTRADOR.md](DECISAO-ORQUESTRADOR.md)). Não usamos o código deles, mas reaproveitamos
padrões que eles mostraram funcionar: tratar entradas como não confiáveis, permissões mínimas,
isolamento por tarefa, estado persistente e revisão humana obrigatória.

| Projeto | De quem | O que aprendemos |
|---|---|---|
| [GitHub Agentic Workflows (gh-aw)](https://github.com/github/gh-aw) | GitHub | saídas controladas e sandbox para agentes no GitHub |
| [OpenHands](https://github.com/OpenHands/OpenHands) | OpenHands | agentes self-hosted em ambientes isolados |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent) | Princeton / Stanford | de uma issue a um PR com agente |

## O que o laboratório usa (instalado, não incluído)

Nenhum destes é distribuído dentro deste repositório: são baixados na sua máquina ou dentro das
imagens Docker no momento da instalação, cada um com a sua licença.

| Componente | Para quê | Licença |
|---|---|---|
| [Claude Code](https://github.com/anthropics/claude-code) (Anthropic) | agente nas salas | proprietária; uso sujeito aos termos da Anthropic |
| [Codex CLI](https://github.com/openai/codex) (OpenAI) | agente nas salas | Apache-2.0 |
| [Node.js](https://nodejs.org) | orquestrador, painel e imagem das salas (`node:24-bookworm`) | MIT |
| [Docker](https://www.docker.com) / [Moby](https://github.com/moby/moby) | salas, Docker-in-Docker (`docker:dind`) | Apache-2.0 |
| [Squid](https://www.squid-cache.org) | proxy de saída das salas | GPL-2.0-or-later |
| [Debian](https://www.debian.org) | base das imagens | várias (livres) |
| [GitHub CLI](https://github.com/cli/cli) | ferramenta dentro das salas | MIT |
| [dumb-init](https://github.com/Yelp/dumb-init) | processo inicial das salas | MIT |
| [ripgrep](https://github.com/BurntSushi/ripgrep), [jq](https://github.com/jqlang/jq), [tmux](https://github.com/tmux/tmux) | ferramentas dentro das salas | MIT/Unlicense, MIT, ISC |
| [Playwright](https://github.com/microsoft/playwright) | testes de navegador dos projetos (opcional) e imagens desta documentação | Apache-2.0 |
| [gitleaks](https://github.com/gitleaks/gitleaks) | varredura de segredos no CI | MIT |
| [nvm](https://github.com/nvm-sh/nvm) | instalação do Node sugerida na documentação | MIT |
| [Tailscale](https://tailscale.com) | acesso opcional ao painel pelo celular | BSD-3-Clause (cliente) |
| [Shields.io](https://shields.io) | selos do README | CC0 |

## Ícones do painel

Os ícones do painel são SVGs simples escritos no próprio `index.html`, no estilo dos
[Feather Icons](https://github.com/feathericons/feather) (MIT) e do [Lucide](https://github.com/lucide-icons/lucide)
(ISC). Alguns têm o mesmo desenho desses projetos. Obrigado aos dois.

## Feito com IA

Boa parte do código, dos testes e da documentação foi escrita com o **Claude Code** (Anthropic) e o
**Codex** (OpenAI), com direção e revisão humanas.

## Marcas

Claude e Claude Code são marcas da Anthropic. Codex, ChatGPT e OpenAI são marcas da OpenAI. GitHub é
marca da GitHub, Inc. Docker é marca da Docker, Inc. Este projeto é independente e não tem vínculo
com essas empresas.

---

Esqueceu de alguém? Abra uma issue ou um PR: queremos dar o crédito certo.
