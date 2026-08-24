import axios from 'axios'

const base = () => localStorage.getItem('jdwpApiBase') || 'http://localhost:8083'
const token = () => sessionStorage.getItem('jdwp-token') || ''

function api() {
  const i = axios.create({
    baseURL: `${base()}/api/debug`,
    timeout: 0,
    validateStatus: () => true,
  })
  const t = token()
  if (t) i.defaults.headers.common['X-Debug-Token'] = t
  return i
}

function k8s() {
  const i = axios.create({ baseURL: `${base()}/api/k8s`, timeout: 25000, validateStatus: () => true })
  const t = token()
  if (t) i.defaults.headers.common['X-Debug-Token'] = t
  return i
}

const unwrap = async (p) => {
  try { return { ok: true, data: (await p).data } } catch (e) { return { ok: false, error: e.response?.data?.message || e.message } }
}

export const api2 = {
  base, token, setBase: (b) => localStorage.setItem('jdwpApiBase', b), getBase: base,
  setToken: (t) => sessionStorage.setItem('jdwp-token', t || ''), getToken: token,
  raw: api, unwrap,
}
export default api
