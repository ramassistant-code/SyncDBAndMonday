# הפעלת ייצור (go-live) — Runbook מעשי

> מצב נוכחי (נבדק 2026-07-29): נתוני הייצור + ה-control-plane **מוכנים ומיושרים**, אבל **אין מנוע ייצור פעיל**.
> השירות היחיד שרץ ב-Railway משרת את הפיתוח בלבד; משתני הייצור שלו הם placeholder
> (`SUPABASE_PROD_URL=https://YOUR_PROD_REF.supabase.co`), ולכן `env=production` מחזיר `fetch failed`.
> כדי להפעיל ייצור צריך להשלים שלב אחד שרק אתה יכול לבצע (מפתח סודי) — ואז אני משלים את השאר.

---

## שלב 1 — אתה: הגדרת מנוע הייצור ב-Railway  ⚠️ (דורש מפתח סודי — לא בהישג ידי)

בפרויקט Railway של המנוע, בסביבה שתריץ ייצור (או צור Environment חדש `prod`), הגדר **Variables**:

```
SUPABASE_PROD_URL    = https://ruavrqoayurhwsmrmcne.supabase.co
SUPABASE_PROD_SECRET = <service_role key של פרויקט BIST-PROD>   ← Supabase Dashboard → Settings → API
MONDAY_PROD_API      = <הטוקן של bist-cast>                     ← כבר קיים אצלך ב-.env.local
SYNC_API_KEY         = <מפתח חדש לייצור>                        ← ראה פקודה למטה
MONDAY_HOOK_TOKEN    = <טוקן ל-webhooks>                        ← יכול להיות זהה לפיתוח או חדש
```

מפתח `SYNC_API_KEY` חדש (הרץ מקומית, הדבק ל-Railway — אל תשמור בריפו):
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

ואז:
- **Settings → Source → Branch** = `production` (כבר מכיל את כל התיקונים, HEAD `a765fb2`).
- **Settings → Networking → Public Domain** — צור כתובת ציבורית (למשל `https://engine-prod-xxxx.up.railway.app`).

אימות (כשעלה):
```bash
curl https://<PROD_URL>/api/health          # → {"ok":true,...}
curl -H "x-api-key: <SYNC_API_KEY>" "https://<PROD_URL>/api/targets?env=production"
# → 200 + רשימת לוחות הייצור (לא fetch failed)
```

## שלב 2 — שלח לי את כתובת הייצור
ברגע ש-`/api/targets?env=production` מחזיר 200, מסור לי את הכתובת. אז אני מבצע מיד:

## שלב 3 — אני: הפעלה + חיווט (מוכן להרצה)
1. **הפעלת 3 ה-targets** בייצור (products / component_operation / deal_product):
   קובעים `is_active=true` וכיוון הסינכרון (ברירת מחדל מומלצת: **דו-כיווני** — `inbound_enabled=true, outbound_enabled=true`;
   אפשר outbound-בלבד אם רוצים רק אפליקציה→Monday). שינוי הפיך לחלוטין.
2. **רישום webhooks של ייצור** על 3 הלוחות (5099782407 / 5095804568 / 5096915757) →
   `https://<PROD_URL>/api/hooks/monday?env=production&token=<MONDAY_HOOK_TOKEN>` (רק אם בוחרים inbound).
3. **אימות round-trip** על פריט בדיקה בייצור (כמו שעשינו בפיתוח).

## שלב 4 — חיווט Replit לייצור
לפי [PROMPT_replit_products.md](PROMPT_replit_products.md): הזן ב-Secrets של Replit
`SYNC_SERVICE_URL=<PROD_URL>`, `SYNC_API_KEY=<של הייצור>`, `SYNC_ENV=production`.
הלקוח כבר שולח `confirmProduction:true` אוטומטית ל-env=production.

---

### הערה על שאר היישויות
7 היישויות ה"פעילות" בייצור (לקוחות/לידים/עסקאות/תשלומים/קרדיטים/אנשי-מכירות/משימות-תיאום)
מסומנות `is_active=true` ב-control-plane אבל **גם הן לא רצות בפועל** — מאותה סיבה (אין מנוע פעיל).
ברגע שמנוע הייצור יעלה, הן יתחילו לעבוד (Monday→DB, לפי הכיוון שמוגדר להן: inbound).
```
