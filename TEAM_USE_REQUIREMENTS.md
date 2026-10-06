# SalesTeam — Team Use: Requirements

Target release: **1.2.2** (test builds 1.2.1.1, 1.2.1.2 …)
Status: **Requirements — agreed 2026-10-02** (all questions in section 9 answered). **Data layer: a shared
OneDrive folder (Option A)**, chosen to avoid any IT involvement. Design and implementation follow separately.
Date: 2026-10-02

Test build 1.2.1.1 is already taken by an unrelated fix (the Setup page's API-key field and three research
buttons had no style in 1.2.1); team-use builds start at 1.2.1.2.

---

## 1. Why this exists

SalesTeam is single-user by design: every account, contact, lead, setting and log entry lives in one
browser's `chrome.storage.local`. Give it to the four or five people of one sales team and each of them
holds a separate copy that drifts from the others from the first day: the same account researched twice
(and paid for twice), the same contact approached by two colleagues, and no one with an overview.

The goal is one shared body of data that every member's SalesTeam works on, without two members ever
overwriting each other's work.

---

## 2. Two phases (Boaz's proposal, 2026-10-01)

**Phase 1 — shared data.** Accounts, contacts and leads (posts) live in one shared store. No team
concept, no roles, no workflow yet. The only rule: updates by different salespeople must not collide.
Check and lock per entity — the first user gets to update, the next is told to wait. (With a OneDrive
folder this becomes *claim, then confirm* — see R3.3.)

**Phase 2 — the team.** Several users share one pipeline and workflow. Two roles at least: Salesperson
and Team Admin. The admin adds users, manages team settings and allocation, and defines what a user may do.
- *Basic mode:* a user assigns an unassigned account to themselves and works it, or releases it. An
  assigned account is blocked for everyone else.
- *Advanced mode:* the admin defines queues by rules (country/region, industry, size band, or a
  combination) and assigns one or more salespeople per queue. Every newly discovered account lands in its
  queue automatically. Members see their queue(s) by default; the admin sees and works everything.

**Q1 — what ships as 1.2.2?** The versioning rule is one whole work item per store release. Phase 1 alone
is useful (no duplicate research, no double outreach) but leaves "who works what" to talking. Proposal:
**1.2.2 = phase 1 + phase 2 basic mode** (self-assign is cheap once the lock exists — an assignment is a
long-lived lock with a name on it); advanced mode (queues, rules, admin dashboards) = the following item. **Answered 2026-10-02: yes —
1.2.2 includes "Assign to me" / release.**

---

## 3. The data layer — what it has to deliver

### 3.1 How SalesTeam stores data today (the starting point)

- All data is in `chrome.storage.local`, per browser profile (`unlimitedStorage`, so no 10 MB cap).
- Data is held as **whole maps**: `targetAccounts`, `targetAccountsWorkbook`, `targetAccountExtras`, the
  leads, settings, etc. A writer reads the whole map, changes a few entries and writes the whole map back.
- Concurrent writers inside one browser are already serialised by a Web Lock
  (`withAccountWriteLock`, 1.2.1 step 0). Web Locks are per browser only; they cannot see another PC.
- The background pipeline writes on its own (research, readiness, discovery), with nobody watching.
- One shared-folder mechanism exists already: the user-chosen backup folder (File System Access,
  `backup-folder.js`). It works only from an open SalesTeam page, and Chrome asks again for permission
  after a restart, which can only be granted by a click.

### 3.2 Requirements

**R3.1 — One source of truth.** Every member reads the same accounts, contacts and leads. A change
saved by one member is visible to the others **within about a minute** while both PCs are online and
OneDrive is syncing, without anyone clicking refresh.

**R3.2 — No lost updates.** A save never silently overwrites a change it did not see. This holds for
people and for the background pipeline alike.

**R3.3 — Lock per entity (phase 1's rule): claim, then confirm.** When a member starts changing an
entity (opens it for editing, or the pipeline starts researching it), SalesTeam writes a claim. Others see
**"Anna is updating this account (since 10:42)"** and cannot change it until she is done. Reading is never
blocked. Because OneDrive needs a few seconds to copy a claim to the other PCs, two members can claim the
same entity within that window. The **earliest claim wins**; the other member is told at once ("Ben
started on this account a few seconds before you — your change is kept aside and can be applied when he is
done"). Nothing is lost silently.

**R3.4 — Locks cannot get stuck.** A lock whose holder closed the browser, lost the connection or crashed
expires by itself (proposal: 5 minutes without a sign of life). A member can see who holds a lock and
since when.

**R3.5 — The pipeline is a polite team member.** A member's background pipeline skips any entity claimed
or assigned by someone else and moves on; it never waits on a person. To keep two members' pipelines off
the same account even inside the sync window, each pipeline works only its member's assigned accounts plus
a **fixed share of the unassigned ones** (a stable split by account, so the shares never overlap). A rare
double research (about US$0.08) is acceptable; a double outreach is not.

**R3.6 — Shared versus personal data.** Not everything is shared. Proposed split (**Q4**):

| Shared by the team | Personal to each member |
|---|---|
| Target accounts, their contacts, readiness and web findings | Anthropic API key and its monthly web budget |
| Leads (posts) and their status | LinkedIn daily limits and today's touch counters |
| Who contacted whom, when (outreach history) — so no contact is approached twice | Drafts not yet sent, Sales Mentor history |
| Decisions queue | Personal profile (name, title, signature), output language |
| Seller setup: offers, ideal customer, exclusions, aliases, targets | Activity Log (plus a shared team log of who changed what) |

**R3.7 — The team never depends on a SalesTeam server, a sign-in or IT.** The public promise "no server,
no resale" stays true: team data lives in a OneDrive folder the **customer** owns. No Microsoft sign-in and
no app approval by the company's IT — the only Microsoft software involved is the OneDrive app already on
every PC. (Section 4 explains the choice.)

**R3.8 — Works offline as read-only.** If the shared folder is not reachable, or SalesTeam sees that it
has had no news from the team for a long time (OneDrive paused or the PC offline), a member still sees the
last known data, clearly marked "not in sync — showing data from 10:42", and cannot edit shared entities
until sync is back. (SalesTeam cannot ask OneDrive whether it is in sync; it judges by the heartbeat every
member's SalesTeam writes into the folder.) (Queuing offline edits and merging them later is possible but is the single largest
source of complexity; not in 1.2.2 — **Q5**.)

**R3.9 — Getting a team started.** One member (the future admin) creates a team folder in OneDrive (or a
synced Teams/SharePoint library), shares it with the team, and turns their existing local data into the
team store. Others join by syncing that folder to their PC, setting it to **"Always keep on this device"**,
and picking it in SalesTeam — with numbered, click-by-click instructions in the join step. A joining member's own local data is
**not** merged automatically: they are shown what they hold that the team does not (accounts not in the
team store) and choose what to add.

**R3.10 — Single users are not affected.** Someone who never sets up a team sees no change, no new
permission warning, no new setup step.

**R3.12 — Folder access after a browser restart.** Chrome lets SalesTeam use the folder only from an open
SalesTeam page, and asks for one click to allow it again after each browser restart (the backup folder
works the same way). SalesTeam shows one clear "Click to reconnect to the team folder" in the top bar.
While the folder is not connected, the background pipeline keeps working and its results are written to
the folder as soon as it is reconnected — nothing is lost, it only arrives later.

**R3.11 — Every change says who and when.** Each shared entity carries "last changed by / at". This is
also the foundation of phase 2's dashboards.

---

## 4. Where the shared data can live — the three options

**Decided 2026-10-02: Option A, a shared OneDrive folder.** Boaz's reason: limit any possible friction with
the team's IT — the team already has to ask its CIO for an Anthropic API key, and a second request
(approving an app's access to company files) is to be avoided. Option B stays documented below as a later
upgrade; the files are designed so that they could one day be reached through Microsoft directly, without
changing them.

The heart of the matter is R3.3: a real lock needs one place that can say "you got it, and nobody else
did". The three candidates differ exactly there.

### Option A — a synced shared folder (OneDrive / SharePoint / Dropbox sync client, or a network drive)

The extension reads and writes JSON files in a local folder that the OneDrive client keeps in sync.
This is Boaz's original idea and it reuses the backup-folder mechanism.

- **No real lock is possible.** Each PC writes its own local copy and the sync client copies files
  around seconds to minutes later. Two members can both create the lock file for the same account within
  that window and **both** believe they hold it. The browser's file API has no "create only if absent"
  either, so not even a network drive gives an atomic lock this way.
- Simultaneous writes to the same file produce **conflict copies** ("account-PC-ANNA.json") rather than
  errors, and the data has to be merged afterwards.
- It can still be made safe — but only by giving up the lock: each member writes only **their own**
  change journal, everyone reads everyone's journal, and a claim that turns out to be the second one
  within the sync window is undone with a notice ("Ben claimed this account a few seconds before you").
  That meets R3.2 but only *approximately* meets R3.3.
- File access works only while a SalesTeam page is open and needs a re-click after each browser restart,
  so the background pipeline cannot sync on its own.
- Plus: nothing to register, nothing to log in to, works with any sync product.

### Option B — the customer's Microsoft 365 (OneDrive / SharePoint) through the Microsoft Graph API — later upgrade

The same OneDrive or SharePoint folder, but the extension talks to Microsoft's servers directly instead
of to the local sync client.

- **Real locks.** Graph can create a file "only if it does not exist yet" (conflict behaviour *fail*)
  and can save a file "only if nobody changed it since I read it" (an ETag check). Both are decided on
  Microsoft's server, so exactly one member wins. That gives R3.2 and R3.3 exactly.
- **Works from the background**, with no folder permission re-click: the extension signs in once with the
  member's work account and refreshes the sign-in itself.
- **Change feed.** Graph's delta query tells the extension which files changed since the last check —
  cheap polling every 30–60 seconds meets R3.1.
- Data stays in the customer's own tenant; still no SalesTeam server (R3.7).
- Costs and risks:
  - The extension needs an app registration in Microsoft Entra ID, and a sign-in. Many company tenants
    only allow users to consent to apps from a **verified publisher** (requires a Microsoft Partner
    Network ID), or require **IT admin consent**. For one known team the simplest route may be that
    their IT registers the app in their own tenant and pastes in its ID. **Q3.**
  - New permissions (`identity`, access to `graph.microsoft.com` and `login.microsoftonline.com`). They
    can be requested **only when a user turns team mode on** (optional permissions), so single users see
    no new warning on update (R3.10).
  - Tied to Microsoft 365. A Google Workspace team would need a second adapter later.

### Option C — a hosted SalesTeam backend (e.g. Cloudflare Workers + database)

- Technically the cleanest: real locks, live updates, accounts and roles in one place.
- But SalesTeam would then **store customers' scraped contact data on its own server**: it becomes a data
  processor under GDPR (contracts, security obligations, breach duty), it needs user accounts and billing
  for running costs, and it breaks the "no server" statement in the store listing, website and privacy
  policy (R3.7). **Not recommended for 1.2.2.** Worth revisiting only if SalesTeam is sold to many teams.

### Comparison

| | A synced folder | B Microsoft Graph | C SalesTeam server |
|---|---|---|---|
| Real per-entity lock (R3.3) | no — detect and undo | **yes** | yes |
| No lost updates (R3.2) | yes, via per-member journals | **yes** | yes |
| Visible to others within ~1 min (R3.1) | depends on sync client | **yes** (delta poll) | yes (live) |
| Background pipeline can sync | no (page must be open) | **yes** | yes |
| "No server" promise (R3.7) | kept | **kept** | broken |
| Setup for the team | pick a folder | sign in once; IT consent may be needed | create accounts |
| Works without Microsoft 365 | yes | no | yes |
| Build effort | medium (journals + merging) | medium (sign-in + Graph calls) | high |

How the decision went on 2026-10-02: first Option B (the team uses Microsoft 365); then, once it was clear
that Microsoft's default since July 2025 requires IT admin approval for any third-party app that touches
files, verified publisher or not (4.1), **Option A**. For a team of four or five the cost of "claim, then
confirm" is small: two people choosing the same account within the same few seconds is rare, and it is
resolved with a notice rather than lost data.

---

### 4.1 Why Option B would need a Microsoft sign-in and IT approval (background to the decision)

- **Why sign in.** With Option B, SalesTeam reads and writes the team's files on Microsoft's servers, not
  through the OneDrive app on the PC. Microsoft lets a program do that only on behalf of a person who has
  signed in — exactly as when you open SharePoint in a browser. So each member signs in **once**, in
  Microsoft's own window, with the work account they already use for Outlook and Teams, and clicks
  **Accept** on "SalesTeam would like to read and write your files". SalesTeam never sees the password;
  it keeps a sign-in token that renews itself.
- **What SalesTeam needs for that.** A one-off "app registration" with Microsoft (Microsoft Entra ID,
  free): the name tag Microsoft shows in that window. Boaz creates it once; customers do nothing.
- **Why IT may need to approve.** That Accept screen grants an outside app access to company files.
  By Microsoft's default, many companies let employees accept only apps from a **verified publisher**;
  otherwise the screen says "Need admin approval", and an IT admin approves SalesTeam once for the whole
  company. Becoming a verified publisher (free Microsoft Partner Network ID + the aisalesteam.app domain)
  removes that in most companies; some companies require IT approval for every app regardless.
- **Checked 2026-10-02: verification alone will most likely NOT avoid IT.** Since July 2025 Microsoft's
  default consent policy ("Let Microsoft manage your consent settings") blocks users from accepting any
  third-party app that accesses **files and sites** — verified publisher or not; users can only send a
  request to their admin. Verification helps only in companies that have switched to "allow user consent
  for all apps". Verification itself needs a Microsoft AI Cloud Partner Program account with a verified
  legal business, an email on the aisalesteam.app domain, and an Entra work tenant with that domain
  DNS-verified. Worth it later, when selling to many companies; not as a way around IT for one team.
- **What IT approval actually is:** one admin opens a link, signs in, clicks Accept for the whole company
  (minutes, once). Members then sign in without any further approval.
- **A local browser extension does not change this.** Microsoft's approval is about which app asks for
  access to company files, not where its code runs. Being local helps only in the conversation with IT (no
  vendor server; access could be narrowed to one SharePoint site with `Sites.Selected`).
- **Option A needs none of this:** SalesTeam only reads and writes files on the PC; the OneDrive app the
  company already approved does the syncing.

## 5. What changes underneath

These are design-level consequences, recorded here because they size the work.

- **Each member writes only their own files.** OneDrive turns two simultaneous writes to the same file into
  a conflict copy ("account-PC-ANNA.json"). So no file is ever written by two members: each member's
  SalesTeam writes its changes and claims into **its own** files in the team folder, and every member reads
  everyone's files and merges them into the same picture by fixed rules (earliest claim wins; for the same
  field, the later change wins and the overwritten value is kept in the team log).
- **Heartbeat.** Each member's SalesTeam updates a small "last seen" file every minute while connected.
  This is how others see who is active, how claims expire (R3.4), and how SalesTeam judges "not in sync"
  (R3.8).
- **From whole maps to per-entity records.** The shared store holds one record per entity (proposal:
  one file per **account bundle** — the account with its contacts and readiness — plus one per lead, and
  one for the shared setup). Every record carries a revision, "changed by" and "changed at". Locking an
  account then locks its contacts too, which is also what phase 2's assignment needs.
- **`chrome.storage.local` stays, as the local copy.** The existing pages and writers keep reading and
  writing the local maps as today. A new **sync layer** sits underneath: it diffs what a writer changed,
  turns it into per-entity saves against the shared store, and pulls others' changes into the local maps.
  This keeps the ~170 existing write sites unchanged, instead of rewriting storage.js.
- **Locks have two lengths.** A *write lock* lasts seconds to minutes (an edit, a research run) and
  expires by itself. An *assignment* (phase 2) is a lock with no expiry that only its holder or the admin
  releases. One mechanism, two lifetimes.
- **The pipeline gets a "skip if claimed or assigned by someone else" check** before it starts on an
  account, and works only its own share of the unassigned accounts (R3.5).
- **Personal data stays local**: API key, limits, counters, drafts, Activity Log (R3.6).

---

## 6. Phase 2 basic mode (part of 1.2.2 — Q1)

**R6.1** — An account shows **Assigned to: Anna** or **Unassigned**. Any member can take an unassigned
account ("Assign to me") or release their own. An assignment follows the same claim-then-confirm rule
(R3.3): if two members assign the same account to themselves within seconds, the earlier one keeps it and
the other is told.
**R6.2** — An assigned account can be read by everyone but changed, researched, scanned or contacted only
by its assignee. The pipeline does not touch another member's assigned accounts (except shared,
non-personal research — **Q6**). **Decided 2026-10-02: no** — an assigned account is off-limits to
every other member's pipeline as well.
**R6.3** — Target Accounts gets a quick filter **Mine / Others / Unassigned / All** (Others = assigned to a colleague; changed 2026-10-05).
**R6.4** — Roles at their simplest: the member who created the team store is Team Admin; the admin can
release or reassign any account and remove a member. Everything else (queues, rules, dashboards, finer
rights) is advanced mode.

**From the competitor research (2026-10-02, `Competitive Analysis/Team Versions - Competitors.md`):**

**R6.5 — "Assigned to Anna since 3 Oct" wherever it appears.** The assignee (or an active claim, R3.3) is
shown on every account and contact in SalesTeam's lists and detail pages, **and on the LinkedIn profile or
company page itself** while a member browses LinkedIn. (Surfe and ZoomInfo show "owned by X" from the CRM.)

**R6.6 — Team-wide check when scanning or adding.** When a scan, discovery or import would add a lead,
contact or account the team already holds, or one a colleague has assigned or claimed, SalesTeam flags it
("Ben already works this account") instead of creating a second copy; the member can still open it, and
override only where they are allowed (their own unassigned items). (Waalaxy's anti-duplicate on import,
Dux-Soup's "reject profiles from other campaigns".) Duplicates are recognised by the same keys SalesTeam
uses today (normalised company name, LinkedIn URL).

**R6.7 — Merge screen when a member joins with their own data.** Extends R3.9: the overlaps between the
joining member's local data and the team store are listed side by side, and the **Team Admin** decides for
each one who keeps it (or accepts a proposed owner — the member who already assigned or contacted it).
(Waalaxy's retroactive dedupe on joining.)

**R6.8 — One shared "do not contact" list.** Exclusions (companies and people not to approach) are team
data, not personal: one list for the whole team, which every member's scans, discovery and drafts respect.
Members can add to it; removing an entry is the Team Admin's. (Expandi's company-wide blacklist.)
*Changed 2026-10-05 (Boaz):* re-classifying a company (normal → competitor, customer, partner, recruiter, or back) is
the **Team Admin's only**, in Setup; a member who thinks an account is wrongly classified asks the admin (email,
Teams, a call). "Do not contact" in the sense of *keeping colleagues away from an account during a critical phase* is
covered by **Assign to me** (R6.2 blocks colleagues' outreach); a lock on a single contact is left out for now.

---

## 7. Non-goals for 1.2.2

- Live co-editing of the same field (Google-Docs style).
- Offline editing with later merge (R3.8).
- The Microsoft Graph route (Option B) or any other cloud API — later upgrade.
- A hard, server-decided lock (possible only with Option B or C).
- Queues, assignment rules, admin dashboards and reports (advanced mode).
- Further ideas from the competitor research — team dashboard per person, "who on the team knows this
  person", shared templates, per-seat pricing — are recorded there for later items.
- A SalesTeam server (Option C).

---

## 8. Risks

- **OneDrive not syncing.** A paused OneDrive, an offline laptop, or a folder left "online only" means a
  member works on old data and their changes arrive late. Mitigation: the heartbeat-based "not in sync"
  warning and read-only mode (R3.8), and the "Always keep on this device" step in the join instructions.
- **Sync delay larger than expected.** OneDrive normally copies small files within seconds, but nothing
  guarantees it. Step 0 measures it on real PCs; if it is regularly over a minute, R3.1's target is revisited.
- **Folder permission after restarts** (R3.12): a forgotten reconnect click delays sharing until the
  member opens SalesTeam.
- **Shared LinkedIn exposure.** Each member scans with their own LinkedIn account; nothing changes there,
  and the daily touch limit stays per person. But "who contacted whom" becomes visible to the whole team —
  members must know that (wording in the team-join step).
- **Data protection.** A team store holds personal data of LinkedIn contacts in the customer's own
  storage; the customer is responsible for it. The privacy policy and Help need a team paragraph.
- **Migration.** Turning one member's local data into the team store must be lossless and reversible:
  take a full backup first, automatically.

---

## 9. Questions for Boaz

- **Q1** — 1.2.2 = phase 1 + phase 2 basic mode? **Yes (2026-10-02)**, including Assign to me / release.
- **Q2** — Microsoft 365? **Yes** — Outlook, Teams, SharePoint, OneDrive.
- **Q3** — IT approval for Option B: explained in 4.1. **Decided: avoid it — Option A, a shared OneDrive
  folder** (the team already needs its CIO's approval for an Anthropic API key).
- **Q4** — Shared/personal split in R3.6: **agreed as proposed.**
- **Q5** — Offline = read-only: **agreed for 1.2.2.**
- **Q6** — May a member's pipeline research an account assigned to a colleague (results are shared anyway),
  or is an assigned account off-limits to everyone else's pipeline too? **No — off-limits (2026-10-02).**

---

## 10. Next steps

1. ~~Boaz answers Q1–Q6~~ — done 2026-10-02.
2. **Step 0 spike (proof before design), on two real PCs sharing one OneDrive folder:** (a) how long
   OneDrive takes to bring a small file from PC 1 to PC 2 — typical and worst case over a working day;
   (b) two PCs claiming the same account within a second both end up agreeing on the same winner, and the
   loser gets the notice; (c) no conflict copies appear when each PC writes only its own files; (d) the
   reconnect click after a browser restart, and results produced while disconnected arriving afterwards.
3. Then `TEAM_USE_DESIGN.md` (data model, sync layer, lock protocol, join/migration flow, UI) and the
   build steps.
