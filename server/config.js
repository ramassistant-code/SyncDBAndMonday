// Loads .env.local and defines the two environments (dev/test and production).
// Each environment bundles: a Supabase connection + a Monday token + the
// control-plane `environment` value used to filter monday_export_* tables.

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// Prefer .env.local, fall back to .env
dotenv.config({ path: path.join(rootDir, '.env.local') });
dotenv.config({ path: path.join(rootDir, '.env') });

function envDef(key, label, supabaseUrl, supabaseKey, mondayToken, controlPlaneEnv) {
  const configured = Boolean(supabaseUrl && supabaseKey && mondayToken);
  return {
    key,                       // 'test' | 'production'  (our internal id)
    label,                     // human label
    controlPlaneEnv,           // value stored in monday_export_targets.environment
    configured,
    missing: [
      !supabaseUrl && 'supabaseUrl',
      !supabaseKey && 'supabaseKey',
      !mondayToken && 'mondayToken',
    ].filter(Boolean),
    supabase: { url: supabaseUrl || null, key: supabaseKey || null },
    monday: { token: mondayToken || null },
    isProduction: key === 'production',
  };
}

export const ENVIRONMENTS = {
  test: envDef(
    'test',
    'פיתוח (Test)',
    process.env.PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_DEV_SECRET,
    process.env.MONDAY_DEV_API,
    'test',
  ),
  production: envDef(
    'production',
    'ייצור (Production)',
    process.env.SUPABASE_PROD_URL,
    process.env.SUPABASE_PROD_SECRET,
    process.env.MONDAY_PROD_API,
    'production',
  ),
};

export function getEnvironment(key) {
  const env = ENVIRONMENTS[key];
  if (!env) {
    const e = new Error(`Unknown environment "${key}". Valid: ${Object.keys(ENVIRONMENTS).join(', ')}`);
    e.status = 400;
    throw e;
  }
  return env;
}

export function requireConfigured(env) {
  if (!env.configured) {
    const e = new Error(`Environment "${env.key}" is not fully configured. Missing: ${env.missing.join(', ')}`);
    e.status = 409;
    throw e;
  }
  return env;
}

export const PORT = process.env.PORT || 4000;
