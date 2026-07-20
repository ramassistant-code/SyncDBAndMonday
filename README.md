# SyncDBAndMonday

מנוע סינכרון + מסך ניהול בין Supabase (DB) ל-Monday.com, בנוי **על גבי ה-control-plane הקיים**
(`monday_export_targets`, `monday_export_field_mappings`, `monday_entity_links` ...).

ראה [PLAN.md](PLAN.md) לתוכנית המלאה ולממצאי החקירה החיה.

## הרצה

```powershell
# 1. Backend (פורט 4000)
npm install
npm start            # node server/index.js

# 2. Frontend (פורט 5173, עם proxy ל-4000)
cd web
npm install
npm run dev
```

פתח http://localhost:5173

## סביבות (`.env.local`)

| סביבה | DB | Monday |
|---|---|---|
| פיתוח (`test`) | `PUBLIC_SUPABASE_URL` + `SUPABASE_DEV_SECRET` | `MONDAY_DEV_API` (חשבון bist3) |
| ייצור (`production`) | `SUPABASE_PROD_URL` + `SUPABASE_PROD_SECRET` | `MONDAY_PROD_API` (חשבון bist-cast) |

ראה `.env.example`. **ייצור עדיין לא מוגדר** — פרויקט ה-Supabase הישן מושהה; יש להפעילו מחדש ולהזין מפתחות.

## איך זה עובד

המסך עובד בשלושה מצבים. **הסדר המומלץ לפני סינכרון ראשון של ישות:**

1. **מיזוג כפילויות** — לנקות כפילויות פנימיות ב-DB.
2. **יישור קו** — לקשר שורות קיימות לפריטי לוח הפיתוח.
3. **סינכרון** — משיכה/דחיפה שוטפת.

### מצב "מיזוג כפילויות" (dedup) — לקוחות / לידים (בורר ישות)
ממזג **רק** שורות שבהן גם הטלפון וגם השם זהים (שמרני). לכל מיזוג: מעביר את כל הקשרים לשורה
השורדת (המוקדמת ביותר), ואז מוחק את הכפולה. שורות עם אותו טלפון ושם **שונה** מוצגות לבדיקה
ידנית ולא נמחקות (עלולות להיות אנשים שונים). preview→אישור.

מפת הקשרים לכל ישות מוגדרת ב-`server/engine/dedup.js` (`ENTITY_DEDUP`):
- **לקוחות**: `deals`, `payments`, `credits`, `quotes`, `special_tasks`, `leads.linked_customer_id`
- **לידים**: `customers.lead_id`, `deals.lead_id`, `quotes.lead_id`, `special_tasks.lead_id`

> הערה: המנוע מדפדף על כל השורות (PostgREST מגביל תגובה בודדת ל-1000) — קריטי לטבלאות גדולות
> כמו `leads` (2,813), `deals`, `payments`.

### טבלאות lookup (סטטוסים)
עמודות סטטוס בלידים/לקוחות מוגבלות ב-FK לטבלאות `lookup_*` (מפתח `value`): `lookup_lead_status`,
`lookup_answer_status`, `lookup_capture_attempt`, `lookup_lead_source`, `lookup_rejection_reason`,
`lookup_customer_type`, `lookup_industry`, `lookup_contact_status`. בעת סינכרון Monday→DB, אם Monday
מכיל ערך סטטוס שלא קיים בטבלת הלוקאפ, המנוע **מוסיף אותו אוטומטית** (Monday = מקור האמת) כדי
למנוע כשל FK, ומדווח על כך בסיכום. המיפוי מוגדר ב-`LOOKUP_MAP` ב-`server/engine/apply.js`.

### מצב "יישור קו" (reconciliation) — פעם אחת לכל יעד
נחוץ כי שורות ה-DB נזרעו מ**ייצור** ומחזיקות `monday_item_id` של לוח הייצור, בעוד לוח
הפיתוח הוא עותק עם מזהים אחרים. בלי יישור, הסינכרון הראשון היה יוצר כפילות לכל רשומה.

1. מתאים כל פריט בלוח הפיתוח לשורת DB קיימת לפי מפתח טבעי (customers: `phone → email → name`).
2. מציג **יקושרו** (התאמה חד-משמעית) / **לבדיקה** (עמום — מעדיף את שורת הייצור, השאר ידני) / **חדשים**.
3. באישור: מעדכן `monday_board_id` + `monday_item_id` בשורות המותאמות — **רק קישור, לא נוגע בנתונים**.

### מצב "סינכרון" — שוטף
1. **בחירת סביבה** (test/production) — קובעת credentials + מסננת `environment` ב-control-plane.
2. **בחירת כיוון** (בורר גלובלי): `Monday → DB` / `DB → Monday` / דו-כיווני.
3. **הצג הבדלים** — המנוע שולף משני הצדדים, מריץ diff לפי `monday_export_field_mappings`, ומציג
   חדשים / שינויים (שדה-אחר-שדה) / חסרים.
4. **אישור וביצוע** — כותב לצד היעד. בסביבת test, Monday הוא מקור האמת וה-identity הוא
   `monday_item_id` של לוח היעד; בעת יצירה נכתב הקישור בחזרה ל-DB (אידמפוטנטי מהריצה השנייה).
5. **סיכום** — נוצרו / עודכנו / דולגו / נכשלו + לוג מלא.

## מבנה

```
server/                Node/Express API
  connectors/          supabase.js (PostgREST), monday.js (GraphQL)
  engine/              diff.js, apply.js, compare.js, entities.js
  controlPlane.js      קריאת targets + field mappings
  config.js            הגדרת סביבות
web/                   React (Vite) — מסך הניהול
```

## כיסוי ישויות (יישור, סביבת test)

| ישות | יישור | הערה |
|---|---|---|
| לקוחות | ✅ | phone→email→name |
| לידים | ✅ | phone→email→name |
| קרדיטים | ✅ | לפי `credit_name` (854 קישור) |
| עסקאות / תשלומים | ✅ יישור מורכב | סכום + שם לקוח בכותרת. עסקאות: 1195 קישור; תשלומים: 1222 קישור. |

זיהוי היישור:
- **לקוחות/לידים** — מפתח טבעי (phone→email→name).
- **קרדיטים** — `credit_name` (עמודת ה-name ב-Monday).
- **עסקאות/תשלומים** — **יישור מורכב** (`alignComposite` ב-align.js): סכום מעוגל (עמודת numeric ממופה) + שם הלקוח (מ-`customer_id`→`customers.name`) שמופיע ככותרת הפריט. חד-משמעי→קישור, דו-משמעי→לבדיקה. ה-DB כבר מחזיק את ה-FK הנכונים — היישור רק מקשר, לא יוצר. אחרי יישור: סינכרון = עדכונים בלבד (יצירות מדולגות על FK אב).

## סטטוס

- ✅ שלב א' (סינכרון ידני מבוקר) — connectors, diff, apply, יישור קו, מיזוג כפילויות. מאומת חי מול test.
- ⬜ שלב ב' (מנוע אוטומטי) — worker ל-`monday_sync_outbox` + polling; הפעלה לייצור.
