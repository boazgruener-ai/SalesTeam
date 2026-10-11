// Customers and partners (1.2.3, EXCLUSIONS_RELATIONSHIPS_DESIGN.md): a property of the account, not an exclusion.
// They live on their own list, companyRelationships, with the same entry shape as companyExclusions
// ({ category, slug?, name?, domain?, source?, sourceUrl? }) and the same matching.
//
// PURE: no chrome.*, no DOM. Executed and asserted on by test_pure_modules.py.

import { normalizeCompanyName, websiteDomain } from "./company-identity.js";

export const RELATIONSHIP_CATEGORIES = ["customer", "partner"];

export const RELATIONSHIP_CATEGORY_LABELS = {
  customer: "Customer",
  partner: "Partner / reseller",
};

export function isRelationshipCategory(category) {
  return RELATIONSHIP_CATEGORIES.includes(category);
}

// Same entry = same category and the same identity (slug, normalised name, domain).
function entryKey(e) {
  return [
    e.category || "",
    String(e.slug || "").trim().toLowerCase(),
    normalizeCompanyName(e.name || ""),
    websiteDomain(e.domain || "") || "",
  ].join("|");
}

// Design 4.1: every customer / partner entry leaves the exclusion list and goes onto the relationship list, unless
// an equal entry is already there. Idempotent and flag-free - on already-split lists it changes nothing - so it is
// safe on update, after a restore and after an import.
export function splitCompanyLists(exclusions, relationships) {
  const keptExclusions = [];
  const nextRelationships = [...(relationships || []).filter(Boolean)];
  const known = new Set(nextRelationships.map(entryKey));
  const moved = { customer: 0, partner: 0 };
  for (const e of exclusions || []) {
    if (!e) continue;
    if (!isRelationshipCategory(e.category)) { keptExclusions.push(e); continue; }
    const k = entryKey(e);
    if (!known.has(k)) {
      nextRelationships.push(e);
      known.add(k);
      moved[e.category]++;
    }
  }
  return { exclusions: keptExclusions, relationships: nextRelationships, moved };
}

// Design 6.1 (R5.4, D3): a customer's priority is raised one level; P1 stays P1. Anything that is not P1-P5 is
// returned as it is (no priority yet -> nothing to raise).
export function raisePriority(priority) {
  const m = /^P([1-5])$/.exec(String(priority || ""));
  if (!m) return priority;
  return `P${Math.max(1, Number(m[1]) - 1)}`;
}

export const RAISED_REASON = "Raised one level: existing customer";

// The priority shown and used everywhere. `manual`: the user set it by hand - shown as set, never raised.
// `relationship`: the categories the account matches (relationshipOf). A partner only stays neutral.
export function effectivePriority({ priority, manual = false, relationship = [] } = {}) {
  if (manual || !priority || !(relationship || []).includes("customer")) return { priority, raised: false };
  const raised = raisePriority(priority);
  return { priority: raised, raised: raised !== priority };
}

// One sentence for the AI prompts (design 7). Empty when the account has no relationship.
export function relationshipPromptLine(relationship, companyName, sellerName) {
  const rel = relationship || [];
  const company = companyName || "This company";
  const seller = sellerName || "us";
  const customer = rel.includes("customer");
  const partner = rel.includes("partner");
  if (customer && partner) {
    return `Relationship: ${company} is an existing customer and a partner / reseller of ${seller}. Do not write or advise as if this were a first contact; build on the existing relationship (more departments, further offers, renewal).`;
  }
  if (customer) {
    return `Relationship: ${company} is an existing customer of ${seller}. Do not write or advise as if this were a first contact; build on the existing relationship (more departments, further offers, renewal).`;
  }
  if (partner) {
    return `Relationship: ${company} is an existing partner / reseller of ${seller} - a company you work with, not a cold prospect.`;
  }
  return "";
}

// The tag text: "Customer", "Partner", "Customer · Partner", or "".
export function relationshipTagText(relationship) {
  const rel = relationship || [];
  return [rel.includes("customer") ? "Customer" : null, rel.includes("partner") ? "Partner" : null].filter(Boolean).join(" · ");
}

// The pop-up / log text (R3.2): what moved, how many accounts and leads (posts) came back.
export function relationshipsMovedText({ customer = 0, partner = 0, accounts = 0, leads = 0 } = {}) {
  const out = [];
  const parts = [];
  if (customer) parts.push(`${customer} customer${customer === 1 ? "" : "s"}`);
  if (partner) parts.push(`${partner} partner${partner === 1 ? "" : "s"}`);
  if (parts.length) {
    out.push(`${parts.join(" and ")} moved from the exclusions to the new Customers and partners list - customers and partners are no longer excluded.`);
    out.push(accounts
      ? `${accounts} of them ${accounts === 1 ? "is an account and is" : "are accounts and are"} back in Target Accounts, with a Relationship tag; ${accounts === 1 ? "it joins" : "they join"} the normal research queue.`
      : `None of them is one of your accounts, so Target Accounts does not change.`);
  }
  if (leads) out.push(`${leads} lead${leads === 1 ? "" : "s"} (posts) from customers' and partners' people ${leads === 1 ? "is" : "are"} back in the Leads Dashboard as New.`);
  return out.join(" ");
}
