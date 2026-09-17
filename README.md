# PayPoint

A finance workspace for content creators — track brand deals, expenses,
and generate professional invoices.

## What works

- ✅ Email/password signup and login (via Supabase)
- ✅ Google OAuth sign-in
- ✅ Dashboard with revenue, expenses, taxes, take-home
- ✅ Deals — create, edit, delete, notes, currency per deal
- ✅ Expenses — create, delete, link to deals, receipt upload
- ✅ Invoices — create, list, PDF generation, CSV export
- ✅ Profile — edit name/bio, avatar upload, bank details, business details
- ✅ Settings — currency preference, tax rate
- ✅ Admin page — manually upgrade users to Pro (`is_admin` flag in profiles)

## What's disabled / coming soon

- 🚧 **Pro subscriptions** — the upgrade flow returns "coming soon". The
  Paystack integration code is stubbed but preserved. See `server.cjs`
  route `POST /api/subscribe`.
- 🚧 **Invoice email sending** — invoices are created and stored, but the
  "email to brand" step is not wired up. The server logs a console message
  instead. To enable, add Resend or Nodemailer.
- 🚧 **Auto-chase** for overdue invoices — not implemented.

## Tech stack

| Layer | Tech |
|---|---|
| Backend | Node.js + Express |
| Database | Supabase (PostgreSQL) |
| Auth | Supabase Auth |
| File storage | Supabase Storage (`avatars` bucket) |
| PDF | PDFKit |
| Payments | Paystack (disabled) |
| Frontend | Plain HTML + CSS + JS (no build step) |

## Setup

### 1. Clone and install

\`\`\`bash
git clone <your-repo>
cd paypoint-backend
npm install
\`\`\`

### 2. Create your .env

Copy `.env.example` to `.env` and fill in values from your Supabase
dashboard (Settings → API):

\`\`\`
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
PAYSTACK_SECRET_KEY=sk_test_...
FRONTEND_URL=http://localhost:5500
BACKEND_URL=http://localhost:3000
PORT=3000
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:5500,http://localhost:3000
\`\`\`

### 3. Create Supabase tables

Run this in Supabase → SQL Editor:

\`\`\`sql
-- profiles
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  default_currency text default 'USD',
  tax_rate int default 30,
  subscription_tier text default 'free',
  subscription_status text default 'active',
  subscription_expires_at timestamptz,
  bank_account_name text,
  bank_name text,
  bank_account_number text,
  business_name text,
  business_address text,
  business_phone text,
  is_vat_registered boolean default false,
  vat_number text,
  payment_instructions text,
  invoice_logo_url text,
  invoice_primary_color text default '#4F7CFF',
  invoice_accent_color text default '#1A1A2E',
  invoice_custom_header text,
  invoice_custom_footer text,
  invoice_business_links jsonb default '[]',
  invoice_template text default 'modern',
  auto_chase_enabled boolean default false,
  is_admin boolean default false,
  updated_at timestamptz default now()
);

-- deals
create table if not exists deals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  brand_name text not null,
  amount numeric not null,
  currency text default 'USD',
  status text default 'pending',
  due_date date,
  deliverable text,
  notes text,
  paid_at timestamptz,
  created_at timestamptz default now()
);

-- expenses
create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  deal_id uuid references deals(id) on delete set null,
  vendor text not null,
  amount numeric not null,
  currency text default 'USD',
  category text default 'other',
  receipt_url text,
  created_at timestamptz default now()
);

-- invoices
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  deal_id uuid references deals(id) on delete cascade,
  invoice_number text not null,
  brand_email text,
  brand_name text,
  brand_address text,
  service_date date,
  due_date date,
  line_items jsonb default '[]',
  subtotal numeric default 0,
  vat_rate numeric default 0,
  vat_amount numeric default 0,
  total numeric default 0,
  currency text default 'USD',
  notes text,
  status text default 'sent',
  portal_token text,
  created_at timestamptz default now()
);

-- invoice_sequences
create table if not exists invoice_sequences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_number int default 0
);
\`\`\`

Then create a **Storage bucket** named `avatars` and make it public.

### 4. Frontend Supabase keys

Open `login.html` and replace the hardcoded Supabase URL and key
near the top of the `<script>` block:

\`\`\`js
const supabase = window.supabase.createClient(
  'YOUR_SUPABASE_URL',
  'YOUR_SUPABASE_ANON_KEY'
);
\`\`\`

(Also anywhere else you see `xpccuovjcsixpcmudyin.supabase.co`.)

### 5. Run

Backend:
\`\`\`bash
node server.cjs
\`\`\`

Frontend:
\`\`\`bash
npx serve -l 5500
\`\`\`

Open `http://localhost:5500/login.html`.

## Deployment

- **Backend** — Render (Node.js web service, start command `node server.cjs`)
- **Frontend** — Netlify or Vercel (static site)

On Netlify, add a `_redirects` file to proxy API calls:

\`\`\`
/api/*    https://your-backend-url.com/api/:splat    200
/portal/* https://your-backend-url.com/portal/:splat 200
/*        /index.html                                 200
\`\`\`

## Making a user an admin

In Supabase → profiles table → find the user → set `is_admin = true`.
Then they can visit `admin.html` to manually grant Pro to any account.

## Enabling Pro subscriptions (optional)

See the comments near `POST /api/subscribe` in `server.cjs`. The code
was stubbed to return "coming soon". To enable:

1. Re-implement the Paystack init logic in `/api/subscribe`
2. Add a webhook at `/api/webhooks/paystack`
3. Un-disable the Pro buttons in `pricing.html`
4. Set `PAYSTACK_SECRET_KEY` in your environment

## Project structure

\`\`\`
server.cjs                      # Express backend
package.json
.env.example
account-reconciliation.js

*.html                          # All frontend pages
auth.js                         # Global auth helpers
toast.js                        # Toast notifications
mobile.css                      # Responsive styles
\`\`\`

## Known limitations

- No automated tests
- Currency is per-transaction (deals/expenses keep their original currency)
- Invoice emails are not sent
- Pro tier is disabled