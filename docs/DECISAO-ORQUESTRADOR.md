# Decisão do orquestrador

Data da pesquisa: 2026-10-16.

## Opções avaliadas

| Opção | Pontos fortes | Incompatibilidade com este laboratório |
|---|---|---|
| GitHub Agentic Workflows (`gh-aw`) | Claude e Codex, sandbox e saídas GitHub controladas | Compila para GitHub Actions; não controla nossas salas no WSL nem o serviço systemd local |
| OpenHands Agent Canvas | Self-hosted, automações e vários agentes/backends | Plataforma muito maior, duplica o sandbox e não entrega diretamente as regras de dependência/área exigidas |
| SWE-agent | Recebe URL de issue e pode abrir PR | É outro agente/runtime; não é um escalonador para Claude Code e Codex CLI nem cobre retomada e exclusão por área |

## Decisão

Escrever um controlador local pequeno e portátil, sem dependências npm, usando a API REST do GitHub e
as salas já validadas. Reaproveitamos os padrões úteis das opções estudadas: entradas não confiáveis,
permissões mínimas, isolamento por tarefa, estado persistente e revisão humana obrigatória.

O controlador fica desligado por padrão (`enabled: false`). Nenhum webhook, label, token ou serviço foi
ativado nesta etapa.
