# DCR Employee Portal

A secure login site for DCR employees. Employees sign in and can view/edit only the
SharePoint tables their role (and per‑user overrides) allow.

- **Frontend** (this folder) → hosted on **GitHub Pages**. Static HTML/CSS/JS, **no secrets**.
- **Backend** → the existing **Vercel** project (`share-point-api`, the `DCR Internal Website`
  repo). All authentication and permission checks run there; secrets stay in Vercel.

```
Squarespace ──▶ GitHub Pages (this folder) ──fetch()──▶ Vercel /api ──▶ Microsoft Graph ──▶ SharePoint
```

---

## Part 1 — Backend (Vercel)

The new backend files already live in the repo:

```
lib/            graph.js, lists.js, http.js, auth.js, permissions.js, users.js, handlers.js
api/portal.js   single serverless function; routes by ?action=
                  action=login   POST email/password -> session token
                  action=me      current user + permissions
                  action=lists   admin: table catalog for the permissions picker
                  action=users   admin: create/update users
                  action=data    authenticated data gateway (enforces per-user access)
                  action=setup   one-time bootstrap (creates AppUsers list + first admin)
```

> All portal endpoints are consolidated into one function (`api/portal.js`) so the
> project stays under Vercel's Hobby-plan 12-function limit.

### 1a. Add environment variables in Vercel
Project → **Settings → Environment Variables** (keep the existing `TENANT_ID`,
`CLIENT_ID`, `CLIENT_SECRET`, `ADMIN_API_KEY`), then add:

| Name          | Value |
|---------------|-------|
| `AUTH_SECRET` | A long random string (32+ chars). Generate one: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `CORS_ORIGIN` | Comma‑separated allowed origins, e.g. `https://YOURNAME.github.io,https://www.dcrframing.com` |

### 1b. Deploy
From the `DCR Internal Website` folder:
```
npm install        # pulls in bcryptjs + jsonwebtoken (added to package.json)
vercel --prod
```
Note your production URL (e.g. `https://share-point-api.vercel.app`).

### 1c. One-time setup (create the AppUsers list + first admin)
Run this **once**, replacing the URL, admin key, and your details:
```
curl -X POST "https://share-point-api.vercel.app/api/portal?action=setup" \
  -H "X-Admin-Key: YOUR_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"cristobal@dcrframing.com","password":"ChangeMe12345","displayName":"Cristobal"}'
```
- Creates a SharePoint list named **AppUsers** and seeds you as **Admin**.
- If the Graph app can't create lists, the response tells you exactly which columns to add
  manually to an `AppUsers` list, then re-run the command.
- Log in once and change your password from the admin console.

---

## Part 2 — Frontend (GitHub Pages)

### 2a. Point the site at your backend
Edit **`config.js`** and set `API_BASE` to your Vercel URL (no trailing slash):
```js
window.DCR_CONFIG = {
  API_BASE: "https://share-point-api.vercel.app",
  COMPANY_NAME: "DCR Framing",
};
```

### 2b. Publish to GitHub Pages
Push **the contents of this `dcr-portal` folder** to a GitHub repo (e.g. `dcr-portal`), then:
Repo → **Settings → Pages** → Source = `main` branch, root. Your site will be at
`https://YOURNAME.github.io/dcr-portal/`.

Make sure that origin is included in the backend's `CORS_ORIGIN`.

### 2c. Test
Open the Pages URL, sign in with the admin account, then **Admin** → create a test user,
assign a role, and confirm that user only sees the tables they're allowed to.

---

## Part 3 — Squarespace
Add a button/link on your Squarespace site pointing to the portal:
```html
<a href="https://YOURNAME.github.io/dcr-portal/"
   style="display:inline-block;padding:12px 20px;background:#c8371f;color:#fff;
          border-radius:8px;text-decoration:none;font-weight:600">
  Employee Login
</a>
```
A **link/button** (or full‑page embed) is recommended over a small `iframe`: the login
session is stored in the GitHub Pages origin, and cross‑origin iframes complicate that.

---

## Roles
| Role       | Default access |
|------------|----------------|
| **Admin**    | Read/write every table + user management |
| **Manager**  | Read/write everything except sensitive lists (passwords, settings) |
| **Field**    | Edit TimeSheets & To‑Do lists; view core project/material/vehicle tables |
| **ReadOnly** | View a safe operational subset; no editing |

Per‑user **overrides** (Admin console → edit user) can grant, upgrade, downgrade, or fully
remove access to any individual table, on top of the role default.

## Security notes
- Passwords are stored only as **bcrypt hashes** in the AppUsers list — never in plain text.
- Sessions are **signed JWTs** (12‑hour expiry) verified server‑side on every request.
- The browser never receives the SharePoint admin key or Graph credentials.
- Every read/write goes through `api/data.js`, which checks the user's permissions **before**
  touching SharePoint — the frontend cannot grant itself access.
- Changing a user's role/permissions takes effect on their **next login** (token refresh).
