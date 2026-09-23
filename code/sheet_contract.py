# -*- coding: utf-8 -*-
# Single source of truth for the workbook format SalesTeam's importer reads
# (xlsx-lite.js RELATIONAL_SHEETS + the Explorer's column set), derived from the
# first real workbook (V66). Used by:
#   - build_prompt_v13.py  (writes Section 45 of the research prompt from this)
#   - validate_workbook.py (checks any generated workbook against this)
# Each column: (header, required, description). Headers are case- and space-exact.

R, O = True, False

COMPANIES = [
    ("Company_ID", R, "Unique stable ID, e.g. C0001"),
    ("Universe_Order", R, "Integer 1..N, the account's position in the universe"),
    ("Company", R, "Canonical company name"),
    ("Industry", O, "Industry / sector label"),
    ("Use_Case_Fit_Score", O, "0-100 fit between the account and the user's offering"),
    ("Evidence_Coverage", R, "Decimal 0-1: research-confidence coverage"),
    ("Priority_Score", O, "Number 0-100: account attractiveness; may be blank only when Priority is Insufficient Evidence"),
    ("Priority", R, "Label, see value rules"),
    ("Research_Quality", O, "A, B, C or D"),
    ("Research_Status", R, "Short text describing the research state of the account"),
    ("Priority_Rationale", O, "One or two sentences explaining the score"),
    ("Primary_Source_URL", O, "Main source URL"),
    ("Last_Verified", O, "Date YYYY-MM-DD"),
    ("Portfolio_Profile", O, "Short profile of the company's activity relevant to the offering"),
    ("Portfolio_Profile_Confidence", O, "High, Medium or Low"),
    ("Evidence_Status", R, "One of the allowed evidence labels, see value rules"),
    ("Registry_Official_Name", O, "Official registered legal name from the primary target country's official company registry"),
    ("Registry_ID", O, "Registry identifier of that registry entry"),
    ("Registry_Address", O, "Registered address"),
    ("Alternative Company Name", O, "Commonly used short name, acronym or brand. The header contains spaces"),
    ("LinkedIn Link", O, "Full LinkedIn company-page URL, https://www.linkedin.com/company/... The header contains a space"),
    ("Prospect_Status", O, "Target, or Review - <reason>"),
    ("Company_Type", O, "Organization/ownership type: Public company, Private company, Cooperative, State-owned..."),
    ("Target_Country_Relationship", O, "Local company or Global company (schema 1.1): where the account's group is headquartered relative to the project's home market"),
    ("Global_HQ_City", O, "Group headquarters city"),
    ("Global_HQ_Country", O, "Group headquarters country"),
    ("Main_Home_Location", O, "Main location in the primary target country"),
    ("Home_Decision_Authority", O, "Decision authority of the account's primary-target-country entity, e.g. Full, Partial, Group-level"),
    ("Global_Revenue", O, "Number, group-wide annual revenue"),
    ("Revenue_Currency", O, "ISO currency code"),
    ("Revenue_Period", O, "Fiscal year or period"),
    ("Global_Revenue_Confidence", O, "Verified, Reported, Estimated..."),
    ("Home_Revenue", O, "Number, revenue in the primary target country"),
    ("Home_Revenue_Currency", O, "ISO currency code"),
    ("Home_Revenue_Period", O, "Fiscal year or period"),
    ("Home_Revenue_Confidence", O, "Verified, Reported, Estimated..."),
    ("Global_Employees", O, "Number, group-wide employees/FTE"),
    ("Global_Employees_Period", O, "Year or period"),
    ("Global_Employees_Confidence", O, "Verified, Reported, Estimated..."),
    ("Home_Employees", O, "Number, employees/FTE in the primary target country"),
    ("Home_Employees_Period", O, "Year or period"),
    ("Home_Employees_Confidence", O, "Verified, Reported, Estimated..."),
    ("Investment_Global", O, "Relevant investment/budget evidence, group-wide"),
    ("Investment_Home", O, "Relevant investment/budget evidence in the primary target country"),
    ("Investment_Confidence", O, "Verified, Reported, Estimated..."),
    ("Top_Initiatives", O, "Short text list of the main relevant initiatives"),
    ("Relevant_Contacts_Count", O, "Integer: number of verified relevant contacts"),
    ("Home_Size_Fit_Score", O, "0-100 size-fit sub-score for the primary target country"),
    ("Decision_Authority_Score", O, "0-100 sub-score"),
    ("Maturity_Fit_Score", O, "0-100 sub-score"),
    ("Investment_Score", O, "0-100 sub-score"),
    ("Contact_Access_Score", O, "0-100 sub-score"),
    ("Size_Bucket", O, "Size band label"),
    ("Employee_Count", O, "Integer, when an exact count exists"),
    ("Employee_Range", O, "Range text such as 1,001-5,000, when only a range exists"),
    ("Size_Source", O, "Where the size figure comes from"),
    ("Size_Scope", O, "Global, Local, Group..."),
    ("Size_Confidence", O, "Verified, Reported, Estimated..."),
    ("Size_Last_Verified", O, "Date YYYY-MM-DD"),
    ("Excluded", R, "Yes or No"),
]

CONTACTS = [
    ("Contact_ID", R, "Unique contact ID"),
    ("Company_ID", R, "Must exist in Companies"),
    ("Company", R, "Company name, same as in Companies"),
    ("Full_Name", R, "Verified real person only, never invented"),
    ("Job_Title", R, "Current title in its original language"),
    ("Function", O, "Business function"),
    ("Seniority", O, "e.g. C-level, Head, Director, Professional"),
    ("Relevance", O, "Why this person is relevant to the offering"),
    ("Home_Based", O, "Yes or No: based in the primary target country"),
    ("City", O, ""),
    ("Country", O, ""),
    ("Public_Business_Email", O, "Only when publicly verified, never guessed"),
    ("Profile_URL", O, "Full LinkedIn profile URL"),
    ("Last_Verified", O, "Date YYYY-MM-DD"),
    ("Evidence_Quality", O, "How well the contact is evidenced"),
]

INITIATIVES = [
    ("Initiative_ID", R, "Unique initiative ID"),
    ("Company_ID", R, "Must exist in Companies"),
    ("Company", R, "Company name"),
    ("Initiative_Name", R, "Short name of the initiative"),
    ("Category", O, ""),
    ("Scope", O, "Global, Local, Business unit..."),
    ("Business_Function", O, ""),
    ("Description", O, ""),
    ("Status", O, "Stage of the initiative, e.g. Pilot, Production, Scaling"),
    ("Announced_Date", O, ""),
    ("Investment_Amount", O, ""),
    ("Currency", O, ""),
    ("Technology_or_Partner", O, ""),
    ("Source_URL", O, ""),
    ("Last_Verified", O, "Date YYYY-MM-DD"),
    ("Evidence_Quality", O, ""),
]

INVESTMENT = [
    ("Investment_ID", R, "Unique ID"),
    ("Company_ID", R, "Must exist in Companies"),
    ("Company", R, ""),
    ("Year", O, ""),
    ("Scope", O, ""),
    ("Amount_Low", O, ""),
    ("Amount_High", O, ""),
    ("Currency", O, ""),
    ("Evidence_Type", O, ""),
    ("Basis", O, ""),
    ("Source_URL", O, ""),
    ("Last_Verified", O, "Date YYYY-MM-DD"),
]

SOURCES = [
    ("Source_ID", R, "Unique ID"),
    ("Company_ID", O, "Must exist in Companies; may be blank for general coverage/market sources"),
    ("Company_or_Coverage", O, ""),
    ("Source_Type", O, ""),
    ("Source_Title", O, ""),
    ("Source_Date", O, ""),
    ("URL", O, "Full URL"),
    ("Used_For", O, "Which fact this source supports"),
    ("Evidence_Quality", O, ""),
    ("Last_Verified", O, "Date YYYY-MM-DD"),
]

EXCLUSION_LIST = [
    ("Company_ID", R, "Must exist in Companies"),
    ("Company", R, ""),
    ("Exclusion_Reason", R, "Competitor, Partner, Customer or Other"),
]

ALIASES = [
    ("Company_ID", R, "Must exist in Companies"),
    ("Canonical_Name", R, "The company's canonical name"),
    ("Alias", R, "The name variant"),
    ("Alias_Type", R, "See value rules"),
    ("Language", O, "Two-letter code such as EN, FR, DE, or blank"),
    ("Search_Priority", R, "1 = primary, 2 = useful secondary, 3 = fallback search variant"),
    ("Normalized_Alias", R, "Lowercase, accents removed, punctuation replaced by single spaces"),
    ("Source_or_Notes", O, ""),
    ("Source_URL", O, ""),
    ("Verification_Status", O, ""),
]

# Older workbooks (V66) used country-specific header names; the importer and validator still accept them.
LEGACY_HEADERS = {'Registry_Official_Name': 'Zefix_Official_Name', 'Registry_ID': 'Zefix_UID', 'Registry_Address': 'Zefix_Address', 'Main_Home_Location': 'Main_Swiss_Location', 'Home_Decision_Authority': 'Swiss_Decision_Authority', 'Home_Revenue_Currency': 'Swiss_Revenue_Currency', 'Home_Revenue_Period': 'Swiss_Revenue_Period', 'Home_Revenue_Confidence': 'Swiss_Revenue_Confidence', 'Home_Revenue': 'Swiss_Revenue', 'Home_Employees_Period': 'Swiss_Employees_Period', 'Home_Employees_Confidence': 'Swiss_Employees_Confidence', 'Home_Employees': 'Swiss_Employees', 'Investment_Home': 'Investment_Switzerland', 'Home_Size_Fit_Score': 'Swiss_Size_Fit_Score', 'Home_Based': 'Swiss_Based'}

SHEETS = [
    ("Companies", COMPANIES), ("Contacts", CONTACTS), ("Initiatives", INITIATIVES),
    ("Investment", INVESTMENT), ("Sources", SOURCES),
    ("Exclusion_List", EXCLUSION_LIST), ("Aliases", ALIASES),
]

EVIDENCE_STATUS_VALUES = ["Full Evidence", "Rich Evidence", "Sufficient Evidence",
                          "Provisional Evidence", "Insufficient Evidence"]
PRIORITY_BASE = ["Very High", "High", "Medium", "Low"]
PRIORITY_EXTRA = ["Insufficient Evidence"]
ALIAS_TYPES = ["Canonical Name", "Legal Name", "Alternative / Trading Name", "Abbreviation",
               "English Name", "Local-language Name", "LinkedIn / Curated Name", "Former Name",
               "Brand / Subsidiary / Predecessor", "Common Name", "Search Variant"]
EXCLUSION_REASONS = ["Competitor", "Partner", "Customer", "Other"]
