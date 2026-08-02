# Replit Agent prompt — populate salesperson & lead foreign keys on deal/customer creation

Paste the block below into the Replit Agent for the `Bist-Production-System` app.

---

You are working on the `Bist-Production-System` monorepo (`artifacts/bist-app` = Vite/React frontend, `artifacts/api-server` = backend). This app is **DB-only**: it writes to Postgres (Supabase) and must **NEVER call Monday.com**. A separate sync engine mirrors the database to Monday automatically — do not add any Monday API calls here.

## Problem

A separate Monday sync now mirrors three relationships from the database to Monday boards:
- deal → "איש מכירות" (salesperson), read from `deals.salesperson_id`
- deal → "לידים" (lead), read from `deals.lead_id`
- customer → "ליד מקושר" (linked lead), read from `customers.lead_id`

The sync only **mirrors existing values** — it never invents them. But this app currently does **not** populate these foreign keys when it creates deals and customers, so they are empty on ~95% of deals and the Monday columns stay blank. Your job is to fill them in at write time.

## What to change

Find where the app **creates a deal** and where it **creates a customer** (search `artifacts/api-server` for the deal and customer insert/create logic — likely a service, route handler, or repository). Populate these existing `uuid` columns from context already available in the create flow:

1. **On deal creation** — set:
   - `deals.salesperson_id` → the `id` of the salesperson (`app_users.id`) handling the deal.
   - `deals.lead_id` → the `id` of the lead the deal originated from (`leads.id`), when the deal comes from a lead's quote. The originating lead is typically reachable via the quote (`deals.quote_id` → the quote → its lead) or from the request context.
   - (`deals.customer_id` is already required and set — leave as is.)

2. **On first-deal customer creation** — when a deal is created from a lead and a **new** customer is created because none existed, set:
   - `customers.lead_id` → the originating lead's `id` (`leads.id`). This is the "ליד מקושר" link.
   - If the app also maintains the reverse column `leads.linked_customer_id`, keep the two consistent — but pick ONE as the source of truth (they currently disagree in the data).

## Constraints

- **DB-only.** Do NOT call the Monday API or the sync engine from this app. Only write Postgres columns. The sync layer handles Monday.
- **Schema is LOCKED.** Do NOT run `drizzle-kit push` or alter any table. These columns already exist — you are only populating them.
- Use the canonical `deals.salesperson_id` (a legacy `salesperson_user_id` column was removed — do not reintroduce it).

## Important data caveat (surface to the user, don't code around it)

The Monday "איש מכירות" column is a *status* column whose labels are short salesperson names (e.g. אביאל / רם / קורן). The sync writes `app_users.full_name` as the label. If `full_name` does not exactly match an existing Monday label, Monday creates a **new duplicate label**. So ensure the salespeople's `full_name` values line up with the intended Monday labels (or flag the mismatch to the user).

## Verification

After the change, create (or simulate) a deal that originates from a lead and confirm in the database that the new deal row has non-null `salesperson_id` and `lead_id`, and that a newly created customer has non-null `lead_id`. Report the create sites you modified and how each FK value is resolved.
