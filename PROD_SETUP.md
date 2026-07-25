# הקמת סביבת ייצור — תוכנית שלבים

מסמך תכנון להעלאת מערכת הסינכרון Monday ↔ Supabase לייצור.
נכתב על בסיס המצב הקיים (dev/test עובד חי) + שתי החלטות שהתקבלו:

- **כיוון סינכרון בהתחלה:** `Pull-only` — רק `Monday → DB` מתוזמן + push ידני/מבוקר. דו-כיווני אוטומטי רק אחרי חיווט מניעת-לולאה (`loopGuard`).
- **Supabase ייצור:** פרויקט **חדש** (לא מחייה את המושהה `czjiyqhozzkhiuruepxh`), נזרע מדאמפ של הפרויקט הישן.

---

## הארכיטקטורה (תזכורת)

```
   ┌────── Replit (טפסים, DB-only) ─────┐
   │  לקוח/ליד/עסקה → כותב ל-Postgres    │
   └───────────────┬────────────────────┘
                   ▼ (webhook / push ידני — שלב מאוחר)
   ┌────── n8n Cloud ──────┐      ┌──── Railway (מנוע Node) ────┐
   │ Schedule 08:00/13:00  │─HTTP→│ /api/sync/full {env:prod}   │→ Supabase(prod) + Monday(bist-cast)
   │ (+key x-api-key)      │      │ /api/push, /api/hooks/monday │
   └───────────────────────┘      └──────────────────────────────┘
```

- **מנוע** = פרמטרי לפי `env` בגוף הבקשה (`test` / `production`). אותו deploy יכול לשרת את שתי הסביבות אם כל ה-Variables קיימים.
- **מקור אמת בייצור:** Monday (חשבון `bist-cast`, id 24473879, 94 לוחות).
- **מזהי לוחות ליבה (prod):** לקוחות `2091985169`, לידים `5088502309`, עסקאות `2091985867`, תשלומים `2091987777`, קרדיטים `2091986228`, שעות-אולפן `2118939888`.

---

## שלב 0 — הכנה (לפני שנוגעים בענן)

- [ ] **רוטציית סודות** — לפני שמזינים מפתחות אמיתיים לענן: לחדש סיסמת DB + secret keys של Supabase ולהנפיק מחדש טוקני Monday (יש כרגע בקבצי `.env` בתיקיות מסונכרנות בטקסט גלוי). לוודא ש-`.env*` ב-gitignore (כן).
- [ ] **`SYNC_API_KEY` ייצור** — לייצר מחרוזת אקראית ארוכה חדשה (לא לשתף עם test).
- [ ] **החלטה — שירות Railway:** אותו deploy עם Variables של prod (פשוט, מומלץ), או שירות Railway נפרד לייצור (בידוד מלא, בטוח יותר, כפול תחזוקה). ברירת מחדל בתוכנית: **אותו שירות + הפרדה לפי `env`**.
- [ ] **גיבוי** — לוודא שיש גיבוי/דאמפ עדכני של הפרויקט המושהה לפני כל פעולה.

---

## שלב 1 — SUPABASE (ייצור)

יעד: פרויקט Supabase ייצור חדש, נקי, עם סכימה + control-plane + נתונים אמיתיים, ומיגרציות 003–007 מוחלות.

1. **הקמת פרויקט חדש** ב-Supabase (region קרוב, tier בתשלום — לא free, כדי שלא ייכנס להשהיה). לשמור את `Project URL` ואת ה-`service_role`/`secret` key.
2. **חילוץ הנתונים מהפרויקט הישן** (`czjiyqhozzkhiuruepxh`):
   - להפעיל אותו זמנית (resume) ולקחת `pg_dump` מלא (סכימה + נתונים + control-plane `monday_export_targets`/`field_mappings`/`entity_links`).
   - זה מביא איתו את ה-`monday_item_id` שכבר מצביעים על **לוחות הייצור** (בניגוד ל-dev) → בייצור **אין drift**, ולכן "יישור קו" צפוי להיות כמעט no-op.
3. **טעינה לפרויקט החדש** — `pg_restore`/`psql` אל הפרויקט החדש.
4. **הרצת מיגרציות בסדר** (כולן idempotent, אבל 003/004 כוללות ניקויים ואילוצי NOT NULL — לוודא נתונים לפני):
   - `003_lookup_tables.sql` — 8 טבלאות lookup + FK + מיזוג `ליד חדש`→`חדש` + תיקון industry מלוכלך.
   - `004_schema_fixes.sql` — הסרת `salesperson_user_id`, NOT NULL על `customer_id`/`deal_id`. **לפני:** לבדוק בייצור שאין nulls בעמודות האלה (בייצור ייתכן מצב שונה מ-dev).
   - `005_coordination_tasks_monday_link.sql` — עמודות linkage ל-`deal_coordination_tasks`.
   - `006` + `007` — הוספת ערכי enum חסרים (`בעבודה`, `שולם`, `שולם חלקית`). **סיכון ייצור:** לוחות הייצור עשירים יותר ועלולים להחזיק **ערכי enum נוספים** שחסרים (`deal_execution_status`, `deal_payment_status`, ואולי enums אחרים: `payment_status`/`payment_method`/`payment_purpose`/`credits.status`). ראה שלב 5 (ריצת יבש) לאיתור מראש.
5. **בדיקת control-plane** — לוודא שקיימות שורות `monday_export_targets` עם `environment = 'production'` המצביעות על לוחות ה-prod הנכונים, ו-`field_mappings` תואמים. אם הדאמפ הישן החזיק רק `test` — לשכפל את מיפויי היעדים לסביבת production עם ה-board ids של ייצור.
6. **סודות** — לשמור בצד: `SUPABASE_PROD_URL`, `SUPABASE_PROD_SECRET` (לשלב Railway).

> הערה: לא לפתוח כתיבה חזרה ל-Monday עדיין. שלב זה הוא רק הכנת ה-DB.

---

## שלב 2 — REPLIT (אפליקציית הטפסים, DB-only)

יעד: אפליקציית הזנת רשומות (לקוח/ליד/עסקה) שכותבת **רק** ל-Postgres של ייצור. **אסור** שתקרא ל-Monday — שדות מקושרים = FK ב-Postgres, קומבואים נטענים מטבלאות קשורות דרך PostgREST.

1. **בסיס הפרומפטים** — `PROMPT_customers.md`, `PROMPT_deals.md`, `PROMPT_leads.md` (DB-native). `REPLIT_PROMPT_linked_fields.md` הישן (מבוסס-Monday) מיושן לצורך ה-UI.
2. **הצבעה ל-Supabase ייצור** — להזין ב-Replit את `PUBLIC_SUPABASE_URL` (prod) + מפתח קריאה/כתיבה מתאים. לוודא שהטפסים טוענים קומבואים מ-`lookup_*` (`select=value,label&is_active=eq.true&order=sort_order`) ומ-FK (customers/leads=`name`, app_users=`full_name`, quotes=`quote_number`).
3. **הרשאות/RLS** — להחליט על מדיניות גישה: אם ה-app ניגש עם anon key צריך RLS מתאים; אם עם service key — לוודא שהוא לא נחשף בצד לקוח (עדיף שרת-ביניים). **לא להזין service key בקוד צד-לקוח.**
4. **אימות שדות** — enums אמיתיים (`deals.payment_status/execution_status`, `payments.status/payment_method/payment_purpose`, `credits.status`) מול רשימות סטטוס-טקסט (`lookup_*`). תשלומים/קרדיטים הם **ילדים של עסקה** (`deal_id`) — לא קומבו בטופס העסקה.
5. **Deploy** ב-Replit (Reserved VM אם רוצים always-on לצד ה-webhook העתידי).
6. **בדיקה** — ליצור רשומת בדיקה בייצור, לוודא שהיא נכתבת נכון ל-Postgres (בלי מגע ב-Monday). לנקות רשומות בדיקה אחרי.

---

## שלב 3 — השירות ב-RAILWAY (מנוע)

יעד: המנוע חשוף לציבור, מאובטח, ויודע לשרת `env:production`.

1. **Variables (Settings → Variables)** — להוסיף לצד קיימי ה-test:
   - `SUPABASE_PROD_URL`, `SUPABASE_PROD_SECRET`, `MONDAY_PROD_API` (כבר קיים ב-`.env.local`).
   - `SYNC_API_KEY` — המחרוזת החדשה משלב 0. **חובה** — בלעדיה ה-API פתוח.
   - `PORT` — Railway מזריק אוטומטית.
2. **פריסה** — auto-deploy מ-`main` (כבר מוגדר; אין railway CLI). `railway.json` מגדיר `startCommand`, healthcheck `/api/health`, restart on-failure.
3. **בדיקות עשן**:
   - `GET /api/health` → 200 מהיר.
   - אימות מפתח: קריאה ללא/עם `x-api-key` שגוי → 401; עם נכון → 200.
   - `GET /api/targets?env=production` → מחזיר את יעדי הייצור (מאמת ששלב 1.5 תקין).
4. **בידוד** — לוודא שקריאות `{env:"test"}` לא נוגעות ב-prod ולהיפך (המנוע בוחר credentials לפי `env`). אם בחרו שירות Railway נפרד — לפרוס אותו כאן עם Variables של prod בלבד.

---

## שלב 4 — תהליך הסנכרון ב-N8N

יעד: תזמור ייצור. בשלב זה — **Pull-only**: רק סינכרון מלא מתוזמן `Monday → DB`. push ו-Monday-webhook נדחים.

1. **שכפול ה-workflow המנוצח** — הבסיס הוא `Scheduled Full Sync 08:00 & 13:00` (`Lld5qURxnGnd11nB`) שעבד חי ב-test (per-target loop, retry, timeout 180s, Gmail alert). לשכפל לעותק **PROD** נפרד:
   - `Get Targets`: `GET {RAILWAY}/api/targets?env=production`.
   - סינון `is_active && inbound_enabled` (בייצור צפויים 6+ יעדים: customers/deal/leads/payments/coordination_tasks/credits).
   - `Sync One Target`: `POST /api/sync/full` עם `{env:"production", targetKeys:[<key>]}`, `onError=continueErrorOutput`, retry×2, timeout 180000.
   - `Notify Failure`: Gmail ל-`eyal.amedi@gmail.com` על כל יעד שנכשל (`totals.failed>0` או `ok=false`).
2. **credentials ב-n8n** — Supabase/Monday/Header Auth כבר קיימים; לוודא ש-`SYNC_API_KEY` בהדר תואם לזה שב-Railway prod. Gmail OAuth2 כבר מחובר.
3. **הרצת בדיקה ידנית** (Execute Workflow) על prod **לפני הפעלת הלו"ז** — לבדוק שאין timeout, לאתר כשלי enum/FK (ראה שלב 5).
4. **הפעלה** — `active:true` רק אחרי שהריצה הידנית נקייה. הלו"ז: 08:00 + 13:00.
5. **נדחה לשלב מאוחר (אחרי loopGuard):**
   - תהליך ב' — Supabase webhook על `customers/leads/deals` → `POST /api/push` (DB→Monday).
   - תהליך ג' — Monday webhook → `POST /api/hooks/monday` (Monday→DB בזמן אמת).
   - **חובה לפני הפעלת שני הכיוונים אוטומטית:** לחווט את `loopGuard.js` לתוך נתיבי push/webhook (מניעת הד/לולאה). כבר בנוי ובדוק כ-unit, טרם מחובר לכל הנתיבים.

---

## שלב 5 — ריצת יבש, אימות ו-Go-Live

**סדר עבודה לכל ישות לפני סינכרון שוטף:** `dedup → align → sync` (בייצור align צפוי כמעט-ריק כי אין drift, אבל מריצים כדי לאמת).

1. **ריצת יבש (preview) לכל יעד** — `POST /api/sync/preview {env:"production", direction:"monday_to_db", targetKey:<key>}` על כל ישות. מטרה: לאתר מראש **ערכי enum חסרים**, כשלי FK, וכפילויות — לפני כתיבה אמיתית.
2. **מיזוג כפילויות** (customers/leads) — מצב "מיזוג כפילויות" ב-UI, preview→אישור. שמרני (טלפון+שם זהים בלבד).
3. **יישור קו** — להריץ ולאמת שהתוצאה ~"alreadyAligned" (מאשש שאין drift בייצור).
4. **סינכרון ראשון מבוקר** — להריץ ידנית מה-UI לכל ישות (`Monday → DB`), לבדוק סיכום: נוצרו/עודכנו/דולגו/נכשלו + לוג. לתקן enums חסרים ע"י מיגרציה נוספת (`ALTER TYPE ... ADD VALUE` מחוץ ל-txn) לפי הצורך.
5. **הפעלת הלו"ז ב-n8n** (שלב 4.4).
6. **ניטור** — לעקוב אחרי ריצות n8n (execution history) והתראות המייל ביומיים הראשונים.

### נקודות סיכון ייצור לשים לב אליהן
- **enums חסרים** — הכי סביר לצוץ בייצור (יותר ערכים מ-dev). לאתר ב-preview, לא בכתיבה.
- **כתיבת title על CREATE בלבד** — כבר תוקן (commit 121dbf4): מפתחות עסקיים (`payment_number`/`deal_number`) לא נדרסים ע"י כותרת Monday בעדכון.
- **NOT NULL / ילדים רלציוניים** — credits/deals/payments: עדכונים עובדים, יצירות מדולגות אם אין אב. בייצור האבות אמורים להתקיים (relations מאוכלסים) — לוודא.
- **מפתחות כפולים** — מסווגים כ-`skipped` ולא `failed` (commit b8132ec).
- **loopGuard** — לא להפעיל דו-כיווני אוטומטי לפני חיווט מלא.

---

## רשימת פעולות שהמשתמש צריך לבצע בעצמו (לא ניתן להאצה מכאן)
- הקמת פרויקט Supabase ייצור + resume/דאמפ מהישן.
- הזנת Variables ב-Railway וב-Replit.
- הזנת/רענון credentials ב-n8n.
- הרצות אישור (apply) ב-UI — אף פעם לא אוטומטית ללא אישור.
- רוטציית הסודות.

## מצב נוכחי (בסיס ההתחלה)
- ✅ test עובד חי end-to-end: מנוע על Railway, n8n workflow פעיל (08:00/13:00), UI (סינכרון/יישור/מיזוג).
- ✅ מיגרציות 003–007 רצו ואומתו ב-**dev**.
- ⬜ ייצור: פרויקט Supabase חדש, Variables, workflow prod, ריצת יבש, go-live.
- ⬜ loopGuard לחיווט מלא לפני דו-כיווני אוטומטי.
