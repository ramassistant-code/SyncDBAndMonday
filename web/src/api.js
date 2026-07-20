async function req(path, opts) {
  const res = await fetch(path, opts);
  const text = await res.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

export const api = {
  environments: () => req('/api/environments'),
  testConnection: (key) => req(`/api/environments/${key}/test`, { method: 'POST' }),
  targets: (env) => req(`/api/targets?env=${encodeURIComponent(env)}`),
  preview: (payload) => req('/api/sync/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }),
  apply: (payload) => req('/api/sync/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }),
  alignPreview: (payload) => req('/api/align/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }),
  alignApply: (payload) => req('/api/align/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }),
  dedupPreview: (payload) => req('/api/dedup/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }),
  dedupApply: (payload) => req('/api/dedup/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }),
};
