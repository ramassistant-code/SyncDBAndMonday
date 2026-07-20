# Replit prompt — קומבו לשדות מקושרים (Monday board_relation) + ולידציה

> מבוסס על בדיקה חיה של **סביבת הייצור** (`bist-cast`, account 24473879) שבה עמודות הקישור מוגדרות במלואן.
> ב-dev (`bist3`, 36061977) אותן עמודות קיימות עם **אותם `column_id`** אך `boardIds:[]` כי לוחות היעד לא הועתקו ל-dev.

## מטרה
בכל טופס עריכה/יצירה של פריט, שדה שממופה לעמודת **`board_relation`** ב-Monday (קישור ללוח) יוצג כ**קומבו נשלף עם חיפוש (searchable async combobox)** שבוחרים ממנו פריט קיים מלוח היעד — כך שנשמר **רק ערך חוקי** (item id אמיתי). אין להקליד טקסט חופשי. שדות `status/color/dropdown` → `<select>` מרשימת התוויות. שדות `mirror`/`lookup`/`formula` → קריאה בלבד.

## עקרונות
1. **מקור אמת דינמי** — אל תקודד סכימה קשיח. בטעינת הטופס שלוף עמודות הלוח מ-Monday והחלט לפי `type`:
   - `board_relation` → קומבו נשלף (ערכים = פריטים מלוח/לוחות היעד).
   - `status` / `color` / `dropdown` → `<select>` מ-`settings_str.labels`.
   - `mirror` / `lookup` / `formula` / `auto_number` / `dependency` → תצוגה בלבד, `disabled`.
   - אחר → קלט לפי הסוג.
2. **לוח היעד** = `settings_str.boardIds` (יכול להכיל **כמה** לוחות — אז מאחדים פריטים מכולם). אם ריק (`[]`/`null`) → **השבת/הסתר** את השדה, אל תבנה קומבו.
3. **חיפוש בצד השרת + פאג'ינציה** — לוחות היעד גדולים (לידים ~2879, עסקאות ~1637, תשלומים ~1717, לקוחות ~838). חפש לפי שם עם cursor, אל תשלוף הכול לדפדפן.
4. **ולידציה בשמירה** — כל ערך קישור חייב להיות item id שקיים בלוח היעד; כל status/dropdown חייב להיות תווית מהרשימה. אחרת דחה עם הודעה.
5. **ריבוי ערכים** — אם `settings_str.allowMultipleItems === true` → multi-select; אחרת יחיד.

## Monday GraphQL (API-Version 2024-10)

**סכימת עמודות:**
```graphql
query ($board:[ID!]) { boards(ids:$board){ id name columns{ id title type settings_str } } }
```
**חיפוש פריטים בלוח היעד (עם חיפוש + cursor):**
```graphql
query ($board:ID!, $term:String, $cursor:String) {
  boards(ids:[$board]) {
    items_page(limit:50, cursor:$cursor, query_params:{
      rules:[{ column_id:"name", compare_value:[$term], operator:contains_text }]
    }) { cursor items { id name } }
  }
}
```
**אימות id (בשמירה):** `query ($ids:[ID!]){ items(ids:$ids){ id name board { id } } }` — ודא ש-`board.id` ∈ `boardIds`.
**כתיבה חזרה:** `change_column_value(board_id,item_id,column_id,value)`; ערך board_relation = `{"item_ids":[123]}` (מספרים), status = `{"label":"שולם"}`, dropdown = `{"labels":["סוכנות"]}`.

---

## מפת השדות המקושרים — סמכותית (Production)
לכל עמודה: `column_id` זהה ב-dev וב-prod. עמודה שמסומנת **⚠️ חסר ב-dev** = לוח היעד לא קיים ב-`bist3`, ולכן שם היא `boardIds:[]` (צריך ליצור/להעתיק את לוח היעד ל-dev לפני שהקומבו יעבוד שם).

### לקוחות — prod `2091985169` · dev `5100631736`
| שדה | column_id | לוח יעד (prod id) | סטטוס dev |
|---|---|---|---|
| ליד מקושר | `board_relation_mkzm5f4f` | לידים `5088502309` | ✅ dev `5100631741` |
| link to עסקאות | `board_relation_mm3qpbte` | עסקאות `2091985867` | ✅ dev `5100631737` |
| מנהל תיק לקוח - עמודת עזר | `board_relation_mm3pqgms` | מנהל תיק לקוח `5096921501` | ⚠️ חסר ב-dev |
| link to Agencies | `board_relation_mm3gp01` | Agencies `5096736097` | ⚠️ חסר ב-dev |
| משימות לקוחות | `board_relation_mm3pded1` | משימות לקוחות `5097159920` | ⚠️ חסר ב-dev |
| הקלטות שיחה לקוח | `board_relation_mm3q1695` | **ריק גם ב-prod** | ⛔ להשבית |
| דרופדאון: `סוג לקוח` `dropdown_mm3phb83`, `תחום` `dropdown_mm3pq7n3`; סטטוס: `מנהל תיק לקוח - יצירת קשר` `color_mm41hx8m` | | | |

### לידים — prod `5088502309` · dev `5100631741`
| שדה | column_id | לוח יעד (prod id) | סטטוס dev |
|---|---|---|---|
| איש מכירות | `board_relation_mky9akx2` | אנשי מכירות `5088502347` | ✅ dev `5100631742` |
| link to לקוח | `board_relation_mkzmfvm4` | לקוחות `2091985169` (+Test) | ✅ dev `5100631736` |
| הפנייה | `board_relation_mkz22z7s` | לידים שהגיעו מהפניות `5088600011` | ⚠️ חסר ב-dev |
| שם מודעה | `board_relation_mkzav9qz` | מודעות `5089514402` | ⚠️ חסר ב-dev |
| משימות לידים | `board_relation_mm3pyf62` | משימות לידים `5097113777` + שבוצעו `5097343117` | ⚠️ חסר ב-dev |
| מקור הגעה | `board_relation_mm3j66r4` | מקורות הגעה `5096923535` | ⚠️ חסר ב-dev |
| link to הקלטות שיחה | `board_relation_mm3q63d0` | **ריק גם ב-prod** | ⛔ להשבית |
| סטטוסים: `סטטוס` `color_mky9mkkk`, `לענות`, `נסיונות תפיסה`, `סיבת דחייה`, `מקור הגעה1` | | | |

### עסקאות — prod `2091985867` · dev `5100631737`
| שדה | column_id | לוח יעד (prod id) | סטטוס dev |
|---|---|---|---|
| לקוח | `board_relation_mktndwm0` | לקוחות `2091985169` | ✅ dev `5100631736` |
| הפנייה של | `board_relation_mktw4xwq` | לקוחות `2091985169` | ✅ dev `5100631736` |
| תשלומים | `board_relation_mktnpmw1` | תשלומים `2091987777` | ✅ dev `5100631739` |
| רכישות מוצרי עריכה | `board_relation_mkv73n7v` | קרדיטים `2091986228` | ✅ dev `5100631738` |
| רכישות שעות אולפן | `board_relation_mkv7mtsq` | קרדיטים שעות אולפן `2118939888` | ✅ dev `5100631740` |
| לידים | `board_relation_mm3twpfx` | לידים `5088502309` | ✅ dev `5100631741` |
| סטטוסים: `סטטוס תשלום`, `סטטוס ביצוע`, `איש מכירות` `color_mktwdp8c` (תוויות כפולות/זבל — לנקות) | | | |

### תשלומים — prod `2091987777` · dev `5100631739`
| שדה | column_id | לוח יעד (prod id) | סטטוס dev |
|---|---|---|---|
| עסקה מקושרת | `board_relation_mktnjr7z` | עסקאות `2091985867` | ✅ dev `5100631737` |
| סטטוסים: `סוג תשלום` `color_mkz4grpa` (אשראי/העברה/מזומן), `סוג תשלום` `color_mm27bxc` (גבייה/לקוח חדש/החזר/Upsell), `איש מכירות` `color_mm03ctf0`, `סליקה` (כן/לא) | | | |

### קרדיטים 🏷️ — prod `2091986228` · dev `5100631738`
| שדה | column_id | לוח יעד (prod id) | סטטוס dev |
|---|---|---|---|
| עסקה מקושרת | `board_relation_mkv7apeh` | עסקאות `2091985867` | ✅ dev `5100631737` |
| רכיב מקושר | `board_relation_mm51khha` | רכיבים-פעולות וקרדיטים `5095804568` | ✅ dev `5100631743` |
| מוצרי עריכה - למחיקה | `board_relation_mkv7zwxt` | מוצרי עריכה `2118942157` | ⚠️ חסר ב-dev |
| משימות עריכה מקושרות | `board_relation_mkvd1kqd` | Editing Tasks `1760516456` + Editing Task Spotlight `5089239909` | ⚠️ חסר ב-dev |
| סטטוסים: `אחראי`, `סטטוס ביצוע` | | | |

### קרדיטים שעות אולפן — prod `2118939888` · dev `5100631740` *(מקושר מעסקאות)*
| שדה | column_id | לוח יעד (prod id) | סטטוס dev |
|---|---|---|---|
| מוצר | `board_relation_mkv04q08` | מוצרי שעות `2108051516` | ⚠️ חסר ב-dev |
| אולפן מקושר | `board_relation_mktnyfhk` | Studio Bookings `1758740187` | ⚠️ חסר ב-dev |
| רכישה | `board_relation_mkv7ganj` | עסקאות `2091985867` (+Test) | ✅ dev `5100631737` |

### משימות מיוחדות לתיאום — prod `5099906521` · dev `5100631749`
- **אין עמודות קישור.** רק סטטוס `אחראי` (מנהלת משרד/מנהל אופרציה). אף לוח אחר לא מקושר אליו בפועל.

---

## דרישות UI לקומפוננטת הקומבו
- Async searchable single/multi combobox: debounce ~300ms, טעינת 50 בפתיחה, infinite scroll עם cursor.
- מציג `name`, שומר `id`. מצבי טעינה/ריק/"אין תוצאות".
- ערך קיים שהוא id שלא נשלף — שלוף שמו ב-`items(ids:[id])`.
- לוח יעד עם כמה `boardIds` → מזג פריטים מכולם.
- RTL + עברית + נגישות מקלדת (חצים/Enter/Esc).
- בשמירה: המשתמש חייב לבחור מהרשימה — לא לשמור טקסט חופשי.
- שדה עם `boardIds:[]` (חסר יעד) → disabled + tooltip "לוח היעד לא מוגדר".

## הגדרות
- טוקן ב-Replit Secrets (`MONDAY_API_TOKEN`), לא בקוד. קריאות דרך backend proxy כדי לא לחשוף בדפדפן.
- Cache את סכימת העמודות לכל לוח לזמן הסשן; קבץ בקשות (rate limit).
- בחר סביבה (dev/prod) לפי מפתח נפרד; המפה למעלה מספקת את מזהי היעד לשתי הסביבות.
