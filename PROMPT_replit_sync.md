# פרומפט ל-Replit — קריאה לשירות הסינכרון אחרי כתיבה ל-DB

## מטרה
אחרי שהאפליקציה כותבת ל-Postgres (הוספה/עדכון של **ליד / לקוח / עסקה**), היא צריכה **להודיע לשירות הסינכרון** (HTTP חיצוני) עם שם היישות, והשירות ידחוף את העדכון ללוחות המתאימים ב-Monday.

## כללי ברזל
- ⛔ **האפליקציה לא קוראת ל-Monday בשום צורה.** היא כותבת רק ל-Postgres, ואז קוראת ל-endpoint אחד של שירות הסינכרון.
- ✅ הקריאה היא **fire-and-forget עמיד**: אם הסינכרון נכשל — **לוג בלבד, לא להפיל** את פעולת המשתמש.
- ✅ הפעולה אצל השירות **idempotent** — אפשר לקרוא שוב בבטחה.
- (מחיקה **לא** מטופלת כרגע — רק הוספה/עדכון.)

## משתני סביבה להוסיף ל-Secrets (ערכים סופיים)
```
SYNC_SERVICE_URL = https://syncdbandmonday-production.up.railway.app
SYNC_API_KEY     = AeNn7KQn03UQixluYSHt7otqkpZBjC3rWk2xf1wTZI
SYNC_ENV         = test        # פיתוח. בפרודקשן: production (אחרי שהשירות יוגדר לפרוד)
```
> ⚠️ שים את הערכים ב-**Secrets** של Replit, לא בקוד.

## קובץ עזר חדש: `server/lib/syncClient.ts`
```ts
const SYNC_URL = process.env.SYNC_SERVICE_URL!;
const SYNC_KEY = process.env.SYNC_API_KEY!;
const SYNC_ENV = process.env.SYNC_ENV || "test";

type SyncPayload =
  | { action: "customer_upserted"; id: string }
  | { action: "lead_upserted"; id: string }
  | { action: "deal_created" | "deal_updated"; id: string; customerId?: string; leadId?: string };

/** Notify the sync service. Never throws — a sync hiccup must not break the user's op. */
export async function notifySync(payload: SyncPayload): Promise<void> {
  try {
    const res = await fetch(`${SYNC_URL}/api/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": SYNC_KEY },
      body: JSON.stringify({ env: SYNC_ENV, ...payload }),
    });
    if (!res.ok) console.error("[sync] failed", payload.action, payload.id, res.status, await res.text());
    else console.log("[sync] ok", payload.action, payload.id);
  } catch (err) {
    console.error("[sync] error", payload.action, payload.id, err);
  }
}
```

## היכן לקרוא (אחרי שה-commit ל-DB הסתיים)

### לקוח — אחרי INSERT או UPDATE
```ts
await notifySync({ action: "customer_upserted", id: customer.id });
```

### ליד — אחרי INSERT או UPDATE
```ts
await notifySync({ action: "lead_upserted", id: lead.id });
```

### עסקה — אחרי שכל שלבי היצירה הסתיימו (החשוב ביותר) ⚠️
קרא **פעם אחת**, **רק אחרי** שכתבת את כל הגרף (deal + customer אם נוצר + lead אם קושר + payments + credits + coordination_tasks). השירות קורא בעצמו את הילדים לפי `deal_id`, אז לא צריך לשלוח אותם — רק לוודא שהם כבר ב-DB:
```ts
await notifySync({
  action: "deal_created",
  id: deal.id,
  customerId: createdCustomerId, // רק אם נוצר לקוח חדש בתהליך (אחרת השמט)
  leadId: relinkedLeadId,        // רק אם הליד קושר ללקוח (אחרת השמט)
});
```

### עדכון עסקה קיימת
```ts
await notifySync({ action: "deal_updated", id: deal.id });
```

## מה השירות עושה עם כל קריאה (לידע בלבד)
| action | דוחף ל-Monday |
|---|---|
| `customer_upserted` | לוח לקוחות (כולל פרטי חשבונית) |
| `lead_upserted` | לוח לידים |
| `deal_created` / `deal_updated` | **cascade:** עסקה + לקוח + ליד + כל התשלומים/קרדיטים/משימות-תיאום של העסקה |

- אם לרשומה עדיין אין פריט Monday → השירות **יוצר** פריט וכותב בחזרה את `monday_item_id` ל-DB.
- אם כבר יש → **מעדכן** רק שדות שהשתנו.
- `loopGuard` מונע לולאת הד.

## הערות
- קרא לפונקציה **מחוץ** ל-transaction (אחרי commit), כדי שהשירות יראה נתונים שמורים.
- `await notifySync(...)` בטוח — הפונקציה לעולם לא זורקת. אפשר גם בלי await (fire-and-forget) אם לא רוצים להמתין.
- לפרודקשן: החלף `SYNC_ENV=production` **רק אחרי** ששירות הסינכרון יוגדר עם פרטי הפרוד (Supabase+Monday של ייצור).

---

## בדיקת חיבור מהירה (הרץ ב-Replit Shell לפני החיווט)

**1. השירות חי (ללא מפתח):**
```bash
curl https://syncdbandmonday-production.up.railway.app/api/health
# מצופה: {"ok":true,"ts":"..."}
```

**2. אימות מפתח + חיבור ל-DB (עם מפתח):**
```bash
curl -H "x-api-key: AeNn7KQn03UQixluYSHt7otqkpZBjC3rWk2xf1wTZI" \
  "https://syncdbandmonday-production.up.railway.app/api/targets?env=test"
# מצופה: 200 + רשימת לוחות. אם 401 → המפתח לא תואם.
```

**3. בדיקת push אמיתית (אופציונלי — מסנכרן לקוח קיים ל-Monday):**
```bash
# החלף <CUSTOMER_ID> ב-id אמיתי של לקוח קיים ב-DB
curl -X POST -H "x-api-key: AeNn7KQn03UQixluYSHt7otqkpZBjC3rWk2xf1wTZI" \
  -H "Content-Type: application/json" \
  -d '{"env":"test","action":"customer_upserted","id":"<CUSTOMER_ID>"}' \
  https://syncdbandmonday-production.up.railway.app/api/push
# מצופה: {"env":"test","action":"customer_upserted","status":"ok"|"noop",...}
```

**בדיקת עשן מלאה מהקוד (TypeScript):**
```ts
import { notifySync } from "./server/lib/syncClient";
// אחרי שיצרת/עדכנת לקוח בדיקה:
await notifySync({ action: "customer_upserted", id: testCustomer.id });
// בדוק בלוגים: "[sync] ok customer_upserted <id>"  ואז שהפריט מופיע/עודכן בלוח הלקוחות ב-Monday.
```
