# Replit prompt — טופס "לידים" (Leads), עובד מול ה-DB בלבד

כל הנתונים נשלפים ונשמרים **רק מול Supabase (PostgREST)**. אין שום קריאה ל-Monday. שדה שהוא **מפתח זר (FK)** יוצג כ**קומבו נשלף עם חיפוש** שנטען מהטבלה המקושרת ושומר את ה-`uuid`. שדות סטטוס = `<select>`. אין להקליד טקסט חופשי לשדה FK.

**טבלה:** `leads` (מפתח `id` = uuid). כל שאילתה מסננת `deleted_at=is.null`.

## שדות קומבו (FK → נטען מהטבלה המקושרת, נשמר uuid)
| שדה בטופס | עמודת FK | טבלת מקור | עמודת תצוגה | סינון |
|---|---|---|---|---|
| איש מכירות | `salesperson_id` | `app_users` | `full_name` | `is_active=eq.true` |
| לקוח מקושר | `linked_customer_id` | `customers` | `name` | `deleted_at=is.null` |

## שדות `<select>` (הערכים נטענים מטבלת lookup ונאכפים ב-DB ע"י FK)
כל שדה שומר טקסט, וה-FK מוודא שהוא קיים בטבלת ה-lookup. טען אפשרויות מהטבלה (לא לקודד קשיח):
| שדה | עמודה | טבלת lookup |
|---|---|---|
| סטטוס | `status` | `lookup_lead_status` |
| מענה | `answer_status` | `lookup_answer_status` |
| ניסיון תפיסה | `capture_attempt_status` | `lookup_capture_attempt` |
| מקור הגעה | `lead_source` | `lookup_lead_source` |
| סיבת דחייה | `rejection_reason` | `lookup_rejection_reason` |

טעינה: `GET /rest/v1/{lookup_table}?select=value,label&is_active=eq.true&order=sort_order.asc`. מציג `label` (אם null → `value`), שומר `value`. ה-DB דוחה ערך שלא קיים ב-lookup.

## לקריאה בלבד / מוסתר
- להסתיר: `lead_source_relation_id` (שריד מזהה Monday — לא לעריכה), `monday_*`, `deleted_at`, `phone_link`.
- שדות טקסט חופשי רגילים (`referral_name`, `ad_name`, `followup_note`, `rejection_reason_text`, `task_text`): קלט טקסט רגיל.

---
## מפרט טכני (DB-only)
גישה דרך ה-Supabase client הקיים (anon + RLS, או backend proxy) — לא לחשוף secret בדפדפן.

**טעינת אפשרויות לקומבו:**
```
GET /rest/v1/app_users?select=id,full_name&is_active=eq.true&full_name=ilike.*{term}*&order=full_name.asc&limit=50
GET /rest/v1/customers?select=id,name&deleted_at=is.null&name=ilike.*{term}*&order=name.asc&limit=50
```
debounce 300ms, גלילה עם `offset`/Range. **הצגת ערך קיים:** `?select=id,{display}&id=eq.{uuid}`.

**שמירה:** `PATCH /rest/v1/leads?id=eq.{id}` עם ה-uuid-ים והתוויות.

**ולידציה:** FK → רק uuid מהרשימה או `null` (ה-DB אוכף FK). select — רק ערך מהרשימה. אין שמירת טקסט חופשי לשדה קומבו/סטטוס.

**קומבו:** async searchable, מציג תצוגה ושומר `id`, מצבי טעינה/ריק/"אין תוצאות", RTL + מקלדת, כפתור ניקוי (→ `null`).

> `linked_customer_id` הוא הצד ההופכי של `lead_id` בטבלת `customers`. עדכן רק צד אחד בכל פעם והשאר את השני לעקביות דרך הלוגיקה/סינכרון, כדי לא ליצור אי-התאמה.
