# -*- coding: utf-8 -*-
# Converts the externally-maintained "Swiss AI prospects" Excel workbook (a
# ChatGPT-researched, manually-curated list of target companies scored for
# AI-consulting sales fit) into the small JSON file the SalesTeam extension's
# Settings page imports (Import Target Accounts button - see storage.js's
# importTargetAccounts). Re-run manually whenever the workbook is refreshed
# (expected cadence: every few months) - nothing in the extension reads the
# .xlsx file directly, since it has no bundler/xlsx-parsing library and the
# workbook doesn't change often enough to justify one.
import json
import openpyxl

SALESTEAM_DIR = "C:/Users/41793/OneDrive/Documents/Personal/Claude Code/SalesTeam"
SOURCE_XLSX = f"{SALESTEAM_DIR}/Swiss_AI_prospects_500.xlsx"
OUTPUT_JSON = f"{SALESTEAM_DIR}/exports/target-accounts.json"

COLUMNS = [
    "Company_ID", "Universe_Order", "Company", "Industry", "Prospect_Status", "Company_Type",
    "Global_HQ_City", "Global_HQ_Country", "Main_Swiss_Location", "Swiss_Decision_Authority",
    "Global_Revenue", "Revenue_Currency", "Revenue_Period", "Global_Revenue_Confidence",
    "Swiss_Revenue", "Swiss_Revenue_Currency", "Swiss_Revenue_Period", "Swiss_Revenue_Confidence",
    "Global_Employees", "Global_Employees_Period", "Global_Employees_Confidence",
    "Swiss_Employees", "Swiss_Employees_Period", "Swiss_Employees_Confidence",
    "AI_Investment_Global", "AI_Investment_Switzerland", "AI_Investment_Confidence",
    "Top_AI_Initiatives", "Relevant_Contacts_Count", "Swiss_Size_Fit_Score", "Decision_Authority_Score",
    "AI_Maturity_Fit_Score", "AI_Investment_Score", "Contact_Access_Score", "AI_Use_Case_Fit_Score",
    "Evidence_Coverage", "AI_Priority_Score", "AI_Priority", "Research_Quality", "Research_Status",
    "Priority_Rationale", "Primary_Source_URL", "Last_Verified", "AI_Portfolio_Profile",
    "AI_Portfolio_Profile_Confidence",
]
COL = {name: i for i, name in enumerate(COLUMNS)}


def main():
    wb = openpyxl.load_workbook(SOURCE_XLSX, read_only=True, data_only=True)
    ws = wb["Companies"]

    entries = []
    skipped_no_score = 0
    for row in ws.iter_rows(min_row=2, values_only=True):
        company = row[COL["Company"]]
        if not company:
            continue
        score = row[COL["AI_Priority_Score"]]
        if score is None:
            skipped_no_score += 1
            continue
        entries.append({
            "company": company,
            "industry": row[COL["Industry"]],
            "score": float(score),
            "priorityLabel": row[COL["AI_Priority"]],
            "researchStatus": row[COL["Research_Status"]],
            "topInitiatives": row[COL["Top_AI_Initiatives"]],
        })

    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)

    counts = {}
    for e in entries:
        counts[e["priorityLabel"]] = counts.get(e["priorityLabel"], 0) + 1

    print(f"Wrote {len(entries)} companies to {OUTPUT_JSON}")
    print(f"Skipped {skipped_no_score} companies with no AI_Priority_Score")
    for label, count in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {label}: {count}")


if __name__ == "__main__":
    main()
