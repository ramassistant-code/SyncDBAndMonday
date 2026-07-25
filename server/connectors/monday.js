// Monday.com connector (GraphQL v2) with Complexity-Budget / rate-limit retry.
// Ported from the proven patterns in MOndayDB/monday_exporter.py.

const URL = 'https://api.monday.com/v2';

export class MondayConnector {
  constructor({ token }) {
    this.token = token;
  }

  async execute(query, variables, maxRetries = 4) {
    const headers = { Authorization: this.token, 'Content-Type': 'application/json' };
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let res;
      try {
        res = await fetch(URL, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
      } catch (e) {
        if (attempt === maxRetries - 1) throw new Error('Monday network error: ' + e.message);
        await sleep(2000 + attempt * 1000);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        await sleep(5000 + attempt * 3000);
        continue;
      }
      const json = await res.json().catch(() => null);
      if (!json) throw new Error(`Monday: unparseable response (HTTP ${res.status})`);
      if (json.errors) {
        const msg = json.errors.map((e) => e.message).join('; ');
        if (/budget|complexity|rate limit/i.test(msg) && attempt < maxRetries - 1) {
          await sleep(10000 + attempt * 5000);
          continue;
        }
        const err = new Error('Monday GraphQL: ' + msg);
        err.details = json.errors;
        throw err;
      }
      return json.data;
    }
    throw new Error('Monday: exceeded max retries');
  }

  async testConnection() {
    const data = await this.execute('query { me { name email account { name id slug tier } } }');
    return { ok: true, ...data.me };
  }

  async getBoardMeta(boardId) {
    const data = await this.execute(
      `query($id:[ID!]) { boards(ids:$id) { id name columns { id title type settings_str } groups { id title } } }`,
      { id: [String(boardId)] },
    );
    return (data.boards && data.boards[0]) || null;
  }

  // Returns array of items: { id, name, group, updated_at, columns: { <col_id>: {text, value} } }
  async getItems(boardId, limit = 200) {
    const itemFields = `
      id name updated_at
      group { id title }
      column_values { id text value }`;
    const first = await this.execute(
      `query($id:[ID!],$limit:Int!){ boards(ids:$id){ items_page(limit:$limit){ cursor items { ${itemFields} } } } }`,
      { id: [String(boardId)], limit },
    );
    const page = first.boards?.[0]?.items_page;
    if (!page) return [];
    const items = [...page.items];
    let cursor = page.cursor;
    while (cursor) {
      const next = await this.execute(
        `query($cursor:String!,$limit:Int!){ next_items_page(cursor:$cursor,limit:$limit){ cursor items { ${itemFields} } } }`,
        { cursor, limit },
      );
      const np = next.next_items_page;
      if (!np || !np.items?.length) break;
      items.push(...np.items);
      cursor = np.cursor;
    }
    return items.map(normalizeItem);
  }

  // Fetch a single item by id (real-time webhook path — avoids pulling the
  // whole board). Returns the same normalized shape as getItems, or null.
  async getItem(itemId) {
    const data = await this.execute(
      `query($id:[ID!]){ items(ids:$id){ id name updated_at group { id title }
         column_values { id text value ... on BoardRelationValue { linked_item_ids } } } }`,
      { id: [String(itemId)] },
    );
    const it = data.items?.[0];
    return it ? normalizeItem(it) : null;
  }

  async createItem(boardId, groupId, itemName, columnValues) {
    const data = await this.execute(
      `mutation($board:ID!,$group:String,$name:String!,$vals:JSON){
         create_item(board_id:$board, group_id:$group, item_name:$name, column_values:$vals, create_labels_if_missing: true){ id }
       }`,
      { board: String(boardId), group: groupId || null, name: itemName, vals: JSON.stringify(columnValues || {}) },
    );
    return data.create_item;
  }

  async changeColumnValues(boardId, itemId, columnValues) {
    const data = await this.execute(
      `mutation($board:ID!,$item:ID!,$vals:JSON!){
         change_multiple_column_values(board_id:$board, item_id:$item, column_values:$vals, create_labels_if_missing: true){ id }
       }`,
      { board: String(boardId), item: String(itemId), vals: JSON.stringify(columnValues) },
    );
    return data.change_multiple_column_values;
  }
}

function normalizeItem(it) {
  const columns = {};
  for (const cv of it.column_values || []) {
    // board_relation columns report text/value as null; the linked ids live in
    // the typed field linked_item_ids (only fetched by getItem).
    columns[cv.id] = { text: cv.text, value: cv.value, linkedIds: cv.linked_item_ids || null };
  }
  return { id: it.id, name: it.name, updated_at: it.updated_at, group: it.group, columns };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
