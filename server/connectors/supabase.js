// Supabase connector via PostgREST (uses the secret/service key).
// Chosen over a raw pg connection because the pooler DNS was unreliable and
// the REST endpoint gives us schema introspection + RLS-bypass with the secret key.

export class SupabaseConnector {
  constructor({ url, key }) {
    this.base = url.replace(/\/$/, '') + '/rest/v1';
    this.headers = {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
    };
  }

  async _fetch(pathAndQuery, opts = {}) {
    const res = await fetch(this.base + pathAndQuery, {
      ...opts,
      headers: { ...this.headers, ...(opts.headers || {}) },
    });
    const text = await res.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch { body = text; } }
    if (!res.ok) {
      const msg = body && body.message ? body.message : `HTTP ${res.status}`;
      const err = new Error(`Supabase: ${msg}`);
      err.status = res.status;
      err.details = body;
      throw err;
    }
    return { body, headers: res.headers };
  }

  // Quick connectivity + identity check. Returns the list of exposed tables.
  async testConnection() {
    const { body } = await this._fetch('/', { headers: { Accept: 'application/openapi+json' } });
    const defs = (body && body.definitions) || {};
    return { ok: true, tableCount: Object.keys(defs).length };
  }

  // Per-table set of NOT-NULL columns without a default (OpenAPI `required`).
  async notNullColumns() {
    const { body } = await this._fetch('/', { headers: { Accept: 'application/openapi+json' } });
    const defs = (body && body.definitions) || {};
    const out = {};
    for (const [t, d] of Object.entries(defs)) out[t] = new Set(d.required || []);
    return out;
  }

  // Full schema (table -> columns) from the OpenAPI spec.
  async introspect() {
    const { body } = await this._fetch('/', { headers: { Accept: 'application/openapi+json' } });
    const defs = (body && body.definitions) || {};
    const tables = {};
    for (const [name, def] of Object.entries(defs)) {
      tables[name] = Object.entries(def.properties || {}).map(([col, p]) => ({
        name: col,
        type: p.format || p.type,
        description: p.description || '',
      }));
    }
    return tables;
  }

  // Generic select. filters is an array of PostgREST clauses e.g. ["environment=eq.test"].
  // When no explicit `limit` is given, ALL rows are fetched via pagination
  // (PostgREST caps a single response at ~1000 rows).
  async select(table, { columns = '*', filters = [], order, limit } = {}) {
    const buildParams = () => {
      const params = new URLSearchParams();
      params.set('select', columns);
      for (const f of filters) {
        const i = f.indexOf('=');
        params.append(f.slice(0, i), f.slice(i + 1));
      }
      if (order) params.set('order', order);
      return params;
    };

    // Explicit limit → single request, caller owns paging.
    if (limit != null) {
      const params = buildParams();
      params.set('limit', String(limit));
      const { body } = await this._fetch('/' + table + '?' + params.toString());
      return Array.isArray(body) ? body : [];
    }

    // No limit → page through everything with Range headers.
    const pageSize = 1000;
    const all = [];
    let from = 0;
    for (;;) {
      const params = buildParams();
      const { body } = await this._fetch('/' + table + '?' + params.toString(), {
        headers: { Range: `${from}-${from + pageSize - 1}`, 'Range-Unit': 'items' },
      });
      const rows = Array.isArray(body) ? body : [];
      all.push(...rows);
      if (rows.length < pageSize) break;
      from += pageSize;
    }
    return all;
  }

  async count(table, filters = []) {
    const params = new URLSearchParams();
    params.set('select', 'id');
    for (const f of filters) {
      const i = f.indexOf('=');
      params.append(f.slice(0, i), f.slice(i + 1));
    }
    const { headers } = await this._fetch('/' + table + '?' + params.toString(), {
      method: 'GET',
      headers: { Prefer: 'count=exact', Range: '0-0', 'Range-Unit': 'items' },
    });
    const cr = headers.get('content-range') || '';
    const total = cr.split('/')[1];
    return total ? parseInt(total, 10) : 0;
  }

  async insert(table, rows) {
    const { body } = await this._fetch('/' + table, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(rows),
    });
    return body;
  }

  async updateById(table, id, patch) {
    const { body } = await this._fetch('/' + table + '?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
    return Array.isArray(body) ? body[0] : body;
  }

  // Update all rows matching a single column=value. Returns affected rows.
  async updateWhere(table, col, value, patch) {
    const { body } = await this._fetch('/' + table + '?' + col + '=eq.' + encodeURIComponent(value), {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
    return Array.isArray(body) ? body : [];
  }

  async deleteWhere(table, col, value) {
    const { body } = await this._fetch('/' + table + '?' + col + '=eq.' + encodeURIComponent(value), {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
    });
    return Array.isArray(body) ? body : [];
  }

  // Fetch rows where col is in a list of values (PostgREST in.(...)).
  async selectIn(table, col, values, columns = '*') {
    if (!values.length) return [];
    const list = values.map((v) => `"${String(v).replace(/"/g, '')}"`).join(',');
    const params = new URLSearchParams();
    params.set('select', columns);
    const { body } = await this._fetch('/' + table + '?' + col + '=in.(' + list + ')&' + params.toString());
    return Array.isArray(body) ? body : [];
  }
}
