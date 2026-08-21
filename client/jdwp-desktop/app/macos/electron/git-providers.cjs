/**
 * Git provider integration — list a user/org's services (repositories)
 * from GitHub or Bitbucket so they can be matched against pods running
 * in the selected cluster.
 *
 * Security model:
 *  - Tokens are supplied by the renderer, used ONLY for an HTTPS call to
 *    the provider's fixed API host (api.github.com / api.bitbucket.org),
 *    and never written to logs or disk by this process.
 *  - Only listing endpoints are called (read-only scope tokens suffice).
 */
const ALLOWED_HOSTS = new Set(['api.github.com', 'api.bitbucket.org'])

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

/** GitHub: repos accessible to the token, optionally scoped to an org/user. */
async function listGithubRepos({ token, owner }) {
  const t = cleanToken(token)
  const headers = {
    Authorization: `Bearer ${t}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'jdwp-studio',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const o = String(owner || '').trim().replace(/[^a-zA-Z0-9-_.]/g, '')
  const url = o
    ? `https://api.github.com/users/${encodeURIComponent(o)}/repos?per_page=100&sort=updated`
    : 'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'
  const data = await fetchJson(url, headers)
  if (!Array.isArray(data)) throw new Error('Unexpected GitHub response')
  return {
    ok: true,
    repos: data.map((r) => ({
      name: r.name,
      fullName: r.full_name,
      private: !!r.private,
      language: r.language || null,
      updatedAt: r.updated_at,
      url: r.html_url,
    })),
  }
}

/** Bitbucket Cloud: repos in a workspace (workspace is required). */
async function listBitbucketRepos({ token, owner }) {
  const t = cleanToken(token)
  const ws = String(owner || '').trim().replace(/[^a-zA-Z0-9-_.]/g, '')
  if (!ws) throw new Error('Bitbucket needs a workspace name')
  const headers = {
    Authorization: `Bearer ${t}`,
    Accept: 'application/json',
    'User-Agent': 'jdwp-studio',
  }
  let url = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(ws)}?pagelen=100&sort=-updated_on`
  const repos = []
  // Follow up to 3 pages to keep it bounded.
  for (let page = 0; page < 3 && url; page++) {
    const data = await fetchJson(url, headers)
    if (!data || !Array.isArray(data.values)) throw new Error('Unexpected Bitbucket response')
    for (const r of data.values) {
      repos.push({
        name: r.name,
        fullName: r.full_name,
        private: !!r.is_private,
        language: r.language || null,
        updatedAt: r.updated_on,
        url: r.links && r.links.html ? r.links.html.href : null,
      })
    }
    url = data.next || null
  }
  return { ok: true, repos }
}

function registerGitProvidersIpc(ipcMain) {
  ipcMain.handle('git-list-repos', async (_, payload) => {
    try {
      const provider = payload && payload.provider === 'bitbucket' ? 'bitbucket' : 'github'
      if (!ALLOWED_HOSTS.has(provider === 'bitbucket' ? 'api.bitbucket.org' : 'api.github.com')) {
        throw new Error('Unsupported provider')
      }
      if (provider === 'bitbucket') {
        return await listBitbucketRepos(payload || {})
      }
      return await listGithubRepos(payload || {})
    } catch (e) {
      const statusSuffix = e.status === 401 ? ' (check the token)' : ''
      return { ok: false, error: `${e.message}${statusSuffix}`, repos: [] }
    }
  })
}

module.exports = { registerGitProvidersIpc }
