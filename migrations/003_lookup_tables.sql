-- ============================================================================
-- 003_lookup_tables.sql
-- Category ג: enforce "valid value only" for free-text status/type fields
-- via lookup tables + FK — WITHOUT changing column names/types (non-breaking
-- for the sync engine and the Replit UI, which keep using the same text values).
--
-- Design: each lookup table is keyed by the text `value` itself (PK). The base
-- column keeps its `text` type and gains a FK -> lookup(value). The lookup table
-- is the editable source of valid options for the UI combos.
--
-- SAFE & IDEMPOTENT. Wrapped in a transaction. Does NOT drop any data.
-- Review before running. Nothing here was executed for you.
--
-- Fields covered:
--   customers.customer_type, customers.industry, customers.account_manager_contact_status
--   leads.status, leads.answer_status, leads.capture_attempt_status,
--   leads.lead_source, leads.rejection_reason
-- ============================================================================

begin;

-- Reusable shape for every lookup table.
-- value      : the canonical text stored in the base column (PK)
-- label      : display text for the UI (defaults to value)
-- sort_order : combo ordering
-- is_active  : false = keep valid for existing rows, but hide from NEW selections

-- ---------------------------------------------------------------------------
-- 1) customers.customer_type  ->  lookup_customer_type
-- ---------------------------------------------------------------------------
create table if not exists lookup_customer_type (
  value      text primary key,
  label      text,
  sort_order integer not null default 100,
  is_active  boolean not null default true
);
-- seed every value actually present (guarantees the FK will validate)
insert into lookup_customer_type (value)
  select distinct customer_type from customers where customer_type is not null
  on conflict (value) do nothing;
-- curate ordering / labels (harmless no-op if a value is absent)
update lookup_customer_type set sort_order = 10 where value = 'עסקי';
update lookup_customer_type set sort_order = 20 where value = 'סוכנות';
update lookup_customer_type set sort_order = 30 where value = 'פתרונות שיווק ומדיה';
update lookup_customer_type set sort_order = 40 where value = 'בניית Pesonal Brand'; -- NOTE: typo preserved from data; see optional fix at bottom
update lookup_customer_type set sort_order = 50 where value = 'פודקאסט לקידום עסק';
update lookup_customer_type set sort_order = 60 where value = 'פודקאסט לא עסק';
update lookup_customer_type set sort_order = 99 where value = 'אחר';
alter table customers drop constraint if exists customers_customer_type_fk;
alter table customers add constraint customers_customer_type_fk
  foreign key (customer_type) references lookup_customer_type(value) on update cascade;

-- ---------------------------------------------------------------------------
-- 2) customers.industry  ->  lookup_industry
-- ---------------------------------------------------------------------------
-- data cleanup FIRST (one combined/dirty value) so it isn't seeded as its own option
update customers set industry = 'כושר ותזונה' where industry = 'כושר ותזונה, דוד כהן';

create table if not exists lookup_industry (
  value      text primary key,
  label      text,
  sort_order integer not null default 100,
  is_active  boolean not null default true
);
insert into lookup_industry (value)
  select distinct industry from customers where industry is not null
  on conflict (value) do nothing;
-- merge the near-duplicate lawyer values into one option (optional; comment out to keep both)
-- update customers set industry = 'עריכת דין' where industry = 'עורך דין';
-- delete from lookup_industry where value = 'עורך דין';
update lookup_industry set sort_order = 99 where value = 'לא ידוע';
alter table customers drop constraint if exists customers_industry_fk;
alter table customers add constraint customers_industry_fk
  foreign key (industry) references lookup_industry(value) on update cascade;

-- ---------------------------------------------------------------------------
-- 3) customers.account_manager_contact_status  ->  lookup_contact_status
-- ---------------------------------------------------------------------------
create table if not exists lookup_contact_status (
  value      text primary key,
  label      text,
  sort_order integer not null default 100,
  is_active  boolean not null default true
);
insert into lookup_contact_status (value)
  select distinct account_manager_contact_status from customers where account_manager_contact_status is not null
  on conflict (value) do nothing;
update lookup_contact_status set sort_order = 10 where value = 'לא נוצר קשר';
update lookup_contact_status set sort_order = 20 where value = 'נוצר קשר ורלוונטי';
update lookup_contact_status set sort_order = 30 where value = 'נוצר קשר ולא רלוונטי';
alter table customers drop constraint if exists customers_contact_status_fk;
alter table customers add constraint customers_contact_status_fk
  foreign key (account_manager_contact_status) references lookup_contact_status(value) on update cascade;

-- ---------------------------------------------------------------------------
-- 4) leads.status  ->  lookup_lead_status
-- ---------------------------------------------------------------------------
-- merge the obvious duplicate "ליד חדש" (1 row) into "חדש" (169 rows)
update leads set status = 'חדש' where status = 'ליד חדש';

create table if not exists lookup_lead_status (
  value      text primary key,
  label      text,
  sort_order integer not null default 100,
  is_active  boolean not null default true
);
insert into lookup_lead_status (value)
  select distinct status from leads where status is not null
  on conflict (value) do nothing;
update lookup_lead_status set sort_order = 10 where value = 'חדש';
update lookup_lead_status set sort_order = 20 where value = 'בתהליך';
update lookup_lead_status set sort_order = 30 where value = 'פולואפ ארוך';
update lookup_lead_status set sort_order = 40 where value = 'לקראת סגירה';
update lookup_lead_status set sort_order = 50 where value = 'לקוח פעיל';
update lookup_lead_status set sort_order = 90 where value = 'לא רלוונטי';
alter table leads drop constraint if exists leads_status_fk;
alter table leads add constraint leads_status_fk
  foreign key (status) references lookup_lead_status(value) on update cascade;

-- ---------------------------------------------------------------------------
-- 5) leads.answer_status  ->  lookup_answer_status
-- ---------------------------------------------------------------------------
create table if not exists lookup_answer_status (
  value      text primary key,
  label      text,
  sort_order integer not null default 100,
  is_active  boolean not null default true
);
insert into lookup_answer_status (value)
  select distinct answer_status from leads where answer_status is not null
  on conflict (value) do nothing;
update lookup_answer_status set sort_order = 10 where value = 'ענה';
update lookup_answer_status set sort_order = 20 where value = 'לא ענה';
alter table leads drop constraint if exists leads_answer_status_fk;
alter table leads add constraint leads_answer_status_fk
  foreign key (answer_status) references lookup_answer_status(value) on update cascade;

-- ---------------------------------------------------------------------------
-- 6) leads.capture_attempt_status  ->  lookup_capture_attempt
-- ---------------------------------------------------------------------------
create table if not exists lookup_capture_attempt (
  value      text primary key,
  label      text,
  sort_order integer not null default 100,
  is_active  boolean not null default true
);
insert into lookup_capture_attempt (value)
  select distinct capture_attempt_status from leads where capture_attempt_status is not null
  on conflict (value) do nothing;
update lookup_capture_attempt set sort_order = 10 where value = 'ברירת המחדל';
alter table leads drop constraint if exists leads_capture_attempt_fk;
alter table leads add constraint leads_capture_attempt_fk
  foreign key (capture_attempt_status) references lookup_capture_attempt(value) on update cascade;

-- ---------------------------------------------------------------------------
-- 7) leads.lead_source  ->  lookup_lead_source
-- ---------------------------------------------------------------------------
create table if not exists lookup_lead_source (
  value      text primary key,
  label      text,
  sort_order integer not null default 100,
  is_active  boolean not null default true
);
insert into lookup_lead_source (value)
  select distinct lead_source from leads where lead_source is not null
  on conflict (value) do nothing;
update lookup_lead_source set sort_order = 99 where value = 'לא ידוע';
alter table leads drop constraint if exists leads_lead_source_fk;
alter table leads add constraint leads_lead_source_fk
  foreign key (lead_source) references lookup_lead_source(value) on update cascade;

-- ---------------------------------------------------------------------------
-- 8) leads.rejection_reason  ->  lookup_rejection_reason
-- ---------------------------------------------------------------------------
create table if not exists lookup_rejection_reason (
  value      text primary key,
  label      text,
  sort_order integer not null default 100,
  is_active  boolean not null default true
);
insert into lookup_rejection_reason (value)
  select distinct rejection_reason from leads where rejection_reason is not null
  on conflict (value) do nothing;
update lookup_rejection_reason set sort_order = 99 where value = 'אחר';
alter table leads drop constraint if exists leads_rejection_reason_fk;
alter table leads add constraint leads_rejection_reason_fk
  foreign key (rejection_reason) references lookup_rejection_reason(value) on update cascade;

commit;

-- ============================================================================
-- VERIFY (run after commit):
--   select 'customer_type' d, count(*) from lookup_customer_type
--   union all select 'industry', count(*) from lookup_industry
--   union all select 'contact_status', count(*) from lookup_contact_status
--   union all select 'lead_status', count(*) from lookup_lead_status
--   union all select 'answer_status', count(*) from lookup_answer_status
--   union all select 'capture_attempt', count(*) from lookup_capture_attempt
--   union all select 'lead_source', count(*) from lookup_lead_source
--   union all select 'rejection_reason', count(*) from lookup_rejection_reason;
--
-- OPTIONAL data fix (typo) — run only if you want to correct the stored value.
-- The FK has ON UPDATE CASCADE, so update the lookup row and rows follow:
--   update customers set customer_type = 'בניית Personal Brand'
--     where customer_type = 'בניית Pesonal Brand';           -- fix base rows first
--   update lookup_customer_type set value = 'בניית Personal Brand'
--     where value = 'בניית Pesonal Brand';                   -- then the option
--
-- ROLLBACK (if needed):
--   alter table customers drop constraint if exists customers_customer_type_fk;
--   alter table customers drop constraint if exists customers_industry_fk;
--   alter table customers drop constraint if exists customers_contact_status_fk;
--   alter table leads drop constraint if exists leads_status_fk;
--   alter table leads drop constraint if exists leads_answer_status_fk;
--   alter table leads drop constraint if exists leads_capture_attempt_fk;
--   alter table leads drop constraint if exists leads_lead_source_fk;
--   alter table leads drop constraint if exists leads_rejection_reason_fk;
--   drop table if exists lookup_customer_type, lookup_industry, lookup_contact_status,
--     lookup_lead_status, lookup_answer_status, lookup_capture_attempt,
--     lookup_lead_source, lookup_rejection_reason;
-- ============================================================================
