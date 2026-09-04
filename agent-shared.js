// Shared AI-agent engine: the Anthropic tool-use loop, the lead-lookup/draft
// tools, and the system-prompt builders, extracted out of sidepanel.js so the
// Dashboard (a separate tab, with no shared runtime state with the side
// panel) can reuse exactly the same logic instead of a second, drifting copy.
// Every tool here reads chrome.storage.local fresh on each call - there is no
// module-level cache - so it's safe to call from any page.
import { getResults, updateResultDraft } from "./storage.js";
import { sortResultsByRelevance } from "./ranking.js";

// Cheap/fast model, well-suited to drafting a short message - see the
// environment's model list for current Claude model IDs.
export const DRAFT_MODEL = "claude-haiku-4-5-20251001";

// A stronger model for agent conversations - giving real prioritization/
// approach advice (or reacting in character) is a genuine reasoning task,
// unlike a short templated draft, so it's worth the extra cost/latency.
export const AGENT_MODEL = "claude-sonnet-5";

// A plain fetch() has no timeout at all - a stalled connection or a slow
// response from Anthropic's own infrastructure can hang indefinitely with
// no error, which is exactly what a user reported (a chat stuck on
// "Checking: list_leads" for 20+ minutes with no error ever surfacing).
// AbortController turns that into a real, bounded failure instead.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Request to Anthropic timed out after ${timeoutMs / 1000}s - check your connection and try again.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Reasoning across a large lead list (e.g. "rank all 122 leads and pick the
// top 5") is real, legitimate work that can take past a minute - this is
// deliberately generous (2.5 min) so it only fires on an actually-stalled
// connection, not on a slow-but-working response. The heartbeat above is
// what keeps that wait from looking frozen in the meantime.
const AGENT_FETCH_TIMEOUT_MS = 150000;

// A local tool (reading chrome.storage.local) should never take more than a
// moment - this is a safety valve, not a normal limit. Kept comfortably
// above DRAFT_FETCH_TIMEOUT_MS so a legitimately-slow-but-completing
// draft_message tool call isn't cut off by this outer wrapper first.
const TOOL_EXEC_TIMEOUT_MS = 50000;

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} took too long (over ${timeoutMs / 1000}s) - try again.`)), timeoutMs)
    ),
  ]);
}

// A question like "look at all N leads and pick the top 5" is a genuinely
// heavier reasoning pass than a normal chat turn, and can legitimately take
// past a minute - the timeout above exists to catch a truly stalled
// connection, not to cut off real, in-progress work. This ticks the visible
// status text once a second for as long as `promise` is pending, so a long
// wait still reads as "working" rather than "frozen" (the exact ambiguity
// that made the original stuck-for-20-minutes report impossible to tell
// apart from a normal slow response until it was too late).
async function withHeartbeat(promise, label, onStatus) {
  const start = Date.now();
  onStatus?.(`${label} (0s)`);
  const intervalId = setInterval(() => {
    onStatus?.(`${label} (${Math.round((Date.now() - start) / 1000)}s)`);
  }, 1000);
  try {
    return await promise;
  } finally {
    clearInterval(intervalId);
  }
}

// API keys are always plain ASCII - stripping anything outside the printable
// ASCII range guards against invisible/smart-typography characters that can
// sneak in when copy-pasting (from a chat UI, a doc, etc.), which otherwise
// make fetch() reject the request outright ("non ISO-8859-1 code point").
export function sanitizeApiKey(value) {
  return value.replace(/[^\x20-\x7E]/g, "").trim();
}

export function languageInstruction(outputLanguage) {
  return outputLanguage === "german"
    ? "Write your entire response in German (Hochdeutsch/standard business German), not English."
    : "Write your entire response in English.";
}

// Both prompts are built fresh per turn (not fixed constants) so they always
// pick up the latest "What We Offer" text from settings - without this,
// neither agent has any idea what the salesperson's company actually sells,
// and can only react to a lead's own post in isolation rather than reason
// about real fit.
export function companyContextBlock(companyContext) {
  return (companyContext || "").trim()
    ? `\nWhat the salesperson's own company actually sells: ${companyContext.trim()}\n`
    : "\n(No company/offering description has been configured yet - reason generically, and note that " +
        "more specific advice would be possible once one is added in settings.)\n";
}

export function customerPersonaBlock(customerPersona) {
  return (customerPersona || "").trim()
    ? `\nYour default persona, when no specific lead is named: ${customerPersona.trim()}\n`
    : "";
}

export function buildMentorSystemPrompt({ mentorPersona, companyContext, outputLanguage }) {
  return (
    `You are acting as a sales mentor to a salesperson working real leads found by their LinkedIn Lead ` +
    `Scanner extension. Your persona: ${(mentorPersona || "").trim() || "a senior, approachable B2B sales expert"}. ` +
    "There's no such thing as a stupid question." +
    companyContextBlock(companyContext) +
    "When a question is about specific leads (which to prioritize, how to approach one by name), use the " +
    "list_leads and get_lead_details tools to ground your answer in real, current data - never guess or " +
    "invent leads or their content. list_leads returns BOTH Post leads (type: 'post', a real person, " +
    "hasIndividualContact: true) and Jobs-vertical job listings (type: 'job', a company's job ad, " +
    "hasIndividualContact: false) - consider both when ranking or prioritizing, a hiring job ad is real buying " +
    "signal even though there's no individual scraped to message yet. For a 'post' lead, next steps can " +
    "include drafting a message via draft_message. For a 'job' lead, draft_message won't work (no individual " +
    "contact exists) - instead advise the salesperson to research and find a specific person at that company " +
    "(e.g. the hiring manager or team lead named in the ad, or via that company's LinkedIn page) to reach out " +
    "to directly, or to treat it as a market signal worth tracking. Reason about REAL fit against what the " +
    "salesperson's company actually sells (above), not just what the lead's post happens to say - a lead can " +
    "be a poor fit even if their post sounds relevant, or a good fit for a different reason than it first " +
    "appears. When asked a general " +
    "sales-strategy or process question not tied to a specific lead, answer directly from your own expertise " +
    "instead - you don't need a tool for that. When asked to draft or write a message, use the draft_message " +
    "tool rather than writing one yourself directly, so it goes through the same reviewed process as " +
    "everywhere else in the extension. Be direct, practical, and specific - reference actual leads by name " +
    "when relevant. Keep answers focused; a few short paragraphs or a short list is plenty, no need to pad." +
    "\n" + languageInstruction(outputLanguage)
  );
}

export function buildCustomerSystemPrompt({ companyContext, customerPersona, outputLanguage }) {
  return (
    "You are playing the role of a realistic B2B buyer of software & AI-services - the kind of person a " +
    "salesperson using this extension is trying to reach." +
    companyContextBlock(companyContext) +
    customerPersonaBlock(customerPersona) +
    "The salesperson will ask you to react to a proposed message, approach, or offer that pitches the " +
    "company above, or ask general questions about what buyers like you care about. When the question names " +
    "or clearly points to one specific lead (by name or key), use the list_leads and get_lead_details tools " +
    "to ground yourself in that real person's actual post/headline/situation, and react as they specifically " +
    "would - reference their real content over the default persona above, and never invent facts or traits " +
    "beyond what's given. When asked a general question not tied to one specific lead (e.g. what's your main " +
    "pain point with AI projects today), answer in character as the default persona above if one is given, " +
    "or as a knowledgeable, realistic composite of a typical buyer in this space otherwise - and make clear " +
    "this is a general perspective, not one specific person's view. Be honest and even critical - point out " +
    "specifically what would make you ignore a message, what would make you reply, and why. Keep answers " +
    "concise and concrete.\n" +
    "Language: when grounded in one specific real lead (via get_lead_details or list_leads), respond in " +
    "that lead's own post's language, whatever it is - that's what a real reaction from them would sound " +
    "like, even if it differs from the instruction below. For general questions with no specific lead " +
    "grounding your answer, use this instead: " + languageInstruction(outputLanguage)
  );
}

// Used by the Dashboard's per-lead "Consult Mentor" panel: the lead is
// already on screen, so its details are embedded directly in the system
// prompt instead of relying on the list_leads/get_lead_details tools -
// avoids a tool round-trip for a conversation that's already scoped to one
// specific, known lead.
export function buildLeadScopedMentorPrompt(lead, { mentorPersona, companyContext, outputLanguage }) {
  const isJob = lead.type === "job";
  const leadBlock = isJob
    ? `Job listing: "${lead.title || "Untitled role"}" at ${lead.company || "unknown company"}` +
      (lead.location ? ` (${lead.location})` : "") +
      `\nMatched on: ${(lead.matchedTopics || []).map((t) => t.topicName).join(", ")}`
    : `Lead: ${lead.author || "Unknown"}\nHeadline: ${lead.headline || "n/a"}\nTheir post: "${lead.snippet || ""}"\n` +
      `Connection status: ${lead.connectionDegree ? lead.connectionDegree + "-degree connection" : "not yet connected"}\n` +
      `Matched on: ${(lead.matchedTopics || []).map((t) => t.topicName).join(", ")}`;

  return (
    `You are acting as a sales mentor to a salesperson, discussing ONE specific lead they're looking at right ` +
    `now. Your persona: ${(mentorPersona || "").trim() || "a senior, approachable B2B sales expert"}.` +
    companyContextBlock(companyContext) +
    `\nThe lead being discussed:\n${leadBlock}\n\n` +
    "Answer questions about this specific lead directly using the details above - never invent facts beyond " +
    "what's given. When asked to draft or write a message for this lead, use the draft_message tool (with " +
    `this lead's key: "${lead.key}") rather than writing one yourself directly, so it goes through the same ` +
    "reviewed process as everywhere else in the extension. Be direct and specific. Keep answers focused.\n" +
    languageInstruction(outputLanguage)
  );
}

// One-shot, ephemeral synthesis across every lead seen at one company (the
// Dashboard's "Get Account Summary", inside its Group by Company view) -
// same shape as buildLeadScopedMentorPrompt but for a whole account instead
// of one lead. Deliberately not a persisted chat: the caller passes
// history: [] and doesn't save the result anywhere in storage, just an
// in-memory cache for the session, so re-expanding a group doesn't re-call
// the AI for leads that haven't changed.
export function buildAccountSummaryPrompt(companyName, leads, { mentorPersona, companyContext, outputLanguage } = {}) {
  const leadBlocks = leads.map((lead) =>
    lead.type === "job"
      ? `- Job listing: "${lead.title || "Untitled role"}"${lead.location ? ` (${lead.location})` : ""} - matched on: ${(lead.matchedTopics || []).map((t) => t.topicName).join(", ")}`
      : `- Lead: ${lead.author || "Unknown"} - ${lead.headline || "n/a"}\n  Their post: "${(lead.snippet || "").slice(0, 300)}"`
  );

  return (
    `You are acting as a sales mentor to a salesperson, synthesizing everything they've seen so far about ONE ` +
    `account - ${companyName}. Your persona: ${(mentorPersona || "").trim() || "a senior, approachable B2B sales expert"}.` +
    companyContextBlock(companyContext) +
    `\nEvery lead seen at this account so far:\n${leadBlocks.join("\n")}\n\n` +
    "Summarize: who the real decision-maker(s) appear to be, what's collectively happening at this account " +
    "(recurring themes, hiring or buying signals across the leads above), and a suggested angle for " +
    "approaching them - grounded only in what's given above, never inventing detail. Keep it tight, a short " +
    "few paragraphs, not an exhaustive report.\n" +
    languageInstruction(outputLanguage)
  );
}

export const LEAD_LOOKUP_TOOLS = [
  {
    name: "list_leads",
    description:
      "Returns a summary of currently scanned leads worth considering - both LinkedIn Posts (from a real " +
      "person, with an individual to contact) and Jobs-vertical job listings (a company's job ad, with no " +
      "individual contact scraped). Each entry's `type` field ('post' or 'job') and `hasIndividualContact` " +
      "flag tell you which is which - job leads are still real signal (a hiring need) and should be " +
      "considered when prioritizing, just handled differently (see system prompt). Leads already recognized " +
      "as a competitor or a recruiter/staffing post (status 'Irrelevant') are excluded here since they're never " +
      "worth surfacing - use get_lead_details on a specific key if you ever need to check one anyway. Use " +
      "this to survey what's available before recommending which to prioritize.",
    input_schema: {
      type: "object",
      properties: {
        only_not_yet_drafted: {
          type: "boolean",
          description: "If true, only include leads that don't have a drafted message yet.",
        },
      },
    },
  },
  {
    name: "get_lead_details",
    description:
      "Returns full details for one specific lead by its key (from list_leads), including its full post " +
      "text and any existing draft. Use this before reasoning in depth about one particular person.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The lead's key, as returned by list_leads." },
      },
      required: ["key"],
    },
  },
];

export const DRAFT_MESSAGE_TOOL = {
  name: "draft_message",
  description:
    "Generates a suggested opening LinkedIn message for one lead, using the same logic as the 'Draft " +
    "Message' button. Only works for Post-type leads. The draft is shown to the human for review on that " +
    "lead's card - it is never sent automatically.",
  input_schema: {
    type: "object",
    properties: {
      key: { type: "string", description: "The lead's key." },
      template_id: {
        type: "string",
        description:
          "Optional: 'first-degree', 'warm-content', or 'hiring-lead'. If omitted, the best-fitting one " +
          "is picked automatically based on the lead's connection status and content.",
      },
    },
    required: ["key"],
  },
};

// Picks the template that best fits a lead's situation - a 1st-degree
// connection gets a warmer tone, a hiring/job-ad post gets acknowledgment of
// what they're building out, and everything else gets the soft cold-contact
// template. Always overridable per-lead via the template dropdown.
//
// Deliberately checks isJobAd only, not isHiringPost - isJobAd means LinkedIn's
// own embedded job-listing widget was present (a reliable structural signal),
// while isHiringPost is a looser phrase-match ("we're looking for...") that
// also fires on unrelated posts like "looking for feedback/beta users" and
// would pick the wrong tone for an actual outreach message.
export function pickDefaultTemplateId(result, messageTemplates) {
  const findTemplateId = (id) => messageTemplates.find((t) => t.id === id)?.id || messageTemplates[0]?.id;
  if (result.isJobAd) return findTemplateId("hiring-lead");
  if (result.connectionDegree === "1st") return findTemplateId("first-degree");
  return findTemplateId("warm-content");
}

function buildDraftPrompt(result, template, { valueAddOffers, companyContext, outputLanguage }) {
  const context = `Name: ${result.author}\nHeadline: ${result.headline || "n/a"}\nTheir post: "${result.snippet || ""}"`;
  const topicNames = result.matchedTopics.map((t) => t.topicName).join(", ");
  const connectionLine = `Connection status: ${
    result.connectionDegree ? result.connectionDegree + "-degree connection" : "not yet connected"
  }`;
  const offersLine =
    (valueAddOffers || []).length > 0
      ? valueAddOffers.join("; ")
      : "none available - do not offer anything specific";
  const companyLine = (companyContext || "").trim()
    ? `What the salesperson's own company actually sells: ${companyContext.trim()}`
    : "";

  return `You are helping a B2B software & AI-services salesperson write a short, polite, non-pushy opening LinkedIn message to a potential lead.
${companyLine ? "\n" + companyLine + "\n" : ""}
${context}
Matched on: ${topicNames}
${connectionLine}

Style instructions for this situation:
${template.instructions}

Optional resource you may mention, ONLY if it genuinely fits the message naturally (do not force it in, and never invent any other resource, link, offer, or fact beyond what's listed here):
${offersLine}

Write ONLY the message text itself - no subject line, no greeting like "Dear", no explanation, no quotation marks around it. Keep it under 80 words. Do not sound like a template. Never invent facts about the person or company beyond what's given above.

${languageInstruction(outputLanguage)}`;
}

// Shared by the per-lead "Draft Message" button (in both the side panel and
// the Dashboard) and the Sales Mentor agent's draft_message tool, so all
// three go through the exact same prompt and persistence logic. Throws on
// failure; callers decide how to surface that.
export async function generateDraft(result, templateId, settings) {
  const apiKey = sanitizeApiKey(settings.apiKey || "");
  if (!apiKey) throw new Error("No Anthropic API key configured - add one in the Advisors page's AI Settings.");

  const template = settings.messageTemplates.find((t) => t.id === templateId) || settings.messageTemplates[0];
  if (!template) throw new Error("No message templates configured.");

  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: DRAFT_MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: buildDraftPrompt(result, template, settings) }],
    }),
  }, 45000);

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`API error ${response.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await response.json();
  const draft = (data.content || []).map((block) => block.text || "").join("").trim();
  if (!draft) throw new Error("Empty response from API.");

  await updateResultDraft(result.key, { draftMessage: draft, draftTemplateId: template.id });
  return draft;
}

// 1 = highest priority (drop everything, contact today), 5 = lowest
// (unlikely fit / low urgency) - used by the Dashboard's Priority column
// and its bulk-change action.
export const PRIORITY_LEVELS = [1, 2, 3, 4, 5];

const ASSIGN_PRIORITIES_TOOL = {
  name: "assign_priorities",
  description: "Records a priority for every lead given, from 1 (highest) to 5 (lowest).",
  input_schema: {
    type: "object",
    properties: {
      priorities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string", description: "The lead's key, exactly as given." },
            priority: { type: "integer", minimum: 1, maximum: 5 },
            reason: { type: "string", description: "Under 12 words - why this priority." },
          },
          required: ["key", "priority"],
        },
      },
    },
    required: ["priorities"],
  },
};

function buildPrioritizationPrompt({ mentorPersona, companyContext, outputLanguage }) {
  return (
    "You are a sales mentor prioritizing a fresh batch of scanned LinkedIn leads for a salesperson, right " +
    `after a scan - they haven't seen these yet. Persona: ${(mentorPersona || "").trim() || "a senior, approachable B2B sales expert"}.` +
    companyContextBlock(companyContext) +
    "Assign each lead a priority from 1 (drop everything, contact today) to 5 (unlikely fit, low urgency), " +
    "based on REAL fit against what the company above actually sells, the person's seniority/decision-making " +
    "power, and genuine buying-intent or urgency signals in their post or job ad - not just topical keyword " +
    "overlap. A lead can look on-topic and still be a weak fit, or look generic and still be a strong one. " +
    "Use the full 1-5 range across the batch rather than clustering everyone in the middle - these are meant " +
    "to help the salesperson triage, which only works if the scores actually spread leads out. " +
    "Call assign_priorities exactly once, with one entry (priority plus a short, specific reason) for EVERY " +
    "lead listed below - do not skip any, and do not invent a lead that isn't listed.\n" +
    languageInstruction(outputLanguage)
  );
}

function summarizeLeadForPrioritization(lead) {
  return lead.type === "job"
    ? {
        key: lead.key,
        type: "job",
        title: lead.title,
        company: lead.company,
        location: lead.location,
        matchedTopics: lead.matchedTopics.map((t) => t.topicName),
      }
    : {
        key: lead.key,
        type: "post",
        author: lead.author,
        headline: lead.headline,
        snippet: (lead.snippet || "").slice(0, 400),
        connectionDegree: lead.connectionDegree || "unknown",
        matchedTopics: lead.matchedTopics.map((t) => t.topicName),
      };
}

// Batch-scores a list of leads in ONE call (a forced tool call, not a free-
// text response, so the output is guaranteed structured/parseable rather
// than needing to coax valid JSON out of prose). Called by background.js as
// a post-processing step after each scan - never a chat turn, so there's no
// history/onStatus/onProgress plumbing like runAgentTurn's. Returns []
// (rather than throwing) on a missing API key, since this runs unattended
// and a missing key should just mean "skip prioritization this scan", not
// abort the whole scan. Real request failures DO throw - the caller
// (background.js) treats a failed prioritization pass as non-fatal.
export async function prioritizeLeads(leads, settings) {
  const apiKey = sanitizeApiKey(settings.apiKey || "");
  if (!apiKey || leads.length === 0) return [];

  const userText = "Leads to prioritize (JSON):\n" + JSON.stringify(leads.map(summarizeLeadForPrioritization));

  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: AGENT_MODEL,
      max_tokens: 8192,
      system: buildPrioritizationPrompt(settings),
      tools: [ASSIGN_PRIORITIES_TOOL],
      tool_choice: { type: "tool", name: "assign_priorities" },
      messages: [{ role: "user", content: userText }],
    }),
  }, AGENT_FETCH_TIMEOUT_MS);

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`API error ${response.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await response.json();
  const toolUse = (data.content || []).find((block) => block.type === "tool_use" && block.name === "assign_priorities");
  return toolUse?.input?.priorities || [];
}

// Post leads only ever carry a free-text headline (e.g. "Head of AI for IT @
// Azqore") - never a structured company field, unlike Job leads which get one
// straight from the scrape. This extracts a best-guess employer name from the
// headline so Post leads can be grouped by company like Job leads already
// are (see storage.js's normalizeCompanyName / setLeadCompany). A user's own
// manual company assignment always takes precedence - this is only ever
// called for leads still missing a company.
const EXTRACT_COMPANIES_TOOL = {
  name: "extract_companies",
  description: "Records the extracted employer/company name for every lead given, where determinable.",
  input_schema: {
    type: "object",
    properties: {
      companies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string", description: "The lead's key, exactly as given." },
            company: { type: "string", description: "The company's own name only, not the person's job title." },
          },
          required: ["key"],
        },
      },
    },
    required: ["companies"],
  },
};

function buildCompanyExtractionPrompt() {
  return (
    "You extract employer/company names from LinkedIn headlines for a sales tool. For each lead below, read " +
    "its headline and identify the company the person currently works at (e.g. \"Head of AI for IT @ Azqore\" " +
    "→ \"Azqore\"). Return the company's own name only, never the person's job title or department. If a " +
    "headline genuinely doesn't name a current employer (e.g. \"Open to work\", a vague headline with no " +
    "company), omit that lead's company entirely rather than guessing. " +
    "Call extract_companies exactly once, with one entry for EVERY lead listed below."
  );
}

// Batch-extracts a company name per lead in ONE call, same shape as
// prioritizeLeads - a forced tool call, called by background.js as a scan
// post-processing step, [] on no API key (skip silently, never fails the
// scan), real failures throw and are handled as non-fatal by the caller.
export async function extractCompaniesForLeads(leads, settings) {
  const apiKey = sanitizeApiKey(settings.apiKey || "");
  if (!apiKey || leads.length === 0) return [];

  const userText = "Leads to extract a company from (JSON):\n" +
    JSON.stringify(leads.map((lead) => ({ key: lead.key, headline: lead.headline })));

  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: AGENT_MODEL,
      max_tokens: 8192,
      system: buildCompanyExtractionPrompt(),
      tools: [EXTRACT_COMPANIES_TOOL],
      tool_choice: { type: "tool", name: "extract_companies" },
      messages: [{ role: "user", content: userText }],
    }),
  }, AGENT_FETCH_TIMEOUT_MS);

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`API error ${response.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await response.json();
  const toolUse = (data.content || []).find((block) => block.type === "tool_use" && block.name === "extract_companies");
  return (toolUse?.input?.companies || []).filter((entry) => entry.company && entry.company.trim());
}

// Suggests new search keywords based on what made the salesperson's own
// best-scoring leads strong matches - the inverse of Negative Topics (which
// filter out what's NOT wanted), this looks for more of what IS wanted.
// Always review-first: the caller (sidepanel.js) shows suggestions for the
// user to individually accept before anything is added to their actual
// Topics - this function only ever suggests, never writes to storage itself.
const SUGGEST_TOPICS_TOOL = {
  name: "suggest_topics",
  description: "Records suggested new search keywords based on the given high-priority leads.",
  input_schema: {
    type: "object",
    properties: {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            suggestedKeyword: { type: "string", description: "A specific, useful search keyword - not a generic word already obviously covered." },
            rationale: { type: "string", description: "Under 20 words - why this would find more leads like the examples." },
            exampleLeadKeys: { type: "array", items: { type: "string" }, description: "Keys of the lead(s) that inspired this suggestion." },
          },
          required: ["suggestedKeyword", "rationale", "exampleLeadKeys"],
        },
      },
    },
    required: ["suggestions"],
  },
};

function buildLookalikePrompt() {
  return (
    "You are a sales mentor reviewing a salesperson's highest-priority LinkedIn POSTS (not job listings) to " +
    "find what made them strong matches, so you can suggest NEW search keywords for finding more posts just " +
    "like them - the opposite of filtering noise out, this is about surfacing more of what's already working. " +
    "For each post below, look at its matched keywords/topics and its actual snippet text, and identify " +
    "keyword ideas that would plausibly appear in OTHER similar posts' own text - specific and genuinely " +
    "novel, not just repeating a keyword the lead was already found by, and not a generic word so broad it " +
    "would match almost anything. These keywords get matched against free-text post content, so favor real " +
    "phrases a person would actually write in a post, not a rigid label. It's completely fine to suggest zero " +
    "if nothing stands out - don't force weak suggestions. " +
    "Call suggest_topics exactly once, citing which lead key(s) inspired each suggestion."
  );
}

// Post leads only (see the caller in sidepanel.js) - a Job lead only ever
// carries a title/company/location, with no scraped body text to actually
// reason about, so it isn't included here.
function summarizeLeadForLookalike(lead) {
  return {
    key: lead.key,
    headline: lead.headline,
    snippet: (lead.snippet || "").slice(0, 400),
    matchedTopics: lead.matchedTopics.map((t) => t.topicName),
    priorityReason: lead.priorityReason || "",
  };
}

// Batch call over the caller's own best-scoring leads (typically P1, capped
// by the caller before this is called to bound token cost) - same
// forced-tool-call shape as prioritizeLeads/extractCompaniesForLeads.
export async function suggestLookalikeTopics(leads, settings) {
  const apiKey = sanitizeApiKey(settings.apiKey || "");
  if (!apiKey || leads.length === 0) return [];

  const userText = "High-priority leads to learn from (JSON):\n" +
    JSON.stringify(leads.map(summarizeLeadForLookalike));

  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: AGENT_MODEL,
      max_tokens: 8192,
      system: buildLookalikePrompt(),
      tools: [SUGGEST_TOPICS_TOOL],
      tool_choice: { type: "tool", name: "suggest_topics" },
      messages: [{ role: "user", content: userText }],
    }),
  }, AGENT_FETCH_TIMEOUT_MS);

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`API error ${response.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await response.json();
  const toolUse = (data.content || []).find((block) => block.type === "tool_use" && block.name === "suggest_topics");
  return toolUse?.input?.suggestions || [];
}

// Diagnoses why Post leads aren't scoring/surfacing well and proposes
// concrete keyword changes across BOTH Topics and Negative Topics - the
// actual fix for the problem Lookalike Topics can't help with (it only has
// good examples to learn from once Posts are already scoring well). One
// unified suggestion shape (target: topic/negativeTopic, action: add/remove
// keyword) so the caller only needs one render/apply path for all four
// combinations, instead of four separate ones.
const ANALYZE_POST_SEARCH_TOOL = {
  name: "analyze_post_search",
  description: "Records a diagnosis and suggested Topic/Negative-Topic keyword changes to improve Post lead quality.",
  input_schema: {
    type: "object",
    properties: {
      diagnosis: { type: "string", description: "2-4 sentences on what's likely limiting Post lead quality/volume right now." },
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["topic", "negativeTopic"] },
            action: { type: "string", enum: ["add_keyword", "remove_keyword"] },
            topicName: { type: "string", description: "The existing topic's name this applies to, or a new name if isNewTopic is true." },
            isNewTopic: { type: "boolean", description: "Only meaningful with action=add_keyword - true to propose a brand-new topic rather than adding to an existing one." },
            keyword: { type: "string" },
            appliesTo: { type: "string", enum: ["post", "job", "both"], description: "Only meaningful when target=negativeTopic." },
            rationale: { type: "string", description: "Under 20 words." },
          },
          required: ["target", "action", "topicName", "keyword", "rationale"],
        },
      },
    },
    required: ["diagnosis", "suggestions"],
  },
};

function buildPostSearchAnalysisPrompt(topics, negativeTopics, stats, companyContext) {
  const postNegativeTopics = negativeTopics.filter((t) => t.appliesTo !== "job");
  const noGoodLeadsYet = (stats.byPriority[1] || 0) + (stats.byPriority[2] || 0) + (stats.byPriority[3] || 0) === 0;
  return (
    "You are a sales mentor diagnosing why a salesperson's LinkedIn Post search isn't surfacing enough good " +
    "leads. Two mechanics to reason about precisely: a Topic is a group of keywords, OR-matched against a " +
    "post's own text (plus an optional second group the post must ALSO mention) - too narrow a keyword list " +
    "misses relevant posts, too generic a keyword catches irrelevant chatter. A Negative Topic works the same " +
    "way, but a match marks the lead 'Irrelevant' instead of surfacing it - too aggressive a negative " +
    "keyword can silently kill genuinely good leads." +
    companyContextBlock(companyContext) + "\n" +
    "IMPORTANT: a Negative Topic can only ever REDUCE what surfaces - it can never fix a shortage of good " +
    "leads, only make it worse. If the stats below show few or no P1-P3 leads, that's a keyword-coverage " +
    "problem (Topics not casting a wide/specific enough net for what this company's real buyers actually " +
    "post about), not a noise problem - in that case, do not suggest only Negative Topic changes. Use what " +
    "the company actually sells (above) to propose genuinely new Topic keywords or a new Topic aimed at " +
    "buying-intent language its real prospects would plausibly write, not just tweaks to what's already " +
    "there.\n\n" +
    "Current Post Topics (JSON):\n" + JSON.stringify(topics.map((t) => ({ name: t.name, keywords: t.keywords, andKeywords: t.andKeywords, enabled: t.enabled }))) + "\n\n" +
    "Current Negative Topics that apply to Posts (JSON):\n" + JSON.stringify(postNegativeTopics.map((t) => ({ name: t.name, keywords: t.keywords, andKeywords: t.andKeywords, appliesTo: t.appliesTo, enabled: t.enabled }))) + "\n\n" +
    "Stats on currently-unactioned Post leads (JSON):\n" + JSON.stringify(stats) + "\n\n" +
    (noGoodLeadsYet
      ? "There are currently ZERO P1-P3 Post leads - this is the primary problem to address, and your " +
        "suggestions must include at least a few new-keyword or new-Topic ideas aimed at finding better " +
        "leads, not just narrowing what already comes through.\n\n"
      : "") +
    "Diagnose what's likely limiting quality or volume right now, grounded in the stats and the example " +
    "leads given next, not speculation. Then propose specific keyword changes (additions, removals, or a " +
    "genuinely new Topic/Negative Topic) that would plausibly help. It's fine to propose few or even zero " +
    "negative-topic changes if those look reasonable - the priority is fixing lead quality/volume, not " +
    "finding something to say about every config. Call analyze_post_search exactly once."
  );
}

function summarizeLeadForSearchAnalysis(lead) {
  return {
    key: lead.key,
    headline: lead.headline,
    snippet: (lead.snippet || "").slice(0, 400),
    matchedTopics: lead.matchedTopics.map((t) => t.topicName),
    priority: lead.priority || null,
    priorityReason: lead.priorityReason || "",
  };
}

// Batch call, same shape as prioritizeLeads/suggestLookalikeTopics. `leads`
// is the capped example set; `stats` (computed by the caller from the FULL
// qualifying set before capping) carries the volume signal so examples
// alone don't have to.
export async function analyzePostSearch(leads, topics, negativeTopics, stats, settings) {
  const apiKey = sanitizeApiKey(settings.apiKey || "");
  if (!apiKey) return { diagnosis: "", suggestions: [] };

  const userText = "Example currently-unactioned Post leads (JSON):\n" +
    JSON.stringify(leads.map(summarizeLeadForSearchAnalysis));

  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: AGENT_MODEL,
      max_tokens: 8192,
      system: buildPostSearchAnalysisPrompt(topics, negativeTopics, stats, settings.companyContext),
      tools: [ANALYZE_POST_SEARCH_TOOL],
      tool_choice: { type: "tool", name: "analyze_post_search" },
      messages: [{ role: "user", content: userText }],
    }),
  }, AGENT_FETCH_TIMEOUT_MS);

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`API error ${response.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await response.json();
  const toolUse = (data.content || []).find((block) => block.type === "tool_use" && block.name === "analyze_post_search");
  return { diagnosis: toolUse?.input?.diagnosis || "", suggestions: toolUse?.input?.suggestions || [] };
}

// job-drafted messages don't exist (draft_message rejects type "job"), so
// only_not_yet_drafted only ever filters Post leads - a job lead is always
// kept, since "not yet drafted" isn't a meaningful state for it.
export async function toolListLeads({ only_not_yet_drafted } = {}) {
  const resultsMap = await getResults();
  const sorted = sortResultsByRelevance(resultsMap);
  return sorted
    .filter((r) => r.status !== "Irrelevant")
    .filter((r) => r.type === "job" || !only_not_yet_drafted || !r.draftMessage)
    .map((r) =>
      r.type === "job"
        ? {
            key: r.key,
            type: "job",
            title: r.title,
            company: r.company,
            location: r.location,
            matchedTopics: r.matchedTopics.map((t) => t.topicName),
            status: r.status || "New",
            hasIndividualContact: false,
          }
        : {
            key: r.key,
            type: "post",
            author: r.author,
            headline: r.headline,
            matchedTopics: r.matchedTopics.map((t) => t.topicName),
            connectionDegree: r.connectionDegree || "unknown",
            isJobAd: r.isJobAd,
            isHiringPost: r.isHiringPost,
            isFreelancePost: r.isFreelancePost,
            status: r.status || "New",
            hasDraft: Boolean(r.draftMessage),
            hasIndividualContact: true,
          }
    );
}

export async function toolGetLeadDetails({ key }) {
  const resultsMap = await getResults();
  const r = resultsMap[key];
  if (!r) return { error: "No lead found with that key." };
  if (r.type === "job") {
    return {
      key: r.key,
      type: "job",
      title: r.title,
      company: r.company,
      location: r.location,
      jobUrl: r.jobUrl,
      matchedTopics: r.matchedTopics,
      status: r.status || "New",
      hasIndividualContact: false,
    };
  }
  return {
    key: r.key,
    type: "post",
    author: r.author,
    headline: r.headline,
    snippet: r.snippet,
    profileUrl: r.profileUrl,
    matchedTopics: r.matchedTopics,
    connectionDegree: r.connectionDegree || "unknown",
    isJobAd: r.isJobAd,
    isHiringPost: r.isHiringPost,
    isFreelancePost: r.isFreelancePost,
    existingDraft: r.draftMessage || null,
    status: r.status || "New",
    hasIndividualContact: true,
  };
}

// settings: {apiKey, messageTemplates, valueAddOffers, companyContext, outputLanguage}.
// onDrafted (optional): called after a successful draft so the caller can refresh whatever
// lead-list UI it has on screen - each page (side panel vs. Dashboard) refreshes differently.
export async function toolDraftMessage({ key, template_id }, settings, onDrafted) {
  const resultsMap = await getResults();
  const r = resultsMap[key];
  if (!r || r.type === "job") return { error: "No contactable Post lead found with that key." };

  const templateId =
    template_id && settings.messageTemplates.some((t) => t.id === template_id)
      ? template_id
      : pickDefaultTemplateId(r, settings.messageTemplates);

  try {
    const draft = await generateDraft(r, templateId, settings);
    await onDrafted?.();
    return { draft, templateId };
  } catch (err) {
    return { error: err.message };
  }
}

// The Sales Mentor can also draft messages as part of its advice; the
// Customer Voice is read-only - reacting to a message isn't the same as
// being able to write one.
export async function executeMentorTool(name, input, settings, onDrafted) {
  if (name === "list_leads") return toolListLeads(input || {});
  if (name === "get_lead_details") return toolGetLeadDetails(input || {});
  if (name === "draft_message") return toolDraftMessage(input || {}, settings, onDrafted);
  return { error: `Unknown tool: ${name}` };
}

export async function executeReadOnlyLeadTool(name, input) {
  if (name === "list_leads") return toolListLeads(input || {});
  if (name === "get_lead_details") return toolGetLeadDetails(input || {});
  return { error: `Unknown tool: ${name}` };
}

// The DOM-decoupled core of every agent chat in this extension: push the
// user's turn, call the API, run whatever tool it asks for, feed results
// back, repeat until a plain-text answer comes back (or a round-limit safety
// valve trips). Mutates `history` in place (by reference) via push, so the
// caller's own copy stays in sync. Callbacks let each page render however it
// wants without this module knowing about any DOM.
export async function runAgentTurn(userText, {
  history, apiKey, buildSystemPrompt, tools, executeTool, saveHistory, onStatus, onProgress,
}) {
  history.push({ role: "user", content: userText });
  await saveHistory(history);
  onProgress?.();

  if (!apiKey) {
    history.push({
      role: "assistant",
      content: [{ type: "text", text: "Add your Anthropic API key in the Advisors page's AI Settings first." }],
    });
    await saveHistory(history);
    onProgress?.();
    return;
  }

  try {
    // Tool-use loop: keep calling the API and executing whatever tool it
    // asks for until it returns a plain-text answer (stop_reason !==
    // "tool_use"), or we hit a sane round limit as a safety valve.
    for (let round = 0; round < 6; round++) {
      const thinkingLabel = round === 0 ? "Thinking…" : "Thinking some more…";

      const response = await withHeartbeat(
        fetchWithTimeout("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: AGENT_MODEL,
            max_tokens: 2048,
            system: buildSystemPrompt(),
            tools,
            messages: history,
          }),
        }, AGENT_FETCH_TIMEOUT_MS),
        thinkingLabel,
        onStatus
      );

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`API error ${response.status}: ${errBody.slice(0, 200)}`);
      }

      const data = await response.json();
      history.push({ role: "assistant", content: data.content });
      onProgress?.();

      if (data.stop_reason !== "tool_use") {
        await saveHistory(history);
        return;
      }

      const toolUses = data.content.filter((block) => block.type === "tool_use");
      const toolResults = [];
      for (const toolUse of toolUses) {
        const result = await withHeartbeat(
          withTimeout(executeTool(toolUse.name, toolUse.input), TOOL_EXEC_TIMEOUT_MS, `The ${toolUse.name} tool`),
          `Using tool: ${toolUse.name}…`,
          onStatus
        );
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(result) });
      }
      history.push({ role: "user", content: toolResults });
    }

    history.push({
      role: "assistant",
      content: [{ type: "text", text: "(Stopped after several tool calls without a final answer - try rephrasing.)" }],
    });
    await saveHistory(history);
    onProgress?.();
  } catch (err) {
    history.push({ role: "assistant", content: [{ type: "text", text: `Something went wrong: ${err.message}` }] });
    await saveHistory(history);
    onProgress?.();
  } finally {
    onStatus?.("");
  }
}
