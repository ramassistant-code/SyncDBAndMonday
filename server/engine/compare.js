// Value normalization + comparison shared by diff, apply and alignment.

// Israeli phone → last 9 digits (drops +972 / leading 0 / separators).
export function normalizePhone(v) {
  if (!v) return '';
  let d = String(v).replace(/\D/g, '');
  if (d.startsWith('972')) d = d.slice(3);
  return d.slice(-9);
}
export function normalizeEmail(v) { return String(v || '').trim().toLowerCase(); }
export function normalizeName(v) { return String(v || '').trim().replace(/\s+/g, ' '); }


export function norm(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v).trim();
}

// Compares a DB value against a Monday cell's *text*. Returns true if equal.
export function valuesEqual(dbVal, mondayText) {
  const a = norm(dbVal);
  const b = norm(mondayText);
  if (a === b) return true;
  // numeric-tolerant compare
  const na = Number(a.replace(/,/g, ''));
  const nb = Number(b.replace(/,/g, ''));
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) {
    if (na === nb) return true;
  }
  // date-tolerant compare (YYYY-MM-DD prefix)
  const da = a.slice(0, 10);
  const db = b.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(da) && da === db) return true;
  return false;
}
