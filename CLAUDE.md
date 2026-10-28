Leia e siga [AGENTS.md](AGENTS.md): ele vale para qualquer agente que instale, adapte ou modifique este repositório.

Resumo do essencial:

- Testes: `cd orchestrator && npm test` (Node 22+, sem `npm install`). Precisam passar antes e depois de qualquer mudança.
- Nunca leia, imprima ou faça commit de `secrets/*.env`, `local.env` ou arquivos de login das CLIs.
- Não enfraqueça o isolamento das salas (socket Docker, token nas salas, proxy liberado).
- Confirme com a pessoa antes de qualquer ação fora da pasta do laboratório.
