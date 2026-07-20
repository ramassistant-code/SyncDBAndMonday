import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

const DIRECTIONS = [
  { key: 'monday_to_db', label: 'Monday → DB (משיכה)' },
  { key: 'db_to_monday', label: 'DB → Monday (דחיפה)' },
  { key: 'bidirectional', label: 'דו-כיווני' },
];

export default function App() {
  const [envs, setEnvs] = useState([]);
  const [envKey, setEnvKey] = useState('test');
  const [conn, setConn] = useState(null);
  const [testing, setTesting] = useState(false);

  const [mode, setMode] = useState('sync'); // 'sync' | 'align'
  const [direction, setDirection] = useState('monday_to_db');
  const [targets, setTargets] = useState([]);
  const [targetKey, setTargetKey] = useState('');

  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [summary, setSummary] = useState(null);
  const [align, setAlign] = useState(null);
  const [alignSel, setAlignSel] = useState(new Set());
  const [alignSummary, setAlignSummary] = useState(null);
  const [dedup, setDedup] = useState(null);
  const [dedupSel, setDedupSel] = useState(new Set());
  const [dedupSummary, setDedupSummary] = useState(null);
  const [dedupEntity, setDedupEntity] = useState('customers');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const env = envs.find((e) => e.key === envKey);
  const isProd = env?.isProduction;

  useEffect(() => { api.environments().then(setEnvs).catch((e) => setError(e.message)); }, []);

  useEffect(() => {
    setConn(null); setPreview(null); setSummary(null); setSelected(new Set());
    setAlign(null); setAlignSummary(null); setAlignSel(new Set());
    setDedup(null); setDedupSummary(null); setDedupSel(new Set());
    if (!env?.configured) { setTargets([]); return; }
    api.targets(envKey).then((t) => {
      setTargets(t);
      setTargetKey(t.find((x) => x.is_active)?.target_key || t[0]?.target_key || '');
    }).catch((e) => setError(e.message));
  }, [envKey, env?.configured]);

  async function doTest() {
    setTesting(true); setError('');
    try { setConn(await api.testConnection(envKey)); }
    catch (e) { setError(e.message); }
    finally { setTesting(false); }
  }

  async function doPreview() {
    setBusy('preview'); setError(''); setSummary(null); setPreview(null);
    try {
      const p = await api.preview({ env: envKey, direction, targetKey });
      setPreview(p);
      setSelected(new Set(p.rows.filter((r) => r.op === 'create' || r.op === 'update').map((r) => r.key)));
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }

  async function doApply() {
    if (!preview) return;
    const n = selected.size;
    let confirmProduction = false;
    if (isProd) {
      if (!window.confirm(`אזהרה: כתיבה ל־ייצור.\nלבצע ${n} פעולות בסביבת הייצור?`)) return;
      confirmProduction = true;
    } else if (!window.confirm(`לבצע ${n} פעולות סינכרון?`)) return;
    setBusy('apply'); setError('');
    try {
      const s = await api.apply({ env: envKey, direction, targetKey, selectedKeys: [...selected], confirmProduction });
      setSummary(s);
      setPreview(null); setSelected(new Set());
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }

  async function doAlignPreview() {
    setBusy('align-preview'); setError(''); setAlignSummary(null); setAlign(null);
    try {
      const a = await api.alignPreview({ env: envKey, targetKey });
      setAlign(a);
      setAlignSel(new Set(a.rows.filter((r) => r.op === 'link').map((r) => r.key)));
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }

  async function doAlignApply() {
    if (!align) return;
    const n = alignSel.size;
    let confirmProduction = false;
    if (isProd) {
      if (!window.confirm(`אזהרה: כתיבה ל־ייצור.\nלקשר ${n} רשומות בסביבת הייצור?`)) return;
      confirmProduction = true;
    } else if (!window.confirm(`לקשר ${n} רשומות?`)) return;
    setBusy('align-apply'); setError('');
    try {
      const s = await api.alignApply({ env: envKey, targetKey, selectedKeys: [...alignSel], confirmProduction });
      setAlignSummary(s); setAlign(null); setAlignSel(new Set());
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }

  const actionRows = useMemo(
    () => (preview?.rows || []).filter((r) => r.op === 'create' || r.op === 'update'),
    [preview]);
  const linkRows = useMemo(() => (align?.rows || []).filter((r) => r.op === 'link'), [align]);
  const reviewRows = useMemo(() => (align?.rows || []).filter((r) => r.op === 'review'), [align]);

  async function doDedupPreview() {
    setBusy('dedup-preview'); setError(''); setDedupSummary(null); setDedup(null);
    try {
      const d = await api.dedupPreview({ env: envKey, entity: dedupEntity });
      setDedup(d);
      setDedupSel(new Set(d.groups.map((g) => g.key)));
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }

  async function doDedupApply() {
    if (!dedup) return;
    const n = dedupSel.size;
    let confirmProduction = false;
    if (isProd) {
      if (!window.confirm(`אזהרה: מחיקה בסביבת ייצור.\nלמזג ${n} קבוצות כפילויות?`)) return;
      confirmProduction = true;
    } else if (!window.confirm(`למזג ${n} קבוצות כפילויות? הפעולה מוחקת שורות כפולות ומעבירה את הקשרים לשורה השורדת.`)) return;
    setBusy('dedup-apply'); setError('');
    try {
      const s = await api.dedupApply({ env: envKey, entity: dedupEntity, selectedKeys: [...dedupSel], confirmProduction });
      setDedupSummary(s); setDedup(null); setDedupSel(new Set());
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }

  function toggle(key) {
    setSelected((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  const allSelected = actionRows.length > 0 && selected.size === actionRows.length;

  return (
    <div className="app">
      <h1>סינכרון DB ↔ Monday</h1>
      <div className="sub">מסך ניהול — בחירת סביבה, כיוון, תצוגת הבדלים, אישור וביצוע.</div>

      {/* Environment bar */}
      <div className={'envbar' + (isProd ? ' prod' : '')}>
        <div className="seg">
          {envs.map((e) => (
            <button key={e.key}
              className={(e.key === envKey ? 'active ' : '') + (e.isProduction ? 'prod' : '')}
              disabled={!e.configured}
              title={e.configured ? '' : 'לא מוגדר: ' + e.missing.join(', ')}
              onClick={() => setEnvKey(e.key)}>
              {e.label}{!e.configured ? ' (לא מוגדר)' : ''}
            </button>
          ))}
        </div>
        <button className="btn" onClick={doTest} disabled={!env?.configured || testing}>
          {testing ? 'בודק…' : 'בדיקת חיבור'}
        </button>
        {conn && (
          <>
            <span className={'pill ' + (conn.db?.ok ? 'ok' : 'bad')}>
              DB {conn.db?.ok ? `✓ ${conn.db.tableCount} טבלאות` : '✗'}
            </span>
            <span className={'pill ' + (conn.monday?.ok ? 'ok' : 'bad')}>
              Monday {conn.monday?.ok ? `✓ ${conn.monday.account?.slug}` : '✗'}
            </span>
          </>
        )}
        <div className="spacer" />
        {isProd && <span className="pill bad">סביבת ייצור — כתיבה זהירה</span>}
      </div>

      {error && <div className="err-box">{error}</div>}
      {!env?.configured && <div className="warn">סביבה "{env?.label}" אינה מוגדרת עדיין ({env?.missing?.join(', ')}). הוסף את המפתחות ל-.env.local.</div>}

      {/* Mode toggle */}
      {env?.configured && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>סדר מומלץ:</span>
          <div className="seg">
            <button className={mode === 'dedup' ? 'active' : ''} onClick={() => setMode('dedup')}>1. מיזוג כפילויות</button>
            <button className={mode === 'align' ? 'active' : ''} onClick={() => setMode('align')}>2. יישור קו</button>
            <button className={mode === 'sync' ? 'active' : ''} onClick={() => setMode('sync')}>3. סינכרון</button>
          </div>
        </div>
      )}

      {/* Controls */}
      {env?.configured && (
        <div className="controls">
          {mode === 'sync' && (
            <div className="field">
              <label>כיוון סינכרון</label>
              <select value={direction} onChange={(e) => setDirection(e.target.value)}>
                {DIRECTIONS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select>
            </div>
          )}
          {mode !== 'dedup' && (
            <div className="field">
              <label>יעד (לוח / ישות)</label>
              <select value={targetKey} onChange={(e) => setTargetKey(e.target.value)}>
                {targets.map((t) => (
                  <option key={t.target_key} value={t.target_key}>
                    {t.target_name} {t.is_active ? '' : '(לא פעיל)'}
                  </option>
                ))}
              </select>
            </div>
          )}
          {mode === 'sync' && (
            <button className="btn primary" onClick={doPreview} disabled={!targetKey || busy}>
              {busy === 'preview' ? 'טוען הבדלים…' : 'הצג הבדלים'}
            </button>
          )}
          {mode === 'align' && (
            <button className="btn primary" onClick={doAlignPreview} disabled={!targetKey || busy}>
              {busy === 'align-preview' ? 'בודק התאמות…' : 'בדוק יישור'}
            </button>
          )}
          {mode === 'dedup' && (
            <>
              <div className="field">
                <label>ישות</label>
                <select value={dedupEntity} onChange={(e) => { setDedupEntity(e.target.value); setDedup(null); setDedupSummary(null); }}>
                  <option value="customers">לקוחות</option>
                  <option value="leads">לידים</option>
                </select>
              </div>
              <button className="btn primary" onClick={doDedupPreview} disabled={busy}>
                {busy === 'dedup-preview' ? 'בודק כפילויות…' : 'בדוק כפילויות'}
              </button>
            </>
          )}
        </div>
      )}

      {mode === 'dedup' && !dedup && !dedupSummary && (
        <div className="warn">מיזוג כפילויות לקוחות: ממזג רק שורות שבהן <b>גם הטלפון וגם השם זהים</b>. מעביר את כל הקשרים (עסקאות/תשלומים/קרדיטים/לידים) לשורה השורדת, ואז מוחק את הכפולה. שורות עם אותו טלפון ושם שונה מוצגות לבדיקה ולא נמחקות.</div>
      )}

      {mode === 'align' && !align && !alignSummary && (
        <div className="warn">יישור קו הוא צעד חד-פעמי לפני הסינכרון: מקשר שורות DB קיימות לפריטי לוח הפיתוח לפי טלפון→מייל→שם, כדי למנוע כפילות. משנה רק את עמודות הקישור, לא את הנתונים.</div>
      )}

      {busy === 'preview' && <div className="loading">שולף נתונים משני הצדדים ומחשב הבדלים…</div>}

      {/* Preview */}
      {mode === 'sync' && preview && (
        <div className="card">
          <h3>{preview.target.name} — לוח "{preview.target.board_name}"</h3>
          <div className="kv"><span>DB: <b>{preview.totals.db}</b> · Monday: <b>{preview.totals.monday}</b> · מקושרים ליעד: <b>{preview.totals.linkedToTarget}</b> · סביבה אחרת: <b>{preview.totals.otherEnv}</b></span></div>

          {preview.warnings?.map((w, i) => <div className="warn" key={i}>⚠ {w}</div>)}

          <div className="counts">
            <div className="count create"><b>{preview.counts.create}</b> חדשים</div>
            <div className="count update"><b>{preview.counts.update}</b> שינויים</div>
            <div className="count unchanged"><b>{preview.counts.unchanged}</b> ללא שינוי</div>
            <div className="count missing"><b>{preview.counts.missing}</b> חסרים</div>
          </div>

          {actionRows.length === 0 ? (
            <div className="loading">אין פעולות לביצוע — הצדדים מסונכרנים.</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '8px 0' }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--muted)' }}>
                  <input type="checkbox" checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(actionRows.map((r) => r.key)))} />
                  בחר הכל ({selected.size}/{actionRows.length})
                </label>
                <div className="spacer" />
                <button className={'btn ' + (isProd ? 'danger' : 'primary')}
                  onClick={doApply} disabled={selected.size === 0 || busy}>
                  {busy === 'apply' ? 'מבצע…' : `אשר ובצע (${selected.size})`}
                </button>
              </div>
              <div className="tablewrap">
                <table>
                  <thead><tr><th></th><th>פעולה</th><th>שם</th><th>שינויים</th></tr></thead>
                  <tbody>
                    {actionRows.slice(0, 200).map((r) => (
                      <tr key={r.key}>
                        <td><input type="checkbox" checked={selected.has(r.key)} onChange={() => toggle(r.key)} /></td>
                        <td><span className={'op ' + r.op}>{r.op === 'create' ? 'חדש' : 'עדכון'}</span> <span style={{ color: 'var(--muted)', fontSize: 11 }}>{r.writeSide === 'db' ? '→DB' : '→Monday'}</span></td>
                        <td>{r.name}</td>
                        <td className="changes">
                          {r.changes.slice(0, 6).map((c, i) => (
                            <span key={i}><span className="f">{c.field}</span>: {c.from ? <span className="from">{c.from}</span> : ''} <span className="to">{c.to}</span>{i < Math.min(r.changes.length, 6) - 1 ? ' · ' : ''} </span>
                          ))}
                          {r.changes.length > 6 ? `+${r.changes.length - 6}` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {actionRows.length > 200 && <div className="sub">מוצגות 200 שורות ראשונות מתוך {actionRows.length} (הבחירה חלה על כולן).</div>}
            </>
          )}
        </div>
      )}

      {busy === 'align-preview' && <div className="loading">שולף פריטים מ-Monday ומחשב התאמות מול ה-DB…</div>}

      {/* Alignment preview */}
      {mode === 'align' && align && (
        <div className="card">
          <h3>יישור קו — {align.target.name} (מפתחות: {align.matchKeys.join(' → ')})</h3>
          <div className="kv"><span>DB: <b>{align.totals.db}</b> · Monday: <b>{align.totals.monday}</b></span></div>
          {align.warnings?.map((w, i) => <div className="warn" key={i}>⚠ {w}</div>)}
          <div className="counts">
            <div className="count create"><b>{align.counts.link}</b> יקושרו</div>
            <div className="count update"><b>{align.counts.review}</b> לבדיקה</div>
            <div className="count unchanged"><b>{align.counts.new}</b> חדשים (יסונכרנו רגיל)</div>
            <div className="count unchanged"><b>{align.counts.alreadyAligned}</b> כבר מיושרים</div>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '8px 0' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--muted)' }}>
              <input type="checkbox" checked={linkRows.length > 0 && alignSel.size === linkRows.length}
                onChange={() => setAlignSel(alignSel.size === linkRows.length ? new Set() : new Set(linkRows.map((r) => r.key)))} />
              בחר את כל הקישורים ({alignSel.size}/{linkRows.length})
            </label>
            <div className="spacer" />
            <button className={'btn ' + (isProd ? 'danger' : 'primary')} onClick={doAlignApply} disabled={alignSel.size === 0 || busy}>
              {busy === 'align-apply' ? 'מקשר…' : `אשר קישור (${alignSel.size})`}
            </button>
          </div>

          <div className="tablewrap">
            <table>
              <thead><tr><th></th><th>סטטוס</th><th>שם (Monday)</th><th>התאמה</th></tr></thead>
              <tbody>
                {linkRows.slice(0, 200).map((r) => (
                  <tr key={r.key}>
                    <td><input type="checkbox" checked={alignSel.has(r.key)}
                      onChange={() => setAlignSel((s) => { const n = new Set(s); n.has(r.key) ? n.delete(r.key) : n.add(r.key); return n; })} /></td>
                    <td><span className="op create">קישור</span></td>
                    <td>{r.name}</td>
                    <td className="changes">לפי <span className="f">{r.matchedBy}</span> ← {r.dbRow?.name} {r.dbRow?.phone ? `· ${r.dbRow.phone}` : ''}</td>
                  </tr>
                ))}
                {reviewRows.slice(0, 100).map((r) => (
                  <tr key={r.key}>
                    <td></td>
                    <td><span className="op missing">לבדיקה</span></td>
                    <td>{r.name}</td>
                    <td className="changes">{r.candidates?.length} מועמדים (לפי {r.matchedBy}): {r.candidates?.map((c) => c.name).join(' | ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(linkRows.length > 200 || reviewRows.length > 100) && <div className="sub">התצוגה מוגבלת; הבחירה חלה על כל הקישורים.</div>}
        </div>
      )}

      {/* Alignment summary */}
      {alignSummary && (
        <div className="card summary">
          <h3>סיכום יישור — {alignSummary.target}</h3>
          <div className="counts">
            <div className="count create"><b>{alignSummary.linked}</b> קושרו</div>
            <div className="count missing"><b>{alignSummary.failed}</b> נכשלו</div>
          </div>
          <div className="sub">כעת אפשר לעבור למצב "סינכרון" — הרשומות המקושרות יופיעו כעדכון/ללא-שינוי במקום כפילות.</div>
          {alignSummary.failed > 0 && (
            <div className="err-box">
              {alignSummary.results.filter((r) => r.error).slice(0, 20).map((r, i) => (
                <div className="result-row err" key={i}>✗ {r.name}: {r.error}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {busy === 'dedup-preview' && <div className="loading">מחפש כפילויות לקוחות וסופר קשרים…</div>}

      {/* Dedup preview */}
      {mode === 'dedup' && dedup && (
        <div className="card">
          <h3>מיזוג כפילויות — {dedup.entity === 'leads' ? 'לידים' : 'לקוחות'} (סה"כ {dedup.totals.rows})</h3>
          <div className="counts">
            <div className="count create"><b>{dedup.counts.mergeGroups}</b> קבוצות למיזוג</div>
            <div className="count update"><b>{dedup.counts.rowsMerged}</b> שורות יימחקו</div>
            <div className="count missing"><b>{dedup.counts.reviewGroups}</b> לבדיקה ידנית</div>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '8px 0' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--muted)' }}>
              <input type="checkbox" checked={dedup.groups.length > 0 && dedupSel.size === dedup.groups.length}
                onChange={() => setDedupSel(dedupSel.size === dedup.groups.length ? new Set() : new Set(dedup.groups.map((g) => g.key)))} />
              בחר הכל ({dedupSel.size}/{dedup.groups.length})
            </label>
            <div className="spacer" />
            <button className={'btn ' + (isProd ? 'danger' : 'primary')} onClick={doDedupApply} disabled={dedupSel.size === 0 || busy}>
              {busy === 'dedup-apply' ? 'ממזג…' : `אשר מיזוג (${dedupSel.size})`}
            </button>
          </div>

          <div className="tablewrap">
            <table>
              <thead><tr><th></th><th>שם</th><th>שורה שורדת</th><th>יימחקו + קשרים שיועברו</th></tr></thead>
              <tbody>
                {dedup.groups.map((g) => (
                  <tr key={g.key}>
                    <td><input type="checkbox" checked={dedupSel.has(g.key)}
                      onChange={() => setDedupSel((s) => { const n = new Set(s); n.has(g.key) ? n.delete(g.key) : n.add(g.key); return n; })} /></td>
                    <td>{g.name}</td>
                    <td className="changes"><span className="to">שורדת</span> · {g.duplicates.length} כפולה{g.duplicates.length > 1 ? 'ות' : ''}</td>
                    <td className="changes">{g.totalRefs > 0
                      ? g.duplicates.map((d, i) => <span key={i}>{Object.entries(d.refs || {}).map(([t, c]) => `${t}:${c}`).join(', ') || 'ללא קשרים'}{i < g.duplicates.length - 1 ? ' · ' : ''}</span>)
                      : <span style={{ color: 'var(--muted)' }}>ללא קשרים</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {dedup.reviewGroups.length > 0 && (
            <>
              <h3 style={{ marginTop: 16 }}>לבדיקה ידנית — אותו טלפון, שם שונה ({dedup.reviewGroups.length})</h3>
              <div className="sub">לא ימוזגו אוטומטית — ייתכן שאלה אנשים שונים עם אותו טלפון.</div>
              <div className="tablewrap" style={{ maxHeight: 200 }}>
                <table>
                  <thead><tr><th>טלפון</th><th>שמות</th></tr></thead>
                  <tbody>
                    {dedup.reviewGroups.map((g) => (
                      <tr key={g.key}><td>{g.phone}</td><td className="changes">{g.rows.map((r) => r.name).join(' / ')}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* Dedup summary */}
      {dedupSummary && (
        <div className="card summary">
          <h3>סיכום מיזוג — {dedupSummary.entity === 'leads' ? 'לידים' : 'לקוחות'}</h3>
          <div className="counts">
            <div className="count create"><b>{dedupSummary.merged}</b> קבוצות מוזגו</div>
            <div className="count update"><b>{dedupSummary.deleted}</b> שורות נמחקו</div>
            <div className="count unchanged"><b>{dedupSummary.repointed}</b> קשרים הועברו</div>
            <div className="count missing"><b>{dedupSummary.failed}</b> נכשלו</div>
          </div>
          {dedupSummary.failed > 0 && (
            <div className="err-box">
              {dedupSummary.results.filter((r) => r.error).slice(0, 20).map((r, i) => (
                <div className="result-row err" key={i}>✗ {r.survivor}: {r.error}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Summary */}
      {summary && (
        <div className="card summary">
          <h3>סיכום ביצוע — {summary.target}</h3>
          <div className="counts">
            <div className="count create"><b>{summary.created}</b> נוצרו</div>
            <div className="count update"><b>{summary.updated}</b> עודכנו</div>
            <div className="count unchanged"><b>{summary.skipped}</b> דולגו</div>
            <div className="count missing"><b>{summary.failed}</b> נכשלו</div>
          </div>
          {summary.lookupsAdded > 0 && (
            <div className="warn">נוספו {summary.lookupsAdded} ערכי סטטוס חדשים לטבלאות הלוקאפ (מ-Monday):{' '}
              {Object.entries(summary.lookupDetails || {}).map(([t, vs]) => `${t}: ${vs.join(', ')}`).join(' · ')}</div>
          )}
          {summary.failed > 0 && (
            <div className="err-box">
              {summary.results.filter((r) => r.error).slice(0, 20).map((r, i) => (
                <div className="result-row err" key={i}>✗ {r.name}: {r.error}</div>
              ))}
            </div>
          )}
          <details>
            <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>לוג מלא ({summary.results.length})</summary>
            {summary.results.slice(0, 300).map((r, i) => (
              <div className={'result-row' + (r.error ? ' err' : '')} key={i}>
                {r.error ? '✗' : r.skipped ? '⊘' : '✓'} [{r.op}/{r.side}] {r.name} {r.dbId ? `→ ${r.dbId}` : ''}{r.mondayItemId ? `→ ${r.mondayItemId}` : ''} {r.error || r.skipped || ''}
              </div>
            ))}
          </details>
        </div>
      )}
    </div>
  );
}
