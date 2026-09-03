# תיקוני שירות הסינכרון — 8 דרישות

מסמך זה מסכם את שמונה התיקונים לשירות הסינכרון (Monday ↔ Supabase), מה בוצע בכל אחד, ומה נותר להריץ ידנית (מיגרציות + פרוד). נבדק חי מול **dev/test**.

## עקרון מרכזי
המנוע היה ממפה רק **עמודות סקלריות** (עמודת Monday ↔ שדה DB). שלושת התיקונים הכבדים (5,6,7,8) דרשו יכולות חדשות שנוספו במודול חדש `server/engine/enrich.js` ורצות **רק בכיוון DB → Monday (דחיפה)**:
1. **כותרות מורכבות** — שם פריט Monday מתבנית (`שם לקוח | תאריך ושעה [| רכיב x כמות]`).
2. **קשרים (board_relation)** — קישור פריט-בן לפריט-אב לפי `monday_item_id` של האב.
3. **שדות נגזרים (join)** — FK שמתורגם לערך תצוגה מטבלה קשורה (למשל שם איש מכירות).

---

## מיפוי הדרישות

| # | דרישה | מה בוצע | סוג |
|---|---|---|---|
| **1** | סנכרון לוח אנשי מכירות ↔ `app_users` + טריגר מ-Replit | היעד `salespeople` (לוח `5100631742`) + מיפויים כבר קיימים — **מופעל** ע"י מיגרציה 009. נוסף action `salesperson_upserted` ל-`/api/push` ופרומפט Replit. | SQL + קוד + פרומפט |
| **2** | סיבת הנחה ברמת רכיב (קרדיט) | `credits.discount_reason` (חדש) ↔ `long_text_mm5jd0ae` | מיגרציה 008+009 |
| **3** | סיבת הנחה ברמת עסקה | `deals.discount_reason` (חדש) ↔ `long_text_mm5jxpsv` | מיגרציה 008+009 |
| **4** | הערת איש מכירות לאופרציה → טבלת קרדיטים | **כבר עובד** — `credits.salesperson_note` ↔ `long_text_mkvcfdhq` (מיפוי קיים ופעיל). רק לוודא ש-Replit ממלא את השדה. | קיים |
| **5** | עדכון כל הקשרים בסינכרון עסקה | קוד `enrich.js` — נכתב בכתיבת פריט לבן: (א) קרדיט→עסקה `board_relation_mkv7apeh`, (ב) תשלום→עסקה `board_relation_mktnjr7z`, (ג) משימת-תיאום→עסקה `board_relation_mm5jv7cn`. | קוד |
| **6** | שמות `שם לקוח \| תאריך ושעה` (עסקאות/תשלומים/קרדיטים; קרדיט גם `+ רכיב x כמות`) | קוד `enrich.js` — כותרת מתבנית לפי `created_at` (שעון ישראל). המספר העסקי נשאר ב-DB בלבד. | קוד |
| **7** | עמודת סטטוס "איש מכירות" בתשלומים = שם מלא | קוד `enrich.js` — `payments.salesperson_id` → `app_users.full_name` → `color_mm03ctf0` (סטטוס; תווית נוצרת אם חסרה). | קוד |
| **8** | לינק איש מכירות בתשלום לפי id | קוד `enrich.js` — `payments.salesperson_id` → `board_relation_mm5js0ns`. | קוד |

---

## מה נבדק חי (dev)
- ✅ **תשלום → עסקה** (5ב): פריט תשלום קושר לפריט העסקה הנכון (`D-2026-001559`).
- ✅ **סטטוס איש מכירות** (7): נכתב "Sales Demo" לעמודת הסטטוס (התווית נוצרה אוטומטית).
- ✅ **קרדיט → עסקה** (5א): נבדק שהמנוע מזהה קשר קיים ולא כותב מחדש (guard נגד churn).
- ✅ **כותרות** (6): `בני עמדי | 2026-07-23 15:26` (תשלום), `אלי קשתי | 2026-07-10 16:13 | אלי קשתי - 10 טאמבנייל x 10` (קרדיט).
- ✅ **guard חוצה-סביבות**: לינק איש מכירות (8) **דולג** נכון כי אנשי המכירות ב-dev מקושרים ללוח ה**פרוד** (`5088502347`) ולא ל-dev — המנוע לא כותב id של סביבה אחרת. אחרי הפעלת סנכרון אנשי-מכירות (מיגרציה 009) והרצת push, הם יקושרו ל-dev והלינק ייכתב.

> הערה טכנית: עמודות `board_relation` ב-Monday מדווחות `text/value=null` — הערך האמיתי ב-`linked_item_ids`. `getItem` עודכן לשלוף את השדה הזה כדי לזהות "כבר מקושר".

---

## סדר הרצה (test ואז production)

**1. מיגרציות DB (הרץ ב-Supabase SQL Editor):**
```
008_discount_reason.sql            -- מוסיף deals.discount_reason + credits.discount_reason
009_control_plane_sync_fixes.sql   -- מפעיל salespeople + מיפויי סיבת-הנחה (מריץ אחרי 008!)
010_salespeople_mapping_fix.sql    -- אנשי-מכירות דו-כיווני + כיבוי מיפוי role↔status השבור
```

> **חשוב לגבי אנשי-מכירות (010):** היעד מוגדר **דו-כיווני מלא** — Replit→DB (ישיר), DB→Monday (push על `salesperson_upserted`), ו-Monday→DB (משיכה מתוזמנת + webhook). המיפוי `role↔status` **כובה** כי עמודת "סטטוס" בלוח (פעיל/לא פעיל) היא `is_active`, לא ה-enum `role` — היא הייתה מפילה את המשיכה על ה-enum ודוחפת תוויות זבל. שאר השדות (`full_name`, `phone`, `email`) מסונכרנים בשני הכיוונים. **עמודת הסטטוס פעיל/לא-פעיל** מוזנת מ-`app_users.is_active` בקוד (`enrich.js`, שדה computed: `true→"פעיל"`, `false→"לא פעיל"`) בכיוון DB→Monday — נכתבת ביצירת איש-מכירות ובכל עדכון שנוגע גם בשם/טלפון/אימייל. **מגבלה:** החלפת `is_active` בלבד (בלי שינוי שדה ממופה אחר) עלולה להידלג ע"י מניעת-הלולאה עד שינוי נוסף. הכיוון ההפוך (Monday status→is_active) לא ממופה (דורש טרנספורם תווית→boolean). **לסנכרון בזמן-אמת מ-Monday** (לא רק פעמיים ביום): להגדיר Monday webhook על לוח אנשי-המכירות → `/api/hooks/monday`.

**2. פריסת הקוד** — כבר ב-`main`; Railway עושה auto-deploy. הקבצים שהשתנו:
`server/engine/enrich.js` (חדש), `server/engine/syncSingle.js`, `server/engine/apply.js`,
`server/connectors/monday.js`, `server/index.js`.

**3. בדיקה** — הרץ push של עסקה (cascade) מ-Replit/`/api/push` ובדוק בלוחות Monday: כותרות, קשרים, סטטוס איש מכירות, סיבות הנחה.

**4. Replit** — חבר את הקריאה `salesperson_upserted` במסך אנשי המכירות (ראה `PROMPT_replit_sync.md`).

### מעבר ל-production
- הרץ 008 + 009 על ה-DB של הפרוד, אבל **קודם ודא ש-`environment='production'`** ב-009 (החלף מ-`test`).
- **ודא שמזהי העמודות ב-Monday של הפרוד זהים** לאלה שבקוד (`enrich.js`) וב-009:
  - קשרים (`board_relation_*`) — זהים dev↔prod (dev שוכפל מפרוד).
  - עמודות **חדשות** שצריך לאמת בפרוד: `long_text_mm5jxpsv` (סיבת הנחה עסקה), `long_text_mm5jd0ae` (סיבת הנחה קרדיט), `board_relation_mm5js0ns` (לינק איש מכירות), `board_relation_mm5jv7cn` (משימה→עסקה), `color_mm03ctf0` (סטטוס איש מכירות).
  - **אומת 2026-09-03** (`prod_bootstrap/probe_relation_columns.mjs`): שתי עמודות קיבלו מזהה **שונה** בפרוד — לינק איש מכירות בתשלום הוא `board_relation_mm5jmf0w`, ומשימה→עסקה הוא `board_relation_mm5jveeq`. `enrich.js` מחזיק עכשיו מזהה לכל סביבה (`{ test, production }`); עד אז שני הקישורים האלה נפלו בשקט בפרוד. שם משימת תיאום הוא מעכשיו "לקוח | טקסט המשימה" (הלקוח נלקח מהעסקה), ומתעדכן גם בעדכון.
  - אם מזהה שונה בפרוד — עדכן ב-`server/engine/enrich.js` (`PUSH_CONFIG`) וב-009 בהתאם.
- ודא שאנשי המכירות מסונכרנים ומקושרים ללוח הפרוד לפני שתסמוך על לינק איש-מכירות (8).

---

## מגבלות ידועות
- **Backfill של קשרים לפריטים קיימים** נעשה על **יצירה** (עסקה/קרדיט/תשלום חדשים) ובדחיפת `db_to_monday` ידנית מה-UI. פריט קיים שכבר סונכרן במלואו ורק חסר לו קשר — לא יעודכן אוטומטית ע"י webhook בזמן אמת (מנגנון ה-echo/loopGuard מדלג עליו). כדי לקשר פריטים היסטוריים: הרץ דחיפה ידנית (`direction: db_to_monday`) מה-UI.
- **סיבת הנחה** נבדקת רק אחרי הרצת 008 (העמודה חייבת להתקיים לפני שהמיפוי פעיל, אחרת ה-diff נכשל).
- שעון הכותרות מקובע ל-`Asia/Jerusalem`.

---

## איש מכירות ראשון (סוגר) על הלקוח — 2026-09-03

**כלל עסקי:** על כל לקוח נשמר איש המכירות **הראשון** שסגר אותו (`customers.first_salesperson_id`),
נקבע פעם אחת בעסקה הראשונה ולא נדרס; איש המכירות של כל עסקה נשאר על העסקה (`deals.salesperson_id`).
לקוחות קיימים → רם (backfill).

**DB (אפליקציה):** `Bist-Production-System/lib/db/sql/customers/01_first_salesperson_id.sql` — עמודה + FK + backfill.
חובה להריץ **לפני** פריסת קוד האפליקציה (Drizzle מרחיב SELECT לרשימת עמודות מפורשת).

**Monday:** עמודת **סטטוס** "איש-מכירות-ראשון" בלוח הלקוחות, נוצרה ידנית ב-03/09 בשתי הסביבות
ולכן עם מזהה שונה לכל סביבה: dev (`5100631736`) `color_mm6v2rkc`, פרוד (`2091985169`) `color_mm6vpfg4`.
הקוד מחזיק `{ test, production }` (כמו לינק איש מכירות בתשלום). למה סטטוס ולא Connect boards: ה-API של Monday
מסרב ליצור `board_relation` ("This column type is not supported yet in the API"), ותווית-שם היא אותו דפוס
כמו "איש מכירות" בלוח העסקאות.

**מנוע:**
- `enrich.js` `PUSH_CONFIG.customer.derived` — DB→Monday: `first_salesperson_id` → `app_users.full_name` → תווית סטטוס (נוצרת אם חסרה).
- `enrich.js` `INBOUND_DERIVED.customer` + `resolveInboundDerived` — Monday→DB: תווית → `app_users` לפי `full_name` (רק התאמה יחידה; תווית ריקה/לא-מוכרת/כפולה לא נוגעת ב-FK).
- `syncSingle.js` `syncDealGraph` — הלקוח **תמיד** רוכב על ה-cascade של `deal_created` (נפתר מ-`deals.customer_id`), לא רק כשהאפליקציה שולחת `customerId`. בלי זה החותמת על לקוח קיים לא הייתה מגיעה ללוח.

**Backfill ל-Monday:** ה-backfill ב-SQL לא מפעיל push. כדי שהלקוחות הקיימים יראו "רם" בלוח — דחיפה ידנית
`db_to_monday` ליעד `customers` מה-UI (ה-derived רץ גם במסלול הזה).
