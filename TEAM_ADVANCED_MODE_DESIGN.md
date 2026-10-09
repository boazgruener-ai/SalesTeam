# SalesTeam — Team Advanced Mode: Design

Target release: **1.2.3, together with Exclusions & Relationships** (test builds 1.2.2.5, 1.2.2.6 …; step 1 = 1.2.2.7, step 1b = 1.2.2.8)
Status: **Design — agreed 2026-10-08.** All decisions D1–D19 answered (section 13).
Date: 2026-10-07
Builds on: `TEAM_ADVANCED_MODE_REQUIREMENTS.md` (agreed 2026-10-07) and `TEAM_USE_DESIGN.md` (the 1.2.2 sync
layer). Requirement numbers (R2.5, R5.3 …) refer to the requirements.

---

## 1. The design in one page

1. **The Team Lead is decided by the team folder, not by each PC.** Today the role sits in two places that can
   disagree: a local `membership.role` set once at create/join, and `admins/<member>.json` in the folder. A
   hand-over cannot be expressed: the old admin keeps `role: "admin"` locally, and nothing removes an admins
   file. From 1.2.3 there is **one source**: the creator (the single `admins/` file) is the first Team Lead.
   After that, each hand-over is a change record ("Boaz makes Anna Team Lead"), and it counts only if its author
   was Team Lead at that moment. Every PC walks the same records and reaches the same Team Lead. Every role
   check goes through one helper, `isTeamLead()` (section 3).
2. **Groups are one shared map, written only by the Team Lead.** In the new key `teamGroups`, each group is one
   row: name, description, kind (filter or named accounts), the filter or the account list, and its members.
   Other is a fixed row (`other`) that holds only members. The merge **ignores group records whose author was
   not Team Lead** at that stamp. This is the first role rule enforced in the merge itself; today "admin-only"
   is enforced in the UI only (section 4).
3. **Which groups an account is in is computed, never stored.** One pure module, `team-groups.js`, takes an
   account's effective values (country → region, size bucket, Local / Global, industry, company type,
   effective priority, relationship) and the groups, and returns its group ids. It is the same function on
   every PC, tested in `test_pure_modules.py` (R10.2). A just-discovered account gets its groups the moment it
   exists. An account matching no group is in Other (section 5).
4. **Access is one rule in one place:** `accessOf(account)` = the Team Lead, plus the members of the account's
   groups. The background computes it with the claim summary it already publishes (`teamAccountStates`), and
   every page asks `teamAccounts.canSee(key)`. Four pages build their own lists today and nothing is shared
   (Target Accounts, Target Contacts, Leads Dashboard, side panel), so the rule is wired into each of them, plus
   the account and contact pages, Decisions and the LinkedIn badge (section 6).
5. **An assignment the assignee no longer has access to is void on every PC.** This is computed, not written,
   so the rule does not depend on anyone's PC being online. The Team Lead's PC also writes an explicit release,
   for the log and the notices. This is R5.3 (section 8).
6. **Research does not move an assigned account by itself.** The data is updated (the employee count really is
   6,000). The account's *groups*, though, are held at their old value by a **pin** until the Team Lead
   decides in Decisions (R5.2). For an unassigned account the new groups apply at once (section 8).
7. **The pipeline works only what its owner may access** (R7). Rendezvous hashing is unchanged, now run among
   the online people who have access to each account. The Team Lead's pipeline covers what no online member
   can (section 9).
8. **A team without groups behaves exactly as 1.2.2** (R9.1). Every new path starts with
   `if (!advanced) return today's behaviour`.

---

## 2. What the code review found

### 2.1 Roles
- `teamMembership.role` (`"admin" | "member"`) is set once: on create (team-sync.js:1096) and on join (:1175).
  `admins/<member>.json` is written only on create (:1111) and read each round into `meta.admins` (:342).
- Two helpers combine them with OR: the background at team-sync.js:612 (published as
  `teamAccountStates.admin`) and the pages' `teamAccounts.isAdmin()` (team-accounts-ui.js:49).
- **Several checks read `role` directly and bypass both helpers:**
  - team-ui.js:457 and :478 (the role label, Release all, Remove from team);
  - onboarding.js:3086 (Setup read-only);
  - settings.js:789 (the research offer);
  - storage.js:775 (the relationships migration).
  After a hand-over these would still treat the new Team Lead as a Member.
- Background refusals (`not_admin`) are in assignInner (:893/:897), unassignAccount (:932), unassignAllOf
  (:961) and removeMember (:988).

### 2.2 Shared keys and the merge
- `team-keys.js` has four kinds of shared key: the workbook, `TEAM_MAP_KEYS` (one row per map entry),
  `TEAM_WHOLE_KEYS` (Setup and rules, whole value, last writer wins) and `TEAM_LIST_KEYS` (exclusions,
  relationships).
- A new map key needs one line. `TEAM_SHARED_KEYS`, `teamKeyKind` and `rowTarget` (team-rows.js:116) pick it up.
- **"Admin-written" is only a comment** (team-keys.js:39). `applyChange` (team-merge.js:112) checks the shape
  and the stamp, never the author's role. A member's Setup change would be accepted by every PC; the read-only
  Setup screen is the only guard.
- Entity type `team` exists in the merge (team-merge.js:83) but is unused, which suits the hand-over records.

### 2.3 Visibility today
- The owner filter `teamAccounts.ownerFilter` (team-accounts-ui.js:97) is applied in one place only: the
  companies table (`sortedFilteredCompanies`, target-accounts.js:1162).
- Target Contacts (`sortedFilteredContacts`, :2779), the Leads Dashboard (`loadLeads`, dashboard.js:410;
  `applyFilterSortSearch`, :1278) and the side panel (`computePipelineStats`, sidepanel.js:~63) have no team
  filter at all.
- **There is no common chokepoint.** `getAccountViews` (storage.js:5129) is used by the pipeline, the web
  lane, Target Accounts and Decisions, but each page builds its own list.
- Links between records: a contact belongs to its account by `companyId`; a lead belongs by
  `normalizeCompanyName(lead.company)`. The account key everywhere is `normalizeCompanyName`.

### 2.4 Fields a filter needs (all on the account view)

| Filter field | Source |
|---|---|
| Region | Not stored. Derived from `globalHqCountry` with `CONTINENT_COUNTRIES` (storage.js:3045, six regions: North America, Latin America, Europe, Africa, Middle East, South-East Asia) |
| Country | `globalHqCountry` (exact names from `ALL_COUNTRIES`) |
| Size | `SIZE_PRIORITY_BUCKETS` (storage.js:375): S ≤200, M ≤500, L ≤1000, XL ≤5000, XXL >5000; `resolveSizeBucket` (:3768, private) / `sizeBucketKey` (web-findings-arbitration.js:107, pure) |
| Local / Global | `targetCountryRelationship` ("Local company" / "Global company") |
| Industry, Company type | `industry`, `companyType` |
| Priority | the view's effective `salesTeamPriority` (customer raise included, `accountPriorityFor` → `effectivePriority`) |
| Relationship | the view's `relationship` array (`[]`, `customer`, `partner`) |

### 2.5 Pipeline, Discovery, Decisions
- `teamWorkGate()` (team-sync.js:1027) builds `members = [me, ...activeMembers]` and asks
  `pipelineOwner(key, members)` (team-merge.js:400). "Active" means seen in the last 10 minutes
  (`claimContext`, :595). The callers are the pipeline (pipeline-runner.js:385), the web lane (web-lane.js:115)
  and bulk research (bulk-research.js:24).
- **Discovery has no team check.** Any member's pipeline can run it (`kickPipeline` → `discoverForTargets`,
  pipeline-runner.js:162/225).
- **Decisions are not filtered by owner.** Only join proposals are admin-only (team-proposals.js:12). Adding a
  decision kind touches five places: `buildDecisionQueue`, `applyDecision`, `DECISION_KIND_LABELS`, decisions.js
  (`KIND_PLURAL` and render), and the watched keys.
- Research writes fields directly: `autoResolveWebFindings` (storage.js:5308) after the arbitration rules, and
  `applyEmployeeCheck` (:5636) for the LinkedIn employee count.

### 2.6 Smaller findings
- **Reassign to… offers former members** (left or removed): `teamReassign` (target-accounts.js:2338) uses
  `st.members` unfiltered. This is a bug; fixed in step 1.
- The members table has plain buttons, not a ⋮ menu (team-ui.js:494–535), which goes against the menu rule.
- Notices: `applyRemote` (team-sync.js:301) detects only "someone took / released *my* assignment". There is no
  detector yet for being assigned something, for group changes or for role changes.
- Each page saves its filters in its own localStorage keys, best effort. The owner filter has its own key
  (`salesteam-team-owner-filter`, target-accounts.js:2201).

---

## 3. Team Lead: one role, decided by the folder (R1)

### 3.1 The record
- A hand-over is a normal change record on the unused entity `team`:
  `{e: "team", id: "lead", op: "set", f: {member: "<new lead>"}}`, stamped and authored like every change.
- A pure function `teamLeadOf(creator, leadRecords)` in `team-groups.js` produces the result:
  1. start with the creator (the member in `admins/`);
  2. walk the hand-over records in stamp order (ties by member id);
  3. accept a record only if its author is the current Team Lead.
  Any order of arrival gives the same Team Lead on every PC. This is the property the tests shuffle.
- **Existing teams:** the one `admins/` file is the creator, so they need no migration. `admins/` stays
  read-only history; no new files are written there.
- `membership.role` is **no longer read** for the role. It stays only as the answer before the first folder
  read (create: lead; join: member).

### 3.2 One helper
- Background: `isTeamLead(member = me)`. It is published as `teamAccountStates.lead` (the member id), and
  `.admin` is kept as `lead === me` so old readers keep working during the build.
- Pages: `teamAccounts.isTeamLead()`.
- The six direct `role` reads in 2.1 are replaced with it. The background refusals (`not_admin` → `not_lead`)
  use it too.

### 3.3 Hand-over (R1.3)
- Settings > Team, members table, ⋮ on a colleague's row → **Make Team Lead…** Confirm dialog: "Anna becomes
  Team Lead. You become a Member and see only the accounts of your groups. Anna can make you Team Lead again."
- The record is written and flushed at once. Each PC switches when the record arrives.
- The former lead's PC applies the new rule straight away, without waiting for the folder, so they cannot keep
  editing groups in between.
- The new Team Lead sees all accounts. The former one is a Member: of the groups they were in, or of Other
  (D9).
- Team log: "Boaz made Anna Team Lead". Top bar on Anna's PC: "Boaz made you Team Lead".
- **A Team Lead who is gone** (left the company, PC lost) cannot hand over. Proposal D13 covers recovery.

### 3.4 Deputy Team Lead (Boaz, 2026-10-07; D15)
A temporary second lead, for absences, instead of handing the whole role over:
- The Team Lead picks a member: ⋮ → **Make deputy…** (at most one deputy at a time). The Team Lead stays Team
  Lead.
- **While deputy,** the member has the Team Lead's powers: sees every account, edits groups, members and Setup,
  answers Decisions, Reassign / Release, and their pipeline fills gaps (section 9). There are two exceptions:
  a deputy cannot remove or demote the Team Lead, and cannot appoint another deputy.
- **When the Team Lead is back,** they remove the deputy with ⋮ → **End deputy** (it needs no cooperation from
  the deputy). The deputy is a Member again, with their own groups.
- **The record:** `team|deputy` records are valid only from the then-current Team Lead, so it is the same chain
  as 3.1. A group record is accepted from the Team Lead *or* the deputy of that moment. `isTeamLead()` becomes
  `hasLeadRights()` for every check except hand-over, deputy and removing the Team Lead.
- **When both edit the same group** while the deputy is active, the later Save wins, as for any shared row. The
  loser's version is kept in the team log.
- Top bar: "Boaz made you deputy Team Lead" / "Boaz ended your deputy role". Team log the same.

---

## 4. Groups: the data (R2, R10)

### 4.1 `teamGroups` (shared map key, one row per group)
```
teamGroups["g-<random>"] = {
  name: "Swiss accounts", description: "…",
  kind: "filter" | "named",
  filter: { region: ["europe"], country: ["Switzerland"], size: ["M","L","XL"],
            scope: [], industry: [], companyType: [], priority: [], relationship: [] },
  accounts: ["roche", "ubs", …],   // named only: normalised company keys
  members: ["m-boaz", "m-anna"],
  createdAt, updatedAt, deleted: false
}
teamGroups["other"] = { members: [...] }   // built in, never deleted, no filter or list
```
- It is registered in `TEAM_MAP_KEYS` as `{key: "teamGroups", e: "setting", prefix: "teamGroups:"}`. Each group
  merges as its own row, so a change to EMEA never touches VIP.
- **A deleted group is marked, not removed.** A late change from an older PC then cannot revive it unnoticed.
  The row stays hidden, and the deletion is logged.
- **Named-account lists hold company keys** (the same key claims use). A renamed account therefore moves off
  the list, as its claim does. The list editor shows "2 accounts on this list no longer exist" with Remove.
  This is rare, and it is better than losing them silently.

### 4.2 Only the Team Lead writes groups (R10.1)
- In `applyChange`, a `set` or `delete` on a `teamGroups:` row is **ignored unless its author was Team Lead at
  its stamp** (from 3.1).
- To keep the merge order-free, it runs in two passes: the `team|lead` records first, then everything else.
  The tests shuffle both.
- An ignored record goes to the team log as "ignored: Anna's change to group VIP (not Team Lead)". It should
  never happen through the UI.
- Setup and rules keys keep today's UI-only guard (D2).

### 4.3 Personal state
- Per page: the picker choice (R6.2), in localStorage next to each page's existing filter state.
- `teamGroupNoticesSeen`: which group notices were acknowledged.

---

## 5. Which groups an account is in (pure `team-groups.js`)

### 5.1 Facts
- `groupFacts(view, ctx)` turns an account view into plain values:
  - `region`: the region whose list contains `globalHqCountry`;
  - `country`;
  - `size`: the bucket from the same employee count and bucket function the Size column and the size priority
    use (D4);
  - `scope`: local / global;
  - `industry`, `companyType`;
  - `priority`: effective, P1–P5;
  - `relationship`: an array.
- An unknown value is `null`.
- **The country→region table moves out of storage.js** into a pure module `geo-regions.js`. storage.js imports
  it back, so there is still one copy. `resolveSizeBucket` is replaced by the pure `sizeBucketKey` that already
  exists, after checking in the tests that both give the same bucket.

### 5.2 Matching
- `matchesFilter(facts, filter)`:
  - each field with values must match: *any of* its values, and *all* fields together (R2.2);
  - an empty field means "no condition";
  - **a `null` fact never matches a field that has values**, so an account with no country is not "Europe".
    It falls to Other until research fills the country in (R2.5).
- `groupsOf(key, facts, groups, pins)` returns:
  - the pinned groups, if the account has a pin (section 8);
  - otherwise every filter group it matches, plus every named list it is on;
  - otherwise `["other"]`.
  This is R2.3, R2.5 and R2.7. New accounts never land on a named list on their own, because nothing writes a
  list but the Team Lead.
- **A filter group with no conditions at all** would catch every account. Saving one is refused: "Add at least
  one condition — or use All accounts."

### 5.3 Members and access
- `membersOf(groupId, groups, activeTeam)`: a group's members. **A member in no group is counted in Other**
  (D9). This replaces R9.2's one-time write and also covers members who join later.
- `accessOf(groupIds, groups, lead)`: the Team Lead, plus the members of those groups.
- `mayAccess(member, …)`: true for the Team Lead; otherwise true if the member is in one of the account's
  groups.

### 5.4 Where it is computed
- The background already computes and publishes `teamAccountStates` (claims and assignments per account key).
  In advanced mode it adds, per account, `g` (its group ids) and per summary `myGroups`, `lead` and
  `groupsOn: true`.
- It recomputes when `teamGroups`, the workbook, `targetAccounts`, extras, relationships or the lead record
  change, at most once every 2 seconds. It calls `getAccountViews`, the same call the pipeline already makes.
- **Cost:** ~600 accounts × a handful of groups is well under 50 ms. This is to be measured in step 0 against
  the live data.

---

## 6. Visibility (R3)

### 6.1 The helper
- `teamAccounts.canSee(key)` reads the published summary: true outside advanced mode; true for the Team Lead;
  otherwise `g ∩ myGroups ≠ ∅`.
- Contacts are checked through their account (`companyId` → company → key). Leads are checked through
  `normalizeCompanyName(lead.company)`.

### 6.2 Where it is wired in

| Place | Change |
|---|---|
| Target Accounts, companies | `sortedFilteredCompanies` filters by `canSee` before the picker (section 7) |
| Target Contacts | `sortedFilteredContacts` filters through the contact's account |
| Leads Dashboard | after `loadLeads`, leads whose company is a team account the member cannot see are dropped. A lead whose company is **not** a team account is shown only to the Team Lead (and deputy) and to the member who scanned it (D12). New leads get a `scannedBy` member id. For older leads, the author of the change record that first brought the lead into the team stands in, and leads from the team's base file count as the Team Lead's. Once the company becomes an account, the lead follows that account's groups. |
| Side panel | `computePipelineStats` counts only visible accounts, contacts, leads |
| Account / contact page | opened by link or history for an invisible account: "This account is not in your groups." and nothing else (no data shown) |
| Decisions and red dot | items about an invisible account are left out; group-move items are the Team Lead's only |
| Exports (CSV, HubSpot) | export what the member sees (D3) |
| LinkedIn badge | an invisible account: "SalesTeam — the team already has this company" (R3.3), no name, no assignee |
| Discovery / scan / import "already have it" | unchanged: the local data is the team's data, so duplicates are still caught; the member is told only "The team already has this company" (R3.3) |

### 6.3 What visibility is, and is not (D3)
- The data still syncs to every PC. The team folder is shared in OneDrive, and the sync layer needs every row
  to merge. Hiding is a **view filter**, which is what R3.2 asks for (no distraction). It is not a secrecy
  guarantee against a member who opens the folder.
- The full backup (Settings > Backup) still contains everything, as today.
- Help says so plainly.

---

## 7. The group picker, column and header (R6)

- **Toolbar, in place of today's owner pills:** two compact dropdowns.
  - **Group:** All my groups · each of my groups · (Team Lead: All accounts · every group · Other).
  - **Assigned:** All · Mine · Others · Unassigned (the 1.2.2 filter: who the account is assigned to).
  - In basic mode the Group dropdown is hidden and the Assigned choice looks exactly as today (R6.4).
- The same control goes on Target Contacts and the Leads Dashboard (new on both), from one shared builder in
  `team-accounts-ui.js`, so the three pages cannot drift. The choice is remembered per page (R6.2).
- **Groups column** (Target Accounts, on by default when groups exist; Contacts and Leads get it hidden by
  default). It shows names, comma-separated; a pinned account shows "Swiss accounts (move to VIP waiting)".
- **Page header:** "EMEA · VIP · Assigned to Anna" next to the existing assignee badge.
- **Deep links from the Groups overview:** `target-accounts.html?group=<id>&owner=unassigned` (and
  `&ready=1`) set the pickers and the Ready filter on load.

---

## 8. Changing groups, and losing access (R2.6, R5)

### 8.1 By the Team Lead
- **Add to group… / Remove from group…** go in the account ⋮ (row and page — one shared builder) and in bulk
  edit. They are shown only to the Team Lead, and only named groups are offered.
- The Team Lead can also edit a list in Settings > Team: search, tick, preview, Save.
- Editing a filter, deleting a group or editing an account's data by hand applies at once (R5.1).

### 8.2 By research on an assigned account: the pin (R5.2)
- **Where it is detected:** in the sync layer's local → team step, which already sees every write with its old
  and new value. For each changed account it compares `groupsOf` before and after. A pin is written if all of
  these hold:
  - the groups differ;
  - the account is assigned;
  - the write came from automatic work (pipeline, web lane, bulk research, all of which already mark their
    writes as the actor "Automatic"), or from a member who is not the Team Lead.

  The pin goes into the new shared map key `teamGroupPins[key] = {groups: <old>, proposed: <new>, reason:
  "size L → XXL", by, at}`.
- **Effect:** the data is saved as found, but `groupsOf` returns the pinned groups. Nobody loses access, and the
  account stays with its assignee.
- **Decisions (Team Lead only):** a new kind, `group_move`: "Roche: size L → XXL — moves from 'Swiss accounts'
  to 'VIP'. Assigned to Anna, who is not in VIP." The answers:
  - **Move it**: the pin is deleted, the new groups apply, and 8.3 follows.
  - **Keep it where it is**: the pin stays, `proposed` is cleared, and the account stays put while it is
    assigned.
- **The pin is removed** when the account is released or reassigned. It then lands in its computed groups, as
  an unassigned account would.
- **An unassigned account** never gets a pin. The new groups apply at once (R5.2).

### 8.3 Losing access (R5.3)
- **The rule, computed on every PC:** an assignment whose assignee is not Team Lead and has no access through
  the account's current groups is **void**. The account shows as unassigned in its new group, and the former
  assignee can no longer see it. It does not wait for any PC to write anything (D6).
- **The explicit release:** the Team Lead's PC, when it saves a change that voids assignments (filter edit,
  list edit, member taken out of a group, Move it), writes an `unassign` for each one. The log then reads
  "Roche moved to VIP — released from Anna", and a later group change cannot bring back an old assignment.
- **Notices:** Anna's top bar shows "Roche moved to VIP — it is no longer in your groups". The Team Lead sees
  the same in the save confirmation, with the count before saving:

  > "Saving this filter moves 14 accounts; 3 of them lose their assignee (Anna 2, Luc 1). Save / Cancel."

- **If the assignee is also in a new group,** they keep the account (R5.3).

---

## 9. Pipeline and Discovery (R7)

- **Who may work an account:** `teamWorkGate().mayWork(key)` gains one check before today's, `mayAccess(me,
  key)`. A member's pipeline, web lane and bulk research never touch accounts outside their groups.
- **Sharing:** the rendezvous candidates for an account become the **online members who have access** to it,
  instead of all online members.
- **The Team Lead (D7, answered 2026-10-08: a setting):** Settings > Team, shown to the Team Lead and the
  deputy, has **"My pipeline researches:"** with two choices. It is a personal setting, kept on that PC.
  - **"Only accounts no member can work right now"** (default). The Team Lead joins an account's candidates
    only when no other online person has access to it, plus their own assigned accounts. Members' groups are
    therefore worked by members, and the research cost lands on their keys (R7.4). The Team Lead's pipeline
    fills the gaps: a group with nobody online, and Other when no member is in it (R7.3).
  - **"All accounts".** The Team Lead is a candidate for every account and takes an equal share of every group
    alongside its online members. That is faster, but more of the research runs on the Team Lead's key.

  The choice is published with the heartbeat, so every PC builds the same candidate lists and the shares stay
  disjoint.
- **Every PC computes the same "online with access" set** from heartbeats and the shared groups, so the shares
  stay disjoint, as in 1.2.2. During a ≤15 s sync window two PCs can briefly disagree; today's claim-before-work
  absorbs it, and the worst case is one double research (~US$0.08).
- **Discovery (D8):** in advanced mode only the Team Lead's pipeline runs Discovery. `discoveryMayRun` returns
  "team: Discovery is run by the Team Lead" for members. In basic mode nothing changes.

---

## 10. Settings > Team: Groups section and members table (R1.3, R8)

### 10.1 Members table
- The plain buttons become a row **⋮** (the menu rule), shown to the Team Lead:
  - **Make Team Lead…**;
  - **Groups…** (tick the member's groups — the other way to edit membership);
  - **Release all**;
  - **Remove from team…**
- A new **Groups** column lists each member's groups ("Other" when none).
- Role column: Team Lead / Member.

### 10.2 Groups section (Team Lead edits; members see it read-only, their own groups marked)

| Group | Kind | Members | Accounts | Assigned | Unassigned | Ready |
|---|---|---|---|---|---|---|
| Swiss accounts | Region Europe · Country Switzerland · Size M, L, XL | Anna, Luc | 42 | 12 | 30 | 25 |
| VIP | Named accounts (18) | Boaz | 18 | 18 | 0 | 16 |
| Other | everything in no group | Fay | 7 | 0 | 7 | 1 |

- Each count opens Target Accounts with the matching pickers (section 7).
- Warnings in the row, where work is waiting (R8.2):
  - "no members";
  - "Other is growing: 12 new this week — widen a filter?";
  - in the members table, "nothing assigned".
- **+ New group** and the row ⋮ (**Edit…**, **Delete…**) open the editor:
  - Name and Description;
  - Kind: Filter / Named accounts (the kind is fixed once saved; to change it, create a new group);
  - **Filter:** one multi-select per field. Values come from what the accounts hold, plus Setup (sizes S–XXL,
    P1–P3, Customer / Partner, the six regions); there is no free typing (R2.2).
  - **Named accounts:** search box + tick list of all accounts, with the ticked ones first.
  - **Members:** ticks.
  - **Preview**, live as the editor changes: "Matches 42 accounts — 30 unassigned, 12 assigned", the first 50
    listed, and — when editing — "+5 join, −3 leave; 1 loses its assignee" (R2.4).
  - **Save / Cancel**. Nothing changes until Save (the explicit-save rule).
- **Delete…:** "VIP has 18 accounts: 11 stay in their other groups, 7 go to Other. Members of VIP who are in no
  other group move to Other." (R2.8)
- **First group (R9.2):** after the first Save, a one-time notice: "Advanced mode is on. Members see only their
  groups' accounts. Fay, Luc are in Other until you add them to a group." Nothing is written for that (D9).

---

## 10a. Invitations and the team list (D17, D18 - Boaz, 2026-10-08)

### 10a.1 The Team Lead invites (D17)
- Settings > Team, below the members table: **Add member…** (Team Lead and deputy). The dialog asks for the
  colleague's **name** and **e-mail** (the e-mail is only shown, to tell two people of the same name apart). Save
  writes `invites/<invite id>.json` into the team folder: `{ name, email, by, at }`.
- **No groups in the invitation** (Boaz, 2026-10-08 - simpler): after the colleague has joined, the Team Lead puts
  them into groups like any member (⋮ Groups…). Until then they are in Other (D9).
- The members table lists them as **Invited** (name, e-mail, "invited 8 Oct by Boaz"). Their ⋮ has **Cancel
  invitation…** (the file is marked cancelled, not deleted, so a late join is refused).
- The Team Lead still shares the folder in OneDrive (right-click > Share, "Can edit") - SalesTeam cannot do that.
  The dialog's last line says so, with the folder's name.

### 10a.2 The member accepts
- Join a team, after the team is chosen (10a.3): SalesTeam reads the open invitations and shows them -
  "Boaz invited: **Annick Zutter** (anna@…)". The one whose name matches the User Profile name is preselected.
  **Join as Annick Zutter** joins with the name from the invitation. The backup and the "accounts to bring" question
  stay as today.
- The PC writes `invites/<id>.json` back as accepted (with the time). An invitation that is accepted or cancelled
  is not offered again; two PCs accepting the same one at once: the later acceptance is refused with "This
  invitation has just been used on another PC".
- **No joining without an invitation** (Boaz, 2026-10-08 - the Team Lead controls who is in the team): a team with no
  open invitation for this person is not offered. Chosen by folder (fallback), it is refused with "There is no
  invitation for you in this team. Ask the Team Lead to add you (Settings > Team > Add member…)."
- The Team Lead gets a top-bar notice when an invitation is accepted: "Annick Zutter joined the team - add her to
  groups?".
- **As built (1.2.2.8, Boaz's live tests 2026-10-08/09):** the button is **Join Team** (nobody can join as someone
  else - the name comes from the invitation, so the button does not repeat it). With one team, its name is the heading
  ("Join the team "TimeToAct2"") and no list is shown. Invitation names match on letters and digits only ("member2" =
  "Member 2"). An invitation waiting for this person is a priority message in the top bar on every page ("Boaz has
  invited you - **Join…**", greyed out while the Join screen is open); Join… opens the Join screen with it ticked.
  A team found without an invitation for this person is named: "You have no invitation to the team "X" yet. Ask
  your Team Lead to invite you." - and SalesTeam then looks again by itself every 30 s.

### 10a.3 Choosing the team from a list instead of a folder (D18)
- Chrome lets SalesTeam use a folder only after the person picked it once. So the first time, Join and Create ask
  for the **OneDrive folder itself** ("Choose your OneDrive folder" - the step-by-step text names it, e.g.
  "OneDrive - TimeToAct"), with "Allow on every visit". SalesTeam keeps that permission.
- **Join:** SalesTeam looks one level down for folders holding a `team.json` (a shared folder added with "Add
  shortcut to My files" appears there) and shows a dropdown of the teams **with an open invitation for this person**:
  **TimeToAct2 - created by Boaz, 5 Oct**. Choosing one is all; no folder picking. None found: "No team found in OneDrive yet - has the folder been shared with you and
  added to My files? It can take a minute to appear." and a Look again button.
- **Create:** the team name is typed as today; SalesTeam creates the folder `SalesTeam - <team name>` in OneDrive
  itself (no empty folder to make by hand). Sharing it stays the Team Lead's step in OneDrive.
- Fallback: "Choose a folder instead…" keeps today's folder picker, for a team folder that is not directly in
  OneDrive.
- The team folder is then reached through the OneDrive folder; reconnecting after a Chrome restart asks for the
  OneDrive folder once, as it asks for the team folder today.
- **REVERSED in the 1.2.2.8 test (Boaz, 2026-10-09): the team's folder is chosen directly, not the OneDrive folder.**
  Chrome refuses the OneDrive folder itself ("contains system files") when Windows keeps Desktop / Documents in it -
  the normal setup on a company PC. So:
  - **Create:** "Choose the team folder…" - in Chrome's folder window, OneDrive on the left, **New folder**, the
    team's name, Select Folder. The folder's name fills in the team name. A folder that already holds files is
    refused ("Choose the team folder again and click New folder to make an empty one"). SalesTeam does not create
    `SalesTeam - <team name>`.
  - **Join:** three numbered steps, each saying where it happens - in the e-mail (Open), on the OneDrive website (Add
    shortcut to My files), back in SalesTeam ("Choose your team's folder…"). SalesTeam then finds team folders in the
    chosen folder and up to two levels down. No "Look again" and no "Choose a folder instead…": while nothing joinable
    is found it looks again by itself every 30 s.
  - The result pop-ups have one OK and name only the next step (share the team folder: File Explorer > right-click >
    Share, "Can edit"; invite with Add member…).

### 10a.4 Not in a team yet: Join first, Create for the Team Lead only (D19 - Boaz, 2026-10-08)
- Only a Team Lead creates a team; members never do. A PC that is not in a team cannot know which one its user will
  be (there is no account or server holding roles - whoever creates the team becomes its Team Lead), so the screen
  steers instead:
  - **Main text and button for members:** "Your Team Lead invites you. **Join a team…**" (the dropdown of D18 offers
    only teams holding an invitation for this person).
  - **Create as a smaller line below:** "Are you the Team Lead, setting up a team for your colleagues? **Create a team
    as Team Lead…**". Its confirm repeats: "Only the Team Lead creates the team. If a colleague has invited you, use
    Join a team instead."
  - **An invitation waiting in OneDrive for this person:** Create is not offered at all - only "Boaz has invited you
    to TimeToAct2 - **Join**".
- Inside a team, Create and Join are hidden as today. A strict rule (who may ever be a Team Lead) needs the
  company-wide Admin role - a later item.
- Built in step 1b with the invitations.

## 11. Notices and team log (R3.4, R10.3)

- **New detectors in `applyRemote`,** next to today's reassign detector, each a `teamNotices` entry with OK in
  the top bar:
  - added to or removed from a group ("Boaz added you to the group VIP");
  - an account of mine lost to a group move;
  - made Team Lead / no longer Team Lead;
  - advanced mode switched on.
- **Team log (`team-log.js`) gains readable lines:**
  - "Boaz created the group VIP (named, 18 accounts)";
  - "changed the filter of Swiss accounts: size + XL";
  - "added Anna to EMEA";
  - "deleted VIP";
  - "made Anna Team Lead";
  - "Roche moved to VIP (approved)";
  - "release of Roche from Anna (no longer in her groups)".

  The filter diff is described field by field rather than as raw JSON.

---

## 12. Build steps

| Step | Content | Build |
|---|---|---|
| 0 | **Data and rules.** `team-groups.js` (pure: `teamLeadOf`, `groupFacts`, `matchesFilter`, `groupsOf`, `membersOf`, `mayAccess`, `voidAssignments`, `groupCounts`) and `geo-regions.js`, all in `test_pure_modules.py` (shuffle tests for the lead chain, null facts, Other, pins). `teamGroups` / `teamGroupPins` keys; Team-Lead-only rule in `applyChange` (two passes); `isTeamLead()` everywhere (the six direct reads); summary gains `g`, `myGroups`, `lead`. **Rename Team Admin → Team Lead** in all user text (~40 strings, help ids kept). Measure the group computation on the live data. | 1.2.2.5; fixes 1.2.2.6 (clear "✓ Saved", creator from team.json, Team Lead has no Leave the team, Sync now removed) |
| 1 | **Settings > Team.** Members ⋮ (Make Team Lead…, Groups…, Release all, Remove…); Groups section, editor with preview, delete, counts; hand-over flow; Reassign candidates fixed (no former members, only those with access). `test_team_sync.py`: hand-over between two members, a non-lead's group record ignored on every PC. **Close the team… (D16).** | 1.2.2.7 |
| 1b | **Invitations and the team list (D17, D18).** Add member… (name, e-mail) writes an invitation; the members table shows "Invited" with ⋮ Cancel invitation; Join and Create start from "Choose your OneDrive folder" once; Join lists only teams with an invitation for this person, and refuses without one; Create makes the team folder itself. `test_team_sync.py`: an invited member joins with the invitation's name; joining without an invitation is refused; an invitation cannot be used twice. Not-in-a-team screen: Join first, Create as Team Lead only, hidden when invited (D19). | 1.2.2.8 |
| 2 | **Visibility.** `canSee` in the companies and contacts tables, Leads Dashboard, side panel, account/contact page, Decisions, exports, LinkedIn badge. | 1.2.2.10 |
| 3 | **Picker, column, header, notices, log.** Shared picker on the three pages, deep links from the overview, Groups column, header line; notice detectors; team-log lines. | 1.2.2.11 |
| 4 | **Group changes.** Add to / Remove from group… (row, page, bulk); pins from automatic work and `group_move` decisions; voided assignments and the Team Lead's explicit releases with the before-save count. `test_team_sync.py`: research moves an assigned account → pinned → approved → assignee loses it; unassigned moves at once. | 1.2.2.12 |
| 5 | **Pipeline and Discovery.** Access in `mayWork`, candidates with access, Team Lead fills gaps, Discovery Team Lead only. `test_team_sync.py`: shares disjoint and covering per group; a group with nobody online goes to the Team Lead. | 1.2.2.13 |
| 6 | Help ("Account groups", "Working as a team", Team Lead), PRD section + gen_docs mirror, one 1.2.3 release-notes entry covering both items, listing/website check → **1.2.3** rebuilt. | 1.2.3 |

1.2.2.9 (2026-10-09) is not a step of this table: a PC that lost its saved shadow no longer re-sends every row
(team-sync.js waits for the full re-read, then seeds the shadow from the merged state). Steps 2-5 moved up one number.

Each step: `check_js_syntax.py`, `test_pure_modules.py`, `test_team_sync.py`, then Reload on the live install
with numbered test steps for two Chrome profiles (Team Lead and Member).

---

## 13. Decisions (all answered 2026-10-08)

- **D1 — The Team Lead is decided by the folder.** The creator, then a chain of hand-over records, each valid
  only from the then-current Team Lead. The local `membership.role` is no longer used for the role; existing
  teams need no migration. Agree?
  **Answer 2026-10-08: agreed.**
- **D2 — Team-Lead-only enforced in the merge for groups (and the lead record) only.** A member's record
  changing a group is ignored on every PC. Setup and rules keys keep today's UI-only guard, because enforcing
  them too would touch the 1.2.2 Setup flow and its join proposals; that can follow later. Agree, or enforce
  Setup in the merge now as well?
  **Answer 2026-10-08: as recommended** (groups and the lead record now; Setup keeps the screen lock, maybe
  later; exclusion lists stay open to members either way).
- **D3 — Visibility is a view filter, not secrecy.** Every PC still holds all the team's data (the merge needs
  it, and the OneDrive folder is shared anyway). Members don't see other groups anywhere in SalesTeam; CSV and
  HubSpot exports carry only what they see; the full backup carries everything. Agree?
  **Answer 2026-10-08: agreed.**
- **D4 — Size and region for filters.** Size = the same Setup bucket (S–XXL) the Size column and size priority
  use, from the global employee count. Region = the six regions SalesTeam already uses (North America, Latin
  America, Europe, Africa, Middle East, South-East Asia), from Global HQ Country. "EMEA" is then Europe + Middle
  East + Africa ticked together, and "Asia" is South-East Asia. An unknown value never matches, so the account
  waits in Other. Agree, or do you want EMEA / APAC / Americas as ready-made choices too?
  **Answer 2026-10-08: agreed** (the six regions, no ready-made EMEA / APAC / Americas).
- **D5 — Research on an assigned account: the data changes, the groups wait.** The account is pinned to its old
  groups until you decide in Decisions. "Keep it where it is" keeps it there for as long as it is assigned;
  releasing it lets it move. Agree?
  **Answer 2026-10-08: agreed.**
- **D6 — A lost assignment ends on every PC at once** (computed), not only when the Team Lead's PC writes the
  release. Agree?
  **Answer 2026-10-08: agreed.**
- **D7 — The Team Lead's pipeline fills gaps only.** It works accounts no online member has access to, plus the
  Team Lead's own, so members' groups are researched on members' keys. Alternative: the Team Lead takes an
  equal share of every group. Agree with gaps only?
  **Answer 2026-10-08: a setting.** The Team Lead chooses "only accounts no member can work right now" (default)
  or "all accounts" (section 9).
- **D8 — Discovery is run by the Team Lead only, in advanced mode.** In basic mode every member's pipeline
  still discovers, as in 1.2.2. Agree?
  **Answer 2026-10-08: agreed.**
- **D9 — A member in no group counts as in Other.** This is computed, nothing is written: it covers R9.2 and any
  member who joins later. The consequence: taking someone out of their last group puts them in Other, never
  "nowhere". Agree?
  **Answer 2026-10-08: agreed.**
- **D10 — Members table gets a ⋮ menu** (Make Team Lead…, Groups…, Release all, Remove from team…), replacing the
  buttons, and **Reassign to…** offers only current members with access (fixing the former-members bug). Agree?
  **Answer 2026-10-08: agreed** (the menu also carries Make deputy… / End deputy, D15).
- **D11 — Group kind is fixed once saved.** To turn a filter group into a named list, create a new one (the
  editor offers "Copy its current accounts into a new named group"). Agree?
  **Answer 2026-10-08: agreed.**
- **D12 — Leads (posts) whose company is not a team account** (a scan found a post, no account yet): proposal —
  visible to **everyone**, as in 1.2.2. They belong to no group until the company becomes an account; once it
  does, they follow it. Alternative: only the Team Lead and the member who scanned them. Which?
  **Answer 2026-10-08: only the Team Lead and the member who scanned them** (section 6.2; the deputy counts as
  Team Lead while active).
- **D13 — A Team Lead who is gone.** Proposal: if the Team Lead has not been seen for **30 days**, any member
  gets **Take over as Team Lead** in Settings > Team (logged, everyone notified; the absent Team Lead becomes a
  Member when they return). Without it, a team whose lead leaves without handing over can never change groups
  again. Agree, another number of days, or leave it out?
  **Answer 2026-10-08 (final):**
  - **If the Team Lead has not been seen for 30 days, the deputy gets Take over as Team Lead.** If there is a
    deputy, nobody else does.
  - **If there is no deputy, every member gets it.** The first take-over (earliest stamp) wins on every PC; any
    later one is ignored and that member is told "Anna took over a few seconds before you".
  - Either way the absent Team Lead becomes a Member. The take-over is logged and everyone is notified. When
    the Team Lead returns, the new Team Lead can hand the role back.
  - **What the merge checks** (pure, in `teamLeadOf`): a take-over record counts only if the then-current Team
    Lead has written no change record in the 30 days before its stamp, and its author was the deputy, or anyone
    if there was no deputy at that moment. The button itself also looks at the heartbeats, so it is not offered
    while the Team Lead's PC is still running SalesTeam.
- **D15 — Deputy Team Lead (your question, 2026-10-07).** The Team Lead can make one member deputy with the
  Team Lead's rights while away, and ends it on return (3.4). This is safer than a hand-over for absences: the
  Team Lead never gives up control, and taking the rights back needs nobody's help. It needs R1.3 and R1.1 to
  change, from "one Team Lead" to "one Team Lead, plus at most one deputy". Proposal: **keep both** — the deputy
  for absences, the hand-over for a permanent change of Team Lead — and let D13's 30-day take-over go to the
  deputy first, when there is one. Agree, or deputy only (no hand-over)?
  **Answer 2026-10-08: both** (deputy for absences, hand-over for a permanent change). R1.1 / R1.3 read "one
  Team Lead, plus at most one deputy".
- **D14 — Picker as two dropdowns** (Group, Assigned) on all three pages, rather than one combined list ("EMEA —
  Mine", "EMEA — Unassigned" …). Agree?
  **Answer 2026-10-08: agreed**, with the second dropdown labelled **Assigned**.
- **D16 — Close the team (Boaz, 2026-10-08).** The Team Lead does not leave a team they lead; "Leave the team" is
  hidden for them (done in 1.2.2.6, together with removing "Sync now" for everyone - the automatic sync runs every few
  seconds). Instead the Team Lead gets **Close the team…** (red, where Leave the team is for members; not for the
  deputy):
  - every PC stops sharing; each member keeps the data as it is at that moment, as their own copy;
  - all assignments end; the team folder is marked closed, so nobody can join it again;
  - confirm: "Close the team 'TimeToAct2'? Everyone stops sharing; each person keeps a copy of the data as it is
    now. This cannot be undone. To keep the team going without you, make someone else Team Lead instead.";
  - a Team Lead who wants to leave hands the role over first (Make Team Lead…) and then leaves as a Member.
  - **A team created by mistake** (Boaz, 2026-10-08 - e.g. the wrong folder, or a test): with no other member and no
    accepted invitation, the confirm is short - "Close the team 'X'? Nobody else has joined it. Your data stays here
    as it is." - and open invitations are cancelled with it. The Team Lead's PC is then a single user again, exactly
    as before creating it, and can create or join another team at once.
  Built in step 1.
  **Answer 2026-10-08: agreed as proposed.**
- **D17 — Invitations (Boaz, 2026-10-08: in 1.2.3, not later).** The Team Lead adds a member by name, e-mail and
  groups; the member accepts on their PC with one click (10a.1, 10a.2). Open question: **may someone still join
  without an invitation?** Proposal: yes - they land in Other and the Team Lead is told (the folder's OneDrive
  sharing already decides who can reach it). Alternative: invitation required - a member without one is refused
  with "Ask your Team Lead for an invitation".
  **Answer 2026-10-08: invitations yes, with two changes - (1) no groups in the invitation: the Team Lead assigns
  groups after the member has joined; (2) no joining without an invitation - the Team Lead controls everything.**
- **D18 — Team from a list (Boaz, 2026-10-08).** Join and Create start from the OneDrive folder, chosen once;
  joining picks the team from a dropdown, creating makes the team folder itself (10a.3). Agree, including
  SalesTeam creating the team folder on Create?
  **Answer 2026-10-08: agreed, including SalesTeam creating the team folder.**
  **Reversed 2026-10-09 (1.2.2.8 test): the team folder is chosen directly - Chrome refuses the OneDrive folder on PCs
  where Windows keeps Desktop / Documents in it (10a.3).**
- **D19 — Create a team is for the Team Lead (Boaz, 2026-10-08).** Not-in-a-team screen leads with Join; Create is a
  smaller "as Team Lead" line, hidden when an invitation for this person is waiting (10a.4).
  **Answer 2026-10-08: agreed.**
