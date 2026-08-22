/**
 * Git provider integration — list repositories AND branches the token can
 * access from GitHub or Bitbucket, so services can be matched against pods
 * running in the selected cluster and sources opened at a given branch.
 *
 * Security model:
 *  - Tokens are supplied by the renderer, used ONLY for HTTPS calls to the
 *    provider's fixed API host (api.github.com / api.bitbucket.org), never
 *    logged, never persisted by this process.
 *  - Read-only endpoints only; names are validated before URL interpolation.
 */
const GITHUB_HOST = 'api.github.com'
const BITBUCKET_HOST = 'api.bitbucket.org'

async function fetchJson(url, headers) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const msg = (body && (body.message || body.error_description)) || `HTTP ${res.status}`
      const err = new Error(msg)
      err.status = res.status
      throw err
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

function cleanToken(t) {
  const s = String(t || '').trim()
  if (!s) throw new Error('Missing token')
  if (s.length > 512 || /[\s\r\n]/.test(s)) throw new Error('Invalid token format')
  return s
}

/** Strict identifier for owners/workspaces/repos — no URL metacharacters. */
function ident(value, label) {
  const s = String(value || '').trim()
  if (!s || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s)) {
    throw new Error(`Invalid ${label}`)
  }
  return s
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${cleanToken(token)}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'jdwp-studio',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

function mapGithubRepo(r) {
  return {
    name: r.name,
    fullName: r.full_name,
    private: !!r.private,
    language: r.language || null,
    updatedAt: r.updated_at,
    url: r.html_url,
    cloneUrl: `https://github.com/${r.full_name}.git`,
    provider: 'github',
  }
}

function mapBitbucketRepo(r) {
  return {
    name: r.name,
    fullName: r.full_name,
    private: !!r.is_private,
    language: r.language || null,
    updatedAt: r.updated_on,
    url: r.links && r.links.html ? r.links.html.href : null,
    cloneUrl: `https://bitbucket.org/${r.full_name}.git`,
    provider: 'bitbucket',
  }
}

/**
 * GitHub: repos the token can see.
 * Owner resolution order matters for ACCESS correctness:
 *   1. /orgs/{owner}        — real org account (includes private members' access)
 *   2. /users/{owner}       — plain user account
 *   3. /user/repos          — no owner given: everything the token can reach
 */
async function listGithubRepos({ token, owner }) {
  const headers = ghHeaders(token)
  const o = String(owner || '').trim()
  if (!o) {
    const data = await fetchJson(
      `https://${GITHUB_HOST}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`,
      headers,
    )
    return { ok: true, repos: data.map(mapGithubRepo) }
  }
  const name = ident(o, 'owner')
  // Org first: /users/{org}/repos silently drops private repos.
  try {
    const data = await fetchJson(
      `https://${GITHUB_HOST}/orgs/${encodeURIComponent(name)}/repos?per_page=100&sort=updated`,
      headers,
    )
    return { ok: true, repos: data.map(mapGithubRepo) }
  } catch (e) {
    if (e.status !== 404) throw e
  }
  const data = await fetchJson(
    `https://${GITHUB_HOST}/users/${encodeURIComponent(name)}/repos?per_page=100&sort=updated`,
    headers,
  )
  return { ok: true, repos: data.map(mapGithubRepo) }
}

async function listBitbucketRepos({ token, owner }) {
  const headers = {
    Authorization: `Bearer ${cleanToken(token)}`,
    Accept: 'application/json',
    'User-Agent': 'jdwp-studio',
  }
  const ws = ident(owner, 'workspace')
  let url = `https://${BITBUCKET_HOST}/2.0/repositories/${encodeURIComponent(ws)}?pagelen=100&sort=-updated_on`
  const repos = []
  for (let page = 0; page < 3 && url; page++) {
    const data = await fetchJson(url, headers)
    if (!data || !Array.isArray(data.values)) throw new Error('Unexpected Bitbucket response')
    for (const r of data.values) repos.push(mapBitbucketRepo(r))
    url = data.next || null
  }
  return { ok: true, repos }
}

/** Branches of one repo, mapped to {name, default}. */
async function listGithubBranches({ token, owner, repo }) {
  const headers = ghHeaders(token)
  const o = ident(owner, 'owner')
  const r = ident(repo, 'repo')
  const [branchesData, repoData] = await Promise.all([
    fetchJson(`https://${GITHUB_HOST}/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}/branches?per_page=100`, headers),
    fetchJson(`https://${GITHUB_HOST}/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}`, headers).catch(() => null),
  ])
  const def = repoData && repoData.default_branch ? repoData.default_branch : null
  return {
    ok: true,
    defaultBranch: def,
    branches: branchesData.map((b) => ({
      name: b.name,
      isDefault: def ? b.name === def : false,
      protected: !!b.protected,
    })),
  }
}

async function listBitbucketBranches({ token, owner, repo }) {
  const headers = {
    Authorization: `Bearer ${cleanToken(token)}`,
    Accept: 'application/json',
    'User-Agent': 'jdwp-studio',
  }
  const ws = ident(owner, 'workspace')
  const r = ident(repo, 'repo')
  const data = await fetchJson(
    `https://${BITBUCKET_HOST}/2.0/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(r)}/refs/branches?pagelen=100`,
    headers,
  )
  const branches = []
  for (const b of data.values || []) {
    branches.push({
      name: b.name,
      isDefault: !!(b.target && b.target.type === 'commit' && data.values.length && b.name && b.target &&
        (b.target.repository && b.target.repository.mainbranch && b.target.repository.mainbranch.name) === b.name),
      protected: !!(b.target && b.target.restrictions),
    })
  }
  // Bitbucket marks the default via mainbranch on the repo; simpler second look:
  if (branches.length && !branches.some((b) => b.isDefault)) {
    try {
      const rd = await fetchJson(
        `https://${BITBUCKET_HOST}/2.0/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(r)}`,
        headers,
      )
      const dn = rd.mainbranch && rd.mainbranch.name
      if (dn) for (const b of branches) b.isDefault = b.name === dn
    } catch { /* best effort */ }
  }
  return { ok: true, defaultBranch: (branches.find((b) => b.isDefault) || {}).name || null, branches }
}

function registerGitProvidersIpc(ipcMain) {
  ipcMain.handle('git-list-repos', async (_, payload) => {
    try {
      const provider = payload && payload.provider === 'bitbucket' ? 'bitbucket' : 'github'
      if (provider === 'bitbucket') return await listBitbucketRepos(payload || {})
      return await listGithubRepos(payload || {})
    } catch (e) {
      const statusSuffix = e.status === 401 ? ' (check the token)' : e.status === 404 ? ' (not found)' : ''
      return { ok: false, error: `${e.message}${statusSuffix}`, repos: [] }
    }
  })

  ipcMain.handle('git-list-branches', async (_, payload) => {
    try {
      if (!payload) throw new Error('Missing arguments')
      const provider = payload.provider === 'bitbucket' ? 'bitbucket' : 'github'
      if (provider === 'bitbucket') return await listBitbucketBranches(payload)
      return await listGithubBranches(payload)
    } catch (e) {
      const statusSuffix = e.status === 401 ? ' (check the token)' : e.status === 404 ? ' (repo not found)' : ''
      return { ok: false, error: `${e.message}${statusSuffix}`, branches: [] }
    }
  })
}

module.exports = { registerGitProvidersIpc }
