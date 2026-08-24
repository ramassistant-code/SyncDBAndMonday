// Pure, no-network self-test for the Monday→DB credit fixes:
//   • credit titles are composed LABELS — the DB must store the name they embed
//   • a credit's "עסקה מקושרת" relation must reach credits.deal_id (and the
//     customer must be inherited from that deal)
//
// Run: node server/engine/inbound.test.mjs

import assert from 'node:assert';
import {
  INBOUND_INHERIT, INBOUND_RELATIONS, PUSH_CONFIG,
  creditNameFromTitle, resolveInboundInherited, resolveInboundRelations,
} from './enrich.js';

// ── the title → name parser ───────────────────────────────────────────
// our composed format: "customer | YYYY-MM-DD HH:MM | name x qty"
assert.strictEqual(creditNameFromTitle('Smadar | 2026-08-24 18:46 | עריכת שורט סטנדרט x 4'), 'עריכת שורט סטנדרט');
assert.strictEqual(creditNameFromTitle('רפאל מזרחי | 2026-08-24 19:44 | שעת צילום באולפן x 12'), 'שעת צילום באולפן');
assert.strictEqual(creditNameFromTitle('טל יצחק | 2026-08-24 15:54 | עריכת שורט פרימיום x 0.5'), 'עריכת שורט פרימיום');
// the app's format: "customer | name - qty | YYYY-MM-DD"
assert.strictEqual(creditNameFromTitle('מארק זינביץ | עריכת פרק פודקאסט מלא - 1 | 2026-08-23'), 'עריכת פרק פודקאסט מלא');
assert.strictEqual(creditNameFromTitle('נועה ינאי | חבילת סרטוני שורט (קצרים לרשתות) רמת עריכה סטנדרט - 10 | 2026-08-23'),
  'חבילת סרטוני שורט (קצרים לרשתות) רמת עריכה סטנדרט');
// a name that itself contains " - " must survive: the LAST " - qty" is the split
assert.strictEqual(creditNameFromTitle('יוסף קריכלי | ראיון שיווקי - שיחת הכנה + צילום - 1 | 2026-08-23'),
  'ראיון שיווקי - שיחת הכנה + צילום');
assert.strictEqual(creditNameFromTitle('יוסף קריכלי | 2026-08-23 15:23 | ראיון שיווקי - שיחת הכנה x 1'),
  'ראיון שיווקי - שיחת הכנה');
// free text a human typed on the board is NOT a composed label → untouched
for (const plain of [
  'ספיר גנון 15 רילס סטנדרט',
  'מאשה |טיזר - 1 | 2026-06-21',              // no space after the pipe → not our shape
  'רוסלינה אביטוב 10 סטנדרט | 09.07.26',      // dd.mm.yy, not a composed label
  'איריס חן | שיפור ניתוב והוספת מיתוג | 2025-09-25', // no quantity segment
]) assert.strictEqual(creditNameFromTitle(plain), plain, `must pass through: ${plain}`);
// degenerate input
assert.strictEqual(creditNameFromTitle(null), null);
assert.strictEqual(creditNameFromTitle(''), '');
// idempotent: re-parsing an already-clean name changes nothing
assert.strictEqual(creditNameFromTitle('עריכת שורט סטנדרט'), 'עריכת שורט סטנדרט');

// ── inbound relation config mirrors the outbound one ──────────────────
const outRel = PUSH_CONFIG.credit.relations.find((r) => r.fk === 'deal_id');
const inRel = INBOUND_RELATIONS.credit.find((r) => r.fk === 'deal_id');
assert.strictEqual(inRel.column, outRel.column, 'inbound and outbound must use the same board_relation column');
assert.strictEqual(INBOUND_INHERIT.credit.parentFk, 'deal_id');

// ── resolveInboundRelations: link → FK, empty link → untouched ────────
const boardByEntity = { deal: '2091985867', credit: '2091986228' };
const itemWithDeal = { columns: { board_relation_mkv7apeh: { text: null, value: null, linkedIds: ['3182946727'] } } };
const itemNoDeal = { columns: { board_relation_mkv7apeh: { text: null, value: null, linkedIds: [] } } };
const supabaseWith = (rows) => ({ select: async () => rows });

assert.deepStrictEqual(
  await resolveInboundRelations({ supabase: supabaseWith([{ id: 'deal-1' }]), entityType: 'credit', item: itemWithDeal, boardByEntity }),
  { deal_id: 'deal-1' }, 'a linked deal must reach deal_id');

assert.deepStrictEqual(
  await resolveInboundRelations({ supabase: supabaseWith([]), entityType: 'credit', item: itemWithDeal, boardByEntity }),
  {}, 'a link to a deal with no DB row resolves to nothing — never NULLs the FK');

assert.deepStrictEqual(
  await resolveInboundRelations({ supabase: supabaseWith([{ id: 'deal-1' }]), entityType: 'credit', item: itemNoDeal, boardByEntity }),
  {}, 'an empty relation must leave the existing deal_id alone');

// ── resolveInboundInherited: customer comes from the deal ─────────────
const dealRow = { id: 'deal-1', customer_id: 'cust-1' };
const supabaseDeal = { select: async () => [dealRow] };

assert.deepStrictEqual(
  await resolveInboundInherited({ supabase: supabaseDeal, entityType: 'credit', dbRow: null, resolved: { deal_id: 'deal-1' } }),
  { customer_id: 'cust-1' }, 'a Monday-created credit inherits the deal customer');

assert.deepStrictEqual(
  await resolveInboundInherited({ supabase: supabaseDeal, entityType: 'credit', dbRow: { customer_id: 'other' }, resolved: { deal_id: 'deal-1' } }),
  {}, 'a credit that already has a customer keeps it');

assert.deepStrictEqual(
  await resolveInboundInherited({ supabase: { select: async () => [{ id: 'deal-1', customer_id: null }] },
    entityType: 'credit', dbRow: {}, resolved: { deal_id: 'deal-1' } }),
  {}, 'a customer-less deal writes nothing');

console.log('inbound (credit name + deal link): all assertions passed ✅');
