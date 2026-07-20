# פריסה ל-Railway + תזמור ב-n8n

הארכיטקטורה: **מנוע Node (השירות) על Railway ← n8n מתזמר אותו דרך HTTP.**
n8n = המפעיל (לו"ז + webhooks). המנוע = עושה את עבודת הסינכרון.

```
   ┌────────── n8n (Cloud) ──────────┐         ┌─── Railway ───┐
   │ Schedule 08:00/13:00            │         │  מנוע Node    │
   │ Supabase webhook (רשומה חדשה)   │ ─HTTP─► │  /api/...      │ ─► Supabase + Monday
   │ Monday webhook (פריט שונה)      │  +key   │               │
   └─────────────────────────────────┘         └───────────────┘
```

---

## 1. פריסה ל-Railway

1. דחוף את הריפו ל-GitHub (או `railway up` מקומית).
2. ב-Railway: **New Project → Deploy from GitHub repo** → בחר את הריפו.
   - Railway מזהה Node אוטומטית; `railway.json` כבר מגדיר `startCommand`, healthcheck (`/api/health`), ומדיניות restart.
3. **Variables** (Settings → Variables) — הזן את מה שב-`.env.example` (אין `.env.local` בענן):
   - `SUPABASE_DEV_SECRET`, `PUBLIC_SUPABASE_URL`, `MONDAY_DEV_API`
   - (ייצור בהמשך: `SUPABASE_PROD_URL/SECRET`, `MONDAY_PROD_API`)
   - **`SYNC_API_KEY`** = מחרוזת אקראית ארוכה. **חובה** — בלעדיה ה-API פתוח לכולם.
   - `PORT` — Railway מזריק אוטומטית; המנוע קורא אותו.
4. אחרי הפריסה תקבל כתובת ציבורית, למשל `https://sync-xxxx.up.railway.app`.
   בדיקה: `GET /api/health` → `{"ok":true}`.

---

## 2. אבטחה

כל endpoint תחת `/api` דורש את המפתח, **חוץ מ**:
- `/api/health` (בשביל Railway),
- `/api/hooks/*` (webhooks נכנסים — מודל אמון משלהם).

n8n שולח בכל קריאה header:
```
x-api-key: <SYNC_API_KEY>
```
(או `Authorization: Bearer <SYNC_API_KEY>`).

---

## 3. ה-API שהמנוע חושף (מה ש-n8n קורא לו)

| Endpoint | כיוון | מתי | גוף (JSON) |
|---|---|---|---|
| `POST /api/sync/full` | Monday→DB | לו"ז (08:00/13:00) | `{ "env":"test" }` (אופ' `targetKeys:[...]`) |
| `POST /api/push` | DB→Monday | רשומה נוצרה/עודכנה באפליקציה | `{ "env":"test", "action":"customer_upserted", "id":"<uuid>" }` |
| `POST /api/hooks/monday` | Monday→DB | פריט שונה ב-Monday | `{ "env":"test", "boardId":"<id>", "itemId":"<id>" }` |
| `POST /api/sync/preview` | — | תצוגה מקדימה (read-only) | `{ "env":"test","direction":"monday_to_db","targetKey":"customers" }` |
| `POST /api/sync/apply` | לפי direction | ביצוע ממוקד | `{ ...,"selectedKeys":[...] }` |

**actions ל-`/api/push`:** `customer_upserted`, `lead_upserted`, `deal_created` / `deal_updated` (עושה cascade לגרף העסקה), או גנרי `{ "entity":"credit", "id":"<uuid>" }`.

---

## 4. שלושת התהליכים ב-n8n

### א. סינכרון מלא מתוזמן (Monday→DB, פעמיים ביום)
```
[Schedule Trigger: 08:00, 13:00]
        → [HTTP Request]
             POST {RAILWAY}/api/sync/full
             Header: x-api-key
             Body: { "env":"test" }
```

### ב. לקוח/ליד חדש באפליקציה → Monday (בזמן אמת)
```
[Supabase Trigger / Postgres]  (INSERT/UPDATE ב-customers/leads)
        → [HTTP Request]
             POST {RAILWAY}/api/push
             Header: x-api-key
             Body: { "env":"test", "action":"customer_upserted", "id":"{{ $json.id }}" }
```
> לחלופין: Supabase **Database Webhook** → n8n **Webhook node** → HTTP Request.

### ג. שינוי ב-Monday → DB (בזמן אמת)
```
[n8n Webhook node]  ← רושמים אותו כ-webhook בלוח Monday
        → [HTTP Request]
             POST {RAILWAY}/api/hooks/monday
             Body: { "env":"test", "boardId":"{{...}}", "itemId":"{{...}}" }
```
> ה-handshake של Monday (`challenge`) מטופל: המנוע מחזיר אותו, וגם n8n Webhook יכול לענות עליו.

---

## 5. ⚠️ מניעת לולאה (עדיין לפתוח — משימה פתוחה)
כשמפעילים גם push וגם pull אוטומטית: push דוחף DB→Monday → Monday יורה אירוע → pull מושך → DB משתנה → push שוב... **לולאה.**
הפתרון: עמודות ה-hash ב-`monday_entity_links` (`last_outbound_hash`/`last_inbound_hash`) — לזהות "זה ההד שלי, התעלם". **חובה לממש לפני הפעלת שני הכיוונים אוטומטית.** עד אז: להפעיל כיוון אחד אוטומטי, או להריץ ידנית.

---

## 6. סדר הפעלה מומלף
1. פרוס ל-Railway + `SYNC_API_KEY`. ודא `/api/health`.
2. חבר את **תהליך א'** (מלא מתוזמן) — הכי בטוח (pull-only, בלי לולאה).
3. הוסף **תהליך ב'** (push לקוח/ליד חדש).
4. רק אחרי מניעת-לולאה (§5) — הוסף **תהליך ג'** (Monday→DB בזמן אמת).
