# Company mail hosting

Friday's Team Console can create real company mailboxes (`name@yourcompany.com`) for employees, and
gives every staff member a **Mailbox** (webmail) that reads that mailbox plus any Gmail / Outlook / Zoho
/ iCloud / other IMAP account they add. Mailboxes are standard IMAP/SMTP accounts, so the same address
and password also work in the Gmail app, Outlook, Apple Mail and on phones.

The mail itself lives on **our own mail server**: [mailcow](https://mailcow.email) (open source —
Postfix, Dovecot, rspamd spam filtering, ClamAV, SOGo webmail, DKIM) on a VPS we control. Friday
creates and manages mailboxes through mailcow's REST API (`backend/src/services/mail/hosting.ts`).
Friday does not run a mail server inside the app: delivery, spam filtering and IP reputation are what
mailcow is for.

## 1. Server

- A VPS with **port 25 open both ways**. Many clouds block outbound 25 by default (AWS, GCP, Azure,
  DigitalOcean, and Railway can't run a mail server). Hetzner, OVH, Contabo and Netcup allow it,
  sometimes after a short request.
- Size: 2 vCPU and 6 GB RAM (4 GB if ClamAV is disabled), and 40 GB+ disk plus mailbox storage.
- A hostname such as `mail.yourcompany.com` with an **A record** pointing at the server IP.
- **Reverse DNS (PTR)** for the server IP set to `mail.yourcompany.com`, in the VPS provider's panel.
  Gmail and Outlook check this.

Install it by following mailcow's official guide (docker + compose, `git clone
https://github.com/mailcow/mailcow-dockerized`, `./generate_config.sh` with the hostname, `docker
compose up -d`). Then sign in to the mailcow admin UI at `https://mail.yourcompany.com`.

## 2. API key for Friday

In mailcow, go to **System → Configuration → Access → API**, create a **read-write** key, and allow
only the Friday server's outbound IP. Then set these on the Friday backend (Railway variables, or the
AWS JSON secret):

```
MAILCOW_URL=https://mail.yourcompany.com
MAILCOW_API_KEY=<read-write key>
# optional — the host mail apps connect to, if it differs from MAILCOW_URL's host
MAIL_SERVER_HOST=mail.yourcompany.com
```

Then apply migration `0041_add_company_mail.sql`.

## 3. Domains and DNS

In Team Console, go to **Mail hosting → Add domain**. Friday creates the domain on mailcow, generates
a 2048-bit DKIM key and shows the DNS records to add at your DNS provider:

| Record | Name | Value | Why |
|---|---|---|---|
| MX (10) | yourcompany.com | mail.yourcompany.com | incoming mail |
| TXT | yourcompany.com | `v=spf1 mx a:mail.yourcompany.com ~all` | SPF |
| TXT | dkim._domainkey.yourcompany.com | (shown in the console) | DKIM signing |
| TXT | _dmarc.yourcompany.com | `v=DMARC1; p=quarantine; rua=mailto:postmaster@…` | DMARC |
| CNAME | autodiscover / autoconfig | mail.yourcompany.com | phones/Outlook auto-setup |

If you already use Resend for Friday's own emails, keep its SPF `include:` in the same SPF record (one
SPF record per domain, e.g. `v=spf1 mx a:mail.yourcompany.com include:amazonses.com ~all`).
Alternatively, keep Resend on a subdomain (`send.yourcompany.com`).

Check the setup by sending a test to [mail-tester.com](https://www.mail-tester.com). It should score
9/10 or better.

## 4. Mailboxes

Create mailboxes in **Mail hosting → New mailbox**. Pick the employee, the name before the @, the
storage size, and either a password or a generated one. The password is shown once. Picking an
employee also links the mailbox to their **Mailbox** in the Console, so they don't have to type
anything.

Each mailbox drawer can reset the password, disable the mailbox (it can't sign in or receive mail,
and keeps its mail), change the owner, or delete it. Deleting removes the mailbox **and its mail**,
and you must type the address to confirm.

Employees can change their own mailbox password under **Mailbox → Accounts**. Every action is in the
audit log.

## 5. Using it anywhere

Settings for any mail app (also shown in Mailbox → Accounts):

- Incoming: IMAP, `mail.yourcompany.com`, port 993, SSL/TLS
- Outgoing: SMTP, `mail.yourcompany.com`, port 465 SSL/TLS (or 587 STARTTLS)
- Username: the full email address. Password: the mailbox password.

**Gmail app / Gmail on the web:** In Gmail, go to Settings → Accounts → "Check mail from other
accounts" (POP), or in the Gmail mobile app add an "Other" account with the IMAP settings above.

**External accounts in the Friday Mailbox:** Gmail, Outlook, Yahoo and iCloud need an **app
password** (with 2-step verification turned on), not the normal password. The add dialog links to
where to create one. Credentials are verified before they are saved and are stored encrypted
(`utils/crypto.ts`). Only public mail servers on mail ports are allowed, as an SSRF guard.

## 6. Operations

- **Backups:** use mailcow's `helper-scripts/backup_and_restore.sh` daily, stored off the server.
- **Updates:** run `./update.sh` in the mailcow folder monthly.
- **Monitoring:** watch the mailcow UI's queue and rspamd history. Friday's Mail hosting page shows
  per-mailbox storage used.
- **Costs:** add the VPS as a monthly expense in **Finance → Expenses** so it shows in the P&L.
