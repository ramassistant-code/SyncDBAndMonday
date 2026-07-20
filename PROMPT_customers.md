# Replit prompt — טופס "לקוחות" (Customers), עובד מול ה-DB בלבד

כל הנתונים נשלפים ונשמרים **רק מול Supabase (PostgREST)**. אין שום קריאה ל-Monday. שדה שהוא **מפתח זר (FK)** יוצג כ**קומבו נשלף עם חיפוש** שנטען מהטבלה המקושרת ושומר את ה-`uuid`. שדות סטטוס = `<select>` מרשימת ערכים. אין להקליד טקסט חופשי לשדה FK.

**טבלה:** `customers` (מפתח `id` = uuid). כל שאילתה מסננת `deleted_at=is.null`.

## שדות קומבו (FK → נטען מהטבלה המקושרת, נשמר uuid)
| שדה בטופס | עמודת FK | טבלת מקור | עמודת תצוגה | סינון |
|---|---|---|---|---|
| מנהל תיק לקוח | `account_manager_id` | `app_users` | `full_name` | `is_active=eq.true` |
| ליד מקושר | `lead_id` | `leads` | `name` | `deleted_at=is.null` |

## שדות `<select>` (הערכים נטענים מטבלת lookup ונאכפים ב-DB ע"י FK)
כל שדה כזה שומר טקסט, וה-FK מוודא שהוא קיים בטבלת ה-lookup. טען את האפשרויות מהטבלה (לא לקודד קשיח):
| שדה | עמודה | טבלת lookup | טעינת אפשרויות |
|---|---|---|---|
| סוג לקוח | `customer_type` | `lookup_customer_type` | `GET /rest/v1/lookup_customer_type?select=value,label&is_active=eq.true&order=sort_order.asc` |
| תחום | `industry` | `lookup_industry` | `GET /rest/v1/lookup_industry?select=value,label&is_active=eq.true&order=sort_order.asc` |
| סטטוס יצירת קשר | `account_manager_contact_status` | `lookup_contact_status` | `GET /rest/v1/lookup_contact_status?select=value,label&is_active=eq.true&order=sort_order.asc` |

מציג `label` (אם null → `value`), שומר `value`. ה-DB דוחה ערך שלא קיים ב-lookup.

## לקריאה בלבד / מוסתר
- מחושבים (disabled): `ltv_amount`, `pipeline_amount_ex_vat`.
- להסתיר לגמרי: `monday_board_id`, `monday_item_id`, `monday_group_id`, `monday_raw_data`, `normalized_phone`, `deleted_at`.
- **עסקאות/תשלומים של הלקוח אינם קומבו** — הם רשומות-בן (ל-`deals`/`payments` יש `customer_id` המצביע לכאן). הצג אותם כרשימה/טאב, לא כבורר בטופס הלקוח.

---
## מפרט טכני (DB-only)
גישה דרך ה-Supabase client הקיים של האפליקציה (מפתח anon + RLS, או backend proxy) — **לא** לחשוף את ה-secret key בדפדפן.

**טעינת אפשרויות לקומבו (חיפוש + עמוד ראשון):**
```
GET /rest/v1/leads?select=id,name&deleted_at=is.null&name=ilike.*{term}*&order=name.asc&limit=50
GET /rest/v1/app_users?select=id,full_name&is_active=eq.true&full_name=ilike.*{term}*&order=full_name.asc&limit=50
```
פאג'ינציה: הוסף `&offset=N` או Range header לגלילה. debounce 300ms.

**הצגת ערך קיים (id → שם):** `GET /rest/v1/leads?select=id,name&id=eq.{uuid}`

**שמירה:** `PATCH /rest/v1/customers?id=eq.{id}` עם `{ "account_manager_id":"{uuid|null}", "lead_id":"{uuid|null}", ... }`.

**ולידציה:** שדה FK מקבל רק `uuid` שנבחר מהרשימה (או `null`). ה-DB ממילא אוכף את ה-FK ודוחה uuid לא קיים — אבל ה-UI לא ישמור טקסט חופשי, רק בחירה מהקומבו. select — רק ערך מהרשימה.

**קומבו:** async searchable, מציג את עמודת התצוגה ושומר `id`, מצבי טעינה/ריק/"אין תוצאות", RTL + נגישות מקלדת, אפשרות ניקוי (→ `null`).
