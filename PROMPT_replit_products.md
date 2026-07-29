# פרומפט ל-Replit — סינכרון מוצרים / רכיבים / רכיבים-במוצר אחרי כתיבה ל-DB

## מטרה
אחרי שהאפליקציה כותבת ל-Postgres **מוצר** (`products`), **רכיב** (`components`) או **רכיב-במוצר** (`product_components`) — הוספה או עדכון — היא **מודיעה לשירות הסינכרון**, והשירות דוחף את השינוי ללוחות המתאימים ב-Monday (מוצרים / רכיבי אופרציה / רכיבים במוצר), כולל הקשרים (relations) וכמות/סדר.

## כללי ברזל (זהים לסינכרון לקוח/ליד/עסקה)
- ⛔ האפליקציה **לא קוראת ל-Monday** — רק כותבת ל-Postgres ואז קוראת ל-endpoint אחד של השירות.
- ✅ הקריאה **fire-and-forget עמידה**: כשל בסינכרון → **לוג בלבד, לא להפיל** את פעולת המשתמש.
- ✅ הפעולה **idempotent** — בטוח לקרוא שוב. `loopGuard` מונע לולאת הד.
- (מחיקה **לא** מטופלת — רק הוספה/עדכון.)
- ⚠️ **סדר קריטי לרכיב-במוצר:** קרא לסינכרון של `product_components` **רק אחרי** שגם המוצר וגם הרכיב שהוא מקשר כבר קיימים ב-DB ומסונכרנים ל-Monday (יש להם `monday_item_id`). אם ההורים עדיין לא ב-Monday — השירות ידלג (`skipped: not aligned`), אז סנכרן קודם מוצר+רכיב.

## משתני סביבה (Secrets) — ייצור
```
SYNC_SERVICE_URL = <כתובת מנוע-הייצור>        # יוזן כשמנוע הייצור יעלה (ראה הערה בתחתית)
SYNC_API_KEY     = <SYNC_API_KEY של הייצור>
SYNC_ENV         = production
```
> ⚠️ ב-**Secrets** של Replit, לא בקוד. בפיתוח: `SYNC_ENV=test` והכתובת `https://syncdbandmonday-production.up.railway.app` עם מפתח הפיתוח.

## עדכון `server/lib/syncClient.ts` — הוסף פעולות מוצר/רכיב
הרחב את ה-type ואת הפונקציה הקיימת (מהפרומפט הקודם). מוצרים/רכיבים משתמשים בצורה הגנרית `{ entity, id }`:

```ts
const SYNC_URL = process.env.SYNC_SERVICE_URL!;
const SYNC_KEY = process.env.SYNC_API_KEY!;
const SYNC_ENV = process.env.SYNC_ENV || "test";

type SyncPayload =
  | { action: "customer_upserted"; id: string }
  | { action: "lead_upserted"; id: string }
  | { action: "salesperson_upserted"; id: string }
  | { action: "deal_created" | "deal_updated"; id: string; customerId?: string; leadId?: string }
  // ── חדש: מוצרים / רכיבים / רכיבים-במוצר (צורה גנרית) ──
  | { entity: "product"; id: string }             // טבלת products
  | { entity: "component_operation"; id: string } // טבלת components
  | { entity: "deal_product"; id: string };       // טבלת product_components (טבלת הקשר)

/** מודיע לשירות הסינכרון. לעולם לא זורק — תקלת סינכרון לא תשבור את פעולת המשתמש. */
export async function notifySync(payload: SyncPayload): Promise<void> {
  try {
    const body: Record<string, unknown> = { env: SYNC_ENV, ...payload };
    // ⚠️ כתיבות לייצור דורשות אישור מפורש (המנוע מחזיר 428 בלעדיו)
    if (SYNC_ENV === "production") body.confirmProduction = true;

    const res = await fetch(`${SYNC_URL}/api/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": SYNC_KEY },
      body: JSON.stringify(body),
    });
    const label = "action" in payload ? payload.action : `entity:${payload.entity}`;
    if (!res.ok) console.error("[sync] failed", label, payload.id, res.status, await res.text());
    else console.log("[sync] ok", label, payload.id);
  } catch (err) {
    const label = "action" in payload ? payload.action : `entity:${(payload as any).entity}`;
    console.error("[sync] error", label, payload.id, err);
  }
}
```

## היכן לקרוא (אחרי ה-commit ל-DB)

### מוצר — אחרי INSERT / UPDATE ל-`products`
```ts
await notifySync({ entity: "product", id: product.id });
```

### רכיב — אחרי INSERT / UPDATE ל-`components`
```ts
await notifySync({ entity: "component_operation", id: component.id });
```

### רכיב-במוצר (טבלת הקשר) — אחרי INSERT / UPDATE ל-`product_components`
```ts
// ודא קודם שהמוצר והרכיב כבר סונכרנו (יש להם monday_item_id)
await notifySync({ entity: "deal_product", id: productComponent.id });
```
> אם באותו מסך יוצרים מוצר **וגם** את הרכיבים שלו בבת-אחת: סנכרן קודם את המוצר ואת כל הרכיבים, ורק אז את שורות ה-`product_components`.

## מה השירות עושה עם כל קריאה (לידע בלבד)
| entity | טבלת DB | דוחף ל-Monday |
|---|---|---|
| `product` | `products` | לוח "מוצרים" — שם, מחירים (צרכן/בכמות), קטגוריה, תיאורי הצעה, קישורים |
| `component_operation` | `components` | לוח "רכיבי אופרציה" — שם, קטגוריה, deliverable, הערות, SOP |
| `deal_product` | `product_components` | לוח "רכיבים במוצר" — **הקשרים** (איזה מוצר + איזה רכיב) + כמות ברירת-מחדל + סדר |

- אין פריט Monday עדיין → השירות **יוצר** וכותב בחזרה `monday_item_id` ל-DB.
- כבר קיים → **מעדכן** רק שדות שהשתנו. `loopGuard` מונע לולאה.

## בדיקת עשן (אחרי חיווט)
```ts
import { notifySync } from "./server/lib/syncClient";
await notifySync({ entity: "product", id: testProduct.id });
// לוג מצופה: "[sync] ok entity:product <id>" ואז הפריט מופיע/מתעדכן בלוח המוצרים ב-Monday.
```

## הערות
- קרא **מחוץ** ל-transaction (אחרי commit) כדי שהשירות יראה נתונים שמורים.
- ⚠️ **כתובת מנוע-הייצור (`SYNC_SERVICE_URL`) עדיין לא קיימת/פעילה.** מנוע הייצור טרם הוגדר עם פרטי הפרוד האמיתיים (Supabase+Monday). עד שיעלה — השתמש ב-`SYNC_ENV=test` מול מנוע הפיתוח, או המתן לכתובת הייצור. אל תפעיל `SYNC_ENV=production` לפני שהכתובת מחזירה `{"ok":true}` ב-`/api/health`.
