# Replit prompt — טופס "עסקאות" (Deals), עובד מול ה-DB בלבד

כל הנתונים נשלפים ונשמרים **רק מול Supabase (PostgREST)**. אין שום קריאה ל-Monday. שדה שהוא **מפתח זר (FK)** יוצג כ**קומבו נשלף עם חיפוש** שנטען מהטבלה המקושרת ושומר את ה-`uuid`. שדות סטטוס = `<select>`. אין להקליד טקסט חופשי לשדה FK.

**טבלה:** `deals` (מפתח `id` = uuid). כל שאילתה מסננת `deleted_at=is.null`.

## שדות קומבו (FK → נטען מהטבלה המקושרת, נשמר uuid)
| שדה בטופס | עמודת FK | טבלת מקור | עמודת תצוגה | סינון |
|---|---|---|---|---|
| לקוח | `customer_id` | `customers` | `name` | `deleted_at=is.null` |
| ליד | `lead_id` | `leads` | `name` | `deleted_at=is.null` |
| איש מכירות | `salesperson_id` | `app_users` | `full_name` | `is_active=eq.true` |
| הצעת מחיר (אופציונלי) | `quote_id` | `quotes` | `quote_number` | `deleted_at=is.null` |

> איש המכירות מאוחסן ב-`salesperson_id` בלבד (288 רשומות). העמודה הכפולה `salesperson_user_id` נמחקה — התעלם ממנה.

## שדות `<select>` — enums אמיתיים ב-DB (הערכים נאכפים ע"י ה-DB)
| שדה | עמודה | ערכים (enum) |
|---|---|---|
| סטטוס תשלום | `payment_status` | ממתינה לתשלום / תשלום חלקי / שולמה במלואה / בוטלה |
| סטטוס ביצוע | `execution_status` | פתוחה / ממתינה לתיאום / בטיפול / הושלמה / בוטלה |

## שדה `<select>` נוסף (טקסט עם קודים — הצג תווית, שמור קוד)
| שדה | עמודה | קוד → תווית |
|---|---|---|
| אמצעי תשלום | `payment_type` | `credit_card`→אשראי · `cash`→מזומן · `bank_transfer`→העברה בנקאית |

## לקריאה בלבד / מוסתר
- מחושבים (disabled): `total_amount`, `paid_amount`, `remaining_amount`, `studio_hours_remaining`, `editing_tasks_remaining`, `total_amount_including_vat`, `amount_paid_including_vat`.
- להסתיר: `*_snapshot`, `snapshot_locked_at`, `source_quote_version_id`, `monday_*`, `deleted_at`.
- **תשלומים / קרדיטים (מוצרי עריכה) אינם קומבו** — הם רשומות-בן (`payments.deal_id`, `credits.deal_id` מצביעים לכאן). הצג כרשימה/טאב, לא כבורר בטופס העסקה.
- "רכישות שעות אולפן" — אין לזה עמודת DB; אל תציג.

---
## מפרט טכני (DB-only)
גישה דרך ה-Supabase client הקיים (anon + RLS, או backend proxy) — לא לחשוף secret בדפדפן.

**טעינת אפשרויות לקומבו:**
```
GET /rest/v1/customers?select=id,name&deleted_at=is.null&name=ilike.*{term}*&order=name.asc&limit=50
GET /rest/v1/leads?select=id,name&deleted_at=is.null&name=ilike.*{term}*&order=name.asc&limit=50
GET /rest/v1/app_users?select=id,full_name&is_active=eq.true&full_name=ilike.*{term}*&order=full_name.asc&limit=50
GET /rest/v1/quotes?select=id,quote_number&deleted_at=is.null&quote_number=ilike.*{term}*&order=quote_number.desc&limit=50
```
debounce 300ms, גלילה עם `offset`/Range. **הצגת ערך קיים:** `?select=id,{display}&id=eq.{uuid}`.

**שמירה:** `PATCH /rest/v1/deals?id=eq.{id}` עם ה-uuid-ים והתוויות/enum.

**ולידציה:** FK → רק uuid מהרשימה או `null` (ה-DB אוכף FK). enum → רק ערך מהרשימה (ה-DB דוחה אחר). `payment_type` → רק אחד משלושת הקודים.

**קומבו:** async searchable, מציג תצוגה ושומר `id`, מצבי טעינה/ריק/"אין תוצאות", RTL + מקלדת, כפתור ניקוי (→ `null`).
