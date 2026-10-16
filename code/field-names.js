// 1.2.4.4 (projects design 5.1, R6): what users read for a customer field whose stored id says "ai…" or names a country.
// The ids stay as they are in every user's data, backup and team folder (R3.3); only the words change. Used by the
// Activity Log and team log (team-log.js fieldName) and the backup's spreadsheets (csv-export.js headerLabel), which
// otherwise build a name from the id ("aiMaturityFitScore" -> "Ai maturity fit score").
//
//   customerFieldName(id)  -> "Adoption fit score", or null for an id not in the table
//
// SalesTeam's own AI keeps its name: aiPriority / aiPriorityScore are the imported priority, named in the callers.
//
// PURE - no chrome APIs, no storage, no DOM (test_pure_modules.py runs it).

export const CUSTOMER_FIELD_NAMES = {
  aiInvestment: "Investment",
  aiInvestmentGlobal: "Investment (global)",
  investmentGlobal: "Investment (global)",
  aiInvestmentSwitzerland: "Investment (local)",
  investmentSwitzerland: "Investment (local)",
  investmentHome: "Investment (local)",
  aiInvestmentConfidence: "Investment confidence",
  investmentConfidence: "Investment confidence",
  aiInvestmentScore: "Investment score",
  investmentScore: "Investment score",
  aiMaturityFitScore: "Adoption fit score",
  maturityFitScore: "Adoption fit score",
  aiUseCaseFitScore: "Use-case fit score",
  useCaseFitScore: "Use-case fit score",
  aiPortfolioProfile: "Portfolio profile",
  portfolioProfile: "Portfolio profile",
  aiPortfolioProfileConfidence: "Portfolio profile confidence",
  portfolioProfileConfidence: "Portfolio profile confidence",
  aiRelevance: "Relevance",
  topAiInitiatives: "Top projects",
  topInitiatives: "Top projects",
  aiInitiatives: "Projects",
  initiativeId: "Project ID",
  initiativeName: "Project",
};

export function customerFieldName(id) {
  return CUSTOMER_FIELD_NAMES[id] || null;
}
