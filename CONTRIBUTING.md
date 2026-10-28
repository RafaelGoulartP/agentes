# Como contribuir

Obrigado pelo interesse! Issues e pull requests são bem-vindos, em português ou inglês.

## Antes de começar

- Para mudanças grandes, abra uma issue primeiro descrevendo o problema e a ideia.
- Leia o [AGENTS.md](AGENTS.md) (vale também para pessoas): princípios de segurança, mapa do código e
  o que nunca fazer.

## Ambiente

```bash
git clone https://github.com/<voce>/laboratorio-agentes.git
cd laboratorio-agentes/orchestrator
npm test        # Node 22+, sem npm install
```

Os testes rodam em segundos, sem Docker, GitHub ou agentes reais. O teste com salas reais é opcional:

```bash
LAB_PROJECT_ID=principal PROJECT_ROOT=<algum-repo-local> ../scripts/build-images.sh
LAB_DOCKER_TEST=1 node --test test/docker-integration.test.mjs
```

## Regras do código

- Node.js puro (ESM), **sem dependências npm**.
- Toda mudança de comportamento vem com teste em `orchestrator/test/`.
- Comentários curtos explicando o **porquê**; mensagens para o usuário em português.
- Shell: `set -Eeuo pipefail`, variáveis entre aspas, `bash -n` sem erros.
- Não enfraqueça o isolamento das salas nem a remoção de segredos dos logs.

## Pull requests

- Um assunto por PR, com descrição do problema, da solução e de como foi testado.
- `npm test` passando (o CI roda em todo PR).
- Atualize a documentação (`README.md`, `docs/`) quando mudar comportamento ou configuração.
