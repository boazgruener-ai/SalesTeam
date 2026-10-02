# How competitors handle their team versions

Research for SalesTeam 1.2.2 (team use). Date: 2026-10-02. Sources are vendor pages and help documentation
unless marked **[unconfirmed]** (third-party reviews or vendor marketing blogs only).

## Comparison

| Tool | Where team data lives | Stopping two reps working the same prospect | Roles and admin | Team reporting | Team pricing | LinkedIn limits |
|---|---|---|---|---|---|---|
| **Sales Navigator Advanced / Advanced Plus** | LinkedIn's cloud; on Advanced Plus the CRM is the system of record | No lock. TeamLink shows which teammate is connected to a lead (warm intros). Advanced Plus CRM Auto-Save fills "My CRM Accounts/Leads" from CRM ownership, synced daily | Admin Center: seats, central billing, TeamLink on/off | Team reporting (Advanced) | Core $119.99/mo, Advanced $159.99/mo; up to 5 seats online; Advanced Plus on request | One seat per person, own LinkedIn account |
| **Waalaxy** | Waalaxy cloud; each member's lists, visible across the team | Anti-duplicate on import (on by default): a lead in any teammate's list is skipped. On joining, a retroactive dedupe: the admin assigns each duplicate or picks a "recommended" owner | Captain/Owner (billing, team), Director (all but billing), Member; custom roles | Team dashboard: queued actions, credits and performance per member | Pro €19, Advanced €49, Business €69 per user/month; all members on the same plan; Enterprise 5-seat minimum [unconfirmed] | Each member's own LinkedIn account |
| **Dux-Soup** | Chrome extension + cloud dashboard where team campaigns live | Team Campaigns never enrol the same profile twice; optional "Reject profiles from other campaigns" | License Admin manages seats; only Team Admin deletes team campaigns; shared signature marker `_SIG_` | "Team Funnel Flow": per member and team total | Turbo Team from $41.25, Cloud Team from $74.16 per seat/month; free months at 10+ and 20+ seats | One seat = one LinkedIn account |
| **Expandi** | Expandi cloud (Workspace > Companies > LinkedIn accounts) | Shared campaigns split leads across accounts so no two contact the same lead; company-wide and per-account blacklists (up to 20k, CSV upload) | Admin, Workspace Manager, Workspace Member; custom roles with View/Add/Edit/Delete | Unified dashboards, client reports | Business $99/mo per account ($79 yearly); Agency custom | Daily limits per LinkedIn account |
| **Surfe** | The customer's CRM (HubSpot, Salesforce, Pipedrive, Copper) | On a LinkedIn profile: already in the CRM? who owns it? deal stage; duplicate warning; matched on LinkedIn URL | Team page: invite, admin rights, paid seats, billing-only admin; shared extra credits; SSO/SCIM on Enterprise | None found [unconfirmed] | Essential $49, Pro $89 per seat/month (lower yearly) | No automation |
| **Apollo.io** | Apollo cloud, one database per team; optional CRM sync | Contact and account owners; permission profiles for reassigning; **territories** (owner, location, industry, size) limit what each rep may prospect; a contact active in any sequence cannot be enrolled again | Permission profiles; admin manages users | Team reporting [unconfirmed] | Pooled credits; same plan for all; Basic $49, Pro $79, Organization $119 per user/month yearly, Organization 3-seat minimum [unconfirmed] | n/a |
| **Lusha** | Lusha cloud, pushes to CRM | None found | Admin, Manager (no seat used, Scale plan), User; credit limits per user or group | Usage per member | Starter $49.90, Pro $69.90/mo; Premium $399.90 incl. 5 seats [unconfirmed]; shared pool or per-user credits | n/a |
| **ZoomInfo** | ZoomInfo cloud + CRM | Extension shows whether a record exists in the CRM and who owns it [unconfirmed] | Admin portal, SSO/SCIM, per-user credit limits [unconfirmed] | Usage reports [unconfirmed] | Not published | n/a |
| **Kaspr** | Kaspr cloud | None found | 1, 2 or 5 admins by plan; optional credit cap per user | None found | Starter $45, Business $79 per user/month yearly; pooled credits [unconfirmed] | n/a |

## Patterns most competitors share

1. **The vendor's cloud is the shared store.** The exception is Surfe and Sales Navigator Advanced Plus, which use the customer's CRM and treat CRM ownership as the truth.
2. **Collisions are handled when a lead is added**, not while someone works it: Waalaxy at import, Dux-Soup and Apollo at enrolment, Expandi by splitting leads. Nobody locks an account while it is being worked.
3. **Ownership is a field on the record** (Apollo, and the CRM for Surfe, ZoomInfo, Sales Navigator). Apollo adds territories: rules by region, industry or size.
4. **Usually three roles:** owner/admin with billing, manager without billing, member. Lusha and Surfe let a billing-only person in without using a seat.
5. **Pricing per seat, all seats on the same plan**, often with pooled credits and volume discounts; seat minimums are rare.
6. **Every member uses their own LinkedIn account** and daily limits; team tools spread work across accounts.
7. **Shared blacklists** across the company (Expandi; Dux-Soup's "reject from other campaigns").

## Gaps SalesTeam can use

- **The data stays with the customer** — no vendor server; team data in a OneDrive folder the customer already owns.
- **No CRM needed.** Surfe and Sales Navigator ownership depend on a CRM; without one, only Apollo (a much larger platform) gives real ownership.
- **Nobody locks an account while it is being worked**; SalesTeam's per-entity claim plus "Assign to me / release" is more precise.
- **LinkedIn-first tools deduplicate people, not companies.** Two reps can still work the same company through different contacts; account-level assignment closes that.
- **Territory rules without a CRM** — only Apollo has them, on its own cloud.

## Ideas, and where they go

Taken into the 1.2.2 requirements (2026-10-02, TEAM_USE_REQUIREMENTS.md R6.5–R6.8):

1. "Assigned to Anna since 3 Oct" badge wherever an account or contact appears, including on the LinkedIn profile (Surfe, ZoomInfo).
2. Team-wide check when scanning or adding: flag what a colleague already has or has claimed, with override (Waalaxy, Dux-Soup).
3. Merge screen when a member joins with existing data; the Team Admin decides who keeps each overlap (Waalaxy).
4. One shared "do not contact" list for the whole team (Expandi).

For later:

5. Auto-assignment queues as territory rules by region, industry, size, with an unowned pool (Apollo) — confirms the advanced-mode plan.
6. Team dashboard: claims, touches and replies per person and team total (Dux-Soup, Waalaxy).
7. "Who on the team knows this person" from members' 1st-degree connections (Sales Navigator TeamLink).
8. Shared outreach templates with a signature placeholder (Dux-Soup, Expandi).
9. Pricing: per seat, same plan for all, free billing-only admin, team discount from 5 seats (Lusha, Surfe, Dux-Soup).

Already planned and confirmed by every competitor: daily LinkedIn limits stay per person, on their own account.

## Sources

- https://business.linkedin.com/sales-solutions/compare-plans
- https://www.linkedin.com/help/sales-navigator/answer/a105077 (TeamLink)
- https://www.linkedin.com/help/sales-navigator/answer/a163444 (CRM Auto-Save)
- https://www.linkedin.com/help/sales-navigator/answer/a1515474 (Book of Business)
- https://www.waalaxy.com/pricing
- https://www.waalaxy.com/blog/linkedin-automation-software/waalaxy-team-plan
- https://blog.waalaxy.com/en/duplication-control-waalaxy/
- https://www.dux-soup.com/pricing
- https://www.dux-soup.com/blog/dux-soup-for-teams
- https://support.dux-soup.com/article/242-shared-team-campaigns-for-monthly-and-annual-turbo-team-license-holders
- https://expandi.io/pricing/
- https://help.expandi.io/en/articles/10001730-roles-and-permissions-workspace
- https://help.expandi.io/en/articles/12277052-shared-campaigns-workspace
- https://help.expandi.io/en/articles/5405272-blacklists
- https://www.surfe.com/pricing/
- https://www.surfe.com/blog/prevent-crm-duplicates/
- https://intercom.help/surfe/en/articles/10214109-invite-remove-team-members
- https://www.apollo.io/pricing
- https://www.apollo.io/insights/how-do-i-prevent-duplicate-outreach-when-my-sales-team-shares-lists
- https://knowledge.apollo.io/hc/en-us/articles/4412665806989-Create-Territories-to-Control-Prospecting-Access (search result only)
- https://knowledge.apollo.io/hc/en-us/articles/4409154208269-Create-and-Assign-Permission-Profiles (search result only)
- https://www.lusha.com/pricing/
- https://docs.lusha.com/user-guide/team-management/user-roles-and-permissions
- https://info.lusha.com/en/articles/163964-how-to-limit-credits-per-user-or-group
- https://www.kaspr.io/pricing, https://help.kaspr.io/en/articles/9090907-kaspr-faqs (search results only)
- Third-party, for [unconfirmed] points only: warmly.ai, emelia.io, aeroleads.com, revenueflow.com
