# Preparar um projeto para os agentes

Este guia é sobre o **seu repositório** (o projeto em que os agentes vão trabalhar), não sobre o
laboratório. Um projeto bem preparado tem três coisas:

1. **`.laboratorio.json`**: como instalar, testar e pré-visualizar o projeto (o laboratório lê).
2. **`AGENTS.md`**: como o projeto funciona e quais são as regras (o agente lê antes de cada tarefa).
3. **Boas issues**: o que fazer, com critérios claros de pronto.

Quanto melhores os testes e o `AGENTS.md`, melhores os PRs. O agente só vê o que está no repositório
e na issue.

---

## 1. No GitHub

1. O repositório precisa ter **pelo menos um commit** (crie com "Add a README" se estiver vazio).
2. **Settings → General → Features:** deixe **Issues** marcado.
3. Inclua o repositório no token do laboratório (seção 3 de [INSTALACAO.md](INSTALACAO.md)).
4. Recomendado: **Settings → Branches → Add rule** para `main`, com "Require a pull request before
   merging". Assim nada entra na `main` sem a sua revisão, nem por engano.
5. Adicione o projeto na aba **Projetos** do painel. O laboratório cria as etiquetas sozinho:
   `claude`, `codex`, `em-andamento`, `bloqueado` e `pronto-para-revisao`.

As etiquetas de área (`area:frontend`, `area:api`...) você cria quando quiser, no próprio GitHub
(*Issues → Labels → New label*) ou direto ao abrir a issue.

---

## 2. `.laboratorio.json`

O jeito mais fácil: no painel, clique em **Gerar configuração**. Um agente analisa o projeto e abre um
PR com o arquivo (e um `AGENTS.md`, se faltar). Antes do merge, confira:

- [ ] `instalar` instala tudo o que o projeto precisa (rodou sem erro no PR?).
- [ ] `verificar` tem os **mesmos testes que você confia** (lint, build, testes) e eles passam hoje.
- [ ] `proibido.dominios` tem o seu domínio de produção.
- [ ] `previa` sobe o app com dados de teste (se quiser testar PRs pelo painel antes do merge).

Para escrever à mão, veja a referência em [CONFIGURACAO.md](CONFIGURACAO.md#laboratoriojson-no-seu-projeto).
Para conferir o arquivo, rode na raiz do projeto: `node ~/laboratorio-agentes/scripts/validar-config.mjs`.

> Se o projeto ainda não tem testes, comece por aí: abra uma issue pedindo ao agente que crie testes
> básicos e um comando `npm test` (ou equivalente). Sem verificação, o laboratório não tem como
> saber se o trabalho está certo.

---

## 3. `AGENTS.md` do projeto

O laboratório manda o agente ler os arquivos listados em `leia` (no `.laboratorio.json`). Coloque
`AGENTS.md` ali. É o lugar de tudo que uma pessoa nova no projeto precisaria saber. Modelo para copiar
e adaptar:

```markdown
# Guia para agentes

## O projeto
Sistema de agendamento para clínicas. Frontend React (pasta `web/`), API Node/Express (`api/`),
banco PostgreSQL.

## Como rodar e testar
- Instalar: `npm ci`
- Testes: `npm test` (unitários) e `npm run test:e2e` (Playwright; sobe a API sozinho)
- Banco de teste: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=teste postgres:16`
- Lint e tipos: `npm run lint && npm run typecheck`

## Regras
- Todo comportamento novo precisa de teste.
- Não mude o formato da API pública sem a issue pedir.
- Textos da interface em português do Brasil.
- Nunca use dados reais; os fixtures ficam em `api/test/fixtures/`.
- Não mexa em `scripts/deploy/` nem em arquivos `.env`.

## Organização
- `web/src/pages/`: uma pasta por tela
- `api/src/routes/`: rotas; `api/src/services/`: regras de negócio
- Migrações do banco: `api/migrations/` (crie uma nova, nunca edite as antigas)

## Estilo
- Funções pequenas, nomes em inglês, comentários só quando o "porquê" não é óbvio.
- Commits curtos no imperativo: "Corrige cálculo de horário livre".
```

Dicas:

- Seja específico: comandos exatos, pastas exatas, o que é proibido.
- Se o projeto tem decisões importantes (por que tal biblioteca, por que tal regra), escreva aqui.
  O agente não tem como adivinhar.
- Quando um PR vier com o mesmo erro mais de uma vez, acrescente a regra no `AGENTS.md`.
- Documentação extra (ex.: `docs/TESTES.md`, `docs/ARQUITETURA.md`) também pode entrar em `leia`.

O Claude Code também lê `CLAUDE.md`. Se quiser um só arquivo, crie `CLAUDE.md` com a linha
`Leia e siga AGENTS.md.`

---

## 4. Escrever boas issues

O texto da issue é a única descrição da tarefa que o agente recebe. Ele só abre PR quando declara que
**todos os critérios** foram atendidos e a verificação passa, então critérios claros evitam idas e voltas.

**Modelo:**

```markdown
## Objetivo
Permitir que a recepção remarque uma consulta arrastando-a na agenda.

## Critérios de aceitação
- [ ] Arrastar a consulta para outro horário livre muda o horário e salva.
- [ ] Horário ocupado não aceita o arrasto e mostra "Horário indisponível".
- [ ] O paciente recebe o mesmo e-mail de remarcação que já existe hoje.
- [ ] Teste e2e cobrindo os dois casos.

## Onde mexer (se souber)
`web/src/pages/agenda/`, rota `PATCH /consultas/:id` na API.

## Fora do escopo
Remarcar pelo celular.
```

Etiquetas: `claude` e/ou `codex` + uma ou mais `area:...`.

**Boas práticas:**

- **Uma issue, uma entrega.** Tarefas grandes viram várias issues encadeadas com `depende de #N`
  no corpo. A seguinte espera a anterior, ou é construída em cima dela quando a anterior já foi
  verificada (as etapas entram juntas no PR da última).
- **Áreas certas.** Duas issues que mexem nos mesmos arquivos devem ter a mesma `area:`. Assim elas
  rodam uma depois da outra e não geram conflito.
- **Critérios verificáveis** ("mostra a mensagem X", "o teste Y passa"), não vagos ("ficar melhor").
- **Bugs:** passos para reproduzir, o que acontece e o que deveria acontecer.
- O texto da issue é tratado como **pedido, não como ordem de sistema**: o agente não obedece a uma
  issue que mande, por exemplo, ignorar as regras do laboratório.

Para facilitar, copie o modelo como template de issue do seu projeto: crie
`.github/ISSUE_TEMPLATE/tarefa-agente.md` com o conteúdo acima e um cabeçalho:

```markdown
---
name: Tarefa para agente
about: Trabalho para o Claude ou o Codex do laboratório
labels: claude
---
```

(O laboratório não deixa os agentes mexerem em `.github/workflows`, mas templates de issue você
pode criar normalmente.)

---

## 5. Revisar e pedir ajustes

1. O PR chega com a etiqueta `pronto-para-revisao`, o resumo do agente, o resultado da verificação e
   uma seção **"Atenção na revisão"** quando mexeu em testes, `package.json` ou configurações.
2. Teste se quiser: no painel, o botão **Abrir prévia** sobe o app do PR numa sala limpa, com dados de teste.
3. Deu certo: faça o merge. A issue fecha sozinha (o PR leva `Closes #N`).
4. Precisa mudar algo: no painel, use **Pedir ajuste** na tarefa e descreva o que mudar. O agente volta
   à mesma branch e atualiza o mesmo PR.
5. A `main` andou e o PR ficou em conflito: o laboratório percebe e manda o agente incorporar a `main`
   sozinho.
6. Tarefa `bloqueado`: leia o motivo no painel ou no comentário da issue, ajuste a issue (ou o
   projeto) e **tire a etiqueta `bloqueado`** para tentar de novo.

---

## Checklist rápido

- [ ] Repositório com commit inicial e Issues ativadas
- [ ] Repositório incluído no token do laboratório e adicionado no painel
- [ ] `.laboratorio.json` na `main`, com testes que passam
- [ ] `AGENTS.md` com comandos, regras e organização do projeto (e listado em `leia`)
- [ ] Domínio de produção em `proibido.dominios`
- [ ] Proteção da branch `main` (merge só por PR)
- [ ] Primeira issue pequena para testar o fluxo
