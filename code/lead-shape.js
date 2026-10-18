// Lead shape helpers - a lead is either a Post (author/headline/snippet) or a Job listing (title/company/location), see
// storage.js's mergeTopicPosts/mergeJobPosts for the two shapes. Pure: shared by the Leads Dashboard (dashboard.js) and,
// since 1.2.4.7, the Leads lists on the account and contact pages and the Leads sheet of the SalesTeam Excel export.

export function leadTitle(lead) {
  return lead.type === "job" ? (lead.title || "Untitled role") : (lead.headline || lead.author || "Untitled");
}

export function leadContent(lead) {
  return lead.type === "job"
    ? [lead.title, lead.company, lead.location].filter(Boolean).join(" · ")
    : (lead.snippet || "");
}

export function leadCreatorName(lead) {
  return lead.type === "job" ? (lead.company || "Unknown company") : (lead.author || "Unknown");
}

// Reported directly: the CSV export had no Company column at all for Post
// leads (leadCreatorName above returns the author's name, not their
// employer) - blocked a real analysis (cross-referencing new leads against
// the Target Accounts list) that the JSON leads backup could already do via
// its own company field. Job leads already carry company in leadCreatorName,
// but this gives both lead types their own explicit, unambiguous column.
export function leadCompany(lead) {
  return lead.company || "";
}

export function leadCreatorUrl(lead) {
  return lead.type === "job" ? lead.jobUrl : lead.profileUrl;
}

// The post or job listing itself (the creator's profile is leadCreatorUrl).
export function leadItemUrl(lead) {
  return lead.type === "job" ? lead.jobUrl : lead.postUrl;
}

export function leadSourceLabel(lead) {
  if (lead.type === "job") return "Job Listing";
  if (lead.isJobAd) return "In-Post Job Ad";
  return "Post";
}

// The real (estimated) post date, not when the scanner happened to find it -
// see storage.js's parseRelativeTimestamp. Falls back to firstSeenAt only
// for the rare case both parsing attempts (fresh scrape and self-heal) failed.
export function leadDate(lead) {
  return lead.postedAt || lead.firstSeenAt || 0;
}

export function leadPriorityLabel(lead) {
  return lead.priority ? `P${lead.priority}` : "";
}

// 1.2.4.7: the Leads sheet of the SalesTeam Excel export - one row per lead, Company_ID ties it to the Companies sheet.
// Dates as YYYY-MM-DD so Excel sorts them. Import… does not read this sheet (leads come from scans, not files).
export const LEADS_SHEET_HEADERS = ["Company_ID", "Company", "Post_Date", "First_Scanned", "Source", "Title", "Content",
  "Creator", "Creator_URL", "Connection", "Status", "Priority", "Priority_Reason", "URL"];

function isoDay(ms) {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "";
}

export function leadsSheet(leads, companyIdOf = () => "") {
  const rows = [...leads]
    .sort((a, b) => leadDate(b) - leadDate(a))
    .map((lead) => [
      companyIdOf(lead) || "",
      leadCompany(lead),
      isoDay(leadDate(lead)),
      isoDay(lead.firstSeenAt),
      leadSourceLabel(lead),
      leadTitle(lead),
      leadContent(lead),
      leadCreatorName(lead),
      leadCreatorUrl(lead) || "",
      lead.connectionDegree || "",
      lead.status || "New",
      leadPriorityLabel(lead),
      lead.priorityReason || "",
      leadItemUrl(lead) || "",
    ]);
  return { name: "Leads", headers: [...LEADS_SHEET_HEADERS], rows };
}
