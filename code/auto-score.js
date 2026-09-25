// Local, no-AI re-scoring of account priorities (design 2.5.3 and the pipeline's `score` step, 5.1).
// Shared by the Target Accounts page (after an import, a merge, a discovery, on open) and the
// background pipeline (after each account it works on), so both score exactly the same way.
// Free: local computation only - no AI call, no LinkedIn visit. Never touches a manual override or an
// AI-judged score (getCompaniesForPrioritization's rescoreDerived rule).
import {
  getCompaniesForPrioritization, applyCompanyPrioritizationResults, getTargetUniverseConfig, getMentorPersona,
  getCompanyContext, getIdealCustomerProfile, getOutputLanguage,
} from "./storage.js";
import { prioritizeCompanies } from "./agent-shared.js";

// onlyCompanyIds (optional): limit to these workbook company ids. Only companies whose priority or
// score actually moved are written. Returns { applied, counts, summary, results }.
export async function rescoreDerivedPriorities({ onlyCompanyIds = null } = {}) {
  let eligible = await getCompaniesForPrioritization({ rescoreAll: false, rescoreDerived: true });
  if (onlyCompanyIds) {
    const only = new Set(onlyCompanyIds);
    eligible = eligible.filter((e) => only.has(e.company.companyId));
  }
  const empty = { applied: 0, counts: {}, summary: "", results: [] };
  if (eligible.length === 0) return empty;
  const previousById = new Map(eligible.map((e) => [e.company.companyId, e.company]));
  const [targetUniverseConfig, mentorPersona, companyContext, idealCustomerProfile, outputLanguage] = await Promise.all([
    getTargetUniverseConfig(), getMentorPersona(), getCompanyContext(), getIdealCustomerProfile(), getOutputLanguage(),
  ]);
  const results = (await prioritizeCompanies(
    eligible, targetUniverseConfig,
    { apiKey: null, mentorPersona, companyContext, idealCustomerProfile, outputLanguage },
    { useAI: false }
  )).filter((r) => {
    const prev = previousById.get(r.companyId);
    return !prev || prev.salesTeamPriority !== r.priority || (prev.salesTeamPriorityScore ?? null) !== (r.priorityScore ?? null);
  });
  if (results.length === 0) return empty;
  const applied = await applyCompanyPrioritizationResults(results);
  const counts = { P1: 0, P2: 0, P3: 0, P4: 0, P5: 0 };
  for (const r of results) if (counts[r.priority] != null) counts[r.priority]++;
  const summary = ["P1", "P2", "P3", "P4", "P5"].filter((p) => counts[p] > 0).map((p) => `${counts[p]} ${p}`).join(", ");
  return { applied, counts, summary, results };
}
