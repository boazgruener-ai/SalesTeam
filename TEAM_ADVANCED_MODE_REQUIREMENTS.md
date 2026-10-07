# SalesTeam — Team Advanced Mode: Requirements

Target release: **1.2.3, together with Exclusions & Relationships** (Q1, answered 2026-10-07). Test builds
continue from that item's last one: 1.2.2.5, 1.2.2.6 …
Status: **Requirements — agreed 2026-10-07** (all questions in section 6 answered). Design follows separately.
Date: 2026-10-07

---

## 1. Why this exists

1.2.2 gave a team one shared set of accounts, contacts and leads (posts), and **basic mode**: every
member takes unassigned accounts from one common pool ("Assign to me") and works them; the Team Admin can
reassign. That is enough for three or four people who talk every day. It stops working when a sales
manager needs to **steer** who works what:

- territories — EMEA, USA, Asia; or Western / German-speaking / Italian-speaking Switzerland;
- special lists — VIP accounts, global accounts, existing customers;
- cover — one person as backup for every region.

Advanced mode finishes team management: the **Team Lead** defines **account groups** — each one a saved
filter on the accounts — and assigns **members to groups**. Members see and work only the accounts of their
groups. Inside a group, colleagues share the work with the Assign to me / Release mechanism of 1.2.2.

Example (Boaz, 2026-10-05): members 1 and 3 — EMEA; member 2 — VIP and Global; members 4 and 5 — USA and
Asia; member 6 — all regions, as backup.

---

## 2. How it works today (1.2.2 basic mode, the starting point)

- Two roles: **Team Admin** (the creator) and **Member**. The data model already allows more than one
  admin (an `admins` folder in the team folder), but the UI offers no way to add one.
- An account is **Unassigned** or **Assigned to X**. Assign to me / Release in every account menu;
  Reassign to… and Release all for the admin. An assigned account is off-limits to colleagues (edits,
  its contacts, its leads (posts), their pipelines) and readable by everyone.
- Target Accounts filter: **Mine / Others / Unassigned / All**, plus Removed… (admin).
- The background pipelines of all members share the unassigned accounts between them (rendezvous
  hashing) — every unassigned account is worked by exactly one member's pipeline.
- The Team Admin owns Setup, rules, Remove / Restore, join proposals and Remove from team. Members see
  Setup read-only.
- Accounts carry the fields a group rule needs: country (Global HQ Country), industry, size band,
  Local / Global, company type, priority (P1–P3) and, from 1.2.3, Relationship (Customer / Partner).

---

## 3. Requirements

### R1 — Roles: Team Lead and Member

- R1.1 Two roles (answer Q9). **Team Lead** — the 1.2.2 **Team Admin, renamed**: keeps everything the
  Team Admin does (folder, Setup, rules, Remove / Restore, join proposals, Remove from team) and adds
  groups. **Member** — works the accounts of their groups.
- R1.2 The Team Lead manages **all** groups (answer Q2): creates, edits and deletes groups, puts members
  into groups and takes them out (only the Team Lead does this), approves group changes (R5), sees every
  account.
- R1.3 **One Team Lead per team** (the creator, as in 1.2.2). The Team Lead can **hand the role over** to
  another member — e.g. while away — and get it back the same way (Settings > Team, members table, ⋮ "Make
  Team Lead"; the previous Team Lead becomes a Member). Answer Q13.
- R1.4 A Team Lead works accounts like anyone else and follows the same assignment rule: an account
  assigned to a colleague is changed only through Reassign / Release, never edited directly (as in 1.2.2).

### R2 — Account groups: a filter, or a list of named accounts

- R2.1 A group has a **Name**, a **Description** and one of two kinds of content (answer Q10):
  - a **Filter** — e.g. "Swiss accounts": Region = EMEA, Country = Switzerland, Size = M, L, XL;
    "VIP": Type = Global, Size = XXL. Accounts get in and out by their data.
  - **Named accounts** — a plain list of accounts picked by the Team Lead, with no filter logic (the
    "named accounts" allocation many sales teams use). E.g. a small Swiss team splits accounts by person —
    "Anna's accounts", "Luc's accounts" — mixing sizes, perhaps by language area (German, French, Italian).
- R2.2 Filter fields: Region (continent), Country, Size (S, M, L, XL, XXL — the Setup size buckets),
  Local / Global, Industry, Company type, Priority (P1–P3), Relationship (Customer / Partner). Several
  values in one field mean *any of*; several fields mean *all of*. Values are picked from lists (what exists
  in the accounts and in Setup) — no free typing.
- R2.3 An account belongs to **every group whose filter it matches, and every named-accounts list it is
  on** — one, or several (answer Q3: an account can be in EMEA and in VIP).
- R2.4 **Preview before saving:** while a filter or a named-accounts list is edited, the screen shows how many accounts match and
  lists them ("Matches 42 accounts — 30 unassigned, 12 assigned"). Nothing changes until **Save**.
- R2.5 **Other** — a built-in group that cannot be deleted, and has no filter of its own (like a
  named-accounts group, it is not a filter). It holds every account that is in no other group, so there are
  no ungrouped accounts (answer Q6). Typical case: a just-discovered account whose
  country or size is not known yet; it moves to its group once research fills them in. The Team Lead
  assigns members to Other like to any group.
- R2.6 **Named accounts are added by hand:** the Team Lead puts accounts on a named-accounts group with
  **Add to group…** / **Remove from group…** (account ⋮ menu — list row and page, one action set — and bulk
  edit for many at once), and from the group itself in Settings > Team (search and tick accounts). A
  **filter** group has no hand exceptions (answer Q10: an account from another country makes no sense in
  "Country = Switzerland"; if one is ever needed, it goes on a named-accounts group).
- R2.7 New accounts land in **filter** groups automatically — from Discovery (LinkedIn and web), import,
  the pipeline, a join — because the filter decides. A new account never lands on a named-accounts list by
  itself: if no filter catches it, it waits in Other until the Team Lead adds it to a list.
- R2.8 Deleting a group: its accounts stay in their other groups, or go to Other. The confirm dialog says
  how many.
- R2.9 Groups exist only in a team. A solo user sees nothing new.

### R3 — Members per group, and what they see

- R3.1 A group has one or more members; a member can be in several groups. (Example: members 1 and 3 —
  EMEA; member 2 — VIP; member 6 — every group, as backup.)
- R3.2 A member **sees only the accounts of their groups** — in Target Accounts, Target Contacts, the
  Leads Dashboard and the side panel (answer Q4: everything else distracts from their own work). Contacts
  and leads (posts) follow their account.
- R3.3 Accounts outside their groups do not appear anywhere for the member. The one exception is the 1.2.2
  team-wide check: when a scan, discovery or import meets a company the team already has, the member is
  told "The team already has this company" (no details), so it is not created twice.
- R3.4 A member is told in the top bar when added to or removed from a group ("Boaz added you to the group
  VIP").

### R4 — Working inside a group: assign and release, as in 1.2.2

- R4.1 Everyone who has access to a group (its members and the Team Lead) shares its accounts through
  **Assign to me / Release**: an unassigned account can be taken by any of them; once assigned, the others
  can **view** it but not edit it, research it, or draft to, copy for or contact its contacts and leads
  (posts).
- R4.2 An account in two groups can be taken by a member of either group. The first to assign it has it
  (claim, then confirm — as in 1.2.2).
- R4.3 Reassign to… and Release (any account) stay Team Lead actions; Reassign offers only members who
  have access to the account through one of its groups.

### R5 — When an account changes group

- R5.1 The Team Lead changes an account's groups by adding it to or removing it from a named-accounts
  group (R2.6), by editing a group's filter, or by editing the account's data.
- R5.2 When **research** finds data that would change the groups of an **assigned** account (e.g. a new
  employee count turns it into XXL, so it becomes VIP), the change is not applied by itself: it goes to the
  **Team Lead's Decisions** ("Roche: size L → XXL — moves from 'Swiss accounts' to 'VIP'"). For an
  unassigned account it is applied as usual (it simply lands in its new group) — answer Q11.
- R5.3 Once an account has moved (Team Lead by hand, or research approved by the Team Lead), **only
  members of its new groups** can access it (answer Q7). If it was assigned to someone who is not in any of
  its new groups, the assignment ends: the account becomes unassigned in its new group, the former assignee
  loses access, and both they and the Team Lead are told ("Roche moved to VIP — it is no longer in your
  groups"). If the assignee is also a member of a new group, they keep it.

### R6 — Choosing a group in the dashboards

- R6.1 Target Accounts, Target Contacts and the Leads Dashboard get one picker in the toolbar, where
  Mine / Others / Unassigned / All is today:
  - **All my groups** (default);
  - each of **my groups** separately, e.g. "EMEA" — to see and work only that group;
  - combined with the 1.2.2 owner choice **Mine / Others / Unassigned** inside that selection;
  - the Team Lead also gets **All accounts** and every group, including Other.
- R6.2 The last choice is remembered per page.
- R6.3 A **Groups** column (on by default in a team with groups) and the groups in the account page
  header next to the assignee ("EMEA · VIP · Assigned to Anna").
- R6.4 A team without groups shows today's Mine / Others / Unassigned / All, unchanged (R9).

### R7 — Background pipeline and discovery (answer Q12: recommendation agreed)

- R7.1 **Team Lead:** the pipeline may work every account (all groups, including Other), and the Team
  Lead runs Discovery for new accounts.
- R7.2 **Member:** the pipeline works only the accounts of their own groups — the unassigned ones, shared
  with the group's other online members as in 1.2.2, and their own assigned ones.
- R7.3 Each account is still worked by exactly one pipeline at a time (1.2.2 rendezvous hashing, now among
  the online people who have access to it). A group with no member online is covered by the Team Lead's
  pipeline when it runs.
- R7.4 Research costs fall on the API key of whoever's pipeline did the work, as today — with groups, that
  is the person who works those accounts.

### R8 — Group overview for the Team Lead (Q8)

- R8.1 Settings > Team gets a **Groups** section — the place where the Team Lead creates and edits groups.
  One row per group: name, kind (filter summary, or "Named accounts"), members, and four counts:
  accounts, assigned, unassigned, Ready.
  Plus the row for Other. Clicking a count opens Target Accounts filtered to it.
- R8.2 The counts show at a glance where work is waiting: a group with many unassigned accounts and no
  member, a growing Other (a filter to widen), a member with nothing assigned.

### R9 — Turning it on and off

- R9.1 Advanced mode is **on when the team has at least one group** besides Other. A team without groups
  works exactly as 1.2.2 (basic mode). No separate switch.
- R9.2 When the first group is created, every member who is not yet in a group is put in **Other**, so no
  one suddenly sees nothing; the Team Lead then assigns members to groups.
- R9.3 Existing assignments are kept when groups are created or edited — except where R5.3 applies (the
  assignee no longer has access).

### R10 — Same picture on every PC

- R10.1 Groups, filters, named-accounts lists, members per group and the Team Lead role are shared team
  data, written only by the Team Lead, merged like Setup (1.2.2 sync layer).
- R10.2 Every PC computes the same groups for the same account (the filter evaluation is a pure function,
  tested in `test_pure_modules.py`).
- R10.3 Group, role and access changes go to the team log ("Boaz made Anna Team Lead", "Roche moved to
  VIP").

### R11 — Help, PRD, release notes

- R11.1 Help: new "Account groups" entry; "Team Admin" renamed "Team Lead" everywhere (Help, Settings >
  Team, top bar, menus, PRD); update "Working as a team".
- R11.2 PRD section and one 1.2.3 release-notes entry covering Exclusions & Relationships and advanced
  mode; store listing / website only if they describe team roles (messaging rules apply).

---

## 4. Out of scope

- Per-contact ownership (a contact owned by someone other than the account's assignee).
- Automatic assignment of accounts to people (round robin) — not needed; members take accounts
  themselves (answer Q5).
- **Company Admin** (later — Boaz, 2026-10-07): a role above the teams, for the whole company, so the Team
  Lead is not loaded with administration. Read-only on accounts, contacts and leads (posts); creates and
  manages teams, sets up new users and puts them in the right team, checks that each user's API key has
  budget, handles imports and exports, and does clean-up (accounts in Other, accounts with no size or no
  contacts). Needs several teams per company, which 1.2.3 does not have (one team = one folder).
- Hand exceptions in a filter group — use a named-accounts group instead (answer Q10).
- A "language area" field (German / French / Italian-speaking Switzerland, from the canton) that would let
  a filter do what a named-accounts list does by hand today.
- Quotas, targets per member, commission, forecasting; a reporting dashboard with charts.
- Custom permission sets per person beyond the two roles.
- CRM territory sync (HubSpot / Salesforce) — the CRM items on the roadmap.
- Microsoft Graph data layer (Option B).

---

## 5. Build outline (for the design)

0. Data: groups (name, description, filter or named-accounts list), Other; pure group evaluation +
   tests; shared keys and merge; the access rule (who may see an account) in one place; Team Admin →
   Team Lead rename.
1. Settings > Team: Groups section (create / edit with preview / delete / members), counts, hand over
   Team Lead.
2. Visibility: members see only their groups' accounts, contacts, leads (posts), side panel.
3. Group picker on the three pages, Groups column, page header; top-bar notices; team log.
4. Group changes: Add to group… / Remove from group…, research changes to Decisions, loss of access
   (R5.3).
5. Pipelines and discovery per role (R7).
6. Help, PRD, release notes → 1.2.3 (with Exclusions & Relationships).

---

## 6. Questions — answers and what is still open

Answered 2026-10-07:

- **Q1 — Version.** Hold 1.2.3 (Exclusions & Relationships, built in commit 22f07fc, not submitted) and
  **ship both together as 1.2.3**. Test builds go on as 1.2.2.5 …; the final 1.2.3 package is rebuilt at
  the end.
- **Q2 — Team Lead scope.** **Manages all groups.** → R1.1
- **Q3 — Groups per account.** **One or more** (EMEA and VIP). A group has a name, a description and a
  filter — or a list of named accounts. → R2
- **Q4 — Visibility.** **Members see only their groups' accounts** (no distraction). → R3.2
- **Q6 — Ungrouped.** **No ungrouped accounts:** a default group (Other) holds whatever matches no other
  group. → R2.5
- **Q7 — An account changes group.** Moved by hand by the Team Lead, or by research approved by the Team
  Lead → only members of the new group can access it, even if someone else was working on it. → R5
- **Q5 — Round robin.** **Not needed.** → Out of scope
- **Q9 — Roles.** **Team Lead is enough for now** (the 1.2.2 Team Admin, renamed). A company-wide Admin
  with read-only access to accounts comes later, with several teams. → R1, Out of scope
- **Q10 — Moving an account by hand.** **No exceptions in a filter group.** Instead, a second kind of
  group: **named accounts** — a list with no filter, for teams that allocate accounts by name. → R2.1, R2.6
- **Q11 — Research moving an account.** **Team Lead approves only for assigned accounts.** → R5.2
- **Q12 — Pipelines.** **Recommendation OK.** → R7

- **Q8 — Overview.** **OK as described** (R8).
- **Q13 — Team Lead hand-over.** **One Team Lead per team, who can hand the role over when away.** → R1.3
- Two kinds of group (filter and named accounts) **confirmed** — no exceptions needed; Other is also a
  non-filter group. → R2
