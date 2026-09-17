# PayPoint

A finance workspace for content creators — track brand deals, expenses, and generate professional invoices.

---

## What works

- ✅ Email/password signup and login (via Supabase)
- ✅ Google OAuth sign-in
- ✅ Dashboard — revenue, expenses, taxes set aside, take-home
- ✅ Deals — create, edit, delete, notes, currency per deal
- ✅ Expenses — create, delete, link to deals, receipt upload
- ✅ Invoices — create, list, PDF generation, CSV export
- ✅ Profile — edit name/bio, avatar upload, bank details, business details
- ✅ Settings — currency preference, tax rate
- ✅ Admin page — manually grant Pro to any user (`is_admin` flag in `profiles`)

## What's coming soon (intentionally disabled)

- 🚧 **Pro subscriptions** — the upgrade button shows "coming soon". The Paystack integration code is stubbed but preserved. See [Enabling Pro subscriptions](#enabling-pro-subscriptions-optional) below.
- 🚧 **Invoice email delivery** — invoices are created and stored, but the "email to brand" step is not wired up. Add Resend or Nodemailer to enable.
- 🚧 **Auto-chase reminders** — scheduled reminders for overdue invoices are not implemented.

---

## Tech stack

| Layer | Tech |
|---|---|
| Backend | Node.js + Express |
| Database | Supabase (PostgreSQL) |
| Auth | Supabase Auth |
| File storage | Supabase Storage (`avatars` bucket) |
| PDF generation | PDFKit |
| Payments | Paystack (currently disabled) |
| Frontend | Plain HTML + CSS + JS (no build step) |

---

## Setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd paypoint-backend
npm install
```

### 2. Create your `.env`

Copy `.env.example` to `.env` and fill in the values.

```
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxxxxx

FRONTEND_URL=http://localhost:5500
BACKEND_URL=http://localhost:3000

ALLOWED_ORIGINS=http://localhost:5500,http://localhost:3000

PORT=3000
NODE_ENV=development
```

Get the Supabase keys from **Supabase → your project → Settings → API**.

### 3. Create Supabase tables

Run this in **Supabase → SQL Editor**:

```sql
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
```

Then in **Supabase → Storage**, create a bucket named `avatars` and mark it **public**.

### 4. Frontend Supabase keys

Open `login.html` and find:

```js
const supabase = window.supabase.createClient(
    'https://xpccuovjcsixpcmudyin.supabase.co',
    'sb_publishable_IOAC8ZpWsF1YOGTsrrnXLQ_5SzGAGWf'
);
```

Replace with your own Supabase URL and anon key:

```js
const supabase = window.supabase.createClient(
    'YOUR_SUPABASE_URL',
    'YOUR_SUPABASE_ANON_KEY'
);
```

Search the entire project for `xpccuovjcsixpcmudyin.supabase.co` and replace any remaining occurrences.

### 5. Run

Backend:

```bash
node server.cjs
```

Server starts on `http://localhost:3000`.

Frontend:

```bash
npx serve -l 5500
```

Open `http://localhost:5500/login.html`.

---

## Deployment

### Backend (Render)

1. Create a **Web Service** on Render
2. Connect your Git repo
3. Build command: `npm install`
4. Start command: `node server.cjs`
5. Add all `.env` variables in Render's environment settings
6. Set `FRONTEND_URL` and `BACKEND_URL` to your real deployed URLs (no trailing slash)

### Frontend (Netlify)

Deploy the static HTML files. Then create a file named `_redirects` (no extension) in the root of your deployed site:

```
/api/*    https://your-backend-url.com/api/:splat    200
/*        /index.html                                 200
```

### Frontend (Vercel)

A `vercel.json` is included that proxies `/api/*` to your backend. Update the destination URL to your own Render URL.

---

## Google OAuth setup

For Google sign-in to work on your own domain:

1. Go to **Google Cloud Console → APIs & Services → Credentials**
2. Find your OAuth 2.0 Client ID
3. Under **Authorized redirect URIs**, add your Supabase callback:
   ```
   https://<your-project-ref>.supabase.co/auth/v1/callback
   ```
4. In **Supabase → Authentication → Providers → Google**, paste your Google Client ID and Client Secret

---

## Making a user an admin

1. In **Supabase → Table Editor → profiles**, find the user's row
2. Set `is_admin` to `true`
3. The user can now visit `admin.html` to grant Pro to any account by email

---

## Enabling Pro subscriptions (optional)

Pro is stubbed to return "coming soon". To enable:

1. In `server.cjs`, replace the stubbed `/api/subscribe` route with the Paystack init logic (preserved in git history)
2. Add a webhook endpoint at `/api/webhooks/paystack` to upgrade users on payment success
3. In `pricing.html`, remove `disabled` from the Pro buttons and re-enable the click listeners
4. Set `PAYSTACK_SECRET_KEY` in your environment
5. Configure your Paystack dashboard to send webhooks to `https://your-backend.com/api/webhooks/paystack`

---

## Project structure

```
server.cjs                      # Express backend (all API routes)
package.json
.env.example
account-reconciliation.js       # Merges accounts that share an email

index.html                      # Landing page
login.html                      # Login / signup + Google OAuth
dashboard.html                  # Main dashboard
deals.html                      # Deals list
deal-detail.html                # Single deal with profit
expense.html                    # Expenses list
invoice.html                    # Invoices list
invoice-customization.html      # Invoice branding (Pro)
creator.html                    # Profile page
settings.html                   # Settings
pricing.html                    # Pricing page
admin.html                      # Admin: manual Pro upgrade
pay-invoice.html                # Public invoice view
success.html                    # Paystack success page
cancel.html                     # Paystack cancel page
contact.html
privacy.html
terms.html

auth.js                         # Global auth helpers
toast.js                        # Toast notifications
mobile.css                      # Responsive + mobile bottom nav
```

---

## Known limitations

- No automated tests
- Currency is per-transaction (a $500 deal stays $500 even if you change your preference)
- Invoice email delivery is not wired up
- Auto-chase reminders are not implemented
- Pro tier is intentionally disabled

---

## Support

Contact the original author for questions about this codebase.