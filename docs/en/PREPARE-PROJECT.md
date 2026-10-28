# Preparing a project for the agents

This guide is about **your repository** (the project the agents will work on), not about the lab. A
well-prepared project has three things:

1. **`.laboratorio.json`**: how to install, test and preview the project (read by the lab).
2. **`AGENTS.md`**: how the project works and what the rules are (read by the agent before every task).
3. **Good issues**: what to do, with clear criteria for "done".

The better the tests and the `AGENTS.md`, the better the PRs. The agent only sees what is in the
repository and in the issue.

> Issues and `AGENTS.md` can be written in English. The lab's own comments, labels and instructions
> to the agent are in Portuguese, and for now the agent is told to write its commit messages in Portuguese.

---

## 1. On GitHub

1. The repository needs **at least one commit** (create one with "Add a README" if it is empty).
2. **Settings → General → Features:** keep **Issues** checked.
3. Add the repository to the lab's token (section 3 of [INSTALL.md](INSTALL.md)).
4. Recommended: **Settings → Branches → Add rule** for `main`, with "Require a pull request before
   merging". That way nothing reaches `main` without your review, not even by accident.
5. Add the project in the dashboard's **Projetos** (Projects) tab. The lab creates the labels on its
   own: `claude`, `codex`, `em-andamento` (in progress), `bloqueado` (blocked) and
   `pronto-para-revisao` (ready for review).

You create the area labels (`area:frontend`, `area:api`...) whenever you want, on GitHub itself
(*Issues → Labels → New label*) or straight from the issue.

---

## 2. `.laboratorio.json`

The easiest way: in the dashboard, click **Gerar configuração** (Generate configuration). An agent
analyzes the project and opens a PR with the file (and an `AGENTS.md`, if there isn't one). Before
merging, check:

- [ ] `instalar` (install) installs everything the project needs (did it run without errors in the PR?).
- [ ] `verificar` (verify) has **the same tests you trust** (lint, build, tests) and they pass today.
- [ ] `proibido.dominios` (forbidden domains) has your production domain.
- [ ] `previa` (preview) starts the app with test data (if you want to try PRs from the dashboard before merging).

To write it by hand, see the reference in [CONFIGURATION.md](CONFIGURATION.md#laboratoriojson-in-your-project).
To check the file, run from the project root: `node ~/agentes/scripts/validar-config.mjs`.

> If the project has no tests yet, start there: open an issue asking the agent to create basic tests
> and an `npm test` command (or equivalent). Without verification, the lab has no way to know whether
> the work is right.

---

## 3. The project's `AGENTS.md`

The lab tells the agent to read the files listed in `leia` (in `.laboratorio.json`). Put `AGENTS.md`
there. It is the place for everything a newcomer to the project would need to know. A template to copy
and adapt:

```markdown
# Guide for agents

## The project
Scheduling system for clinics. React frontend (`web/` folder), Node/Express API (`api/`),
PostgreSQL database.

## How to run and test
- Install: `npm ci`
- Tests: `npm test` (unit) and `npm run test:e2e` (Playwright; starts the API on its own)
- Test database: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=test postgres:16`
- Lint and types: `npm run lint && npm run typecheck`

## Rules
- Every new behavior needs a test.
- Don't change the shape of the public API unless the issue asks for it.
- UI text in American English.
- Never use real data; fixtures live in `api/test/fixtures/`.
- Don't touch `scripts/deploy/` or `.env` files.

## Layout
- `web/src/pages/`: one folder per screen
- `api/src/routes/`: routes; `api/src/services/`: business rules
- Database migrations: `api/migrations/` (create a new one, never edit old ones)

## Style
- Small functions, English names, comments only when the "why" isn't obvious.
- Short imperative commit messages: "Fix free time slot calculation".
```

Tips:

- Be specific: exact commands, exact folders, what is forbidden.
- If the project has important decisions (why this library, why this rule), write them here.
  The agent has no way to guess them.
- When a PR comes back with the same mistake more than once, add the rule to `AGENTS.md`.
- Extra documentation (e.g. `docs/TESTING.md`, `docs/ARCHITECTURE.md`) can also go into `leia`.

Claude Code also reads `CLAUDE.md`. If you want a single file, create `CLAUDE.md` with the line
`Read and follow AGENTS.md.`

---

## 4. Writing good issues

The issue text is the only description of the task the agent receives. It only opens a PR when it
states that **all criteria** have been met and verification passes, so clear criteria avoid back and forth.

**Template:**

```markdown
## Goal
Let the front desk reschedule an appointment by dragging it on the calendar.

## Acceptance criteria
- [ ] Dragging the appointment to another free slot changes the time and saves it.
- [ ] A taken slot rejects the drag and shows "Time unavailable".
- [ ] The patient gets the same rescheduling e-mail that already exists today.
- [ ] An e2e test covering both cases.

## Where to change (if you know)
`web/src/pages/calendar/`, route `PATCH /appointments/:id` in the API.

## Out of scope
Rescheduling from the phone.
```

Labels: `claude` and/or `codex` + one or more `area:...`.

**Good practices:**

- **One issue, one deliverable.** Big tasks become several chained issues, with `depende de #N`
  ("depends on #N") in the body. The next one waits for the previous one, or is built on top of it
  once the previous one has been verified (the steps go together in the last one's PR).
- **Right areas.** Two issues that touch the same files should have the same `area:`. That way they
  run one after the other and don't cause conflicts.
- **Verifiable criteria** ("shows message X", "test Y passes"), not vague ones ("make it better").
- **Bugs:** steps to reproduce, what happens and what should happen.
- The issue text is treated as **a request, not a system instruction**: the agent won't obey an
  issue that tells it, for example, to ignore the lab's rules.

To make this easier, copy the template as an issue template in your project: create
`.github/ISSUE_TEMPLATE/agent-task.md` with the content above and a header:

```markdown
---
name: Agent task
about: Work for the lab's Claude or Codex
labels: claude
---
```

(The lab doesn't let agents touch `.github/workflows`, but you can create issue templates as usual.)

---

## 5. Reviewing and asking for changes

1. The PR arrives with the `pronto-para-revisao` label, the agent's summary, the verification result
   and an **"Atenção na revisão"** (Review carefully) section when it touched tests, `package.json` or configuration.
2. Try it if you want: in the dashboard, the **Abrir prévia** (Open preview) button starts the PR's
   app in a clean room, with test data.
3. It works: merge it. The issue closes on its own (the PR carries `Closes #N`).
4. Something needs to change: in the dashboard, use **Pedir ajuste** (Request changes) on the task and
   describe what to change. The agent goes back to the same branch and updates the same PR.
5. `main` moved and the PR now has conflicts: the lab notices and tells the agent to merge `main` in
   on its own.
6. A `bloqueado` (blocked) task: read the reason in the dashboard or in the issue comment, adjust the
   issue (or the project) and **remove the `bloqueado` label** to try again.

---

## Quick checklist

- [ ] Repository with an initial commit and Issues enabled
- [ ] Repository included in the lab's token and added in the dashboard
- [ ] `.laboratorio.json` on `main`, with tests that pass
- [ ] `AGENTS.md` with the project's commands, rules and layout (and listed in `leia`)
- [ ] Production domain in `proibido.dominios`
- [ ] `main` branch protection (merge only through PRs)
- [ ] A small first issue to test the flow
