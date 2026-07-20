# תוכנית סינכרון DB ↔ Monday — SyncDBAndMonday

> נכתב על בסיס חקירה **חיה** של הסביבות (19/07/2026), לא על בסיס קבצים סטטיים.

## 0. עובדות שאומתו חי

**Monday**
- ייצור: חשבון `bist-cast` (id 24473879, pro) — 94 לוחות. ✅ מחובר.
- פיתוח: חשבון `bist3` (id 36061977, free) — 22 לוחות. ✅ מחובר (טוקן `MONDAY_DEV_API`).

**Supabase (DB)**
- פיתוח: פרויקט `baaoemfjxeuqxtojrkig` — ✅ נגיש דרך secret key. 37 טבלאות/views.
- ייצור: פרויקט `czjiyqhozzkhiuruepxh` — ❌ מושהה/נמחק. ידרוש הפעלה מחדש בשלב הייצור.

**ה-control-plane של הסינכרון כבר קיים ב-DB** (11 targets, 83 field mappings, טבלאות
outbox/events/conflicts/polling/runs). **אין קוד מנוע** באף תיקייה — המנוע והמסך הם מה שנבנה.

**Drift ידוע:** יעד `leads` מוגדר על לוח `5100631741`, אבל ה-`entity_links` מצביעים על `5100406384`. ייבדק ויתוקן.

---

## 1. עקרונות

1. **בונים על ה-control-plane הקיים** — `monday_export_targets` + `monday_export_field_mappings` הם מקור האמת לקונפיגורציה. לא ממציאים סכמה חדשה.
2. **בטיחות קודם** — כל כתיבה לייצור (Monday או DB) מאחורי אישור מפורש. מתחילים ב-test.
3. **שקיפות** — כל ריצה מתועדת ב-`monday_export_runs` + steps/items/logs (כבר קיים).
4. **אידמפוטנטיות** — שימוש ב-hashes הקיימים ב-`monday_entity_links` (`last_monday_hash`, `last_supabase_hash`) כדי לזהות "ללא שינוי" ולדלג.

---

## 2. ארכיטקטורה

```
┌────────────────────────────────────────────┐
│  React (Vite) — מסך ניהול הסינכרון          │
│  בחירת סביבה · כיוון · Diff · אישור · סיכום  │
└───────────────┬────────────────────────────┘
                │ REST API
┌───────────────▼────────────────────────────┐
│  Node.js backend (Express + pg)             │
│  • connectors: Supabase + Monday GraphQL    │
│  • diff engine (לפי field_mappings)         │
│  • apply engine (כותב לצד היעד)             │
│  • run logger (monday_export_runs...)       │
│  • [שלב ב'] worker: outbox + polling        │
└───────┬───────────────────────┬─────────────┘
        │                       │
   ┌────▼─────┐          ┌──────▼──────┐
   │ Supabase │          │  Monday API │
   │ (DB)     │          │  (GraphQL)  │
   └──────────┘          └─────────────┘
```

מבנה תיקיות מוצע:
```
SyncDBAndMonday/
  server/           Node backend
    connectors/     supabase.js, monday.js
    engine/         diff.js, apply.js, hash.js
    routes/         environments, targets, sync
    index.js
  web/              React (Vite) app
  .env.local        סודות (קיים)
  .env.example      תיעוד משתנים
```

---

## 3. ניהול סביבות וגישה (דרישות #1, #4)

מסך "סביבות" לניהול פרטי החיבור לכל סביבה, שמור מוצפן בצד השרת (לא ב-front):

| סביבה | DB | Monday |
|---|---|---|
| **פיתוח (test)** | Supabase `baaoemfjxeuqxtojrkig` | `bist3` |
| **ייצור (prod)** | Supabase (יופעל מחדש) | `bist-cast` |

- בורר סביבה גלובלי בראש המסך: **פיתוח / ייצור**. הוא קובע גם את ה-credentials וגם מסנן `environment` בטבלאות ה-control-plane.
- בדיקת חיבור ("Test connection") לכל סביבה בלחיצה, כמו שכבר עשינו.
- כתיבה לייצור מסומנת באדום ודורשת אישור נוסף.

---

## 4. מסך ניהול הסינכרון (דרישות #1, #2, #3)

זרימה: **בחירה → Preview הבדלים → אישור → ביצוע → סיכום**

1. **בחירת סביבה** — פיתוח/ייצור (דרישה #1).
2. **בחירת כיוון** (בורר גלובלי, דרישה #2):
   - `Monday → DB` (משיכה)
   - `DB → Monday` (דחיפה)
   - `דו-כיווני` — קונפליקטים נפתרים לפי `field_authority`/`conflict_policy` שכבר בקונפיג (כרגע Monday מנצח).
3. **בחירת יעדים** — אילו לוחות/ישויות לסנכרן (מתוך 11 ה-targets, עם צ'קבוקסים; מכבד `is_active`).
4. **Preview** (דרישה #3): המערכת שולפת משני הצדדים, מריצה diff לפי `field_mappings`, ומציגה טבלה:
   - חדשים (ייווצרו), שונו (שדה-אחר-שדה: ערך ישן→חדש), נמחקו/חסרים, ללא שינוי (מדולגים לפי hash).
5. **אישור** — המשתמש מסמן מה לבצע (הכל / נבחרים) ומאשר.
6. **ביצוע** — כתיבה לצד היעד + עדכון `entity_links`/`runs`; טיפול ב-rate limits של Monday (מנגנון קיים).
7. **סיכום** — נוצרו X, עודכנו Y, דולגו Z, נכשלו W + לוג מלא + קישור ל-run.

---

## 5. שלביות

**שלב א' — סינכרון ידני מבוקר (עכשיו):** connectors, diff engine, apply engine, מסך ה-Preview/Approve/Summary, ניהול סביבות. עובד מול test בלבד בהתחלה.

**שלב ב' — מנוע אוטומטי (בהמשך):** worker שמעבד `monday_sync_outbox` ומבצע polling ל-Monday לפי `monday_sync_polling_state`, פתרון קונפליקטים אוטומטי, הפעלה לייצור.

---

## 6. פתוח לאישור

- **דרישה #5** ברשימתך נשארה ריקה — מה היה אמור להיות שם?
- **דרישה #4** — האם הפרשנות (מסך ניהול credentials לכל סביבה) נכונה?
- **יעד ראשון לפיילוט** — מוצע להתחיל מ-`customers` (820 רשומות, מיפוי נקי, board תואם) לפני `leads` (יש בו drift).
