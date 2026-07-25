# Replit prompt — הוספת פניית סינכרון למסך אנשי המכירות (הקיים)

**המסך כבר קיים.** אין לשנות אותו — רק **להוסיף פנייה אחת** לשירות הסינכרון אחרי כל שמירה של איש מכירות, כדי שהפריט בלוח "אנשי מכירות" ב-Monday ייווצר/יתעדכן.

## מה להוסיף
בהאנדלר של שמירת איש מכירות (טבלת `app_users`) — **מיד אחרי** שה-`INSERT`/`UPDATE` ל-Postgres הצליח (מחוץ ל-transaction, אחרי commit), קרא:

```ts
import { notifySync } from "./server/lib/syncClient";

// אחרי יצירה או עדכון מוצלחים של איש מכירות:
await notifySync({ action: "salesperson_upserted", id: appUser.id });
```

זהו. השירות יזהה אם הפריט קיים ב-Monday (עדכון) או לא (יצירה + כתיבת `monday_item_id` חזרה ל-DB), וידחוף שם מלא/טלפון/אימייל/סטטוס. `loopGuard` מונע לולאת הד.

## כללי ברזל
- ⛔ המסך **לא קורא ל-Monday** — רק כותב ל-Postgres ואז קורא ל-`notifySync`.
- ✅ הקריאה **מחוץ** ל-transaction (אחרי commit), כדי שהשירות יראה נתונים שמורים.
- ✅ `notifySync` **fire-and-forget עמיד** — לעולם לא זורק; כשל סינכרון = לוג בלבד, לא מפיל את פעולת המשתמש.
- ✅ הפעולה **idempotent** — אפשר לקרוא שוב בבטחה.
- (מחיקה לא מטופלת — רק הוספה/עדכון.)

## אם `syncClient.ts` עדיין לא קיים בפרויקט
צור אותו (זהה לזה שמשמש את שאר הפניות — ראה `PROMPT_replit_sync.md`), והוסף את הסוג `salesperson_upserted`:

```ts
// server/lib/syncClient.ts
const SYNC_URL = process.env.SYNC_SERVICE_URL!;
const SYNC_KEY = process.env.SYNC_API_KEY!;
const SYNC_ENV = process.env.SYNC_ENV || "test";

type SyncPayload =
  | { action: "customer_upserted"; id: string }
  | { action: "lead_upserted"; id: string }
  | { action: "salesperson_upserted"; id: string }
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

משתני סביבה ב-Secrets (אם עוד לא קיימים):
```
SYNC_SERVICE_URL = https://syncdbandmonday-production.up.railway.app
SYNC_API_KEY     = <המפתח מ-PROMPT_replit_sync.md>
SYNC_ENV         = test        # בפרודקשן: production
```
> אם ה-`syncClient` כבר קיים (מהחיווט של לקוח/ליד/עסקה) — רק הוסף את השורה `| { action: "salesperson_upserted"; id: string }` ל-`SyncPayload`, וקרא ל-`notifySync` במסך.

## למה `full_name` חייב להיות מדויק
הוא משמש ב-Monday גם ככותרת הפריט בלוח אנשי המכירות, גם כערך בעמודת הסטטוס "איש מכירות" בלוח **התשלומים**, וגם בקישור "לינק איש מכירות" בתשלום. שם לא-עקבי → תוויות סטטוס כפולות.
