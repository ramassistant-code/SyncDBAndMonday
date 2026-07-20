import express from 'express';
import cors from 'cors';
import { ENVIRONMENTS, getEnvironment, requireConfigured, PORT } from './config.js';
import { SupabaseConnector } from './connectors/supabase.js';
import { MondayConnector } from './connectors/monday.js';
import { getTargets, getTargetByKey } from './controlPlane.js';
import { buildDiff } from './engine/diff.js';
import { applyPlan } from './engine/apply.js';
import { buildAlignment, applyAlignment } from './engine/align.js';
import { buildDedup, applyDedup } from './engine/dedup.js';
import { syncItemFromMonday, syncItemToMonday, syncDealGraph } from './engine/syncSingle.js';
import { apiKeyAuth } from './auth.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use('/api', apiKeyAuth);

const connectorsFor = (env) => ({
  supabase: new SupabaseConnector(env.supabase),
  monday: new MondayConnector(env.monday),
});

const asyncH = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(e.status || 500).json({ error: e.message, details: e.details });
});

// ── Environments ────────────────────────────────────────────
app.get('/api/environments', (req, res) => {
  res.json(Object.values(ENVIRONMENTS).map((e) => ({
    key: e.key, label: e.label, configured: e.configured,
    missing: e.missing, isProduction: e.isProduction,
    supabaseUrl: e.supabase.url, controlPlaneEnv: e.controlPlaneEnv,
  })));
});

app.post('/api/environments/:key/test', asyncH(async (req, res) => {
  const env = requireConfigured(getEnvironment(req.params.key));
  const { supabase, monday } = connectorsFor(env);
  const out = { environment: env.key };
  try { out.db = { ok: true, ...(await supabase.testConnection()) }; }
  catch (e) { out.db = { ok: false, error: e.message }; }
  try { out.monday = await monday.testConnection(); }
  catch (e) { out.monday = { ok: false, error: e.message }; }
  res.json(out);
}));

// ── Targets ─────────────────────────────────────────────────
app.get('/api/targets', asyncH(async (req, res) => {
  const env = requireConfigured(getEnvironment(req.query.env || 'test'));
  const { supabase } = connectorsFor(env);
  const targets = await getTargets(supabase, env.controlPlaneEnv);
  res.json(targets);
}));

// ── Diff preview ────────────────────────────────────────────
// POST /api/sync/preview { env, direction, targetKey }
app.post('/api/sync/preview', asyncH(async (req, res) => {
  const env = requireConfigured(getEnvironment(req.body.env || 'test'));
  const { supabase, monday } = connectorsFor(env);
  const target = await getTargetByKey(supabase, env.controlPlaneEnv, req.body.targetKey);
  if (!target) return res.status(404).json({ error: `target "${req.body.targetKey}" not found` });
  const diff = await buildDiff({ supabase, monday, target, direction: req.body.direction || 'monday_to_db' });
  res.json(diff);
}));

// ── Apply ───────────────────────────────────────────────────
// POST /api/sync/apply { env, direction, targetKey, selectedKeys }
app.post('/api/sync/apply', asyncH(async (req, res) => {
  const env = requireConfigured(getEnvironment(req.body.env || 'test'));
  if (env.isProduction && req.body.confirmProduction !== true) {
    return res.status(428).json({ error: 'Production writes require confirmProduction=true' });
  }
  const { supabase, monday } = connectorsFor(env);
  const target = await getTargetByKey(supabase, env.controlPlaneEnv, req.body.targetKey);
  if (!target) return res.status(404).json({ error: `target "${req.body.targetKey}" not found` });
  const summary = await applyPlan({
    supabase, monday, target,
    direction: req.body.direction || 'monday_to_db',
    selectedKeys: req.body.selectedKeys || null,
  });
  res.json(summary);
}));

// ── Alignment (one-time reconciliation) ─────────────────────
app.post('/api/align/preview', asyncH(async (req, res) => {
  const env = requireConfigured(getEnvironment(req.body.env || 'test'));
  const { supabase, monday } = connectorsFor(env);
  const target = await getTargetByKey(supabase, env.controlPlaneEnv, req.body.targetKey);
  if (!target) return res.status(404).json({ error: `target "${req.body.targetKey}" not found` });
  res.json(await buildAlignment({ supabase, monday, target }));
}));

app.post('/api/align/apply', asyncH(async (req, res) => {
  const env = requireConfigured(getEnvironment(req.body.env || 'test'));
  if (env.isProduction && req.body.confirmProduction !== true) {
    return res.status(428).json({ error: 'Production writes require confirmProduction=true' });
  }
  const { supabase, monday } = connectorsFor(env);
  const target = await getTargetByKey(supabase, env.controlPlaneEnv, req.body.targetKey);
  if (!target) return res.status(404).json({ error: `target "${req.body.targetKey}" not found` });
  res.json(await applyAlignment({ supabase, monday, target, selectedKeys: req.body.selectedKeys || null }));
}));

// ── Duplicate merge (customers) ─────────────────────────────
app.post('/api/dedup/preview', asyncH(async (req, res) => {
  const env = requireConfigured(getEnvironment(req.body.env || 'test'));
  const { supabase } = connectorsFor(env);
  res.json(await buildDedup({ supabase, entity: req.body.entity || 'customers' }));
}));

app.post('/api/dedup/apply', asyncH(async (req, res) => {
  const env = requireConfigured(getEnvironment(req.body.env || 'test'));
  if (env.isProduction && req.body.confirmProduction !== true) {
    return res.status(428).json({ error: 'Production writes require confirmProduction=true' });
  }
  const { supabase } = connectorsFor(env);
  res.json(await applyDedup({ supabase, entity: req.body.entity || 'customers', selectedKeys: req.body.selectedKeys || null }));
}));

// ── Monday webhook receiver (CodeWords processes #1/#2) ───────────────
// Monday → DB for one item, real-time. Handles the challenge handshake and
// accepts either Monday's native {event:{boardId,pulseId}} or a normalized
// {boardId,itemId} (e.g. relayed by CodeWords).
// POST /api/hooks/monday { env?, challenge?, event?, boardId?, itemId? }
app.post('/api/hooks/monday', asyncH(async (req, res) => {
  if (req.body && req.body.challenge) return res.json({ challenge: req.body.challenge });
  const env = requireConfigured(getEnvironment(req.body.env || 'test'));
  const ev = req.body.event || {};
  const boardId = req.body.boardId || ev.boardId;
  const itemId = req.body.itemId || ev.pulseId || ev.itemId;
  if (!boardId || !itemId) return res.status(400).json({ error: 'missing boardId/itemId' });
  const { supabase, monday } = connectorsFor(env);
  const result = await syncItemFromMonday({ supabase, monday, environment: env.controlPlaneEnv, boardId, itemId });
  res.json({ env: env.key, ...result });
}));

// ── App push webhook (CodeWords process #4) ───────────────────────────
// DB → Monday, action-driven. Actions:
//   customer_upserted | lead_upserted        → single entity push
//   deal_created                             → deal graph cascade
//   generic { entity, id }                   → single entity push
// POST /api/push { env?, action, id, customerId?, leadId? }
app.post('/api/push', asyncH(async (req, res) => {
  const env = requireConfigured(getEnvironment(req.body.env || 'test'));
  if (env.isProduction && req.body.confirmProduction !== true) {
    return res.status(428).json({ error: 'Production writes require confirmProduction=true' });
  }
  const { supabase, monday } = connectorsFor(env);
  const environment = env.controlPlaneEnv;
  const { action, id } = req.body;
  let result;
  switch (action) {
    case 'customer_upserted':
      result = await syncItemToMonday({ supabase, monday, environment, entityType: 'customer', dbId: id });
      break;
    case 'lead_upserted':
      result = await syncItemToMonday({ supabase, monday, environment, entityType: 'lead', dbId: id });
      break;
    case 'deal_created':
    case 'deal_updated':
      result = await syncDealGraph({ supabase, monday, environment, dealId: id,
        includeCustomerId: req.body.customerId || null, includeLeadId: req.body.leadId || null });
      break;
    default:
      if (req.body.entity && id) {
        result = await syncItemToMonday({ supabase, monday, environment, entityType: req.body.entity, dbId: id });
      } else {
        return res.status(400).json({ error: `unknown action "${action}" and no {entity,id}` });
      }
  }
  res.json({ env: env.key, action: action || `entity:${req.body.entity}`, ...result });
}));

// ── Full scheduled sync (CodeWords process #3: 08:00 + 13:00) ──────────
// One-directional Monday→DB across every active, inbound-enabled target.
// No loop risk (pull-only, scheduled). Continues past a failing target.
// POST /api/sync/full { env, targetKeys? }  — targetKeys optional filter.
app.post('/api/sync/full', asyncH(async (req, res) => {
  const env = requireConfigured(getEnvironment(req.body.env || 'test'));
  if (env.isProduction && req.body.confirmProduction !== true) {
    return res.status(428).json({ error: 'Production writes require confirmProduction=true' });
  }
  const { supabase, monday } = connectorsFor(env);
  let targets = await getTargets(supabase, env.controlPlaneEnv);
  targets = targets.filter((t) => t.is_active !== false && t.inbound_enabled !== false);
  if (Array.isArray(req.body.targetKeys) && req.body.targetKeys.length) {
    const want = new Set(req.body.targetKeys);
    targets = targets.filter((t) => want.has(t.target_key));
  }

  const startedAt = new Date().toISOString();
  const perTarget = [];
  const totals = { created: 0, updated: 0, skipped: 0, failed: 0, lookupsAdded: 0 };
  for (const target of targets) {
    try {
      const summary = await applyPlan({ supabase, monday, target, direction: 'monday_to_db', selectedKeys: null });
      for (const k of Object.keys(totals)) totals[k] += summary[k] || 0;
      perTarget.push({ target: target.target_key, ok: true,
        created: summary.created, updated: summary.updated, skipped: summary.skipped, failed: summary.failed });
    } catch (e) {
      perTarget.push({ target: target.target_key, ok: false, error: e.message });
    }
  }
  res.json({ env: env.key, direction: 'monday_to_db', startedAt,
    finishedAt: new Date().toISOString(), targetsRun: targets.length, totals, perTarget });
}));

app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.listen(PORT, () => console.log(`SyncDBAndMonday API on http://localhost:${PORT}`));
