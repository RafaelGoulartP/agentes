# Segurança

## Modelo de ameaça

O laboratório assume que **o agente e o conteúdo das issues não são confiáveis**: um agente pode errar,
ser induzido por um texto malicioso numa issue (prompt injection) ou executar código hostil vindo de
uma dependência. As proteções existem para limitar o estrago a uma sala descartável.

| Proteção | Como |
|---|---|
| Sem credenciais do GitHub na sala | O código entra e sai como `git bundle`; só o controlador, no host, tem o token e faz push. |
| Sem push forçado | O controlador só faz `git push` comum e confere que os commits descendem do ponto de partida. |
| Rede controlada | Rede interna sem rota direta; saída só por um proxy Squid com lista de domínios. Domínios proibidos são negados antes de qualquer liberação. |
| Sem Docker do host | Cada sala tem o próprio Docker-in-Docker. O socket do host nunca é montado. |
| Limites de recursos | Memória, CPU e processos limitados por contêiner; tempo máximo e tempo ocioso por tarefa. |
| Verificação independente | O resultado roda de novo numa sala limpa, sem credenciais, com comandos da branch principal (não do PR). |
| Logs sanitizados | Tokens conhecidos (GitHub, Anthropic, OpenAI, chaves privadas) são removidos antes de logs, comentários e PRs. |
| Workflows protegidos | Mudanças em `.github/workflows` bloqueiam a entrega. |
| Revisão humana | O laboratório nunca faz merge. |

## Limites conhecidos

- O agente recebe **o login da CLI** (Claude/Codex) dentro da sala, porque precisa dele para
  trabalhar. Um agente comprometido pode usar a sua cota enquanto a sala existir. Prefira contas ou
  chaves dedicadas ao laboratório, com limite de gasto.
- O sidecar Docker-in-Docker roda com `--privileged` (necessário para criar contêineres). Ele não tem
  o socket do host, mas o isolamento final é o do Docker/kernel da sua máquina.
- O agente tem `sudo` **dentro** da sala, para instalar ferramentas.
- O painel não tem autenticação e escuta só em `127.0.0.1`. Ele confere o cabeçalho `Host` (contra
  DNS rebinding) e exige um cabeçalho próprio nas ações. Não o exponha na internet; use uma VPN.
- Os domínios liberados por padrão incluem GitHub, npm, PyPI e Docker Hub. Um agente consegue, em
  tese, enviar dados para um repositório público nesses serviços. Não use o laboratório com código que
  não pode sair da sua máquina sem revisar `proxy/allowed-domains.txt`.

## Boas práticas

- Use um token *fine-grained* só com os repositórios necessários, com validade definida.
- Nunca coloque segredos de produção no repositório do projeto nem no `.laboratorio.json`.
- Liste o seu domínio de produção em `proibido.dominios` ou em `rooms.deniedDomains`.
- Revise todo PR antes do merge, principalmente mudanças em scripts de teste, `package.json` e
  configurações (o PR já destaca esses arquivos).

## Relatar uma vulnerabilidade

Não abra issue pública. Use **Security → Report a vulnerability** (aviso privado do GitHub) neste
repositório, com os passos para reproduzir. A resposta inicial vem em até 7 dias.
