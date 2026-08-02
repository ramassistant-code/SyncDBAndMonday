# תוכנית עבודה — תיקוני סנכרון (2026-08-02)

סיכום כל התיקונים שבוצעו בסשן הזה + הצעדים שנותרו, מסודר לפי מסלולים. סומן: ✅ בוצע, ⬜ נותר.

**עיקרון מפתח:** ייצור כרגע **pull-only** (רק Monday→DB). לכן:
- **מסלול A (שדות הצעת מחיר = inbound)** — משפיע על ייצור מיד עם ה‑SQL.
- **מסלול B (קישורי enrich = outbound / DB→Monday)** — *לא ירוץ בייצור* עד שמפעילים את מסלול ה‑push/אפליקציה שם. פריסה לייצור בטוחה אך רדומה עד אז.

---

## מסלול A — שדות "ברמת הצעת מחיר" (Monday → DB)

**מה:** 3 שדות שלא סונכרנו כי לוחות האב (`products`, `component_operations`) היו `is_active=false` + `inbound_enabled=false`. המיפויים והעמודות ב‑DB תקינים; החסם היה ברמת ה‑target.
- `products.quote_description_default` — "תיאור מוצר ברמת הצעת מחיר"
- `products.quote_notes_default` — "הערות למוצר ברמת הצעת מחיר"
- `components.quote_description_default` — "תיאור רכיב ברמת הצעת מחיר"

**גם קובץ:** `migrations/011_enable_products_components_inbound.sql`

- ✅ **A1 (test):** הורץ `migration 011` (env='test'). אומת חי — הלוחות כעת is_active/inbound/outbound=true, השדות ברשימת הסנכרון.
- ⬜ **A2 (test) — אימות קצה‑לקצה:** לערוך אחד השדות ב‑Monday בלוח מוצרים/רכיבים (test), ולוודא שהערך נכנס לעמודה ב‑DB. (כרגע Monday ו‑DB תואמים, אז אין דלתא — צריך ליצור שינוי אמיתי כדי לראות זרימה.)
- ⬜ **A3 (production) — הרצת SQL:** להריץ ב‑BIST‑PROD:
  ```sql
  UPDATE public.monday_export_targets
     SET is_active = true, inbound_enabled = true, updated_at = now()
   WHERE environment = 'production'
     AND target_key IN ('products', 'component_operations');
  ```
  ⚠️ לפני: זה מפעיל את **כל** השדות הממופים בלוחות האלה, מפעיל outbound, ומכניס אותם לסנכרון המתוזמן של ייצור (08:00/13:00).
- ⬜ **A4 (production) — מיידיות (רשות):** אין webhook רשום בייצור למוצרים/רכיבים (רק לקוחות/לידים/אנשי מכירות). עדכון ייכנס רק בסנכרון המתוזמן. אם רוצים מיידי — לרשום webhook לשני הלוחות (`prod_bootstrap/register_webhooks.mjs` כתבנית).

---

## מסלול B — קישורי DB → Monday (`server/engine/enrich.js`)

**מה:** הוספת קישורים/שדות נגזרים בדחיפה DB→Monday שהמנוע הסקלרי לא ידע לבטא:
- עסקה → **איש מכירות** (status `color_mktwdp8c`) — `salesperson_id → app_users.full_name`
- עסקה → **לידים** (relation `board_relation_mm3twpfx`) — `deals.lead_id`
- לקוח → **ליד מקושר** (relation `board_relation_mkzm5f4f`) — `customers.lead_id`

- ✅ **B1:** קוד `enrich.js` עודכן (בעץ העבודה).
- ✅ **B2 (test):** אומת חי — עסקה D‑2026‑001548: "איש מכירות" null→"Sales Demo" דרך `syncItemToMonday` האמיתי. לקוח מקושר — קישור יציב (noop).
- ✅ **B3 (prod):** מזהי כל 3 העמודות אומתו קיימים בלוחות הייצור (זהים dev↔prod).
- ⬜ **B4 — commit + push ל‑main:** מפעיל Railway auto-deploy ל‑**dev**. (טעון `gh auth setup-git` אם ה‑push נכשל.)
- ⬜ **B5 (dev) — אימות אחרי deploy:** דחיפה חיה על עסקה עם `salesperson_id`/`lead_id` דרך `/api/push {action:'deal_updated', id:<uuid>}` — לוודא שהעמודות מופיעות.
- ⬜ **B6 (production) — פריסה:** מיזוג `main → production` ו‑push (מודל ה‑promotion של הפרויקט):
  ```bash
  git checkout production && git merge main && git push && git checkout main
  ```
  ⚠️ הקוד ירוץ בייצור **רק** כשמסלול ה‑push/אפליקציה יופעל שם (ייצור pull-only כרגע). עד אז — בטוח אך רדום.
- ⬜ **B7 — הסתייגות תוויות "איש מכירות":** זו עמודת status; ה‑`full_name` נכתב כתווית (`create_labels_if_missing`). לוודא ש‑`full_name` תואם לתוויות הקיימות בלוח (אביאל/רם/קורן) — אחרת ייווצרו תוויות כפולות.

---

## מסלול C — פערי נתונים במעלה הזרם (Replit / אפליקציה) — **הבעיה הגדולה**

התיקונים במסלול B **משקפים FK קיים** — הם לא ממציאים נתונים. הבדיקה החיה (test) גילתה:
- `deals.salesperson_id` מאוכלס ב‑**~5%** (11/234) מהעסקאות.
- `deals.lead_id` ב‑**~6%** (15/234).
- `customers.lead_id` ב‑~64% (14/22).
- חלק מהלידים ללא `monday_item_id` (לא נדחפו ל‑Monday) → הקישור "ליד מקושר" לא ייווצר עד שהליד ב‑Monday.

- ⬜ **C1:** לוודא ש‑Replit ממלא `deals.salesperson_id` בעת יצירת עסקה.
- ⬜ **C2:** לוודא ש‑Replit ממלא `deals.lead_id` ו‑`customers.lead_id` (הקישור לליד המקורי) בעת יצירת עסקה/לקוח ראשון.
- ⬜ **C3:** לוודא שלידים נדחפים ל‑Monday (יש `monday_item_id`).
- ⬜ **C4 — backfill היסטורי:** קישור/סטטוס על רשומות שכבר מסונכרנות מדולג ע"י ה‑echo-guard עד ששדה סקלרי משתנה. לרשומות קיימות — דחיפה ידנית (UI db_to_monday) או שינוי סקלרי כלשהו יפעיל את ה‑backfill.

---

## סדר מומלץ
1. **A2** (אימות test של שדות הצעת מחיר) →
2. **B4 + B5** (deploy ל‑dev + אימות enrich) →
3. **C1–C3** (תיקון מילוי הנתונים ב‑Replit — בלי זה B נשאר תיאורטי) →
4. **A3** (הפעלת שדות הצעת מחיר בייצור, עם ההסתייגויות) →
5. **B6** (פריסת enrich לייצור — רק כשמסלול push בייצור פעיל) + **B7** (תוויות).

## סטטוס git נוכחי
```
 M server/engine/enrich.js              ← מסלול B (לא committed)
?? migrations/011_...inbound.sql        ← מסלול A (כבר הורץ ב-test DB)
```
