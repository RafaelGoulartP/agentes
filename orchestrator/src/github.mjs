function nextLink(header) {
  for (const part of String(header ?? '').split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

export class GitHubClient {
  constructor({ apiBase, owner, repo, token, maxPages = 50 }) {
    this.apiBase = apiBase;
    this.base = `${apiBase}/repos/${owner}/${repo}`;
    this.owner = owner;
    this.repo = repo;
    this.token = token;
    this.maxPages = maxPages;
  }

  async raw(method, url, body) {
    // O token só segue para a própria API configurada, inclusive em links de paginação.
    if (!url.startsWith(`${this.apiBase}/`)) throw new Error(`URL fora da API configurada: ${method}`);
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'laboratorio-agentes-orchestrator/0.2'
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      const route = url.slice(this.base.length).split('?')[0];
      const error = new Error(`GitHub ${method} ${route}: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return { data, headers: response.headers };
  }

  async request(method, route, body) {
    return (await this.raw(method, `${this.base}${route}`, body)).data;
  }

  async listAll(route) {
    const all = [];
    let url = `${this.base}${route}${route.includes('?') ? '&' : '?'}per_page=100`;
    for (let page = 0; url; page += 1) {
      if (page >= this.maxPages) throw new Error(`paginacao excedeu ${this.maxPages} paginas em ${route.split('?')[0]}`);
      const { data, headers } = await this.raw('GET', url);
      all.push(...data);
      url = nextLink(headers.get('link'));
    }
    return all;
  }

  listOpenIssues() { return this.listAll('/issues?state=open'); }
  listOpenPulls() { return this.listAll('/pulls?state=open'); }
  getIssue(number) { return this.request('GET', `/issues/${number}`); }
  getPull(number) { return this.request('GET', `/pulls/${number}`); }
  compare(base, head) { return this.request('GET', `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`); }
  comment(issue, body) { return this.request('POST', `/issues/${issue}/comments`, { body }); }
  repository() { return this.request('GET', ''); }

  async findOpenPull(branch) {
    const head = encodeURIComponent(`${this.owner}:${branch}`);
    const pulls = await this.request('GET', `/pulls?state=open&head=${head}`);
    return pulls[0] ?? null;
  }

  createPull({ title, head, base, body }) {
    return this.request('POST', '/pulls', { title, head, base, body, maintainer_can_modify: false });
  }

  addLabel(issue, label) {
    return this.request('POST', `/issues/${issue}/labels`, { labels: [label] });
  }

  async removeLabel(issue, label) {
    try { return await this.request('DELETE', `/issues/${issue}/labels/${encodeURIComponent(label)}`); }
    catch (error) { if (error.status !== 404) throw error; return null; }
  }
}
