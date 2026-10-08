"""Actually RUN the extension's pure JS modules and assert on what they return.

There is no Node on this machine, but py_mini_racer ships a prebuilt V8, which is enough to execute
any module that touches neither chrome.* nor the DOM. That covers the logic most worth testing and
least pleasant to debug by hand: number parsing, currency conversion, and the web-findings
arbitration rules.

    set PYTHONDONTWRITEBYTECODE=1
    python code/test_pure_modules.py

One-off install if missing: python -m pip install py_mini_racer

This complements check_js_syntax.py - that proves every page will LOAD, this proves some of the
logic is RIGHT. Neither replaces reloading the extension and using it.

Adding a module here is only possible while it stays pure. If one of these ever needs chrome.storage
or document, the right move is to lift the logic back out into a pure module rather than to delete
the test.
"""

import io
import os
import re
import json
import sys

try:
    from py_mini_racer import MiniRacer
except ImportError:
    sys.exit("Missing JS engine. Run:  python -m pip install py_mini_racer")

CODE_DIR = os.path.dirname(os.path.abspath(__file__))

PURE_MODULES = ["company-identity.js", "relationships.js", "value-normalize.js", "web-research-apply.js", "web-findings-arbitration.js", "readiness.js", "pipeline-plan.js", "decision-rules.js", "rate-limit.js", "extras-merge.js", "discovery-filter.js", "iso-country-codes.js", "country-local-names.js", "setup-proposals.js", "onboarding-estimate.js", "geo-regions.js", "team-groups.js", "team-merge.js", "team-keys.js", "team-rows.js", "team-claims.js", "team-log.js", "team-join.js"]

# Dependency order matters above: each module is concatenated after the ones it uses.
IMPORT_RE = re.compile(r"""^\s*import\s+[^;]*?from\s+["\']([^"\']+)["\']\s*;\s*$""", re.M)

_failures = []
_passes = 0


def load_modules(ctx):
    """Concatenate the pure modules with their ES-module syntax stripped.

    MiniRacer evaluates a plain script, not a module graph. These files import nothing from each
    other (that is what keeps them pure and testable), so dropping `export ` and any import line
    leaves a single valid script with every top-level binding in scope.
    """
    parts = []
    for name in PURE_MODULES:
        src = io.open(os.path.join(CODE_DIR, name), encoding="utf-8").read()
        # An import of another module in this list is fine - they are loaded in dependency order and
        # end up sharing one scope. An import of anything else means the module is no longer pure
        # (it has reached for storage or the DOM) and the test would be silently meaningless.
        for match in IMPORT_RE.finditer(src):
            target = os.path.basename(match.group(1))
            if target not in PURE_MODULES:
                sys.exit("%s imports %s, which is not pure - fix the module, not this harness." % (name, target))
        src = IMPORT_RE.sub("", src)
        src = re.sub(r"^export\s+(?=(const|let|var|function|class)\b)", "", src, flags=re.M)
        parts.append("// ===== %s =====\n%s" % (name, src))
    ctx.eval("\n".join(parts))


def check(label, actual, expected):
    global _passes
    if actual == expected:
        _passes += 1
    else:
        _failures.append("%s\n    expected: %r\n    actual:   %r" % (label, expected, actual))


def num(ctx, expr):
    return ctx.eval(expr)


def test_parse_loose_number(ctx):
    cases = [
        # the values that really are in this dataset
        ('"6,500+"', 6500),          # EPFL's employee count
        ('">5,000"', 5000),          # ADM Switzerland
        ('"102bn"', 102000000000.0),
        ('"102M"', 102000000.0),     # 102M -> 102,000,000
        ('"1.5m"', 1500000.0),
        ('"CHF 102m"', 102000000.0),
        ("\"102'000\"", 102000),     # Swiss thousands separator
        ('"USD"', None),             # a currency code alone is not a number
        ('""', None),
        ('"not disclosed"', None),
        ('113530000000', 113530000000),
        ('"~500"', 500),
        ('"approx. 2,300 employees"', 2300),
        ('"1,5m"', 1500000.0),       # European decimal comma
        ('"6500"', 6500),
        ('"$1.2bn"', 1200000000.0),
        ('115', 115),                # Swissmedic - NOT silently promoted to millions
        ('"-5"', -5),
        ('null', None),
        ('"about 12 000"', 12000),
    ]
    for expr, expected in cases:
        check("parseLooseNumber(%s)" % expr, num(ctx, "parseLooseNumber(%s)" % expr), expected)


def test_currency(ctx):
    check('extractCurrency("CHF 102m")', ctx.eval('extractCurrency("CHF 102m")'), "CHF")
    check('extractCurrency("$5")', ctx.eval('extractCurrency("$5")'), "USD")
    check('extractCurrency(102)', ctx.eval('extractCurrency(102)'), None)

    # CHF -> USD at the default table's 1.25
    check(
        "convertCurrency(100, CHF, USD)",
        ctx.eval("convertCurrency(100, 'CHF', 'USD', DEFAULT_EXCHANGE_RATES)"),
        125.0,
    )
    check(
        "convertCurrency same currency is untouched",
        ctx.eval("convertCurrency(100, 'USD', 'USD', DEFAULT_EXCHANGE_RATES)"),
        100,
    )
    check(
        "convertCurrency unknown currency gives null",
        ctx.eval("convertCurrency(100, 'XYZ', 'USD', DEFAULT_EXCHANGE_RATES)"),
        None,
    )

    # normalizeMoney: clean, then convert to the target
    check(
        "normalizeMoney('CHF 102m') -> USD amount",
        ctx.eval("normalizeMoney('102m', 'CHF', 'USD', DEFAULT_EXCHANGE_RATES).amount"),
        127500000.0,
    )
    check(
        "normalizeMoney flags that it converted",
        ctx.eval("normalizeMoney('102m', 'CHF', 'USD', DEFAULT_EXCHANGE_RATES).converted"),
        True,
    )
    check(
        "normalizeMoney does not flag a no-op conversion",
        ctx.eval("normalizeMoney('102m', 'USD', 'USD', DEFAULT_EXCHANGE_RATES).converted"),
        False,
    )


ACCOUNT_CTX = """
  const ctxFor = (over = {}) => ({
    buckets: [
      { key: "S", label: "Small", min: 0, max: 200 },
      { key: "M", label: "Medium", min: 201, max: 500 },
      { key: "L", label: "Large", min: 501, max: 1000 },
      { key: "XL", label: "Extra Large", min: 1001, max: 5000 },
      { key: "XXL", label: "Extra Extra Large", min: 5001, max: Infinity },
    ],
    locationTier: (c) => ({ Switzerland: 3, Germany: 2 }[c] ?? null),
    effective: {},
    hasRevenue: false,
    contactCount: 0,
    employeesFromLinkedin: false,
    ...over,
  });
"""


def test_arbitration(ctx):
    ctx.eval(ACCOUNT_CTX)

    # Rule 4: Glencore - two correct figures, same size band, so the choice changes nothing.
    ctx.eval("""
      var glencore = arbitrateFinding(
        { key: "globalEmployees", label: "Employees (global)", found: 150000, current: 84146, state: "different" },
        ctxFor(), {});
    """)
    check("Glencore same-band rule", ctx.eval("glencore.rule"), 4)
    check("Glencore keeps existing by default", ctx.eval("glencore.action"), "dismiss")

    # Rule 6: a real band change is the one employee disagreement that can move a priority.
    ctx.eval("""
      var band = arbitrateFinding(
        { key: "globalEmployees", label: "Employees (global)", found: 9000, current: 300, state: "different" },
        ctxFor(), {});
    """)
    check("band change asks the user", ctx.eval("band.action"), "review")
    check("band change is rule 6", ctx.eval("band.rule"), 6)

    # Rule 5: different bands but within tolerance -> decided, not asked.
    ctx.eval("""
      var close = arbitrateFinding(
        { key: "globalEmployees", label: "Employees (global)", found: 1050, current: 990, state: "different" },
        ctxFor(), {});
    """)
    check("close counts are decided", ctx.eval("close.action"), "dismiss")
    check("close counts are rule 5", ctx.eval("close.rule"), 5)

    # Rule 1: an empty field is filled from the web.
    ctx.eval("""
      var empty = arbitrateFinding(
        { key: "globalRevenue", label: "Revenue", found: 500000, current: null, state: "new" },
        ctxFor(), {});
    """)
    check("empty field takes the web value", ctx.eval("empty.action"), "apply")
    check("empty field is rule 1", ctx.eval("empty.rule"), 1)

    # Rule 2: 0 employees at a company that has revenue. The found value is the implausible one and
    # the account holds a sound 4,000, so this is discarded rather than put to the user - asking
    # about a value that is plainly junk wastes the attention the whole mechanism exists to save.
    ctx.eval("""
      var zero = arbitrateFinding(
        { key: "globalEmployees", label: "Employees (global)", found: 0, current: 4000, state: "different" },
        ctxFor({ hasRevenue: true }), {});
    """)
    check("an implausible found value is discarded, not escalated", ctx.eval("zero.action"), "dismiss")
    check("zero employees is rule 2", ctx.eval("zero.rule"), 2)

    # THE ONE INVARIANT THAT MUST HOLD WHATEVER THE SETTINGS SAY: a found value that fails the
    # "looks wrong" checks is never written into an account. Swept over every settings combination
    # rather than asserted on one case - that promise is the whole reason it is safe to let a user
    # switch these rules off. It may come back "dismiss" or "review"; it may never come back "apply".
    ctx.eval("""
      var illogicalCases = [
        { key: "globalEmployees", label: "E", found: 0, current: 4000, state: "different" },
        { key: "globalEmployees", label: "E", found: 9000000, current: 4000, state: "different" },
        { key: "globalEmployees", label: "E", found: -5, current: 4000, state: "different" },
        { key: "globalRevenue", label: "R", found: 115, current: 115000000, state: "different" },
      ];
      var appliedAnyway = [];
      var comboCount = 0;
      for (const r1 of [true, false]) for (const r2 of [true, false])
      for (const r3 of [true, false]) for (const r4 of [true, false])
      for (const r5 of [true, false]) for (const r6 of [true, false])
      for (const r7 of [true, false]) for (const pref of ["existing", "web"])
      for (const li of [true, false]) {
        const settings = {
          rule1EmptyApply: r1, rule2IllogicalReview: r2, rule3NonScoringAuto: r3,
          rule4SameBucketAuto: r4, rule5ToleranceAuto: r5, rule6BucketChangeReview: r6,
          rule7LocationTierReview: r7, sourcePreference: pref, linkedinAuthoritative: li,
        };
        comboCount++;
        for (const p of illogicalCases) {
          const d = arbitrateFinding(p, ctxFor({ hasRevenue: true, effective: { globalEmployees: 4000 } }), settings);
          if (d.action === "apply") appliedAnyway.push(p.key + "/" + JSON.stringify(settings));
        }
      }
    """)
    check(
        "an illogical found value is NEVER applied, under any settings combination",
        ctx.eval("appliedAnyway.length"),
        0,
    )
    # Guard the guard: if the sweep ever stops covering the matrix, the test above passes vacuously.
    check("the settings sweep really ran", ctx.eval("comboCount"), 2 ** 7 * 2 * 2)

    # Rule 7: same location tier -> decided; different tier -> asked.
    ctx.eval("""
      var sameTier = arbitrateFinding(
        { key: "globalHqCountry", label: "HQ country", found: "Schweiz", current: "Switzerland", state: "different" },
        ctxFor(), {});
      var diffTier = arbitrateFinding(
        { key: "globalHqCountry", label: "HQ country", found: "Germany", current: "Switzerland", state: "different" },
        ctxFor(), {});
    """)
    # "Schweiz" is not in the tier map, so both resolve differently - assert the real pair instead.
    check("a country that changes the tier is asked", ctx.eval("diffTier.action"), "review")
    check("tier change is rule 7", ctx.eval("diffTier.rule"), 7)

    # LinkedIn authority: a band disagreement against a LinkedIn-sourced count is settled, not asked.
    ctx.eval("""
      var li = arbitrateFinding(
        { key: "globalEmployees", label: "Employees (global)", found: 9000, current: 300, state: "different" },
        ctxFor({ employeesFromLinkedin: true }), {});
    """)
    check("LinkedIn band wins without asking", ctx.eval("li.action"), "dismiss")


def test_currency_pair(ctx):
    """The currency must follow its revenue amount - never be applied on its own."""
    ctx.eval("""
      var proposals = [
        { key: "revenueCurrency", label: "Revenue currency", found: "CHF", current: "USD", state: "different" },
      ];
      var kept = arbitrateAccount({
        proposals,
        extra: { overrides: {} },
        ctx: ctxFor({ effective: { globalRevenue: 113530000000 } }),
        settings: { sourcePreference: "web" },
      });
    """)
    check(
        "currency alone is NOT applied even when the web is preferred",
        ctx.eval("kept.decisions[0].action"),
        "dismiss",
    )

    ctx.eval("""
      var together = arbitrateAccount({
        proposals: [
          { key: "globalRevenue", label: "Revenue", found: 91350000000, current: 113530000000, state: "different" },
          { key: "revenueCurrency", label: "Revenue currency", found: "CHF", current: "USD", state: "different" },
        ],
        extra: { overrides: {} },
        ctx: ctxFor({ effective: { globalRevenue: 113530000000 } }),
        settings: { sourcePreference: "web" },
      });
      var amountD = together.decisions.find((d) => d.proposal.key === "globalRevenue");
      var currD = together.decisions.find((d) => d.proposal.key === "revenueCurrency");
    """)
    check("amount is applied", ctx.eval("amountD.action"), "apply")
    check("currency moves with the amount", ctx.eval("currD.action"), "apply")

    ctx.eval("""
      var asked = arbitrateAccount({
        proposals: [
          { key: "globalEmployees", label: "Employees", found: 9000, current: 300, state: "different" },
          { key: "revenueCurrency", label: "Revenue currency", found: "CHF", current: "USD", state: "different" },
        ],
        extra: { overrides: {} },
        ctx: ctxFor({ effective: { globalRevenue: 5000000 } }),
        settings: {},
      });
      var currAsked = asked.decisions.find((d) => d.proposal.key === "revenueCurrency");
    """)
    check(
        "with no amount finding in play, the currency is kept",
        ctx.eval("currAsked.action"),
        "dismiss",
    )


def test_local_revenue_currency(ctx):
    """The local revenue is normalised with its OWN currency, not the worldwide one."""
    ctx.eval("""
      var money = { targetCurrency: "USD", rates: DEFAULT_EXCHANGE_RATES };
      // Worldwide figure in USD, local figure in CHF. 80m CHF is 100m USD at the default 1.25, so a
      // found 100m USD is the SAME money and must not be reported as a disagreement.
      var company = { swissRevenue: 80000000, revenueCurrency: "USD", swissRevenueCurrency: "CHF" };
      var props = computeFindingProposals(company, {}, { revenueLocal: 100000000, revenueCurrency: "USD" }, money);
      var localProps = props.filter((p) => p.key === "swissRevenue");
    """)
    check(
        "local revenue uses swissRevenueCurrency, so an equal amount is not a finding",
        ctx.eval("localProps.length"),
        0,
    )

    ctx.eval("""
      // With no local currency of its own the row falls back to the global one - and then the same
      // two numbers genuinely DO differ.
      var company2 = { swissRevenue: 80000000, revenueCurrency: "USD" };
      var props2 = computeFindingProposals(company2, {}, { revenueLocal: 100000000, revenueCurrency: "USD" }, money);
      var localProps2 = props2.filter((p) => p.key === "swissRevenue");
    """)
    check("without a local currency it falls back to the global one", ctx.eval("localProps2.length"), 1)


def test_currency_follows_global_only(ctx):
    """A change to the LOCAL amount must not drag the worldwide currency along with it."""
    ctx.eval("""
      var res = arbitrateAccount({
        proposals: [
          { key: "swissRevenue", label: "Revenue (local)", found: 5000000, current: 9000000, state: "different" },
          { key: "revenueCurrency", label: "Revenue currency", found: "CHF", current: "USD", state: "different" },
        ],
        extra: { overrides: {} },
        ctx: ctxFor({ effective: { globalRevenue: 113530000000, swissRevenue: 9000000 } }),
        settings: { sourcePreference: "web" },
      });
      var curr = res.decisions.find((d) => d.proposal.key === "revenueCurrency");
      var local = res.decisions.find((d) => d.proposal.key === "swissRevenue");
    """)
    check("the local amount is still applied", ctx.eval("local.action"), "apply")
    check(
        "the worldwide currency does NOT follow a local-amount change",
        ctx.eval("curr.action"),
        "dismiss",
    )


def test_implausible_briefing_is_discarded(ctx):
    """CSL Vifor, from the real data: a briefing reporting 2,600 employees AND 2,234 of revenue.

    Under 1 of revenue per employee per year - incoherent on its own terms. Neither field should
    reach the user: there is nothing to decide when the incoming value is junk and the stored one
    is sound.
    """
    ctx.eval("""
      var vifor = arbitrateAccount({
        proposals: [
          { key: "globalEmployees", label: "Employees (global)", found: 2600, current: 29904, state: "different" },
          { key: "globalRevenue", label: "Revenue (global)", found: 2234, current: 2234000000, state: "different" },
        ],
        extra: { overrides: {} },
        ctx: ctxFor({ hasRevenue: true, effective: { globalEmployees: 29904, globalRevenue: 2234000000 } }),
        settings: {},
      });
      var emp = vifor.decisions.find((d) => d.proposal.key === "globalEmployees");
      var rev = vifor.decisions.find((d) => d.proposal.key === "globalRevenue");
    """)
    check("the implausible revenue is discarded, not escalated", ctx.eval("rev.action"), "dismiss")
    check("...by rule 2", ctx.eval("rev.rule"), 2)
    check("the employee count in the same briefing goes too", ctx.eval("emp.action"), "dismiss")
    check("...also by rule 2", ctx.eval("emp.rule"), 2)
    check(
        "nothing from this briefing reaches the user",
        ctx.eval("vifor.decisions.filter((d) => d.action === 'review').length"),
        0,
    )

    # Rule 8: the rest of the same briefing goes too, including a finding that would otherwise have
    # been put to the user on its own merits (the HQ country moves the location priority).
    ctx.eval("""
      var whole = arbitrateAccount({
        proposals: [
          { key: "globalEmployees", label: "Employees (global)", found: 2600, current: 29904, state: "different" },
          { key: "globalRevenue", label: "Revenue (global)", found: 2234, current: 2234000000, state: "different" },
          { key: "globalHqCountry", label: "Headquarters country", found: "Germany", current: "Switzerland", state: "different" },
        ],
        extra: { overrides: {} },
        ctx: ctxFor({ hasRevenue: true, effective: { globalEmployees: 29904, globalRevenue: 2234000000 } }),
        settings: {},
      });
      var hq = whole.decisions.find((d) => d.proposal.key === "globalHqCountry");
    """)
    check("the rest of the briefing is discarded too", ctx.eval("hq.action"), "dismiss")
    check("...attributed to rule 8", ctx.eval("hq.rule"), 8)
    check(
        "so the whole account needs no attention at all",
        ctx.eval("whole.decisions.filter((d) => d.action === 'review').length"),
        0,
    )

    # With rule 8 off, that same finding is judged on its own merits again.
    ctx.eval("""
      var perField = arbitrateAccount({
        proposals: [
          { key: "globalRevenue", label: "Revenue (global)", found: 2234, current: 2234000000, state: "different" },
          { key: "globalHqCountry", label: "Headquarters country", found: "Germany", current: "Switzerland", state: "different" },
        ],
        extra: { overrides: {} },
        ctx: ctxFor({ hasRevenue: true, effective: { globalEmployees: 29904, globalRevenue: 2234000000 } }),
        settings: { rule8DiscardWholeBriefing: false },
      });
      var hq2 = perField.decisions.find((d) => d.proposal.key === "globalHqCountry");
    """)
    check("switching rule 8 off restores per-field judgement", ctx.eval("hq2.action"), "review")

    # But when the STORED value is the questionable one, a human is still needed - that is the case
    # where keeping what you have is not obviously right.
    ctx.eval("""
      var storedBad = arbitrateFinding(
        { key: "globalEmployees", label: "E", found: 4000, current: 0, state: "different" },
        ctxFor({ hasRevenue: true, effective: { globalEmployees: 0, globalRevenue: 5000000 } }),
        {});
    """)
    # 1.2.0.63 (Boaz, Coop): a sound web finding that repairs the stored value is applied, not asked.
    check("a sound web finding repairs an implausible STORED value", ctx.eval("storedBad.action"), "apply")
    check("...by rule 2", ctx.eval("storedBad.rule"), 2)

    # Still asked when the web finding does not repair it: Nestle before 1.2.0.62 - the stored REVENUE
    # (89,791, millions) is what is wrong, and the employee finding changes nothing about that.
    ctx.eval("""
      var nestle = arbitrateFinding(
        { key: "globalEmployees", label: "E", found: 271000, current: 308000, state: "different" },
        ctxFor({ hasRevenue: true, effective: { globalEmployees: 308000, globalRevenue: 89791, revenueCurrency: "CHF" } }),
        {});
    """)
    check("a finding that does not repair the stored problem still asks", ctx.eval("nestle.action"), "review")

    # Coop: 37,370 worldwide against 60,678 local stored; the web says 97,040 worldwide.
    ctx.eval("""
      var coop = arbitrateFinding(
        { key: "globalEmployees", label: "E", found: 97040, current: 37370, state: "different" },
        ctxFor({ hasRevenue: true, effective: { globalEmployees: 37370, swissEmployees: 60678, globalRevenue: 34900000000, revenueCurrency: "CHF" } }),
        {});
    """)
    check("Coop: the worldwide count that fixes local > worldwide is applied", ctx.eval("coop.action"), "apply")


def test_listing_revenue_in_millions(ctx):
    """1.2.0.61: a listing's "Revenue (USD millions)" column copied as 62030 becomes plain units."""
    check("Gunvor 62,030 with 1,600 staff -> 62.03 bn", num(ctx, "listingRevenue(62030, 1600)"), 62030000000)
    check("no employee count, under 1 m -> millions", num(ctx, "listingRevenue(850, null)"), 850000000)
    check("plain units stay", num(ctx, "listingRevenue(144000000000, 1600)"), 144000000000)
    check("a small firm's plain revenue stays", num(ctx, "listingRevenue(500000, 5)"), 500000)
    check("nothing stays nothing", ctx.eval("listingRevenue(null, 10)"), None)


def test_revenue_in_millions_is_named(ctx):
    """Gunvor, 1.2.0.59: 62,030 stored (millions, from a Wikipedia list), 144,000,000,000 found, 1,600 staff.

    The old text said "it implies 39 of revenue per employee" - Boaz: "39 what?". The current side must be
    named as written in millions, and the found side (90 million per employee - a commodity trader) must
    not be thrown out as implausible.
    """
    ctx.eval("""
      var gunvor = arbitrateAccount({
        proposals: [
          { key: "globalRevenue", label: "Revenue (global)", found: 144000000000, current: 62030, state: "different" },
        ],
        extra: { overrides: {} },
        ctx: ctxFor({ hasRevenue: true, effective: { globalEmployees: 1600, globalRevenue: 62030 } }),
        settings: {},
      });
      var g = gunvor.decisions[0];
    """)
    check("the found revenue is applied - the current one is the same figure in millions", ctx.eval("g.action"), "apply")
    check("...by rule 2", ctx.eval("g.rule"), 2)
    check("the reason names millions", "written in millions" in ctx.eval("JSON.stringify(g)"), True)
    check("no bare 'implies 39' text", "implies 39" in ctx.eval("JSON.stringify(g)"), False)


def test_employee_contradiction_does_not_taint_other_fields(ctx):
    """An account whose stored local headcount exceeds its global one had EVERY finding escalated.

    The cross-field check sat outside the employee guard, so a contradiction about headcount marked
    a city, a registry field or a currency as "your current value looks wrong" and rule 2 sent them
    all to the user.
    """
    ctx.eval("""
      var contradicted = ctxFor({ effective: { globalEmployees: 500, swissEmployees: 900 } });
      var city = arbitrateFinding(
        { key: "globalHqCity", label: "Headquarters city", found: "Zug", current: "Zurich", state: "different" },
        contradicted, {});
      var emp = arbitrateFinding(
        { key: "globalEmployees", label: "Employees (global)", found: 520, current: 500, state: "different" },
        contradicted, {});
    """)
    check("an unrelated field is decided, not escalated", ctx.eval("city.action"), "dismiss")
    check("...by the non-scoring rule, not the illogical one", ctx.eval("city.rule"), 3)
    check("the employee field itself still sees the contradiction", ctx.eval("emp.action"), "review")
    check("...via rule 2", ctx.eval("emp.rule"), 2)


def test_currency_is_never_put_to_the_user(ctx):
    """Asking someone to choose a currency code in isolation is a question with no meaning."""
    ctx.eval("""
      // A stored revenue of 115 against 29,904 employees is implausible, so the AMOUNT is escalated.
      var res = arbitrateAccount({
        proposals: [
          { key: "globalRevenue", label: "Revenue (global)", found: 400000000, current: 115, state: "different" },
          { key: "revenueCurrency", label: "Revenue currency", found: "CHF", current: "USD", state: "different" },
        ],
        extra: { overrides: {} },
        ctx: ctxFor({ hasRevenue: true, effective: { globalEmployees: 29904, globalRevenue: 115 } }),
        settings: {},
      });
      var amount = res.decisions.find((d) => d.proposal.key === "globalRevenue");
      var currency = res.decisions.find((d) => d.proposal.key === "revenueCurrency");
    """)
    # 1.2.0.63: the found 400,000,000 repairs the stored 115, so it is applied - and the currency follows it.
    check("the implausible stored amount is repaired by the web finding", ctx.eval("amount.action"), "apply")
    check("the currency follows the applied amount, never asked", ctx.eval("currency.action"), "apply")


def test_converted_comparison_is_judged_more_loosely(ctx):
    """MCH Group: 435,700,000 CHF stored as 480,000,000 USD - the same money at a rate of 1.102.

    At the default table's 1.25 they are 11.9% apart, which under the same-currency threshold made
    a finding out of an exchange-rate estimate. The implied rate across this dataset spans 1.10 to
    1.35, so the rate's own error exceeds the tight threshold and has to be allowed for.
    """
    ctx.eval("""
      var money = { targetCurrency: "USD", rates: DEFAULT_EXCHANGE_RATES };
      var mch = { globalRevenue: 480000000, revenueCurrency: "USD" };
      var mchFound = { revenueGlobal: 435700000, revenueCurrency: "CHF" };
      var mchProps = computeFindingProposals(mch, {}, mchFound, money).filter((p) => p.key === "globalRevenue");
    """)
    check("an exchange-rate artefact is not a finding", ctx.eval("mchProps.length"), 0)

    # A genuine cross-currency difference still surfaces: 200m CHF is 250m USD, less than half of
    # 600m USD, and no plausible rate closes that.
    ctx.eval("""
      var real = computeFindingProposals(
        { globalRevenue: 600000000, revenueCurrency: "USD" }, {},
        { revenueGlobal: 200000000, revenueCurrency: "CHF" }, money
      ).filter((p) => p.key === "globalRevenue");
    """)
    check("a real cross-currency difference still surfaces", ctx.eval("real.length"), 1)

    # And within one currency the tight threshold still applies - 15% apart is still a finding.
    ctx.eval("""
      var sameCcy = computeFindingProposals(
        { globalRevenue: 1000000, revenueCurrency: "USD" }, {},
        { revenueGlobal: 1176000, revenueCurrency: "USD" }, money
      ).filter((p) => p.key === "globalRevenue");
    """)
    check("same-currency comparisons keep the tight threshold", ctx.eval("sameCcy.length"), 1)


def test_rule9_global_is_a_copy_of_local(ctx):
    """Rhenus Alpina, from the real data.

    Stored worldwide employees 1,550 and stored LOCAL employees 1,550; stored worldwide revenue
    454,000,000 and stored local revenue 454,000,000 - both worldwide fields are just copies. The
    research matched BOTH local figures exactly, which proves it is describing the same company, and
    reported genuinely larger worldwide ones. So the worldwide figures are taken.
    """
    ctx.eval("""
      var rhenusStored = { globalEmployees: 1550, swissEmployees: 1550, globalRevenue: 454000000, swissRevenue: 454000000 };
      var rhenusData = { employeesGlobal: 39000, employeesLocal: 1550, revenueGlobal: 8200000000, revenueLocal: 454000000 };
      var rhenus = arbitrateAccount({
        proposals: [
          { key: "globalEmployees", label: "Employees (global)", found: 39000, current: 1550, state: "different" },
          { key: "globalRevenue", label: "Revenue (global)", found: 8200000000, current: 454000000, state: "different" },
        ],
        extra: { overrides: {} },
        ctx: ctxFor({ hasRevenue: true, effective: rhenusStored }),
        settings: {},
        data: rhenusData,
      });
      var rEmp = rhenus.decisions.find((d) => d.proposal.key === "globalEmployees");
      var rRev = rhenus.decisions.find((d) => d.proposal.key === "globalRevenue");
    """)
    check("the worldwide employee count is taken", ctx.eval("rEmp.action"), "apply")
    check("...by rule 9", ctx.eval("rEmp.rule"), 9)
    check("the worldwide revenue is taken too", ctx.eval("rRev.action"), "apply")
    check("...also by rule 9", ctx.eval("rRev.rule"), 9)
    check("and it is written into the patch", ctx.eval("rhenus.patch.overrides.globalEmployees"), 39000)

    # GUARD 1 - a purely domestic company. Its worldwide figure legitimately equals its local one,
    # and the research says so too, so there is nothing to take. This is what keeps a cantonal bank
    # safe from a rule designed for multinationals.
    ctx.eval("""
      var domestic = arbitrateAccount({
        proposals: [
          { key: "globalEmployees", label: "Employees (global)", found: 950, current: 900, state: "different" },
        ],
        extra: { overrides: {} },
        ctx: ctxFor({ effective: { globalEmployees: 900, swissEmployees: 900 } }),
        settings: {},
        data: { employeesGlobal: 950, employeesLocal: 900 },
      });
      var dEmp = domestic.decisions[0];
    """)
    check("a domestic company is left alone", ctx.eval("dEmp.action != 'apply'"), True)

    # GUARD 2 - the research does NOT match the stored local figure, so it is not corroborated as
    # the same company and nothing is taken on its word.
    ctx.eval("""
      var uncorroborated = arbitrateAccount({
        proposals: [
          { key: "globalEmployees", label: "Employees (global)", found: 39000, current: 1550, state: "different" },
        ],
        extra: { overrides: {} },
        ctx: ctxFor({ effective: { globalEmployees: 1550, swissEmployees: 1550 } }),
        settings: {},
        data: { employeesGlobal: 39000, employeesLocal: 2400 },
      });
      var uEmp = uncorroborated.decisions[0];
    """)
    check("an uncorroborated briefing is not applied", ctx.eval("uEmp.action != 'apply'"), True)

    # GUARD 3 - the stored worldwide figure is genuinely its own value, not a copy of the local one.
    ctx.eval("""
      var populated = arbitrateAccount({
        proposals: [
          { key: "globalEmployees", label: "Employees (global)", found: 39000, current: 20000, state: "different" },
        ],
        extra: { overrides: {} },
        ctx: ctxFor({ effective: { globalEmployees: 20000, swissEmployees: 1550 } }),
        settings: {},
        data: { employeesGlobal: 39000, employeesLocal: 1550 },
      });
      var pEmp = populated.decisions[0];
    """)
    check("a real stored worldwide figure is not overwritten", ctx.eval("pEmp.action != 'apply'"), True)

    # GUARD 4 - rule 8 outranks rule 9: one impossible number in the briefing and nothing is taken
    # from any of it, however well the rest corroborates.
    ctx.eval("""
      var poisoned = arbitrateAccount({
        proposals: [
          { key: "globalEmployees", label: "Employees (global)", found: 39000, current: 1550, state: "different" },
          { key: "globalRevenue", label: "Revenue (global)", found: 12, current: 454000000, state: "different" },
        ],
        extra: { overrides: {} },
        ctx: ctxFor({ hasRevenue: true, effective: { globalEmployees: 1550, swissEmployees: 1550, globalRevenue: 454000000, swissRevenue: 454000000 } }),
        settings: {},
        data: { employeesGlobal: 39000, employeesLocal: 1550, revenueGlobal: 12, revenueLocal: 454000000 },
      });
    """)
    check(
        "an implausible briefing overrides rule 9 entirely",
        ctx.eval("poisoned.decisions.every((d) => d.action !== 'apply')"),
        True,
    )

    # And with rule 9 switched off, the Rhenus case goes back to being the user's problem.
    ctx.eval("""
      var off = arbitrateAccount({
        proposals: [
          { key: "globalEmployees", label: "Employees (global)", found: 39000, current: 1550, state: "different" },
        ],
        extra: { overrides: {} },
        ctx: ctxFor({ effective: { globalEmployees: 1550, swissEmployees: 1550 } }),
        settings: { rule9TakeGlobalOverCopiedLocal: false },
        data: { employeesGlobal: 39000, employeesLocal: 1550 },
      });
    """)
    check("switching rule 9 off restores the old behaviour", ctx.eval("off.decisions[0].action != 'apply'"), True)

    # THE INVARIANT AT THE ACCOUNT LEVEL. The 512-combination sweep earlier covers arbitrateFinding,
    # one finding at a time - but rules 8 and 9 act on the whole account AFTER those decisions, and
    # that is precisely where rule 9 was found overruling rule 2 and writing a rejected value. Sweep
    # the account-level rules too.
    ctx.eval("""
      var leaked = [];
      var accountCombos = 0;
      for (const r2 of [true, false]) for (const r8 of [true, false])
      for (const r9 of [true, false]) for (const r10 of [true, false]) for (const r11 of [true, false])
      for (const pref of ["existing", "web"]) {
        accountCombos++;
        const out = arbitrateAccount({
          proposals: [
            { key: "globalEmployees", label: "E", found: 39000, current: 1550, state: "different" },
            { key: "globalRevenue", label: "R", found: 12, current: 454000000, state: "different" },
          ],
          extra: { overrides: {} },
          ctx: ctxFor({ hasRevenue: true, effective: { globalEmployees: 1550, swissEmployees: 1550, globalRevenue: 454000000, swissRevenue: 454000000 } }),
          settings: { rule2IllogicalReview: r2, rule8DiscardWholeBriefing: r8, rule9TakeGlobalOverCopiedLocal: r9, rule10PreferWebOverWeakEvidence: r10, rule11KeepGroupHqOverLocalEntity: r11, sourcePreference: pref },
          data: { employeesGlobal: 39000, employeesLocal: 1550, revenueGlobal: 12, revenueLocal: 454000000 },
        });
        const bad = out.decisions.find((d) => d.proposal.key === "globalRevenue" && d.action === "apply");
        if (bad) leaked.push(JSON.stringify({ r2: r2, r8: r8, r9: r9, r10: r10, r11: r11, pref: pref }));
      }
    """)
    check(
        "the impossible revenue is never written, under any account-level combination",
        ctx.eval("leaked.length"),
        0,
    )
    check("the account-level sweep really ran", ctx.eval("accountCombos"), 64)


def test_rule10_weakly_sourced_current_value(ctx):
    """Medartis Holding: a stored 747 recorded as "External source" against a web finding of 1,200
    taken from the company's own website. 148 of 277 stored employee counts in this workbook carry
    that same confidence, so this is a dataset-wide pattern rather than one account.
    """
    ctx.eval("""
      var weak = { globalEmployees: 747, globalEmployeesConfidence: "External source" };
      var medartis = arbitrateFinding(
        { key: "globalEmployees", label: "Employees (global)", found: 1200, current: 747, state: "different" },
        ctxFor({ effective: weak }), {});
      var viaAccount = arbitrateAccount({
        proposals: [{ key: "globalEmployees", label: "E", found: 1200, current: 747, state: "different" }],
        extra: { overrides: {} }, ctx: ctxFor({ effective: weak }), settings: {},
        data: { employeesGlobal: 1200 },
      }).decisions[0];
    """)
    check("on its own the band change is still a question", ctx.eval("medartis.action"), "review")
    check("but the account-level rule answers it", ctx.eval("viaAccount.action"), "apply")
    check("...by rule 10", ctx.eval("viaAccount.rule"), 10)

    # A properly evidenced current value still goes to the user.
    for confidence in ["Reported / official company source",
                       "External database / S&P Global or company annual report",
                       "Validated global parent figure; official reporting or S&P Global-backed database"]:
        ctx.eval("""
          var strong = arbitrateAccount({
            proposals: [{ key: "globalEmployees", label: "E", found: 1200, current: 747, state: "different" }],
            extra: { overrides: {} },
            ctx: ctxFor({ effective: { globalEmployees: 747, globalEmployeesConfidence: %r } }),
            settings: {}, data: { employeesGlobal: 1200 },
          }).decisions[0];
        """ % confidence)
        check("a well-evidenced current value still asks (%s)" % confidence[:28], ctx.eval("strong.action"), "review")

    # No confidence recorded at all is not evidence of weakness.
    ctx.eval("""
      var unknown = arbitrateAccount({
        proposals: [{ key: "globalEmployees", label: "E", found: 1200, current: 747, state: "different" }],
        extra: { overrides: {} }, ctx: ctxFor({ effective: { globalEmployees: 747 } }),
        settings: {}, data: { employeesGlobal: 1200 },
      }).decisions[0];
    """)
    check("an unrecorded provenance still asks", ctx.eval("unknown.action"), "review")

    # And an implausible web finding is never taken, however weak the current value's evidence.
    ctx.eval("""
      var junk = arbitrateAccount({
        proposals: [{ key: "globalEmployees", label: "E", found: 0, current: 747, state: "different" }],
        extra: { overrides: {} },
        ctx: ctxFor({ hasRevenue: true, effective: { globalEmployees: 747, globalRevenue: 90000000, globalEmployeesConfidence: "External source" } }),
        settings: {}, data: { employeesGlobal: 0 },
      }).decisions[0];
    """)
    check("an implausible web finding is never taken by rule 10", ctx.eval("junk.action != 'apply'"), True)

    # Switched off, the question comes back.
    ctx.eval("""
      var off = arbitrateAccount({
        proposals: [{ key: "globalEmployees", label: "E", found: 1200, current: 747, state: "different" }],
        extra: { overrides: {} },
        ctx: ctxFor({ effective: { globalEmployees: 747, globalEmployeesConfidence: "External source" } }),
        settings: { rule10PreferWebOverWeakEvidence: false }, data: { employeesGlobal: 1200 },
      }).decisions[0];
    """)
    check("switching rule 10 off restores the question", ctx.eval("off.action"), "review")


def test_rule11_group_hq_over_local_entity(ctx):
    """Bayer (Schweiz) AG, Moderna Switzerland, Lidl Schweiz: the research reports the Swiss
    subsidiary's seat as "HQ country", while the account holds the group's. Location tiers in ctxFor
    put Switzerland at 3 and Germany at 2, so on its own rule 7 asks.
    """
    ctx.eval("""
      var hq = (current, found, settings) => arbitrateAccount({
        proposals: [{ key: "globalHqCountry", label: "HQ", found: found, current: current, state: "different" }],
        extra: { overrides: {} }, ctx: ctxFor(), settings: settings || {}, data: { hqCountry: found },
      }).decisions[0];
      var bayer = hq("Germany", "Switzerland");
      var alone = arbitrateFinding({ key: "globalHqCountry", label: "HQ", found: "Switzerland", current: "Germany", state: "different" }, ctxFor(), {});
      var reverse = hq("Switzerland", "Germany");
      var webFirst = hq("United States", "Switzerland", { sourcePreference: "web", rule7LocationTierReview: false });
      var off = hq("Germany", "Switzerland", { rule11KeepGroupHqOverLocalEntity: false });
      var german = hq("Germany", "Schweiz");
    """)
    check("on its own rule 7 would ask", ctx.eval("alone.action"), "review")
    check("the group's country is kept", ctx.eval("bayer.action"), "dismiss")
    check("...by rule 11", ctx.eval("bayer.rule"), 11)
    check("Switzerland stored, abroad found - still asks", ctx.eval("reverse.action"), "review")
    check("a web-first preference cannot write the subsidiary's country", ctx.eval("webFirst.action"), "dismiss")
    check("the German spelling is recognised", ctx.eval("german.rule"), 11)
    check("switching rule 11 off restores the question", ctx.eval("off.action"), "review")

    # The account's own Local / Global classification decides first, in both directions.
    ctx.eval("""
      var typed = (type, current, found, field) => arbitrateAccount({
        proposals: [{ key: "globalHqCountry", label: "HQ", found: found, current: current, state: "different" }],
        extra: { overrides: {} }, ctx: ctxFor({ effective: { [field || "companyType"]: type } }), settings: {},
        data: { hqCountry: found },
      }).decisions[0];
      var gKeep = typed("International company", "Germany", "Switzerland");
      var gTake = typed("International company – Swiss subsidiary", "Switzerland", "Germany");
      var lKeep = typed("Swiss company", "Switzerland", "Germany");
      var lTake = typed("Local company", "Germany", "Switzerland", "targetCountryRelationship");
      var bothAbroad = typed("International company", "Germany", "United States");
      var unknownType = typed("National tourism organization / public-law corporation", "Switzerland", "Germany");
    """)
    check("Global: the foreign current country is kept", ctx.eval("gKeep.action + gKeep.rule"), "dismiss11")
    check("Global: a Swiss current country is replaced by the foreign finding", ctx.eval("gTake.action + gTake.rule"), "apply11")
    check("Local: Switzerland is kept", ctx.eval("lKeep.action + lKeep.rule"), "dismiss11")
    check("Local (schema 1.1 field): Switzerland is taken", ctx.eval("lTake.action + lTake.rule"), "apply11")
    check("Global with two foreign countries proves nothing - still asks", ctx.eval("bothAbroad.action"), "review")
    check("an unrecognised classification falls back to the country pair", ctx.eval("unknownType.action"), "review")


def test_patch_shape(ctx):
    """Clearing an override must OMIT the key - a present-but-null override hides the row's data."""
    ctx.eval("""
      var res = arbitrateAccount({
        proposals: [
          { key: "globalRevenue", label: "Revenue", found: 500000, current: null, state: "new" },
          { key: "globalHqCity", label: "HQ city", found: "Zug", current: "Zurich", state: "different" },
        ],
        extra: { overrides: { globalEmployees: 4000 } },
        ctx: ctxFor(),
        settings: {},
      });
    """)
    check("existing overrides survive", ctx.eval("res.patch.overrides.globalEmployees"), 4000)
    check("the applied value is written", ctx.eval("res.patch.overrides.globalRevenue"), 500000)
    check(
        "no null is ever written into overrides",
        ctx.eval("Object.values(res.patch.overrides).some((v) => v === null)"),
        False,
    )
    check(
        "the kept value is recorded as dismissed",
        ctx.eval("res.patch.webFindingsDismissed.globalHqCity"),
        "Zug",
    )


def test_readiness(ctx):
    """readiness.js - the one definition of Ready (DATA_PIPELINE_DESIGN.md section 3)."""
    ctx.eval(r"""
    var NOW = Date.UTC(2026, 8, 25);
    var DAY = 86400000;
    var LINK = "https://www.linkedin.com/company/nestle-s-a/";
    // Targeting that weighs location and size but leaves industry at medium: industry is then not required.
    var CFG = {
      locationPriorities: { Switzerland: 3, Germany: 2 },
      sizeBuckets: { large: { priority: 3 }, small: { priority: 2 } },
      industries: [{ name: "Banking", priority: 2 }],
      seniorityLevels: [{ id: "cxo", priority: 3 }],
    };
    function readyView(patch) {
      var v = {
        key: "nestle", company: "Nestle", source: "Imported",
        linkedinCompanyId: "1234", linkedinLink: LINK, salesTeamPriority: "P2",
        globalHqCountry: "Switzerland", globalEmployees: 270000, swissEmployees: null, industry: "Food",
        evidenceStatus: "Rich Evidence", lastVerified: null, deleted: false, excluded: false, importedAt: NOW - 30 * DAY,
        provenance: {
          linkedinCompanyId: { src: "linkedin", at: NOW - 10 * DAY, link: LINK, v: "1234" },
          globalHqCountry: { src: "workbook", at: NOW - 30 * DAY, evidence: "Rich Evidence", v: "Switzerland" },
          globalEmployees: { src: "linkedin", at: NOW - 10 * DAY, v: 270000 },
        },
        contacts: [{ fullName: "A B", relevant: true, linkedinUrl: "https://www.linkedin.com/in/ab/", verifiedAt: NOW - 20 * DAY }],
      };
      for (var k in (patch || {})) v[k] = patch[k];
      return v;
    }
    function withProv(field, p) { var v = readyView(); v.provenance[field] = p; return v; }
    function state(v) { return assessAccount(v, CFG, NOW).state; }
    function missingFields(v) { return assessAccount(v, CFG, NOW).missing.map(function (m) { return m.field + ":" + m.reason; }).join(","); }
    """)

    check("required fields follow the targeting (industry at medium is not required)",
          ctx.eval("requiredFields(CFG).join(',')"), "linkedinCompanyId,salesTeamPriority,globalHqCountry,employees,contact")
    check("everything medium: only id, priority, contact required",
          ctx.eval("requiredFields({ locationPriorities: { CH: 2 }, sizeBuckets: {}, industries: [] }).join(',')"),
          "linkedinCompanyId,salesTeamPriority,contact")

    check("a fully verified account is Ready", ctx.eval("state(readyView())"), "ready")

    # The id re-check rule: the id counts only once read off the very page the link points to.
    check("id with no record of the page it was read from is not verified",
          ctx.eval("missingFields(withProv('linkedinCompanyId', { src: 'linkedin', at: NOW, link: null, v: '1234' }))"),
          "linkedinCompanyId:unverified")
    check("...and the account is Usable, not Ready (it can still be scanned)",
          ctx.eval("state(withProv('linkedinCompanyId', { src: 'linkedin', at: NOW, link: null, v: '1234' }))"),
          "usable")
    check("a link changed since the id was checked makes the id unverified",
          ctx.eval("missingFields(readyView({ linkedinLink: 'https://www.linkedin.com/company/other-co/' }))"),
          "linkedinCompanyId:unverified")
    check("link variants of the same page still match (case, /about/, no www)",
          ctx.eval("state(readyView({ linkedinLink: 'https://linkedin.com/company/Nestle-S-A/about/' }))"), "ready")
    check("an id whose stored provenance was for a different id is re-derived, and unverified",
          ctx.eval("var d = deriveProvenance(readyView({ linkedinCompanyId: '999' }), 'linkedinCompanyId', {}, NOW); d.src + '|' + d.link"),
          "linkedin|null")
    check("a Discovered row's id comes with its own link, so it is verified",
          ctx.eval("var v = readyView({ source: 'Discovered' }); delete v.provenance.linkedinCompanyId; "
                   "v.provenance.linkedinCompanyId = deriveProvenance(v, 'linkedinCompanyId', {}, NOW); state(v)"),
          "ready")

    check("id older than 12 months is expired",
          ctx.eval("missingFields(withProv('linkedinCompanyId', { src: 'linkedin', at: NOW - 400 * DAY, link: LINK, v: '1234' }))"),
          "linkedinCompanyId:expired")
    check("headcount older than 6 months is expired",
          ctx.eval("missingFields(withProv('globalEmployees', { src: 'linkedin', at: NOW - 200 * DAY, v: 270000 }))"),
          "employees:expired")
    check("workbook value with Provisional evidence is not verified",
          ctx.eval("missingFields(withProv('globalHqCountry', { src: 'workbook', at: NOW, evidence: 'Provisional Evidence', v: 'Switzerland' }))"),
          "globalHqCountry:unverified")
    check("uncited web value is not verified",
          ctx.eval("missingFields(withProv('globalEmployees', { src: 'web', at: NOW, cited: false, v: 270000 }))"),
          "employees:unverified")
    check("a manual edit counts as verified (D2)",
          ctx.eval("state(withProv('globalEmployees', { src: 'user', at: NOW, v: 270000 }))"),
          "ready")
    check("stored provenance for a value that has since changed is ignored",
          ctx.eval("missingFields(readyView({ globalEmployees: 5000 }))"),
          "employees:unverified")
    check("a missing global count falls back to the local one ('6,500+' counts as present)",
          ctx.eval("var v = readyView({ globalEmployees: null, swissEmployees: '6,500+' }); v.provenance.swissEmployees = { src: 'linkedin', at: NOW, v: '6,500+' }; state(v)"),
          "ready")

    check("no relevant contact",
          ctx.eval("missingFields(readyView({ contacts: [{ relevant: false, linkedinUrl: 'https://www.linkedin.com/in/x/', verifiedAt: NOW }] }))"),
          "contact:absent")
    check("relevant contact without a LinkedIn profile",
          ctx.eval("missingFields(readyView({ contacts: [{ relevant: true, linkedinUrl: null, verifiedAt: NOW }] }))"),
          "contact:unverified")
    check("relevant contact checked 7 months ago",
          ctx.eval("missingFields(readyView({ contacts: [{ relevant: true, linkedinUrl: 'https://www.linkedin.com/in/x/', verifiedAt: NOW - 213 * DAY }] }))"),
          "contact:expired")

    check("no LinkedIn id: In progress", ctx.eval("state(readyView({ linkedinCompanyId: null }))"), "in_progress")
    check("no priority: In progress", ctx.eval("state(readyView({ salesTeamPriority: null }))"), "in_progress")
    check("scope P2 excludes a P3", ctx.eval("isScannable(readyView({ salesTeamPriority: 'P3' }), 'P2')"), False)
    check("scope all includes a P5", ctx.eval("isScannable(readyView({ salesTeamPriority: 'P5' }), 'all')"), True)
    check("deleted is never scannable (old scope-all gap)", ctx.eval("isScannable(readyView({ deleted: true }), 'all')"), False)
    check("excluded is never scannable", ctx.eval("isScannable(readyView({ excluded: true }), 'all')"), False)

    # Design 3.4: every account assessAccount calls Ready or Usable is one the Scanner accepts.
    check("Ready/Usable is always scannable (fixture sweep)", ctx.eval("""
      var patches = [{}, { linkedinCompanyId: null }, { salesTeamPriority: null }, { salesTeamPriority: 'P5' },
        { deleted: true }, { excluded: true }, { contacts: [] }, { linkedinLink: null }, { globalEmployees: null },
        { globalHqCountry: null, salesTeamPriority: 'P4' }, { linkedinCompanyId: '', salesTeamPriority: 'P1' }];
      patches.every(function (p) {
        var v = readyView(p), a = assessAccount(v, CFG, NOW);
        return (a.state !== 'ready' && a.state !== 'usable') || isScannable(v, 'all');
      })"""), True)

    for label, expected in [("C-level / Group", "cLevel"), ("Chief Digital & Information Officer", "cLevel"),
                            ("Board member", "board"), ("SVP", "vp"), ("Vice President", "vp"), ("Head-level", "head"),
                            ("Director", "director"), ("Senior Manager", "manager"), ("Specialist", None), ("", None)]:
        check("seniority label %r" % label, ctx.eval("seniorityLevelFromLabel(%r)" % label), expected)

    check("Excel serial date", ctx.eval("toEpochMs(46000) === Date.UTC(2025, 11, 9)"), True)
    check("dd.mm.yyyy date", ctx.eval("toEpochMs('24.09.2026') === Date.UTC(2026, 8, 24)"), True)
    check("derived workbook provenance uses Last_Verified, else the import date (D6)",
          ctx.eval("deriveProvenance(readyView({ lastVerified: '2026-09-01' }), 'globalHqCountry', {}, NOW).at === Date.UTC(2026, 8, 1) && "
                   "deriveProvenance(readyView(), 'globalHqCountry', {}, NOW).at === NOW - 30 * DAY"), True)
    check("derived override with cited web research is web, cited",
          ctx.eval("var p = deriveProvenance(readyView(), 'globalEmployees', { overridden: { globalEmployees: true }, webResearch: { at: 5e12, sources: ['x'] } }, NOW); p.src + '|' + p.cited"),
          "web|true")


def test_pipeline_plan(ctx):
    """pipeline-plan.js - which job an account needs, and whether a LinkedIn answer is accepted (design 5, T1-T4).
    Reuses test_readiness's readyView/CFG/NOW."""
    # Names (T1)
    check("name match ignores accents, umlaut spelling, titles and middle names",
          ctx.eval("namesMatch('Dr. Hans-Peter Mueller, PhD', 'Hans Müller')"), True)
    check("name match needs the last name too", ctx.eval("namesMatch('Hans Meier', 'Hans Müller')"), False)
    check("a one-word known name never matches", ctx.eval("namesMatch('Anna Muster', 'Anna')"), False)
    check("exactly one matching person is accepted",
          ctx.eval("pickProfileMatch([{slug:'a', name:'Anna Muster'}, {slug:'b', name:'Beat Keller'}], 'Anna Muster').status"), "found")
    check("the same person twice (same slug) is still one",
          ctx.eval("pickProfileMatch([{slug:'a', name:'Anna Muster'}, {slug:'a', name:'Anna Muster'}], 'Anna Muster').status"), "found")
    check("two different people with the name are never guessed",
          ctx.eval("pickProfileMatch([{slug:'a', name:'Anna Muster'}, {slug:'b', name:'Anna M. Muster'}], 'Anna Muster').status"), "ambiguous")
    check("a match whose headline names only another company is dropped",
          ctx.eval("pickProfileMatch([{slug:'a', name:'Anna Muster', conflict:true}], 'Anna Muster').status"), "none")

    # Size bands (T3 touch-up)
    check("band parsed", ctx.eval("JSON.stringify(parseSizeBand('1,001-5,000'))"), '{"lo":1001,"hi":5000}')
    check("open band parsed", ctx.eval("parseSizeBand('10,001+ employees').hi === Infinity"), True)
    check("a count inside the band is confirmed, not overwritten", ctx.eval("sizeVerdict('6,500+', parseSizeBand('5,001-10,000'))"), "confirm")
    check("a count outside the band is replaced", ctx.eval("sizeVerdict(300, parseSizeBand('1,001-5,000'))"), "replace")
    check("no count is filled", ctx.eval("sizeVerdict(null, parseSizeBand('11-50'))"), "fill")

    # Jobs (5.1, T1, T2)
    ctx.eval(r"""
    function jobsOf(v, pipeline) { return jobsNeeded(v, assessAccount(v, CFG, NOW), pipeline || {}, NOW).join(','); }
    var OLD_ID = withProv('linkedinCompanyId', { src: 'linkedin', at: NOW - 10 * DAY, v: '1234' });   // no link recorded
    """)
    check("a Ready account needs nothing", ctx.eval("jobsOf(readyView())"), "")
    check("an id not re-checked needs resolve (T2)", ctx.eval("jobsOf(OLD_ID)"), "resolve")
    check("a known contact with no profile needs the profile job, not discovery (T1)",
          ctx.eval("jobsOf(readyView({ contacts: [{ fullName: 'Anna Muster', relevant: true, linkedinUrl: 'https://news.ch/x', verifiedAt: NOW }] }))"), "profile")
    check("once every known contact was searched, discovery takes over",
          ctx.eval("jobsOf(readyView({ contacts: [{ fullName: 'Anna Muster', relevant: true, linkedinUrl: null }] }), { profileTried: ['Anna Müster'] })"), "contacts")
    check("no relevant contact at all needs discovery",
          ctx.eval("jobsOf(readyView({ contacts: [] }))"), "contacts")
    check("discovery that failed on 2 different days stops",
          ctx.eval("jobsOf(readyView({ contacts: [] }), { attempts: { contacts: ['2026-09-23', '2026-09-24'] } })"), "")
    check("two failures on the same day do not count as two days",
          ctx.eval("jobsOf(readyView({ contacts: [] }), { attempts: { contacts: withFailedAttempt({ attempts: { contacts: ['2026-09-24'] } }, 'contacts', '2026-09-24').contacts } })"), "contacts")
    check("unverified employees needs size",
          ctx.eval("jobsOf(withProv('globalEmployees', { src: 'workbook', at: NOW, evidence: 'Weak', v: 270000 }))"), "size")
    check("re-check and size together are one visit (T3)",
          ctx.eval("var v = withProv('globalEmployees', { src: 'workbook', at: NOW, evidence: 'Weak', v: 270000 }); v.provenance.linkedinCompanyId = OLD_ID.provenance.linkedinCompanyId; "
                   "var j = jobsNeeded(v, assessAccount(v, CFG, NOW), {}, NOW); j.join(',') + '|' + estimateTouches(j, v, 2)"), "resolve,size|1")

    # Order (5.3)
    check("P1 before P2, then fewest touches, and an account handled today is skipped",
          ctx.eval(r"""
          var a = readyView({ key: 'a', salesTeamPriority: 'P2', contacts: [] });
          var b = readyView({ key: 'b', salesTeamPriority: 'P1', contacts: [] });
          var c = OLD_ID; c.key = 'c'; c.salesTeamPriority = 'P2';
          var d = readyView({ key: 'd', salesTeamPriority: 'P1', contacts: [] });
          rankCandidates([a, b, c, d].map(function (v) {
            return { view: v, assessment: assessAccount(v, CFG, NOW), pipeline: v.key === 'd' ? { lastRunDay: localDay(NOW) } : {} };
          }), NOW, 2).map(function (e) { return e.view.key; }).join(',')"""), "b,c,a")


def test_auto_run_blocker(ctx):
    """pipeline-plan.js autoRunBlocker - when an automatic run may start (build step 3, U1-U5)."""
    ctx.eval(r"""
    var H = 3600000;
    function blk(o) {
      var base = { enabled: true, pausedDay: null, today: '2026-09-25', holdUntil: 0, runningBatch: null,
                   touches24h: 10, lastBackupAt: NOW - 2 * H, now: NOW };
      for (var k in o) base[k] = o[k];
      return autoRunBlocker(base);
    }
    """)
    check("all clear: may start", ctx.eval("blk({})"), None)
    check("off until the user turns it on", ctx.eval("blk({ enabled: false })"), "off")
    check("paused by the user for today", ctx.eval("blk({ pausedDay: '2026-09-25' })"), "paused_today")
    check("a pause from yesterday no longer holds", ctx.eval("blk({ pausedDay: '2026-09-24' })"), None)
    check("making way for a user's job (U2)", ctx.eval("blk({ holdUntil: NOW + 60000 })"), "hold")
    check("another batch is running", ctx.eval("blk({ runningBatch: { label: 'Scanner' } })"), "busy")
    check("stops at the ceiling", ctx.eval("blk({ touches24h: PIPELINE_TOUCH_CEILING })"), "budget")
    check("one below the ceiling may start", ctx.eval("blk({ touches24h: PIPELINE_TOUCH_CEILING - 1 })"), None)
    check("no backup at all waits for a page (U1)", ctx.eval("blk({ lastBackupAt: 0 })"), "no_backup")
    check("a backup older than 24 hours waits for a page (U1)", ctx.eval("blk({ lastBackupAt: NOW - 25 * H })"), "no_backup")


def test_web_lane(ctx):
    """Build step 5 (W1-W8): which web research an account gets, the budget, confirmation, the W7 state.
    Reuses test_readiness's readyView/withProv/CFG/NOW."""
    ctx.eval(r"""
    function wjobs(v, pipeline, opts) { return jobsNeeded(v, assessAccount(v, CFG, NOW), pipeline || {}, NOW, opts || { web: true }).join(','); }
    function noEmp(p) { var v = readyView(p); v.globalEmployees = null; delete v.provenance.globalEmployees; return v; }
    var WEAK_HQ = { src: 'workbook', at: NOW, evidence: 'Weak', v: 'Switzerland' };
    """)
    check("a Ready P2 account never researched gets a full research, last", ctx.eval("wjobs(readyView())"), "web_full")
    check("web off: no research job", ctx.eval("wjobs(readyView(), {}, { web: false })"), "")
    check("a full research from 10 days ago covers it",
          ctx.eval("wjobs(readyView({ webFullResearchAt: NOW - 10 * DAY }))"), "")
    check("a full research older than 12 months is repeated",
          ctx.eval("wjobs(readyView({ webFullResearchAt: NOW - 400 * DAY }))"), "web_full")
    check("P4 is never researched automatically", ctx.eval("wjobs(readyView({ salesTeamPriority: 'P4' }))"), "")
    check("missing headcount, P2: one full research, FIRST, before the size visit (D3)",
          ctx.eval("wjobs(noEmp())"), "web_full,size")
    check("missing headcount, unscored: a short research first",
          ctx.eval("wjobs(noEmp({ salesTeamPriority: null }))"), "web_gap,size")
    check("the short research asks only for the headcount",
          ctx.eval("var v = noEmp({ salesTeamPriority: null }); JSON.stringify(webPlan(v, assessAccount(v, CFG, NOW), {}, NOW, ['size']).topics)"), '["employees"]')
    check("no headcount research when the resolver visits the page anyway (size rides along)",
          ctx.eval("var v = noEmp({ salesTeamPriority: null }); v.provenance.linkedinCompanyId = { src: 'linkedin', at: NOW, v: '1234' }; wjobs(v)"), "resolve,size")
    check("an unverified HQ country is a gap only the web closes",
          ctx.eval("var v = withProv('globalHqCountry', WEAK_HQ); v.salesTeamPriority = null; wjobs(v)"), "web_gap")
    check("a short research is not repeated within 12 months",
          ctx.eval("var v = withProv('globalHqCountry', WEAK_HQ); v.salesTeamPriority = null; wjobs(v, { webGapAt: { headquarters: NOW - 5 * DAY } })"), "")
    check("a web research that failed on 2 days stops",
          ctx.eval("wjobs(readyView(), { attempts: { web_full: ['2026-09-20', '2026-09-21'] } })"), "")
    check("LinkedIn budget used up: only web work remains (W1)",
          ctx.eval("wjobs(noEmp(), {}, { web: true, linkedin: false })"), "web_full")
    check("a LinkedIn company already used elsewhere stops everything until answered (W7)",
          ctx.eval("wjobs(noEmp(), { idTaken: { pageId: '9' } })"), "")
    check("'Different company' stops the name search, not the rest",
          ctx.eval("var v = readyView(); v.provenance.linkedinCompanyId = { src: 'linkedin', at: NOW, v: '1234' }; wjobs(v, { idTaken: { pageId: '9', kept: true } }, { web: false })"), "")
    check("gap work before depth, whatever the priority (W2)",
          ctx.eval(r"""
          var deep = readyView({ key: 'deep', salesTeamPriority: 'P1' });
          var gapv = noEmp({ key: 'gap', salesTeamPriority: 'P3' });
          rankCandidates([deep, gapv].map(function (v) { return { view: v, assessment: assessAccount(v, CFG, NOW), pipeline: {} }; }),
            NOW, 2, { web: true }).map(function (e) { return e.view.key + (e.depthOnly ? '*' : ''); }).join(',')"""), "gap,deep*")
    check("web research visits no LinkedIn page", ctx.eval("estimateTouches(['web_full', 'size'], readyView(), 2)"), 1)

    # Budget (W3, W6)
    ctx.eval(r"""
    function wb(o) {
      var base = { enabled: true, hasKey: true, monthlyUsd: 10, spentUsd: 2, nextCostUsd: 0.09, blocked: null, today: '2026-09-27' };
      for (var k in o) base[k] = o[k];
      return webBudgetBlocker(base);
    }
    """)
    check("budget: may research", ctx.eval("wb({})"), None)
    check("budget: off until consented", ctx.eval("wb({ enabled: false })"), "off")
    check("budget: no API key", ctx.eval("wb({ hasKey: false })"), "no_key")
    check("budget: zero is stated", ctx.eval("wb({ monthlyUsd: 0 })"), "zero")
    check("budget: the next research must still fit (never exceeded)", ctx.eval("wb({ spentUsd: 9.95 })"), "used_up")
    check("budget: exactly fitting is allowed", ctx.eval("wb({ spentUsd: 9.91 })"), None)
    check("budget: empty API credit holds for the day", ctx.eval("wb({ blocked: { reason: 'credit', day: '2026-09-27' } })"), "credit")
    check("budget: yesterday's refusal no longer holds", ctx.eval("wb({ blocked: { reason: 'limit', day: '2026-09-26' } })"), None)
    check("month key", ctx.eval("monthKey(new Date(2026, 8, 30).getTime())"), "2026-09")
    check("at the LinkedIn ceiling a run may still start for web work (W1)",
          ctx.eval("autoRunBlocker({ enabled: true, today: 'x', touches24h: PIPELINE_TOUCH_CEILING, lastBackupAt: NOW, now: NOW, webPossible: true })"), None)

    # Confirmation by an agreeing research
    check("research agreeing on HQ and within 10% on headcount confirms both",
          ctx.eval("researchConfirms({ globalHqCountry: 'Switzerland', globalEmployees: 1000 }, {}, { hqCountry: 'switzerland', employeesGlobal: 1050 }, null, ['globalEmployees', 'globalHqCountry']).join(',')"),
          "globalEmployees,globalHqCountry")
    check("a disagreeing headcount confirms nothing (it is a finding)",
          ctx.eval("researchConfirms({ globalHqCountry: 'Switzerland', globalEmployees: 1000 }, {}, { hqCountry: 'Switzerland', employeesGlobal: 5000 }, null, ['globalEmployees']).join(',')"), "")
    check("an empty field is filled, not confirmed",
          ctx.eval("researchConfirms({ globalHqCountry: null }, {}, { hqCountry: 'Switzerland' }, null, ['globalHqCountry']).length"), 0)
    check("confirmation reads the override, not the workbook value",
          ctx.eval("researchConfirms({ globalHqCountry: 'Germany' }, { globalHqCountry: 'Switzerland' }, { hqCountry: 'Switzerland' }, null, ['globalHqCountry']).join(',')"), "globalHqCountry")

    # W7 / inputs change
    check("new inputs clear a waiting LinkedIn-company question and the short-research dates",
          ctx.eval("var p = effectivePipeline({ inputsKey: 'a', idTaken: { pageId: '9' }, webGapAt: { employees: 1 } }, 'b'); String(p.idTaken) + '|' + Object.keys(p.webGapAt).length"), "null|0")
    check("the account context is built the same for the page and the background",
          ctx.eval("var c = arbitrationContext({ globalRevenue: 5, employeeCountText: '11-50' }, { overrides: { globalRevenue: 0 } }, { buckets: [], locationTier: null, contactCount: 3 }); c.hasRevenue + '|' + c.contactCount + '|' + c.employeesFromLinkedin"),
          "false|3|true")


def test_decision_rules(ctx):
    """decision-rules.js - build step 4 (V1-V8): changed pages, empty pages, Lacking evidence, duplicates."""
    # LinkedIn's page titles, as the resolver read them on 2026-09-26 (Activity Log)
    check("cleanPageName Overview", ctx.eval('cleanPageName("Stadler: Overview")'), "Stadler")
    check("cleanPageName full title", ctx.eval('cleanPageName("(3) SIG Group: Overview | LinkedIn")'), "SIG Group")
    check("cleanPageName old About", ctx.eval('cleanPageName("Comet | About | LinkedIn")'), "Comet")
    real = [
        ("Stadler Rail", "Stadler: Overview"),
        ("Sunrise Communications AG", "Sunrise: Overview"),
        ("SIG Combibloc", "SIG Group: Overview"),
        ("Forbo Holding", "Forbo Group: Overview"),
        ("Medacta Group", "Medacta International: Overview"),
        ("Bystronic AG", "Bystronic Group: Overview"),
        ("Valiant Holding", "Valiant Bank AG: Overview"),
        ("Cembra Money Bank", "Cembra: Overview"),
        ("Comet Holding", "Comet: Overview"),
        ("SKAN Group", "SKAN: Overview"),
    ]
    for name, page in real:
        check("pageNamesAgree %s / %s" % (name, page), ctx.eval('pageNamesAgree(["%s"], "%s")' % (name, page)), True)
    wrong = [
        ("Zurich Insurance Group", "Zurich Airport: Overview"),
        ("Swiss Life", "Swiss Re: Overview"),
        ("Holcim Group", "Amrize: Overview"),
        ("UBS Group", "UBS Switzerland AG: Overview"),
        ("Nestle", ""),
    ]
    for name, page in wrong:
        check("pageNamesAgree rejects %s / %s" % (name, page), ctx.eval('pageNamesAgree(["%s"], "%s")' % (name, page)), False)
    check("pageNamesAgree two generic words", ctx.eval('pageNamesAgree(["Swiss Life Holding"], "Swiss Life: Overview")'), True)
    check("pageNamesAgree any known name", ctx.eval('pageNamesAgree(["Amrize", "Holcim Group"], "Holcim: Overview")'), True)

    check("isEmptyPageBand 0-1", ctx.eval('isEmptyPageBand("0-1 employees")'), True)
    check("isEmptyPageBand 2-10", ctx.eval('isEmptyPageBand("2-10 employees")'), False)
    check("isEmptyPageBand none", ctx.eval('isEmptyPageBand(null)'), False)

    # retry when something new arrives (R12.5.2)
    check("inputs key stable", ctx.eval('accountInputsKey(["a", 1, null]) === accountInputsKey(["a", 1, null])'), True)
    check("inputs key changes", ctx.eval('accountInputsKey(["a", 1]) === accountInputsKey(["a", 2])'), False)
    check("effectivePipeline same key keeps attempts",
          ctx.eval('effectivePipeline({ attempts: { resolve: ["2026-09-25"] }, inputsKey: "k" }, "k").attempts.resolve.length'), 1)
    check("effectivePipeline new key forgets attempts",
          ctx.eval('Object.keys(effectivePipeline({ attempts: { resolve: ["2026-09-25"] }, keep: true, inputsKey: "old" }, "k").attempts).length'), 0)
    check("effectivePipeline new key forgets keep",
          ctx.eval('effectivePipeline({ attempts: {}, keep: true, inputsKey: "old" }, "k").keep'), False)
    check("effectivePipeline pre-step-4 state is retried once",
          ctx.eval('Object.keys(effectivePipeline({ attempts: { resolve: ["2026-09-25", "2026-09-26"] } }, "k").attempts).length'), 0)
    check("effectivePipeline nothing to forget", ctx.eval('effectivePipeline({ lastRunDay: "2026-09-26" }, "k").lastRunDay'), "2026-09-26")

    # Lacking evidence (R12.5)
    check("lacking: empty page", ctx.eval('lackingReason({ linkedinCompanyId: "1" }, { emptyPage: "2026-09-27" }).reason'), "empty_page")
    check("lacking: no id, gave up",
          ctx.eval('lackingReason({ linkedinCompanyId: null }, { attempts: { resolve: ["2026-09-25", "2026-09-26"] } }).text'),
          "No LinkedIn company found. Tried on 25 September and 26 September.")
    check("lacking: no id, one day only", ctx.eval('lackingReason({ linkedinCompanyId: null }, { attempts: { resolve: ["2026-09-25"] } })'), None)
    check("lacking: has id, resolve gave up = still Usable",
          ctx.eval('lackingReason({ linkedinCompanyId: "9" }, { attempts: { resolve: ["2026-09-25", "2026-09-26"] } })'), None)
    check("lacking: deleted never", ctx.eval('lackingReason({ deleted: true }, { emptyPage: "2026-09-27" })'), None)

    # duplicates (V3)
    js = """(() => {
      const rows = [
        { companyId: "C1", key: "acme", company: "Acme", source: "Imported", universeOrder: 5, linkedinCompanyId: "100", idVerified: true, slug: "acme" },
        { companyId: "D-1", key: "acme", company: "Acme", source: "Discovered", universeOrder: null, linkedinCompanyId: "100", idVerified: false, slug: "acme" },
        { companyId: "C2", key: "beta", company: "Beta", source: "Imported", linkedinCompanyId: "200", idVerified: true, slug: "beta" },
        { companyId: "D-2", key: "beta", company: "Beta", source: "Discovered", linkedinCompanyId: "201", idVerified: true, slug: "beta-ch" },
        { companyId: "C3", key: "gamma", company: "Gamma", source: "Imported", linkedinCompanyId: "300", idVerified: false, slug: "gamma" },
        { companyId: "C4", key: "gamma ag", company: "Gamma AG", source: "Imported", linkedinCompanyId: "300", idVerified: false, slug: "gamma" },
        { companyId: "C5", key: "delta", company: "Delta", source: "Imported", linkedinCompanyId: "400", idVerified: true, slug: "delta" },
        { companyId: "C6", key: "delta", company: "Delta", source: "Imported", linkedinCompanyId: "401", idVerified: true, slug: "delta-x" },
        // 2026-09-27, live: one holds the other's LinkedIn id, but their links open two different pages
        { companyId: "C7", key: "basilea pharmaceutica", company: "Basilea Pharmaceutica", linkedinCompanyId: "700", slug: "basilea-pharmaceutica-ltd" },
        { companyId: "C8", key: "adc therapeutics", company: "ADC Therapeutics", linkedinCompanyId: "700", slug: "adc-therapeutics" },
        // same name, two legal entities in the registry
        { companyId: "C9", key: "epsilon", company: "Epsilon", linkedinCompanyId: "900", slug: "epsilon", registryId: "CHE-1" },
        { companyId: "C10", key: "epsilon", company: "Epsilon", linkedinCompanyId: "901", slug: "epsilon-sa", registryId: "CHE-2" },
      ];
      const g = duplicateGroups(rows, new Set(["C5|C6"]));
      return JSON.stringify(g.map((x) => [x.members[0].companyId, x.members.length, x.auto]));
    })()"""
    check("duplicateGroups", ctx.eval(js), '[["C1",2,true],["C2",2,false],["C3",2,false]]')

    check("similarKey finding", ctx.eval('similarKey({ kind: "finding", payload: { field: "industry" } })'), "finding:industry")
    check("similarKey name match", ctx.eval('similarKey({ kind: "name_match", payload: {} })'), None)
    order = ctx.eval(
        'sortDecisions(['
        '{ id: "a", kind: "finding", priority: "P1", company: "A" },'
        '{ id: "b", kind: "name_match", priority: "P3", company: "B" },'
        '{ id: "c", kind: "lacking_evidence", priority: "P1", company: "C" },'
        '{ id: "d", kind: "name_match", priority: "P1", company: "D" }'
        ']).map((i) => i.id).join("")'
    )
    check("sortDecisions", order, "dbca")


def test_rate_limit_backoff(ctx):
    # 1.2.1 build step 0 (ONBOARDING_RESEARCH_DESIGN.md 5.6): a 429 pauses and retries, it no longer ends the run.
    check("429 is a rate limit", ctx.eval("isRateLimited({ status: 429 })"), True)
    check("529 overloaded is a rate limit", ctx.eval("isRateLimited({ status: 529 })"), True)
    check("web search too_many_requests is a rate limit", ctx.eval("isRateLimited({ rateLimited: true })"), True)
    check("401 is not a rate limit", ctx.eval("isRateLimited({ status: 401 })"), False)
    check("no error is not a rate limit", ctx.eval("isRateLimited(null)"), False)
    check("first back-off is 30 s", ctx.eval("backoffDelayMs(null, 1)"), 30000)
    check("second doubles to 60 s", ctx.eval("backoffDelayMs(undefined, 2)"), 60000)
    check("fourth is 240 s", ctx.eval("backoffDelayMs('', 4)"), 240000)
    check("capped at 5 min", ctx.eval("backoffDelayMs(null, 9)"), 300000)
    check("retry-after seconds win", ctx.eval("backoffDelayMs('12', 3)"), 12000)
    check("retry-after 0 still waits 1 s", ctx.eval("backoffDelayMs('0', 1)"), 1000)
    check("retry-after as an HTTP date", ctx.eval("backoffDelayMs('Mon, 28 Sep 2026 10:00:20 GMT', 1, Date.parse('Mon, 28 Sep 2026 10:00:00 GMT'))"), 20000)
    check("huge retry-after is capped", ctx.eval("backoffDelayMs('3600', 1)"), 300000)
    check("garbage retry-after falls back", ctx.eval("backoffDelayMs('soon', 1)"), 30000)


def test_company_identity(ctx):
    """1.2.1 step 1: company-identity.js - website domains, "Web" row ids, exclusions by name and website (design 3.9, 4.4)."""
    check("domain: scheme, www, path and case dropped", ctx.eval("websiteDomain('https://www.Nestle.com/ch/en?x=1')"), "nestle.com")
    check("domain: a bare domain", ctx.eval("websiteDomain('ubs.com')"), "ubs.com")
    check("domain: www2 and a port", ctx.eval("websiteDomain('http://www2.example.co.uk:8080/')"), "example.co.uk")
    check("domain: a plain name is not a website", ctx.eval("websiteDomain('Nestle')"), None)
    check("domain: empty", ctx.eval("websiteDomain('')"), None)
    check("Web row id from the website", ctx.eval("webCompanyId('https://www.roche.com/', 'Roche Holding AG')"), "W-roche.com")
    check("Web row id from the name when there is no website", ctx.eval("webCompanyId(null, 'Roche Holding AG')"), "W-roche holding")
    check("normalizeCompanyName still strips one legal suffix", ctx.eval("normalizeCompanyName('Azqore SA')"), "azqore")
    ctx.eval("""
    var EXM = buildExclusionMatcher([
      { slug: "adecco", category: "recruiter" },
      { name: "Acme Consulting AG", category: "competitor", source: "research" },
      { domain: "https://www.rival.ch/", category: "competitor", source: "user" },
      null,
    ]);
    """)
    check("exclusion by LinkedIn slug, as before", ctx.eval("matchesExclusion(EXM, { slug: 'adecco' })"), True)
    check("exclusion by normalised name", ctx.eval("matchesExclusion(EXM, { name: 'ACME Consulting' })"), True)
    check("exclusion by website domain", ctx.eval("matchesExclusion(EXM, { name: 'Rival', website: 'rival.ch/about' })"), True)
    check("a company on none of them is not excluded", ctx.eval("matchesExclusion(EXM, { slug: 'nestle-s-a', name: 'Nestle', website: 'nestle.com' })"), False)
    check("a slug-only entry adds no name to match", ctx.eval("matchesExclusion(EXM, { name: 'Adecco Group' })"), False)


def test_relationships(ctx):
    """1.2.3 step 0: customers / partners leave the exclusion list (EXCLUSIONS_RELATIONSHIPS_DESIGN.md 3.2, 4.1, 6.1, 7)."""
    ctx.eval("""
    var REL_EXCL = [
      { slug: "adecco", category: "recruiter" },
      { name: "Rival AG", category: "competitor" },
      { slug: "nestle-s-a", name: "Nestle", category: "customer" },
      { domain: "migros.ch", category: "customer", source: "research" },
      { name: "Partner Co", category: "partner" },
      { name: "Partner Co", category: "customer" },
    ];
    var REL_EXM = buildExclusionMatcher(REL_EXCL, []);
    var REL_M = buildRelationshipMatcher([], REL_EXCL);
    """)
    # The exclusion matcher skips customer / partner entries even while they are still on the list.
    check("a competitor is still excluded", ctx.eval("matchesExclusion(REL_EXM, { name: 'Rival' })"), True)
    check("a recruiter is still excluded", ctx.eval("matchesExclusion(REL_EXM, { slug: 'adecco' })"), True)
    check("a leftover customer entry excludes nothing (slug)", ctx.eval("matchesExclusion(REL_EXM, { slug: 'nestle-s-a' })"), False)
    check("a leftover customer entry excludes nothing (domain)", ctx.eval("matchesExclusion(REL_EXM, { website: 'https://www.migros.ch' })"), False)
    check("a leftover partner entry excludes nothing", ctx.eval("matchesExclusion(REL_EXM, { name: 'Partner Co AG' })"), False)
    # The relationship matcher reads leftovers too, by slug, name or domain.
    check("customer by slug", ctx.eval("JSON.stringify(relationshipOf(REL_M, { slug: 'Nestle-S-A' }))"), '["customer"]')
    check("customer by website", ctx.eval("JSON.stringify(relationshipOf(REL_M, { name: 'Migros-Genossenschafts-Bund', website: 'migros.ch/de' }))"), '["customer"]')
    check("customer and partner", ctx.eval("JSON.stringify(relationshipOf(REL_M, { name: 'Partner Co' }))"), '["customer","partner"]')
    check("a competitor has no relationship", ctx.eval("JSON.stringify(relationshipOf(REL_M, { name: 'Rival AG' }))"), "[]")
    check("no matcher: no relationship", ctx.eval("JSON.stringify(relationshipOf(null, { name: 'Nestle' }))"), "[]")
    check("matchesRelationship", ctx.eval("matchesRelationship(REL_M, { slug: 'nestle-s-a' })"), True)
    check("the exclusion matcher carries the kept matcher", ctx.eval("buildExclusionMatcher([], [], REL_M).kept === REL_M"), True)
    check("no kept matcher by default", ctx.eval("buildExclusionMatcher([], []).kept"), None)

    # splitCompanyLists: moves, keeps order of the rest, idempotent, no duplicates.
    ctx.eval("""
    var REL_S1 = splitCompanyLists(REL_EXCL, [{ name: "Nestle SA", category: "customer" }]);
    var REL_S2 = splitCompanyLists(REL_S1.exclusions, REL_S1.relationships);
    """)
    check("exclusions keep only competitor / recruiter / other",
          ctx.eval("JSON.stringify(REL_S1.exclusions.map(function (e) { return e.category; }))"), '["recruiter","competitor"]')
    check("an equal entry already on the list is not added twice (name+slug differ -> added)",
          ctx.eval("REL_S1.relationships.length"), 5)
    check("moved counts", ctx.eval("JSON.stringify(REL_S1.moved)"), '{"customer":3,"partner":1}')
    check("running it again moves nothing", ctx.eval("JSON.stringify(REL_S2.moved)"), '{"customer":0,"partner":0}')
    check("running it again changes nothing", ctx.eval("REL_S2.relationships.length === REL_S1.relationships.length && REL_S2.exclusions.length === 2"), True)
    check("an exact duplicate is not moved twice",
          ctx.eval("splitCompanyLists([{ name: 'Nestle', category: 'customer' }], [{ name: 'Nestlé'.replace('é','e'), category: 'customer' }]).moved.customer"), 0)
    check("empty input", ctx.eval("JSON.stringify(splitCompanyLists(null, null))"), '{"exclusions":[],"relationships":[],"moved":{"customer":0,"partner":0}}')

    # Priority raise (R5.4, D3).
    for base, raised in (("P1", "P1"), ("P2", "P1"), ("P3", "P2"), ("P4", "P3"), ("P5", "P4")):
        check("raise %s" % base, ctx.eval("raisePriority('%s')" % base), raised)
    check("raise: no priority", ctx.eval("raisePriority(null)"), None)
    check("raise: unknown value untouched", ctx.eval("raisePriority('High')"), "High")
    check("customer P3 -> P2, raised", ctx.eval("JSON.stringify(effectivePriority({ priority: 'P3', relationship: ['customer'] }))"), '{"priority":"P2","raised":true}')
    check("customer P1 stays P1, not marked raised", ctx.eval("JSON.stringify(effectivePriority({ priority: 'P1', relationship: ['customer'] }))"), '{"priority":"P1","raised":false}')
    check("partner only stays neutral", ctx.eval("JSON.stringify(effectivePriority({ priority: 'P3', relationship: ['partner'] }))"), '{"priority":"P3","raised":false}')
    check("customer and partner is raised", ctx.eval("effectivePriority({ priority: 'P4', relationship: ['customer', 'partner'] }).priority"), "P3")
    check("a priority set by hand is never raised", ctx.eval("JSON.stringify(effectivePriority({ priority: 'P3', manual: true, relationship: ['customer'] }))"), '{"priority":"P3","raised":false}')
    check("no relationship: unchanged", ctx.eval("effectivePriority({ priority: 'P2' }).priority"), "P2")

    # Prompt line and tag.
    check("prompt line: customer", ctx.eval("relationshipPromptLine(['customer'], 'Nestle', 'TIMETOACT').indexOf('Nestle is an existing customer of TIMETOACT') >= 0"), True)
    check("prompt line: partner", ctx.eval("relationshipPromptLine(['partner'], 'ALSO', 'TIMETOACT').indexOf('partner / reseller of TIMETOACT') >= 0"), True)
    check("prompt line: both", ctx.eval("relationshipPromptLine(['customer','partner'], 'X', 'Y').indexOf('customer and a partner') >= 0"), True)
    check("prompt line: none", ctx.eval("relationshipPromptLine([], 'X', 'Y')"), "")
    check("tag text", ctx.eval("relationshipTagText(['customer','partner'])"), "Customer · Partner")
    check("tag text: none", ctx.eval("relationshipTagText([])"), "")

    # The pop-up / log text (R3.2, step 1): a moved company that is not an account is not called one.
    check("moved, not an account", ctx.eval("relationshipsMovedText({ partner: 1 })"),
          "1 partner moved from the exclusions to the new Customers and partners list - customers and partners are no longer excluded. None of them is one of your accounts, so Target Accounts does not change.")
    check("moved, accounts back", ctx.eval("relationshipsMovedText({ customer: 12, partner: 3, accounts: 9 })"),
          "12 customers and 3 partners moved from the exclusions to the new Customers and partners list - customers and partners are no longer excluded. 9 of them are accounts and are back in Target Accounts, with a Relationship tag; they join the normal research queue.")
    check("one account back", ctx.eval("relationshipsMovedText({ customer: 1, accounts: 1 }).indexOf('1 of them is an account and is back') >= 0"), True)
    check("leads only", ctx.eval("relationshipsMovedText({ leads: 4 })"),
          "4 leads (posts) from customers' and partners' people are back in the Leads Dashboard as New.")
    check("nothing", ctx.eval("relationshipsMovedText({})"), "")

    # Setup table rows (design 9.2).
    check("row: name only", ctx.eval("JSON.stringify(parseCompanyListEntry({ name: ' Acme AG ' }))"), '{"entry":{"name":"Acme AG"}}')
    check("row: LinkedIn company page", ctx.eval("parseCompanyListEntry({ linkedin: 'https://www.linkedin.com/company/acme-ag/about/' }).entry.slug"), "acme-ag")
    check("row: LinkedIn profile refused", ctx.eval("!!parseCompanyListEntry({ name: 'X', linkedin: 'https://www.linkedin.com/in/jane/' }).error"), True)
    check("row: website kept as domain", ctx.eval("parseCompanyListEntry({ name: 'Acme', website: 'https://www.acme.ch/de' }).entry.domain"), "acme.ch")
    check("row: LinkedIn link as website refused", ctx.eval("!!parseCompanyListEntry({ website: 'linkedin.com/company/acme' }).error"), True)
    check("row: nothing entered", ctx.eval("!!parseCompanyListEntry({}).error"), True)
    check("row: not a web address", ctx.eval("!!parseCompanyListEntry({ name: 'A', website: 'acme' }).error"), True)
    check("same company by name", ctx.eval("sameCompanyEntry({ name: 'Acme AG' }, { name: 'ACME' })"), True)
    check("same company by domain", ctx.eval("sameCompanyEntry({ domain: 'acme.ch' }, { name: 'Other', domain: 'https://www.acme.ch' })"), True)
    check("different companies", ctx.eval("sameCompanyEntry({ name: 'Acme', slug: 'acme' }, { name: 'Beta', slug: 'beta' })"), False)

    # Team: the new list key is shared per entry, after companyExclusions.
    check("companyRelationships is a team list key", ctx.eval("teamKeyKind('companyRelationships')"), "list")
    check("companyExclusions stays the first list key", ctx.eval("TEAM_LIST_KEYS[0].key"), "companyExclusions")
    check("the move notice is personal", ctx.eval("classifyStorageKey('relationshipsMigrationNotice')"), "personal")


def test_per_field_research(ctx):
    """1.2.1 step 1 (design 5.3): each web value carries its own source; the old plain format is still read."""
    ctx.eval(r"""
    var NEWD = {
      employeesGlobal: { value: 12000, url: "https://acme.ch/annual-report-2025.pdf", year: 2025 },
      employeesLocal: { value: 3000, url: null },
      hqCountry: { value: "Switzerland", url: "https://acme.ch/about" },
      revenueCurrency: "CHF",
      revenueGlobal: { value: 2100000000, url: "not a url" },
      website: { value: "https://acme.ch", url: "https://acme.ch" },
    };
    var OLDD = { employeesGlobal: 12000, hqCountry: "Switzerland", revenueCurrency: "CHF" };
    var SRC = [{ url: "https://example.com" }];
    """)
    check("new format: the plain value is read", ctx.eval("WEB_FINDING_FIELDS[0].from(NEWD)"), 12000)
    check("old format: still read", ctx.eval("WEB_FINDING_FIELDS[0].from(OLDD)"), 12000)
    check("new format is recognised", ctx.eval("isPerFieldResearch(NEWD)"), True)
    check("old format is recognised", ctx.eval("isPerFieldResearch(OLDD)"), False)
    check("findings are proposed from the new format",
          ctx.eval("computeFindingProposals({ company: 'Acme' }, {}, NEWD).map(function (p) { return p.key + '=' + p.found; }).join(',')"),
          "globalEmployees=12000,swissEmployees=3000,globalRevenue=2100000000,revenueCurrency=CHF,globalHqCountry=Switzerland")
    check("a value with its own url is cited, with that url as link",
          ctx.eval("JSON.stringify(webCitationFor(NEWD, [], 'globalEmployees', 12000))"),
          '{"cited":true,"link":"https://acme.ch/annual-report-2025.pdf"}')
    check("a value without a url is NOT cited, even when the research cited other things",
          ctx.eval("JSON.stringify(webCitationFor(NEWD, SRC, 'swissEmployees', 3000))"), '{"cited":false,"link":null}')
    check("a url that is not a web address does not count",
          ctx.eval("JSON.stringify(webCitationFor(NEWD, SRC, 'globalRevenue', 2100000000))"), '{"cited":false,"link":null}')
    check("the research does not stand behind a DIFFERENT value", ctx.eval("webCitationFor(NEWD, SRC, 'globalEmployees', 50000)"), None)
    check("...but does behind one within 10% (same fact, rounded)",
          ctx.eval("webCitationFor(NEWD, [], 'globalEmployees', '12,500').cited"), True)
    check("new format, field not in the answer: no citation", ctx.eval("webCitationFor(NEWD, SRC, 'industry', 'Food')"), None)
    check("old format keeps the old rule: cited when the research had any source",
          ctx.eval("JSON.stringify(webCitationFor(OLDD, SRC, 'globalEmployees', 12000))"), '{"cited":true,"link":null}')
    check("old format without sources: no citation", ctx.eval("webCitationFor(OLDD, [], 'globalEmployees', 12000)"), None)
    check("researchConfirms still reads the new format",
          ctx.eval("researchConfirms({ company: 'Acme', globalEmployees: 12000 }, {}, NEWD, null, ['globalEmployees']).join(',')"),
          "globalEmployees")
    # deriveProvenance: storage.js hands in the per-field verdict as facts.webCitations.
    ctx.eval(r"""
    var dview = { company: "Acme", source: "Imported", globalEmployees: 3000, importedAt: NOW - 30 * DAY };
    var research = { at: NOW - DAY, sources: SRC, data: NEWD };
    """)
    check("an overridden value the web gave without a url is web, uncited (so unverified)",
          ctx.eval("var p = deriveProvenance(dview, 'globalEmployees', { overridden: { globalEmployees: true }, webResearch: research, webCitations: { globalEmployees: { cited: false, link: null } } }, NOW); p.src + ':' + p.cited + ':' + isGoodSource(p)"),
          "web:false:false")
    check("an overridden value with its own url is web, cited, with the link",
          ctx.eval("var p = deriveProvenance(dview, 'globalEmployees', { overridden: { globalEmployees: true }, webResearch: research, webCitations: { globalEmployees: { cited: true, link: 'https://acme.ch/r' } } }, NOW); p.src + ':' + p.cited + ':' + p.link"),
          "web:true:https://acme.ch/r")
    check("an override the research does not stand behind is the user's own",
          ctx.eval("deriveProvenance(dview, 'globalEmployees', { overridden: { globalEmployees: true }, webResearch: research, webCitations: { globalEmployees: null } }, NOW).src"),
          "user")
    check("without webCitations the old rule still applies",
          ctx.eval("var p = deriveProvenance(dview, 'globalEmployees', { overridden: { globalEmployees: true }, webResearch: research }, NOW); p.src + ':' + p.cited"),
          "web:true")
    check("a Web row's unstamped value is cited by its listing",
          ctx.eval("var p = deriveProvenance({ source: 'Web', globalHqCountry: 'Switzerland', primarySourceUrl: 'https://listing.example/top100', importedAt: NOW }, 'globalHqCountry', {}, NOW); p.src + ':' + p.cited + ':' + p.link"),
          "web:true:https://listing.example/top100")


def test_web_usable(ctx):
    """1.2.1 step 1 (design 6.1): Usable without LinkedIn. Reuses test_readiness's readyView/CFG/NOW."""
    ctx.eval(r"""
    function webView(patch) {
      var v = readyView({
        source: "Web", linkedinCompanyId: null, linkedinLink: null, contacts: [],
        website: "https://www.acme.ch", primarySourceUrl: "https://listing.example/top100",
        globalHqCountry: "Switzerland", globalEmployees: 12000,
      });
      v.provenance = {
        globalHqCountry: { src: "web", at: NOW - DAY, cited: true, link: "https://acme.ch/about", v: "Switzerland" },
        globalEmployees: { src: "web", at: NOW - DAY, cited: true, link: "https://acme.ch/ar.pdf", v: 12000 },
      };
      for (var k in (patch || {})) v[k] = patch[k];
      return v;
    }
    """)
    check("a web-identified account with verified targeting fields is Usable", ctx.eval("state(webView())"), "usable")
    check("...via the web, and not scannable",
          ctx.eval("var a = assessAccount(webView(), CFG, NOW); a.usableVia + ':' + a.scannable"), "web:false")
    check("a bare-domain website identifies it too", ctx.eval("state(webView({ website: 'acme.ch', primarySourceUrl: null }))"), "usable")
    check("no website and no source url: in progress", ctx.eval("state(webView({ website: null, primarySourceUrl: null }))"), "in_progress")
    check("no priority: in progress", ctx.eval("state(webView({ salesTeamPriority: null }))"), "in_progress")
    check("a value without a url does not count as verified",
          ctx.eval("var v = webView(); v.provenance.globalEmployees = { src: 'web', at: NOW - DAY, cited: false, v: 12000 }; state(v)"), "in_progress")
    check("a targeting field missing: in progress", ctx.eval("state(webView({ globalHqCountry: null }))"), "in_progress")
    check("a field the targeting leaves at medium is not asked for (industry)", ctx.eval("state(webView({ industry: null }))"), "usable")
    check("deleted or excluded: never web usable", ctx.eval("webUsable(webView({ excluded: true }), CFG, NOW)"), False)
    check("a LinkedIn-scannable account stays usable via linkedin",
          ctx.eval("assessAccount(withProv('linkedinCompanyId', { src: 'linkedin', at: NOW, link: null, v: '1234' }), CFG, NOW).usableVia"), "linkedin")
    check("Ready is unchanged, and has no usableVia", ctx.eval("var a = assessAccount(readyView(), CFG, NOW); a.state + ':' + a.usableVia"), "ready:null")
    check("an existing imported account without a website stays in progress",
          ctx.eval("state(readyView({ linkedinCompanyId: null, linkedinLink: null }))"), "in_progress")


def test_web_lane_step2(ctx):
    """1.2.1 step 2 (design 5.1-5.5, D10): what the web lane asks for, in which order, and what it keeps."""
    full = "{ initiatives: 1, relevantContacts: 3, hasSummary: true }"
    check("nothing missing: no research at all (R7a.7)",
          ctx.eval("JSON.stringify(missingWebTopics(webView(), CFG, %s, null, NOW))" % full), "[]")
    check("the listed account typically needs initiatives, contacts and a summary",
          ctx.eval("JSON.stringify(missingWebTopics(webView(), CFG, {}, null, NOW))"), '["initiatives","contacts","summary"]')
    check("an HQ without a url is asked for again",
          ctx.eval("var v = webView(); v.provenance.globalHqCountry = { src: 'web', at: NOW - DAY, cited: false, v: 'Switzerland' }; "
                   "JSON.stringify(missingWebTopics(v, CFG, %s, null, NOW))" % full), '["headquarters"]')
    check("missing employees are asked for",
          ctx.eval("JSON.stringify(missingWebTopics(webView({ globalEmployees: null }), CFG, %s, null, NOW))" % full), '["employees"]')
    check("industry only when the setup weighs it (CFG does not)",
          ctx.eval("JSON.stringify(missingWebTopics(webView({ industry: null }), CFG, %s, null, NOW))" % full), "[]")
    check("...and asked when it does",
          ctx.eval("var c = JSON.parse(JSON.stringify(CFG)); c.industries = [{ name: 'Banking', priority: 3 }]; "
                   "JSON.stringify(missingWebTopics(webView({ industry: null }), c, %s, null, NOW))" % full), '["industry"]')
    check("two contacts are below the default target of 3",
          ctx.eval("JSON.stringify(missingWebTopics(webView(), CFG, { initiatives: 1, relevantContacts: 2, hasSummary: true }, null, NOW))"), '["contacts"]')
    check("a lower target is honoured",
          ctx.eval("JSON.stringify(missingWebTopics(webView(), CFG, { initiatives: 1, relevantContacts: 2, hasSummary: true }, { contactsPerAccount: 2 }, NOW))"), "[]")
    check("excluded: nothing", ctx.eval("missingWebTopics(webView({ excluded: true }), CFG, {}, null, NOW).length"), 0)

    check("traded first, then priority, then listing order",
          ctx.eval("webLaneOrder([{ key: 'a', isPublic: null, priority: 'P1', order: 1 }, { key: 'b', isPublic: true, priority: 'P3', order: 9 },"
                   " { key: 'c', isPublic: false, priority: 'P1', order: 0 }, { key: 'd', isPublic: true, priority: 'P2', order: 5 },"
                   " { key: 'e', isPublic: null, priority: null, order: 2 }]).map(function (e) { return e.key; }).join('')"), "dbcae")

    for text, expected in [("Public", True), ("Publicly listed (SIX)", True), ("Listed", True), ("Private", False),
                           ("Privately held", False), ("Unlisted", False), ("Cooperative", False), ("State-owned", False),
                           ("Public body", False), ("National tourism organization / public-law corporation", False),
                           ("Swiss company", None), ("Foundation", False), ("", None), ("Global company", None)]:
        check("isPubliclyTraded(%r)" % text, ctx.eval("isPubliclyTraded(%r, null)" % text), expected)
    check("the research's own answer wins", ctx.eval("isPubliclyTraded('Private', true)"), True)

    check("profile link normalised", ctx.eval("linkedinProfileUrl('https://ch.linkedin.com/in/anna-muster-12ab/?trk=x')"),
          "https://www.linkedin.com/in/anna-muster-12ab/")
    check("a company page is not a profile", ctx.eval("linkedinProfileUrl('https://www.linkedin.com/company/acme/')"), None)
    check("company page normalised", ctx.eval("linkedinCompanyUrl('https://linkedin.com/company/acme-ag/about/')"),
          "https://www.linkedin.com/company/acme-ag/")
    ctx.eval(r"""
    var LANE_DATA = { contacts: [
      { fullName: "Anna  Muster", title: "CIO", sourceUrl: "https://acme.ch/management", linkedinUrl: "https://ch.linkedin.com/in/anna-muster" },
      { fullName: "anna muster", title: "CIO", sourceUrl: "https://acme.ch/management" },
      { fullName: "The CFO", title: "CFO", sourceUrl: "https://acme.ch/management" },
      { fullName: "Peter Beispiel", title: "CEO", sourceUrl: null },
      { fullName: "Eva Probe", title: "Head of Data", sourceUrl: "https://acme.ch/ar.pdf", linkedinUrl: "https://example.com/eva" },
    ], initiatives: [
      { name: "AI claims triage", stage: "pilot", sourceUrl: "https://acme.ch/news/1" },
      { name: "Cloud move", stage: "whatever", sourceUrl: "not a url" },
      { name: "  " },
    ], isPublic: { value: true, url: "https://six-group.com/acme" } };
    """)
    check("contacts need two names and a source of their own; duplicates dropped",
          ctx.eval("researchContacts(LANE_DATA).map(function (c) { return c.fullName; }).join('|')"), "Anna Muster|Eva Probe")
    check("...with the profile link a search listed (D10), and none for a non-LinkedIn link",
          ctx.eval("researchContacts(LANE_DATA).map(function (c) { return c.linkedinUrl; }).join('|')"), "https://www.linkedin.com/in/anna-muster/|")
    check("initiatives keep a known stage only, and a real url only",
          ctx.eval("JSON.stringify(researchInitiatives(LANE_DATA).map(function (i) { return [i.name, i.stage, i.sourceUrl]; }))"),
          '[["AI claims triage","pilot","https://acme.ch/news/1"],["Cloud move",null,null]]')
    check("isPublic read from the per-field answer", ctx.eval("researchIsPublic(LANE_DATA)"), True)
    check("an industry finding is proposed like any other field",
          ctx.eval("JSON.stringify(computeFindingProposals({ company: 'Acme' }, {}, { industry: { value: 'Banking', url: 'https://acme.ch' } }).map(function (p) { return p.key + ':' + p.found; }))"),
          '["industry:Banking"]')


def test_user_retry_first(ctx):
    """2026-09-29: an account the user gave a new Alt. name or link is tried first, once."""
    ctx.eval(r"""
    function rview(name, prio, edit) { return { key: name, company: name, salesTeamPriority: prio, linkedinCompanyId: null, linkedinLink: null, userIdentityEdit: edit, provenance: {}, contacts: [] }; }
    function rentry(v, pipeline) { return { view: v, assessment: assessAccount(v, CFG, NOW), pipeline: pipeline || {} }; }
    """)
    check("an edited P3 account goes before an unedited P1",
          ctx.eval("rankCandidates([rentry(rview('P1 co', 'P1', false)), rentry(rview('Rega', 'P3', true))], NOW, 2).map(function (e) { return e.view.company; }).join(',')"),
          "Rega,P1 co")
    check("once the pipeline has tried it, it goes back to its place",
          ctx.eval("rankCandidates([rentry(rview('P1 co', 'P1', false)), rentry(rview('Rega', 'P3', true), { attempts: { resolve: ['2026-09-24'] } })], NOW, 2).map(function (e) { return e.view.company; }).join(',')"),
          "P1 co,Rega")
    check("without an edit, priority order as before",
          ctx.eval("rankCandidates([rentry(rview('P3 co', 'P3', false)), rentry(rview('P1 co', 'P1', false))], NOW, 2).map(function (e) { return e.view.company; }).join(',')"),
          "P1 co,P3 co")
    ctx.eval("var EXL = buildExclusionMatcher([{ slug: 'temenos', category: 'competitor' }], ['SophiaGenetics']);")
    check("a lifted slug is recorded, case-insensitively", ctx.eval("EXL.lifted.has('sophiagenetics')"), True)
    check("...and is not itself an exclusion", ctx.eval("matchesExclusion(EXL, { slug: 'sophiagenetics' })"), False)


def test_extras_merge(ctx):
    # 1.2.1 build step 0: a writer applies only what it changed; a change made meanwhile by another writer stays.
    ctx.eval("""var m1 = mergeFieldChanges({ a: 1 }, { a: 1, b: 2 }, { a: 1, c: 3 });""")
    check("an edit adds its field and keeps one filled meanwhile", ctx.eval("JSON.stringify(m1)"), '{"a":1,"c":3,"b":2}')
    ctx.eval("""var m2 = mergeFieldChanges({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2, c: 3 });""")
    check("a removed field is removed, the rest kept", ctx.eval("JSON.stringify(m2)"), '{"a":1,"c":3}')
    ctx.eval("""var m3 = mergeFieldChanges({ a: 1 }, { a: 1 }, { a: 5 });""")
    check("an untouched field keeps the newer stored value", ctx.eval("JSON.stringify(m3)"), '{"a":5}')
    ctx.eval("""var m4 = mergeFieldChanges({ a: 1 }, { a: 2 }, { a: 5 });""")
    check("the same field changed on both sides: this writer wins", ctx.eval("JSON.stringify(m4)"), '{"a":2}')
    ctx.eval("""var m5 = mergeFieldChanges(undefined, { x: [1, 2] }, undefined);""")
    check("no base and nothing stored", ctx.eval("JSON.stringify(m5)"), '{"x":[1,2]}')
    ctx.eval("""var m6 = mergeFieldChanges({ l: ["a"] }, { l: ["a"] }, { l: ["a", "b"] });""")
    check("an unchanged list compares by value, not identity", ctx.eval("JSON.stringify(m6)"), '{"l":["a","b"]}')


def test_profile_search_matching(ctx):
    """1.2.0.7 (D10): LinkedIn profiles read off web search results - name AND company in the title, one profile only."""
    ctx.eval(r"""
    var PR = [
      { url: "https://ch.linkedin.com/in/anna-muster-12ab", title: "Anna Muster - Chief Financial Officer - Glencore | LinkedIn" },
      { url: "https://www.linkedin.com/in/peter-beispiel", title: "Peter Beispiel – Head of IT – Other AG | LinkedIn" },
      { url: "https://www.linkedin.com/in/eva-probe-1", title: "Eva Probe - Glencore | LinkedIn" },
      { url: "https://www.linkedin.com/in/eva-probe-2", title: "Dr. Eva Probe - Data Lead at Glencore | LinkedIn" },
      { url: "https://www.glencore.com/management", title: "Hans Müller - Glencore management" },
      { url: "https://www.linkedin.com/in/hans-mueller-x", title: "Hans Mueller - Glencore International | LinkedIn" },
    ];
    var PP = [{ fullName: "Anna Muster" }, { fullName: "Peter Beispiel" }, { fullName: "Eva Probe" }, { fullName: "Dr. Hans Müller" }, { fullName: "Nobody Here" }];
    """)
    check("name and company in the title: found; another company: not; two profiles: not; umlaut spelling: found",
          ctx.eval("JSON.stringify(profilesFromSearchResults(PR, PP, 'Glencore'))"),
          '[{"fullName":"Anna Muster","url":"https://www.linkedin.com/in/anna-muster-12ab/"},'
          '{"fullName":"Dr. Hans Müller","url":"https://www.linkedin.com/in/hans-mueller-x/"}]')
    check("the name is the title's first part", ctx.eval("profileTitleName('Anna Muster - CFO - Glencore | LinkedIn')"), "Anna Muster")
    check("a distinctive word of the company name is enough", ctx.eval("titleNamesCompany('Jo Doe - Kuehne+Nagel | LinkedIn', 'Kühne + Nagel')"), True)
    check("generic words alone do not identify a company", ctx.eval("titleNamesCompany('Jo Doe - Swiss Group | LinkedIn', 'Swiss Group AG')"), False)
    check("people without a profile make 'profiles' a lane topic",
          ctx.eval("JSON.stringify(missingWebTopics(webView(), CFG, { initiatives: 1, relevantContacts: 3, hasSummary: true, contactsWithoutProfile: 2 }, null, NOW))"),
          '["profiles"]')


def test_discovery_filter(ctx):
    """1.2.1 step 3: discovery-filter.js - band split, centre of the band, row filter and choice (design 4.2-4.3, D9)."""
    ctx.eval("""
      var BANDS = [
        { key: "S", label: "Small", min: 0, max: 200 }, { key: "M", label: "Medium", min: 201, max: 500 },
        { key: "L", label: "Large", min: 501, max: 1000 }, { key: "XL", label: "Extra Large", min: 1001, max: 5000 },
        { key: "XXL", label: "Extra Extra Large", min: 5001, max: Infinity } ];
    """)
    check("wanted: 10 + 15% = 12", ctx.eval("discoveryWanted(10)"), 12)
    check("wanted: 100 + 15% = 115", ctx.eval("discoveryWanted(100)"), 115)
    check("centre: Large ~708", ctx.eval("bandCentre(BANDS[2])"), 708)
    check("centre: Medium ~317", ctx.eval("bandCentre(BANDS[1])"), 317)
    check("centre: Small (open below) 100", ctx.eval("bandCentre(BANDS[0])"), 100)
    check("centre: XXL (open above) 10000", ctx.eval("bandCentre(BANDS[4])"), 10000)
    check("band split: Large High + Medium Medium, 100 -> 60/40",
          ctx.eval("JSON.stringify(bandTargets({ L: { checked: true, priority: 3 }, M: { checked: true, priority: 2 } }, BANDS, 100).map(b => [b.key, b.count]))"),
          '[["L",60],["M",40]]')
    check("band split adds up (12 over three equal bands)",
          ctx.eval("bandTargets({ S: { checked: true, priority: 2 }, M: { checked: true, priority: 2 }, L: { checked: true, priority: 2 } }, BANDS, 12).reduce((a, b) => a + b.count, 0)"), 12)
    check("largest: only XL/XXL ticked", ctx.eval("targetsLargest({ XL: { checked: true }, XXL: { checked: true } }, BANDS)"), True)
    check("largest: Medium ticked is not", ctx.eval("targetsLargest({ M: { checked: true }, XXL: { checked: true } }, BANDS)"), False)
    check("clean row: loose numbers and domain",
          ctx.eval("var r = cleanListingRow({ name: ' Acme  AG ', website: 'https://www.acme.ch/de', employees: '1,200', currency: 'chf' }, 'https://list'); [r.name, r.domain, r.employees, r.currency, r.sourceUrl].join('|')"),
          "Acme AG|acme.ch|1200|CHF|https://list")
    ctx.eval("""
      var CTX = {
        seller: { website: 'https://seller.com' },
        exclusions: buildExclusionMatcher([{ name: 'Rival AG' }, { domain: 'enemy.ch' }]),
        known: buildKnownCompanies([{ company: 'Nestle SA', website: 'nestle.com' }, { company: 'Gone AG', deleted: true }]),
        sizeBuckets: { M: { checked: true }, L: { checked: true } }, bands: BANDS,
        industryNames: ['Banking'], excludedOrgTypes: ['Government Administration'] };
      var ROWS = [
        { name: 'Seller Inc', website: 'seller.com' }, { name: 'Rival', website: null }, { name: 'X', website: 'enemy.ch' },
        { name: 'Gone', website: null }, { name: 'Nestle', website: null }, { name: 'Other', website: 'https://nestle.com' },
        { name: 'Tiny GmbH', employees: 50 }, { name: 'Bank A', employees: 700, industryMatch: 'Banking' },
        { name: 'Bakery B', employees: 300, industryMatch: 'none' }, { name: 'Canton C', employees: 400, industry: 'Government Administration' },
        { name: 'Unknown size D' }, { name: 'Bank A AG', employees: 650 }, { name: '' } ].map(r => cleanListingRow(r, 'https://l'));
      var F = filterListingRows(ROWS, CTX);
    """)
    check("filter: kept rows", ctx.eval("F.kept.map(r => r.name).join(',')"), "Bank A,Unknown size D")
    check("filter: reasons in order",
          ctx.eval("F.dropped.map(d => d.reason).join(',')"),
          "seller,excluded,excluded,removed,existing,existing,size,industry,orgType,duplicate,noName")
    check("filter: a second call drops what the first kept", ctx.eval("filterListingRows([cleanListingRow({ name: 'Bank A' })], CTX).dropped[0].reason"), "duplicate")
    check("filter: no size targeting keeps every size",
          ctx.eval("filterListingRows([cleanListingRow({ name: 'Huge', employees: 90000 })], { bands: BANDS, sizeBuckets: {}, known: buildKnownCompanies([]) }).kept.length"), 1)
    ctx.eval("""
      var T = bandTargets({ L: { checked: true, priority: 3 }, M: { checked: true, priority: 2 } }, BANDS, 5);
      var P = [ { name: 'L-edge', employees: 990, preScore: 50 }, { name: 'L-centre', employees: 700, preScore: 50 },
        { name: 'L-strong-edge', employees: 510, preScore: 70 }, { name: 'M-centre', employees: 320, preScore: 50 },
        { name: 'M-edge', employees: 210, preScore: 50 }, { name: 'M-far', employees: 499, preScore: 50 },
        { name: 'NoSize', employees: null, preScore: 90 }, { name: 'Included', employees: null, preScore: 0, included: true } ];
    """)
    check("choose: bands L 3, M 2", ctx.eval("JSON.stringify(T.map(b => [b.key, b.count]))"), '[["L",3],["M",2]]')
    check("choose: included first, fit before centre, then centre; no-size last",
          ctx.eval("chooseDiscoveryRows(P, T, 5).map(r => r.name).join(',')"),
          "Included,L-strong-edge,L-centre,M-centre,M-edge")
    check("choose: rows without a headcount fill what is left",
          ctx.eval("chooseDiscoveryRows(P.filter(r => r.name !== 'Included'), T, 8).map(r => r.name).slice(-1)[0]"), "NoSize")


def test_linkedin_after_web(ctx):
    """pipeline-plan.js - 1.2.1 step 4, LinkedIn after the web (onboarding design 7.1-7.3, D2, D7).
    Reuses test_readiness's readyView/CFG/NOW."""
    check("MIN_READY_TO_SCAN is 10 (D7)", ctx.eval("MIN_READY_TO_SCAN"), 10)
    ctx.eval(r"""
    var NOPROF = function (name, level) { return { fullName: name, relevant: true, level: level || null, linkedinUrl: null }; };
    """)
    check("the most senior known contact is looked up first (7.2)",
          ctx.eval("profileContactToTry(readyView({ contacts: [NOPROF('Anna Muster', 'manager'), NOPROF('Carl Weber'), NOPROF('Beat Keller', 'cLevel')] }), {}, NOW).fullName"),
          "Beat Keller")
    check("equal seniority keeps the stored order",
          ctx.eval("profileContactToTry(readyView({ contacts: [NOPROF('Anna Muster', 'head'), NOPROF('Beat Keller', 'head')] }), {}, NOW).fullName"),
          "Anna Muster")
    check("D2: after one name search in this pass, the People page - not a second name search",
          ctx.eval("jobsNeeded(readyView({ contacts: [NOPROF('Anna Muster'), NOPROF('Beat Keller')] }), assessAccount(readyView({ contacts: [NOPROF('Anna Muster'), NOPROF('Beat Keller')] }), CFG, NOW), { profileTried: ['Anna Muster'] }, NOW, { profileSearches: 1 }).join(',')"),
          "contacts")
    check("D2: once the People page has given up, the names are searched again",
          ctx.eval("jobsNeeded(readyView({ contacts: [NOPROF('Anna Muster'), NOPROF('Beat Keller')] }), assessAccount(readyView({ contacts: [NOPROF('Anna Muster'), NOPROF('Beat Keller')] }), CFG, NOW), { profileTried: ['Anna Muster'], attempts: { contacts: ['2026-09-23', '2026-09-24'] } }, NOW, { profileSearches: 1 }).join(',')"),
          "profile")

    # 7.1: the web lane's accounts wait for it
    check("an account the web lane still holds is held", ctx.eval("heldForWebLane({ key: 'a' }, { keys: ['a'], since: NOW - 3600000 }, NOW)"), True)
    check("an account the lane does not hold is not", ctx.eval("heldForWebLane({ key: 'b' }, { keys: ['a'], since: NOW - 3600000 }, NOW)"), False)
    check("after a day the lane holds nothing", ctx.eval("heldForWebLane({ key: 'a' }, { keys: ['a'], since: NOW - 25 * 3600000 }, NOW)"), False)
    check("no lane run, no hold", ctx.eval("heldForWebLane({ key: 'a' }, null, NOW)"), False)
    ctx.eval(r"""
    function rentries(views) { return views.map(function (v) { return { view: v, assessment: assessAccount(v, CFG, NOW), pipeline: {} }; }); }
    var HQ = readyView({ key: 'hq', salesTeamPriority: 'P1', globalHqCountry: null, contacts: [] });   // needs the web for its HQ
    var FAR = readyView({ key: 'far', salesTeamPriority: 'P2', contacts: [] });                        // People page, ~2 touches
    var NEAR = readyView({ key: 'near', salesTeamPriority: 'P3', contacts: [NOPROF('Anna Muster')] }); // one name search
    function order(opts) { return rankCandidates(rentries([HQ, FAR, NEAR]), NOW, 2, opts).map(function (e) { return e.view.key; }).join(','); }
    """)
    check("a held account is not offered to LinkedIn",
          ctx.eval("order({ webLaneHold: { keys: ['far'], since: NOW - 60000 } })"), "hq,near")
    check("HQ gap is not closable by LinkedIn", ctx.eval("readyByLinkedin(assessAccount(HQ, CFG, NOW))"), False)
    check("without the goal: priority first", ctx.eval("order({})"), "hq,far,near")
    check("under 10 Ready (D7): accounts LinkedIn can make Ready, fewest touches first, ahead of priority",
          ctx.eval("order({ readyGoal: true })"), "near,far,hq")

    # The Scanner's estimate
    check("time left: 4 accounts at the planning figure", ctx.eval("readyEtaMinutes(6, 10)"), 25)
    check("time left: never under 5 minutes", ctx.eval("readyEtaMinutes(9, 10, 1)"), 5)
    check("time left: goal met", ctx.eval("readyEtaMinutes(12, 10)"), 0)
    check("measured pace only after 3 Ready", ctx.eval("measuredMinutesPerReady({ readyMade: 2, workMs: 600000 })"), None)
    check("measured pace", ctx.eval("measuredMinutesPerReady({ readyMade: 4, workMs: 4 * 300000 })"), 5)

    # 1.2.0.13: the web lane first takes the accounts it can make Ready on its own
    check("only a contact missing: the web can make it Ready",
          ctx.eval("onlyContactMissing(assessAccount(readyView({ contacts: [NOPROF('Anna Muster')] }), CFG, NOW))"), True)
    check("a LinkedIn re-check missing too: not by the web alone",
          ctx.eval("onlyContactMissing(assessAccount(Object.assign(readyView({ contacts: [] }), { provenance: Object.assign({}, readyView().provenance, { linkedinCompanyId: { src: 'linkedin', at: NOW, link: null, v: '1234' } }) }), CFG, NOW))"), False)
    check("a Ready account is not a candidate", ctx.eval("onlyContactMissing(assessAccount(readyView(), CFG, NOW))"), False)
    check("lane order: ready-by-web first, ahead of traded and priority",
          ctx.eval("webLaneOrder([{ key: 'a', isPublic: true, priority: 'P1' }, { key: 'b', isPublic: false, priority: 'P3', readyByWeb: true }]).map(function (e) { return e.key; }).join(',')"), "b,a")


def test_setup_proposals(ctx):
    """1.2.1 step 5: setup-proposals.js - the seller research's answer mapped onto the wizard's own options (design 3.4)."""
    ctx.eval("""
      var SP_CTX = {
        countries: ["Austria", "Germany", "Switzerland", "United Kingdom", "United States", "France", "Netherlands", "Belgium", "Luxembourg"],
        sizeBuckets: [
          { key: "S", label: "Small", min: 0, max: 200 }, { key: "M", label: "Medium", min: 201, max: 500 },
          { key: "L", label: "Large", min: 501, max: 1000 }, { key: "XL", label: "Extra Large", min: 1001, max: 5000 },
          { key: "XXL", label: "Extra Extra Large", min: 5001, max: Infinity } ],
        industries: ["Energy", "Financials", "Health Care", "Industrials", "Information Technology"],
        orgTypes: ["Non-profit Organizations", "Government Administration", "Higher Education"],
        sellerName: "Acme AG", sellerWebsite: "https://www.acme.ch",
      };
      var SP_RAW = {
        summary: { text: "Acme builds   data platforms.", url: "https://acme.ch/about" },
        idealCustomer: { text: "Mid-sized manufacturers.", url: "https://acme.ch/customers" },
        sellsToCountries: [{ name: "Schweiz", url: "https://acme.ch/de" }, { name: "DACH", url: "https://acme.ch/offices" },
                           { name: "Atlantis", url: "https://acme.ch/x" }, { name: "UK", url: "https://acme.ch/uk" }],
        customerSizes: [{ text: "companies with 200-1,000 employees", url: "https://acme.ch/customers" }],
        customerIndustries: [{ name: "Banking", sector: "Financials", url: "https://acme.ch/banks" },
                             { name: "Medical devices", sector: "Health Care", url: "https://acme.ch/medtech" },
                             { name: "Quantum basket weaving", sector: "Basketry", url: "https://acme.ch/q" },
                             { name: "Energy", sector: null, url: "https://acme.ch/energy" }],
        organizationTypes: [{ name: "Public sector", url: "https://acme.ch/public" }, { name: "Space pirates", url: "https://acme.ch/p" }],
        buyerTitles: [{ title: "Chief Data Officer", url: "https://acme.ch/c" }, { title: "Head of Data Platform", url: "https://acme.ch/c" },
                      { title: "CTO", url: "https://acme.ch/c" }, { title: "Head of Data Engineering", url: "https://acme.ch/c" },
                      { title: "chief data officer", url: "https://acme.ch/c" }],
        resources: [{ title: "Data maturity report", url: "https://acme.ch/report" },
                    { title: "Webinar on shop.acme.ch", url: "https://shop.acme.ch/webinar" },
                    { title: "Gartner quadrant", url: "https://gartner.com/acme" },
                    { title: "No link at all" }],
        competitors: [{ name: "Rival AG", website: "rival.ch", url: "https://acme.ch/compare" },
                      { name: "Ghost GmbH", website: null, url: null },
                      { name: "Acme", website: "acme.ch", url: "https://acme.ch" }],
        customers: [{ name: "Rival AG", website: "https://www.rival.ch", url: "https://acme.ch/c" },
                    { name: "Big Bank", website: null, url: "https://acme.ch/case/bigbank" }],
        partners: [{ name: "Cloudco", website: "https://cloudco.com", url: null }],
        siteLanguage: "de-CH",
      };
      var SP = buildSetupProposals(SP_RAW, SP_CTX);
    """)
    j = lambda e: ctx.eval("JSON.stringify(%s)" % e)
    check("countries: website country first, local name, region, alias; Atlantis dropped", j("SP.location.value"), '["Switzerland","Germany","Austria","United Kingdom"]')
    check("countries: the dropped name is listed", j("SP.location.dropped"), '["Atlantis"]')
    check("country: ISO code", j("mapCountryName('US', SP_CTX.countries)"), '["United States"]')
    check("country: Benelux", j("mapCountryName('Benelux', SP_CTX.countries)"), '["Belgium","Netherlands","Luxembourg"]')
    check("country: Europe is too broad", j("mapCountryName('Europe', SP_CTX.countries)"), '[]')
    check("country: not in the picker -> nothing", j("mapCountryName('Japan', SP_CTX.countries)"), '[]')
    check("website country: .ch", ctx.eval("websiteCountry('https://www.timetoact-group.ch/ueber-uns', SP_CTX.countries)"), "Switzerland")
    check("website country: .co.uk", ctx.eval("websiteCountry('acme.co.uk', SP_CTX.countries)"), "United Kingdom")
    check("website country: .com says nothing", ctx.eval("websiteCountry('acme.com', SP_CTX.countries)"), None)
    ctx.eval("""var SP_GROUP = buildSetupProposals({ sellsToCountries: [
        { name: "Germany", scope: "group", url: "https://g.ch/a" }, { name: "Switzerland", scope: "company", url: "https://g.ch/a" },
        { name: "Austria", scope: "group", url: "https://g.ch/a" }, { name: "Netherlands", url: "https://g.ch/b" } ] },
        Object.assign({}, SP_CTX, { sellerWebsite: "https://www.g.ch" }), ["location"]).location;""")
    check("group site: own country first, company countries ticked, group ones not", j("SP_GROUP.value"), '["Switzerland","Netherlands"]')
    check("group site: group countries named for the note", j("SP_GROUP.group"), '["Germany","Austria"]')
    check("group site: only group countries -> still the website's country",
          j("buildSetupProposals({ sellsToCountries: [{ name: 'Germany', scope: 'group', url: 'https://g.ch' }] }, Object.assign({}, SP_CTX, { sellerWebsite: 'g.ch' }), ['location']).location.value"), '["Switzerland"]')
    check("website country alone is not a finding",
          ctx.eval("buildSetupProposals({}, Object.assign({}, SP_CTX, { sellerWebsite: 'g.ch' }), ['location']).location.found"), False)
    check("size: 200-1,000 -> M, L (only touches Small at 200)", j("SP.size.value"), '["M","L"]')
    check("size: 500+", j("sizeBandsForStatement({ text: 'over 500 employees' }, SP_CTX.sizeBuckets)"), '["L","XL","XXL"]')
    check("size: up to 200", j("sizeBandsForStatement({ text: 'up to 200 staff' }, SP_CTX.sizeBuckets)"), '["S"]')
    check("size: numbers given as fields", j("sizeBandsForStatement({ minEmployees: 1000, maxEmployees: null }, SP_CTX.sizeBuckets)"), '["XL","XXL"]')
    check("size: SMEs", j("sizeBandsForStatement({ text: 'SMEs' }, SP_CTX.sizeBuckets)"), '["S","M"]')
    check("size: large enterprises", j("sizeBandsForStatement({ text: 'large enterprises' }, SP_CTX.sizeBuckets)"), '["L","XL","XXL"]')
    check("size: 10k+", j("sizeBandsForStatement({ text: '10k+ employees' }, SP_CTX.sizeBuckets)"), '["XXL"]')
    check("size: no size words -> nothing", j("sizeBandsForStatement({ text: 'innovative companies' }, SP_CTX.sizeBuckets)"), '[]')
    check("industries: sector names only from the wizard's list", j("SP.industry.value"), '["Financials","Health Care","Energy"]')
    check("industries: a made-up sector is never ticked", ctx.eval("SP.industry.value.indexOf('Basketry')"), -1)
    check("industries: not exact names go to the Ideal customer note", j("SP.industry.unmapped"), '["Banking","Medical devices","Quantum basket weaving"]')
    check("org types: public sector -> Government Administration, nonsense dropped", j("SP.industry.orgTypes"), '["Government Administration"]')
    check("icp: draft plus the industries the wizard cannot tick", ctx.eval("SP.icp.value"),
          "Mid-sized manufacturers.\n\nCustomer industries: Banking, Medical devices, Quantum basket weaving.")
    check("what you sell: text tidied", ctx.eval("SP['company-context'].value"), "Acme builds data platforms.")
    check("what you sell: source", j("SP['company-context'].sources"), '["https://acme.ch/about"]')
    check("titles: de-duplicated case-insensitively", j("SP.contacts.exactTitles"), '["Chief Data Officer","Head of Data Platform","CTO","Head of Data Engineering"]')
    check("keywords: words that recur, no seniority words", j("SP.contacts.keywords"), '["Data"]')
    check("seniority: C-level (CTO too) and Head", j("SP.contacts.seniority"), '["cLevel","head"]')
    check("seniority: 'cargo' is not C-level", ctx.eval("seniorityOfTitle('Head of cargo')"), "head")
    check("resources: own domain and subdomain only", j("SP['value-add-offers'].items.map(r => r.url)"), '["https://acme.ch/report","https://shop.acme.ch/webinar"]')
    check("resources: third-party and unlinked dropped", ctx.eval("SP['value-add-offers'].dropped"), 2)
    check("offer line", ctx.eval("offerLine({ text: 'Data maturity report', url: 'https://acme.ch/report' })"), "Data maturity report - https://acme.ch/report")
    check("exclusions: no website/source dropped, seller dropped, listed twice dropped",
          j("SP.exclusions.items.map(e => e.category + ':' + e.name + ':' + (e.domain || ''))"),
          '["competitor:Rival AG:rival.ch"]')
    check("relationships (1.2.3): customers and partners on their own step",
          j("SP.relationships.items.map(e => e.category + ':' + e.name + ':' + (e.domain || ''))"),
          '["customer:Big Bank:","partner:Cloudco:cloudco.com"]')
    check("relationships: research again on that step rebuilds only it", j("Object.keys(buildSetupProposals(SP_RAW, SP_CTX, ['relationships']))"), '["relationships"]')
    check("about: site language -> output language", ctx.eval("SP.about.outputLanguage"), "german")
    check("about: Italian site -> no proposal", ctx.eval("outputLanguageForSite('it')"), None)
    check("only: one step rebuilt", j("Object.keys(buildSetupProposals(SP_RAW, SP_CTX, ['size']))"), '["size"]')
    check("nothing found: empty answer", j("Object.values(buildSetupProposals({}, SP_CTX)).map(p => p.found)"), '[false,false,false,false,false,false,false,false,false,false]')
    check("source label", ctx.eval("sourceLabel('https://www.acme.ch/about/')"), "acme.ch/about")
    check("ticked: first setup, all", j("initiallyTicked(['a', 'b'], [], false)"), '[true,true]')
    check("ticked: completed before, only those saved", j("initiallyTicked(['a', 'B'], ['b'], true)"), '[false,true]')
    check("merge: ticked first, unticked removed even from the free lines, de-duplicated",
          j("mergeChecklistWithLines([{ text: 'CDO', checked: true }, { text: 'CTO', checked: false }], ['cto', 'COO', 'cdo'])"), '["CDO","COO"]')


def test_targets_and_estimate(ctx):
    """1.2.1 step 6: targets, initiative stages, the stop rule (design 8) and the estimate (design 9)."""
    j = lambda e: ctx.eval("JSON.stringify(%s)" % e)
    import json
    v = lambda e: json.loads(j(e))
    # normalizeCompletionTargets: defaults, range, cap by max contacts per account
    check("targets: empty -> defaults", v("normalizeCompletionTargets(null)"), {"accounts": 100, "contactsPerAccount": 3, "initiativesPerAccount": 1})
    check("targets: clamped", v("normalizeCompletionTargets({accounts: 5, contactsPerAccount: 40, initiativesPerAccount: -1})"),
          {"accounts": 10, "contactsPerAccount": 10, "initiativesPerAccount": 0})
    check("targets: capped by max contacts", v("normalizeCompletionTargets({accounts: 250, contactsPerAccount: 5}, 2)")["contactsPerAccount"], 2)
    check("targets: blank field -> default", v("normalizeCompletionTargets({accounts: ''})")["accounts"], 100)
    # initiative stages
    st = v("normalizeInitiativeStages([{id:'pilot', checked:true}, {id:'poc', checked:false}, {id:'bogus'}, 'pilot'])")
    check("stages: user order first, all seven", [s["id"] for s in st][:2] + [len(st)], ["pilot", "poc", 7])
    check("stages: unticked kept unticked", st[1]["checked"], False)
    check("stages: missing ones added ticked", st[6]["checked"], True)
    check("stage counts: unticked stage does not count", v("initiativeCounts('poc', [{id:'poc', checked:false}])"), False)
    check("stage counts: no stage counts", v("initiativeCounts(null, [{id:'poc', checked:false}])"), True)
    check("stage counts: ticked counts", v("initiativeCounts('scaling', [])"), True)
    # targetsStatus
    ctx.eval("""var TS_E = [
      {state:'ready', relevantContacts:3, initiatives:1}, {state:'usable', relevantContacts:1, initiatives:2},
      {state:'in_progress', relevantContacts:0, initiatives:0}, {state:'needs_decision', relevantContacts:5, initiatives:5},
      {state:'lacking_evidence', relevantContacts:0, initiatives:0}];""")
    ts = v("targetsStatus(TS_E, {accounts: 10, contactsPerAccount: 3, initiativesPerAccount: 1})")
    check("status: only ready/usable/in_progress count", [ts["accounts"], ts["ready"], ts["usable"], ts["accountsOwed"]], [3, 1, 1, 7])
    check("status: per-account coverage", [ts["contactsMet"], ts["initiativesMet"], ts["enrichOwed"]], [1, 2, 2])
    check("status: discover while owed", ts["action"], "discover")
    check("status: discovery not allowed -> enrich", v("targetsStatus(TS_E, {accounts: 10}, {discoveryAllowed:false}).action"), "enrich")
    check("status: all met -> idle", v("targetsStatus([{state:'ready', relevantContacts:3, initiatives:1}], {accounts: 1}).action"), "idle")
    check("status: lowering the target never asks to remove", v("targetsStatus(TS_E, {accounts: 1}).accountsOwed"), 0)
    # discoveryMayRun
    check("discovery: never run -> may", v("discoveryMayRun(null, 100, 0)"), True)
    check("discovery: same target, a day later -> no", v("discoveryMayRun({accountsTarget:100, at:0}, 100, 86400000)"), False)
    check("discovery: target raised -> may", v("discoveryMayRun({accountsTarget:100, at:0}, 150, 1000)"), True)
    check("discovery: a week later -> may", v("discoveryMayRun({accountsTarget:100, at:0}, 100, 7*86400000)"), True)
    # coverage lines
    lines = v("coverageLines(targetsStatus(TS_E, {accounts: 10, contactsPerAccount: 3, initiativesPerAccount: 1}))")
    check("coverage lines", lines, ["Accounts: 3 of 10 in the list.", "Contacts: 1 of 3 accounts have 3.", "Initiatives: 2 of 3 accounts have 1 relevant initiative."])
    lines = v("coverageLines({ targets: { accounts: 100, contactsPerAccount: 3, initiativesPerAccount: 0 }, accounts: 108, contactsMet: 54 })")
    check("coverage lines over target", lines[0], "Accounts: 108 in the list, target 100 ✓.")
    check("coverage: no initiative line at target 0", len(v("coverageLines(targetsStatus([], {accounts: 10, initiativesPerAccount: 0}))")), 2)
    # onboardingEstimate - a clean install, 100 accounts
    e = v("onboardingEstimate({accounts: 100})")
    check("estimate: clean install discovers and builds all", [e["toDiscover"], e["toBuild"]], [100, 100])
    check("estimate: money", [round(e["usdLow"], 2), round(e["usdHigh"], 2)], [14.0, 24.0])
    check("estimate: LinkedIn 260 touches, ~4.3 days", [e["touches"], round(e["days"], 1)], [260, 4.3])
    check("estimate: web lane 11 minutes", e["webMinutes"], 11)
    check("estimate: budget rounded up to US$5", e["budgetUsd"], 25)
    check("estimate: text", e["text"], "100 accounts: about 4-5 days of your daily LinkedIn limit and about US$14-24 on your Anthropic API key. "
          "SalesTeam finds 100 new accounts on the web. Your accounts will be usable within the hour; the first Ready ones within the day.")
    # an existing list: 550 accounts, 160 Ready -> nothing to discover, nothing to build for a 100 target
    check("estimate: list already big enough", v("onboardingEstimate({accounts: 100, existing: 550, ready: 160})").get("toBuild"), 0)
    check("estimate: says the real Ready count (Boaz, 2026-10-01)", v("onboardingEstimate({accounts: 100, existing: 541, ready: 121})")["text"],
          "100 accounts: your list already has 121 Ready accounts - nothing more to build.")
    e2 = v("onboardingEstimate({accounts: 300, existing: 250, ready: 100})")
    check("estimate: existing list, part to build", [e2["toDiscover"], e2["toBuild"]], [50, 200])
    # measured averages take over at 20 accounts
    e3 = v("onboardingEstimate({accounts: 100, measured: {lane: {accounts: 20, usd: 3, seconds: 400}, discovery: {accounts: 19, usd: 10}}})")
    check("estimate: measured lane used, discovery not yet", [round(e3["usdLow"], 2), e3["measured"]["lane"], e3["measured"]["discovery"]], [17.0, True, False])
    check("suggestedBudget minimum", v("suggestedBudget(0.4)"), 5)


def test_same_brand_domain(ctx):
    """1.2.0.27: offers on a sibling domain of the same brand (timetoact.ch -> timetoact-group.ch) are kept."""
    e = lambda x: ctx.eval(x)
    check("brand label: plain", e("brandLabel('www.timetoact.ch')"), "timetoact")
    check("brand label: co.uk", e("brandLabel('acme-group.co.uk')"), "acme-group")
    check("sibling: -group domain", e("isOnDomain('https://www.timetoact-group.ch/en/whitepaper', 'timetoact.ch')"), True)
    check("sibling: other country ending", e("isOnDomain('https://acme.de/report', 'acme.ch')"), True)
    check("sibling: reverse", e("isOnDomain('https://www.timetoact.ch/x', 'timetoact-group.ch')"), True)
    check("other company refused", e("isOnDomain('https://www.gartner.com/report', 'timetoact.ch')"), False)
    check("partial word refused", e("isOnDomain('https://acmecorp.com/x', 'acme.ch')"), False)
    check("short brand refused", e("isOnDomain('https://ab-group.ch/x', 'ab.ch')"), False)
    check("subdomain still works", e("isOnDomain('https://blog.acme.ch/x', 'acme.ch')"), True)

def test_title_brackets(ctx):
    """1.2.0.29: a translation in brackets is not part of a title."""
    e = lambda x: ctx.eval(x)
    check("brackets: translation dropped", e("titleWithoutBrackets('Mitglied der Geschäftsleitung (Member of Executive Board)')"), "Mitglied der Geschäftsleitung")
    check("brackets: square", e("titleWithoutBrackets('Head of IT [CIO]')"), "Head of IT")
    check("brackets: none", e("titleWithoutBrackets('Director Marketing')"), "Director Marketing")
    check("brackets: mapped proposal", e("buildSetupProposals({buyerTitles:[{title:'CEO'},{title:'Leiter IT (Head of IT)'}]}, {}, ['contacts']).contacts.exactTitles.join('|')"), "CEO|Leiter IT")

def test_login_wall(ctx):
    """1.2.0.32: LinkedIn's login wall is recognised, so a logged-out browser stops the run instead of counting accounts as not found."""
    e = lambda x: ctx.eval(x)
    for url, want in [
        ("https://www.linkedin.com/authwall?trk=gf&sessionRedirect=x", True),
        ("https://www.linkedin.com/login?session_redirect=x", True),
        ("https://www.linkedin.com/uas/login?x=1", True),
        ("https://www.linkedin.com/checkpoint/lg/login", True),
        ("https://ch.linkedin.com/signup/cold-join", True),
        ("https://www.linkedin.com/search/results/companies/?keywords=Repower", False),
        ("https://www.linkedin.com/company/repower/", False),
        ("https://www.linkedin.com/company/loginsoft/", False),
        ("", False),
    ]:
        check("login wall: " + url, e("isLinkedinLoginWall(%s)" % repr(url)), want)
    check("logged out 10 min ago -> wait", e("linkedinLoggedOutRecently(1, 10*60000)"), True)
    check("logged out 31 min ago -> try again", e("linkedinLoggedOutRecently(1, 31*60000+1)"), False)
    check("never logged out", e("linkedinLoggedOutRecently(null, 5)"), False)


def test_team_merge(ctx):
    """1.2.2 step 1 (TEAM_USE_DESIGN.md 4, 6, 7): the merge engine gives the same picture on every PC."""
    e = lambda x: ctx.eval(x)
    # A small world: three members, a few changes each, written with real clocks.
    e("""
      var M = 60000;
      function st(wall, counter, member) { return formatStamp(wall, counter, member); }
      var T0 = 1759480000000;
      var CH = [
        {t: st(T0,     0, 'anna'), e: 'account', id: 'c-1', op: 'set', f: {status: 'New', city: 'Bern'}},
        {t: st(T0+1000,0, 'ben'),  e: 'account', id: 'c-1', op: 'set', f: {status: 'Contacted'}},
        {t: st(T0+2000,0, 'anna'), e: 'account', id: 'c-1', op: 'set', f: {status: 'Meeting'}},
        {t: st(T0+500, 0, 'cleo'), e: 'account', id: 'c-2', op: 'set', f: {status: 'New'}},
        {t: st(T0+600, 0, 'cleo'), e: 'account', id: 'c-2', op: 'delete'},
        {t: st(T0+700, 0, 'ben'),  e: 'account', id: 'c-3', op: 'set', f: {status: 'New'}},
        {t: st(T0+800, 0, 'anna'), e: 'account', id: 'c-3', op: 'delete'},
        {t: st(T0+900, 0, 'ben'),  e: 'account', id: 'c-3', op: 'set', f: {note: 'still interested'}},
        {t: st(T0+100, 0, 'ben'),  e: 'contact', id: 'p-9', op: 'touch', note: 'InMail'},
        {t: st(T0+150, 0, 'anna'), e: 'contact', id: 'p-9', op: 'touch', note: 'Call'},
        {t: st(T0+1000,0, 'anna'), e: 'account', id: 'c-5', op: 'assign'},
        {t: st(T0+1000,0, 'ben'),  e: 'account', id: 'c-5', op: 'assign'},
        {t: st(T0+3000,0, 'anna'), e: 'account', id: 'c-6', op: 'assign'},
        {t: st(T0+4000,0, 'anna'), e: 'account', id: 'c-6', op: 'unassign'},
        {t: st(T0+5000,0, 'ben'),  e: 'account', id: 'c-6', op: 'assign'},
        {t: st(T0+6000,0, 'admin'),e: 'account', id: 'c-7', op: 'assign', member: 'cleo'},
      ];
      function viewAll(s) {
        var out = {};
        ['c-1','c-2','c-3','c-5','c-6','c-7'].forEach(function (id) {
          out[id] = {v: entityView(s, 'account', id), a: assignee(s, 'account', id)};
        });
        out.touches = touches(s, 'contact', 'p-9');
        out.lost = lostValues(s);
        return JSON.stringify(out);
      }
      function rng(seed) { return function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }
      function shuffled(list, seed) {
        var a = list.slice(), r = rng(seed);
        for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var x = a[i]; a[i] = a[j]; a[j] = x; }
        return a;
      }
      var S = newState(); applyChanges(S, CH);
      var REF = viewAll(S);
    """)

    # The property everything rests on: any order, any repetition -> the same result.
    orders_same = e("""
      (function () {
        for (var seed = 1; seed <= 40; seed++) {
          var s = newState();
          var list = shuffled(CH, seed);
          applyChanges(s, list);
          applyChanges(s, shuffled(CH, seed + 100));   // every file read twice
          if (viewAll(s) !== REF) return seed;
        }
        return 0;
      })()""")
    check("team merge: 40 shuffled orders + re-reads give the identical state", orders_same, 0)

    check("team merge: later stamp wins a field", e("entityView(S,'account','c-1').values.status"), "Meeting")
    check("team merge: untouched field kept", e("entityView(S,'account','c-1').values.city"), "Bern")
    check("team merge: who changed it", e("entityView(S,'account','c-1').changedBy.status.member"), "anna")
    check("team merge: overwritten values are kept, oldest first",
          e("JSON.stringify(lostValues(S,{e:'account',id:'c-1'}).map(function(x){return x.v;}))"), '["New","Contacted"]')
    check("team merge: delete after the last change -> gone", e("entityView(S,'account','c-2').exists"), False)
    check("team merge: change after a delete revives the row", e("entityView(S,'account','c-3').exists"), True)
    check("team merge: both touches kept, in order",
          e("JSON.stringify(touches(S,'contact','p-9').map(function(x){return x.member+':'+x.note;}))"), '["ben:InMail","anna:Call"]')
    check("team merge: same-millisecond assignments -> fixed tie-break (member id)", e("assignee(S,'account','c-5').member"), "anna")
    check("team merge: released then taken by a colleague", e("assignee(S,'account','c-6').member"), "ben")
    check("team merge: admin assigns to someone else", e("assignee(S,'account','c-7').member"), "cleo")
    check("team merge: malformed / half-written records are ignored, never throw",
          e("(function(){var s=newState(); return applyChanges(s,[null,{},{t:'x',e:'account',id:'a',op:'set'},{t:st(T0,0,'a'),e:'nope',id:'a',op:'set'},{t:st(T0,0,'a'),e:'account',id:'',op:'set'}]);})()"), 0)

    # Clock: never backwards, moves past a colleague's later stamp.
    check("team clock: same ms -> counter", e("(function(){var c=createClock('a'); tick(c,T0); return tick(c,T0);})()"),
          e("st(T0,1,'a')"))
    check("team clock: PC clock went back -> still increases", e("(function(){var c=createClock('a'); tick(c,T0); return tick(c,T0-5000);})()"),
          e("st(T0,1,'a')"))
    check("team clock: after seeing a later stamp, the next sorts after it",
          e("(function(){var c=createClock('a'); tick(c,T0); observe(c, st(T0+9000,3,'b')); return tick(c,T0+10) > st(T0+9000,3,'b');})()"), True)
    check("team clock: stamps sort as strings across digit lengths", e("st(999,0,'a') < st(1000,0,'a')"), True)

    # Claims: earliest active wins; expiry by idleness or heartbeat; release.
    e("""
      var C = newState();
      applyChanges(C, [
        {t: st(T0+200, 0, 'ben'),  e: 'account', id: 'k', op: 'claim'},
        {t: st(T0+100, 0, 'anna'), e: 'account', id: 'k', op: 'claim'},
      ]);
      var SEEN = {anna: T0+1000, ben: T0+1000};
    """)
    check("team claim: earliest claim wins", e("claimHolder(C,'account','k',{now:T0+2000,lastSeen:SEEN}).member"), "anna")
    check("team claim: both profiles agree (other order)",
          e("(function(){var s=newState(); applyChanges(s,[{t:st(T0+100,0,'anna'),e:'account',id:'k',op:'claim'},{t:st(T0+200,0,'ben'),e:'account',id:'k',op:'claim'}]); return claimHolder(s,'account','k',{now:T0+2000,lastSeen:SEEN}).member;})()"),
          "anna")
    check("team claim: idle 5 min -> expired, next in line holds it",
          e("(function(){applyChanges(C,[{t:st(T0+6*M,0,'ben'),e:'account',id:'k',op:'set',f:{x:1}}]); return claimHolder(C,'account','k',{now:T0+6*M,lastSeen:{anna:T0+6*M,ben:T0+6*M}}).member;})()"),
          "ben")
    check("team claim: holder's heartbeat too old -> not a holder",
          e("JSON.stringify(activeClaims(C,'account','k',{now:T0+6*M,lastSeen:{anna:T0+6*M}}))"), "[]")
    check("team claim: release ends it, a new claim starts fresh",
          e("(function(){var s=newState(); applyChanges(s,[{t:st(T0,0,'anna'),e:'account',id:'r',op:'claim'},{t:st(T0+10,0,'anna'),e:'account',id:'r',op:'release'},{t:st(T0+20,0,'ben'),e:'account',id:'r',op:'claim'}]); return claimHolder(s,'account','r',{now:T0+30,lastSeen:{anna:T0+30,ben:T0+30}}).member;})()"),
          "ben")

    # Confirmation (design 6.3).
    check("team confirm: every active colleague has written after the claim -> confirmed",
          e("isClaimConfirmed(st(T0,0,'anna'),{me:'anna',activeMembers:['anna','ben','cleo'],readUpTo:{ben:T0+1,cleo:T0+5}})"), True)
    check("team confirm: one colleague not yet heard from since -> not yet",
          e("isClaimConfirmed(st(T0,0,'anna'),{me:'anna',activeMembers:['anna','ben','cleo'],readUpTo:{ben:T0+1,cleo:T0}})"), False)
    check("team confirm: alone in the team -> confirmed at once",
          e("isClaimConfirmed(st(T0,0,'anna'),{me:'anna',activeMembers:['anna'],readUpTo:{}})"), True)

    # Pipeline shares (design 6.5).
    check("team share: deterministic and independent of member order",
          e("pipelineOwner('c-42',['ben','anna','cleo']) === pipelineOwner('c-42',['cleo','anna','ben'])"), True)
    moved = e("""
      (function () {
        var ids = []; for (var i = 0; i < 600; i++) ids.push('c-' + i);
        var three = ['anna','ben','cleo'], four = ['anna','ben','cleo','dan'];
        var moved = 0, wrong = 0, counts = {anna:0, ben:0, cleo:0};
        ids.forEach(function (id) {
          var a = pipelineOwner(id, three), b = pipelineOwner(id, four);
          counts[a]++;
          if (a !== b) { moved++; if (b !== 'dan') wrong++; }
        });
        return JSON.stringify({moved: moved, wrong: wrong, min: Math.min(counts.anna, counts.ben, counts.cleo)});
      })()""")
    import json
    moved = json.loads(moved)
    check("team share: a joining member only takes accounts, nobody else's move", moved["wrong"], 0)
    check("team share: about a quarter move to the new member", 100 < moved["moved"] < 200, True)
    check("team share: three members get roughly equal shares", moved["min"] > 150, True)


def test_team_rows(ctx):
    """1.2.2 step 2 (TEAM_USE_DESIGN.md 4.1, 5.2, 5.3): local values <-> rows <-> change records, end to end."""
    e = lambda x: ctx.eval(x)
    e("""
      var WB = {
        companies: [
          {companyId: 'c-1', company: 'Acme AG', status: 'New', city: 'Bern'},
          {companyId: 'c-2', company: 'Beta SA', status: 'New'},
          {companyId: 'c-1', company: 'Acme duplicate'},
          {company: 'No id GmbH'}
        ],
        contacts: [{contactId: 'p-1', companyId: 'c-1', fullName: 'Ann Muster'}],
        aiInitiatives: [],
        aiInvestment: [{companyId: 'c-1', amount: 5}],
        sources: [{companyId: 'c-2', url: 'https://x'}],
        version: 3
      };
      var LEADS = {
        'lead-a': {author: 'Ann', status: 'New', draftMessage: 'Hi Ann', mentorHistory: [1, 2]},
        'lead-b': {author: 'Ben', status: 'Contacted'}
      };
      function jsonOf(v) { return JSON.stringify(v); }
      function rebuild(key, value) { return patchValue(key, undefined, extractRows(key, value)); }
      // Field order inside a row does not matter to the app; row order and content do.
      function deepSorted(v) {
        if (Array.isArray(v)) return v.map(deepSorted);
        if (v && typeof v === 'object') { var o = {}; Object.keys(v).sort().forEach(function (k) { o[k] = deepSorted(v[k]); }); return o; }
        return v;
      }
      function canonicalWb(wb) { return JSON.stringify(deepSorted(wb)); }
      // Simulates a member: local values -> diff against its shadow -> stamped change records.
      function Member(id, t0) {
        this.clock = createClock(id); this.now = t0; this.shadow = {}; this.state = newState(); this.sent = [];
      }
      Member.prototype.emit = function (key, value) {
        var d = diffRows(this.shadow[key] || {}, extractRows(key, value));
        this.shadow[key] = d.shadow;
        var self = this, out = [];
        d.sets.forEach(function (s) {
          var f = s.f;
          if (s.isNew) { var st = staleFieldUnsets(self.state, s.e, s.id, f); for (var k in st) if (!(k in f)) f[k] = st[k]; }
          self.now += 10;
          out.push({t: tick(self.clock, self.now), e: s.e, id: s.id, op: 'set', f: f});
        });
        d.dels.forEach(function (x) { self.now += 10; out.push({t: tick(self.clock, self.now), e: x.e, id: x.id, op: 'delete'}); });
        applyChanges(this.state, out);
        this.sent = this.sent.concat(out);
        return out;
      };
    """)
    # 1. Round trip: rows -> value gives the value back (duplicates and id-less rows travel with the rest).
    check("team rows: workbook round trip keeps every row, duplicates and id-less rows at the end",
          e("canonicalWb(rebuild('targetAccountsWorkbook', WB))"),
          e("canonicalWb(WB)"))
    check("team rows: workbook rows are keyed by home + id",
          e("jsonOf(Array.from(extractRows('targetAccountsWorkbook', WB).keys()))"),
          '["account|wb:c-1","account|wb:c-2","contact|wb:p-1","setting|wb:rest"]')
    check("team rows: personal lead fields never become row fields",
          e("jsonOf(extractRows('results', LEADS).get('lead|lead-a'))"), '{"author":"Ann","status":"New"}')
    check("team rows: a whole setting is one row with $v",
          e("jsonOf(rebuild('negativeTopics', ['jobs', 'hiring']))"), '["jobs","hiring"]')
    check("team rows: a map whose entries are not objects round-trips",
          e("jsonOf(rebuild('discoveryNameDecisions', {a: 'same', b: 'different'}))"), '{"a":"same","b":"different"}')
    check("team rows: a claim on a bare company id is not a row", e("rowTarget('account', 'c-1')"), None)
    check("team rows: an unknown key is not shared", e("extractRows('anthropicApiKey', 'sk-x').size"), 0)

    # 2. The diff: one field changed, one removed, a row added, a row deleted.
    e("""
      var shadow0 = diffRows({}, extractRows('targetAccounts', {acme: {score: 1, note: 'x'}, beta: {score: 2}})).shadow;
      var D = diffRows(shadow0, extractRows('targetAccounts', {acme: {score: 5}, gamma: {score: 3}}));
    """)
    check("team rows: diff sends only the changed field and clears the removed one",
          e("jsonOf(D.sets[0])"), '{"e":"account","id":"ta:acme","f":{"score":5,"note":{"$unset":1}},"isNew":false}')
    check("team rows: diff sends a new row whole", e("jsonOf(D.sets[1])"), '{"e":"account","id":"ta:gamma","f":{"score":3},"isNew":true}')
    check("team rows: diff deletes a row that is gone", e("jsonOf(D.dels)"), '[{"e":"account","id":"ta:beta"}]')
    check("team rows: no change, no records",
          e("diffRows(D.shadow, extractRows('targetAccounts', {acme: {score: 5}, gamma: {score: 3}})).sets.length"), 0)
    check("team rows: field order does not count as a change",
          e("diffRows(D.shadow, extractRows('targetAccounts', {gamma: {score: 3}, acme: {score: 5}})).sets.length"), 0)

    # 3. End to end: Anna's changes reach Ben's local copy exactly; Ben's personal lead fields survive.
    e("""
      var anna = new Member('anna', 1759480000000), ben = new Member('ben', 1759480000005);
      var base = anna.emit('targetAccountsWorkbook', WB).concat(anna.emit('results', LEADS));
      applyChanges(ben.state, base);
      var benWb = patchValue('targetAccountsWorkbook', undefined, projectKey(ben.state, 'targetAccountsWorkbook'));
      var benLeads = patchValue('results', undefined, projectKey(ben.state, 'results'));
      benLeads['lead-b'].draftMessage = 'Ben draft';
      ben.shadow.targetAccountsWorkbook = diffRows({}, extractRows('targetAccountsWorkbook', benWb)).shadow;
      ben.shadow.results = diffRows({}, extractRows('results', benLeads)).shadow;
      // Anna edits: a company field, a new contact, a deleted company, a lead status.
      var WB2 = JSON.parse(JSON.stringify(WB));
      WB2.companies[0].status = 'Contacted';
      WB2.companies.splice(1, 1);
      WB2.contacts.push({contactId: 'p-2', companyId: 'c-1', fullName: 'Bob Beispiel'});
      var L2 = JSON.parse(JSON.stringify(LEADS)); L2['lead-b'].status = 'Meeting';
      var round = anna.emit('targetAccountsWorkbook', WB2).concat(anna.emit('results', L2));
      applyChanges(ben.state, round);
      function updatesFor(state, key, records) {
        var m = new Map();
        records.forEach(function (r) { var t = rowTarget(r.e, r.id); if (t && t.key === key) m.set(rowKey(r.e, r.id), projectRow(state, r.e, r.id)); });
        return m;
      }
      var benWb2 = patchValue('targetAccountsWorkbook', benWb, updatesFor(ben.state, 'targetAccountsWorkbook', round));
      var benLeads2 = patchValue('results', benLeads, updatesFor(ben.state, 'results', round));
    """)
    check("team rows: Anna's base gives Ben the identical workbook", e("canonicalWb(benWb)"), e("canonicalWb(WB)"))
    check("team rows: Anna's edits give Ben the identical workbook", e("canonicalWb(benWb2)"), e("canonicalWb(WB2)"))
    check("team rows: only 4 records for 4 edits", e("round.length"), 4)
    check("team rows: Ben's lead gets Anna's status and keeps Ben's draft",
          e("jsonOf(benLeads2['lead-b'])"), '{"author":"Ben","status":"Meeting","draftMessage":"Ben draft"}')
    check("team rows: Anna's draft never reached Ben", e("'draftMessage' in benLeads2['lead-a']"), False)
    check("team rows: writing the merged rows back is no change for Ben (no echo)",
          e("diffRows(ben.shadow.results, extractRows('results', benLeads)).sets.length"), 0)

    # 4. Deleted and re-created with fewer fields: the old fields do not come back.
    e("""
      var cleo = new Member('cleo', 1759490000000);
      cleo.emit('targetAccounts', {acme: {score: 1, note: 'old', owner: 'x'}});
      cleo.emit('targetAccounts', {});
      cleo.emit('targetAccounts', {acme: {score: 9}});
      var dan = newState(); applyChanges(dan, cleo.sent.slice().reverse());
    """)
    check("team rows: a re-created row does not revive its old fields",
          e("jsonOf(projectRow(cleo.state, 'account', 'ta:acme'))"), '{"score":9}')
    check("team rows: ... in any order on another PC",
          e("jsonOf(projectRow(dan, 'account', 'ta:acme'))"), '{"score":9}')

    # 5. Compaction keeps the picture.
    e("""
      var full = newState(); applyChanges(full, anna.sent);
      var compact = compactChanges(anna.sent);
      var fromCompact = newState(); applyChanges(fromCompact, compact);
      var keys = ['targetAccountsWorkbook', 'results'];
      function pictureOf(s) { return keys.map(function (k) { return jsonOf(Array.from(projectKey(s, k))); }).join('|'); }
      var again = newState(); applyChanges(again, anna.sent); var reapplied = applyChanges(again, compact);
    """)
    e("function fieldCount(list) { return list.reduce(function (n, r) { return n + Object.keys(r.f || {}).length; }, 0); }")
    check("team compaction: superseded field values are dropped", e("fieldCount(compact) < fieldCount(anna.sent)"), True)
    check("team compaction: the same picture from the snapshot", e("pictureOf(fromCompact) === pictureOf(full)"), True)
    check("team compaction: a reader that had the originals applies nothing new", e("reapplied"), 0)

    # 6. A team's base stamps thousands of rows in one millisecond: the counter must never outgrow 4 digits.
    e("""
      var oc = createClock('z'), ost = [];
      for (var i = 0; i < 12000; i++) ost.push(tick(oc, 1759480000000));
      var ordered = ost.every(function (x, i) { return i === 0 || ost[i - 1] < x; });
      var parsed = ost.every(function (x) { return parseStamp(x) !== null; });
    """)
    check("team clock: 12000 stamps in one millisecond stay parseable", e("parsed"), True)
    check("team clock: ... and strictly increasing", e("ordered"), True)


def test_team_list_rows(ctx):
    """1.2.2 step 5b: companyExclusions is one row per entry - two members adding at once both keep theirs."""
    e = lambda x: ctx.eval(x)
    e("""
      var EX0 = [{slug: 'adecco', category: 'recruiter'}, {name: 'Rival AG', category: 'competitor'}];
      var exRows = extractRows('companyExclusions', EX0);
      var T1 = 1759480000000;
      function stL(w, c, m) { return formatStamp(w, c, m); }
      // Anna and Ben each add one entry to the same list, a second apart, neither having seen the other's.
      var EA = EX0.concat([{name: 'Foo GmbH', category: 'customer', source: 'team'}]);
      var EB = EX0.concat([{slug: 'bar-sa', category: 'partner'}]);
      function setsOf(rows, member, w) {
        var out = []; var c = 0;
        rows.forEach(function (f, rk) { var sp = splitRowKey(rk); out.push({t: stL(w, c++, member), e: sp.e, id: sp.id, op: 'set', f: f}); });
        return out;
      }
      var LS = newState();
      applyChanges(LS, setsOf(extractRows('companyExclusions', EA), 'anna', T1));
      applyChanges(LS, setsOf(extractRows('companyExclusions', EB), 'ben', T1 + 1000));
      var merged = patchValue('companyExclusions', EA, projectKey(LS, 'companyExclusions'));
      // The admin removes Rival AG: its row is deleted, the others stay in place.
      var gone = new Map([[rowKey('setting', 'companyExclusions:' + listEntryId(TEAM_LIST_KEYS[0], EX0[1])), null]]);
      var afterRemove = patchValue('companyExclusions', merged, gone);
    """)
    check("list: one row per entry", e("exRows.size"), 2)
    check("list: row id from the entry's identity", e("listEntryId(TEAM_LIST_KEYS[0], {name: ' Rival AG ', category: 'competitor'})"), "competitor||rival ag|")
    check("list: the key is a list, not a whole setting", e("teamKeyKind('companyExclusions')"), "list")
    check("list: a list row goes back to companyExclusions", e("rowTarget('setting', 'companyExclusions:x').key"), "companyExclusions")
    check("list: the old whole row is no longer a home", e("rowTarget('setting', 'companyExclusions')"), None)
    check("list: both concurrent additions survive", e("merged.length + '|' + merged.map(function (x) { return x.name || x.slug; }).join(',')"),
          "4|adecco,Rival AG,Foo GmbH,bar-sa")
    check("list: removing one keeps the others in place", e("afterRemove.map(function (x) { return x.name || x.slug; }).join(',')"), "adecco,Foo GmbH,bar-sa")
    check("list: no rows touching it leaves the value alone", e("patchValue('companyExclusions', EX0, new Map()) === EX0"), True)


def test_team_claims(ctx):
    """1.2.2 step 4 (TEAM_USE_DESIGN.md 6): which account a change belongs to, claim states, held edits retracted."""
    e = lambda x: ctx.eval(x)
    e("""
      var T0 = 1759480000000;
      function st2(wall, counter, member) { return formatStamp(wall, counter, member); }
      var norm = function (n) { return String(n).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
      var CS = newState();
      applyChanges(CS, [
        {t: st2(T0, 0, 'anna'), e: 'account', id: 'wb:c-1', op: 'set', f: {companyId: 'c-1', company: 'Acme AG', status: 'New'}},
        {t: st2(T0, 1, 'anna'), e: 'contact', id: 'wb:p-1', op: 'set', f: {contactId: 'p-1', companyId: 'c-1', fullName: 'Ann'}},
      ]);
    """)
    k = lambda ch: e("accountKeyOfChange(CS, %s, norm)" % ch)
    check("claims: targetAccounts row -> its key", k("{e:'account', id:'ta:acme ag', f:{}}"), "acme ag")
    check("claims: extras row -> its key", k("{e:'account', id:'x:acme ag', f:{}}"), "acme ag")
    check("claims: workbook company (name from the state)", k("{e:'account', id:'wb:c-1', f:{status:'Won'}}"), "acme ag")
    check("claims: workbook company (name in the change)", k("{e:'account', id:'wb:c-9', f:{company:'Beta SA'}}"), "beta sa")
    check("claims: contact extras -> the company part of its key", k("{e:'contact', id:'x:acme ag::ann muster', f:{}}"), "acme ag")
    check("claims: workbook contact without a company name -> its company row", k("{e:'contact', id:'wb:p-1', f:{title:'CEO'}}"), "acme ag")
    check("claims: a lead belongs to no account claim", k("{e:'lead', id:'lead-1', f:{company:'Acme AG'}}"), None)
    check("claims: a setting neither", k("{e:'setting', id:'negativeTopics', f:{}}"), None)
    check("claims: active members = seen in the window", e("JSON.stringify(activeMembersOf({ben: T0 - 1000, cleo: T0 - 11*60000}, T0, 10*60000))"), '["ben"]')

    # Claim states seen by Anna: Ben active, then Ben's claim earlier/later than hers.
    e("""
      function view(s, readBen) {
        var ctx = {me: 'anna', now: T0 + 20000, lastSeen: {ben: T0 + 15000}, readUpTo: {ben: readBen}, activeMembers: ['ben'], idleMs: 300000};
        return claimView(s, 'acme ag', ctx).state;
      }
      var C1 = newState();
      applyChange(C1, {t: st2(T0 + 10000, 0, 'anna'), e: 'account', id: claimIdFor('acme ag'), op: 'claim'});
    """)
    check("claims: free when nobody claimed", e("view(newState(), 0)"), "free")
    check("claims: checking until Ben has written after Anna's claim", e("view(C1, T0 + 9000)"), "checking")
    check("claims: mine once Ben has written after it", e("view(C1, T0 + 12000)"), "mine")
    e("var C2 = JSON.parse(JSON.stringify(C1)); applyChange(C2, {t: st2(T0 + 8000, 0, 'ben'), e: 'account', id: claimIdFor('acme ag'), op: 'claim'});")
    check("claims: lost when Ben claimed earlier", e("view(C2, T0 + 12000)"), "lost")
    e("var C3 = newState(); applyChange(C3, {t: st2(T0 + 8000, 0, 'ben'), e: 'account', id: claimIdFor('acme ag'), op: 'claim'});")
    check("claims: other when only Ben claimed", e("view(C3, T0 + 12000)"), "other")
    e("var C4 = JSON.parse(JSON.stringify(C2)); applyChange(C4, {t: st2(T0 + 9000, 0, 'ben'), e: 'account', id: claimIdFor('acme ag'), op: 'release'});")
    check("claims: Ben released -> Anna's claim is the earliest again", e("view(C4, T0 + 12000)"), "mine")
    check("claims: a claim is not a data row", e("rowTarget('account', claimIdFor('acme ag'))"), None)

    # Held edits of a lost claim are taken back out; a colleague's later change stays.
    e("""
      var R = newState();
      applyChange(R, {t: st2(T0, 0, 'ben'), e: 'account', id: 'x:acme ag', op: 'set', f: {status: 'New', note: 'ben-1'}});
      var held = [
        {t: st2(T0 + 1000, 0, 'anna'), e: 'account', id: 'x:acme ag', op: 'set', f: {status: 'Contacted', city: 'Bern'}},
        {t: st2(T0 + 2000, 0, 'anna'), e: 'account', id: 'x:acme ag', op: 'set', f: {status: 'Meeting'}},
      ];
      var prior = {'account|x:acme ag': priorOf(R, held[0])};
      held.forEach(function (h) { applyChange(R, h); });
      // Ben's later change to the note arrives while Anna's edits are held.
      applyChange(R, {t: st2(T0 + 3000, 0, 'ben'), e: 'account', id: 'x:acme ag', op: 'set', f: {note: 'ben-2'}});
      var heldShown = entityView(R, 'account', 'x:acme ag').values;
      retractChanges(R, held, prior);
      var afterRetract = entityView(R, 'account', 'x:acme ag').values;
      var lostAfterRetract = lostValues(R, {e: 'account', id: 'x:acme ag'});
      // Re-applied later (Apply my changes) with new stamps: they win again.
      var again = held.map(function (h, i) { return Object.assign({}, h, {t: st2(T0 + 9000 + i, 0, 'anna')}); });
      applyChanges(R, again);
      var afterApply = entityView(R, 'account', 'x:acme ag').values;
    """)
    check("claims: held edits show on Anna's PC meanwhile", e("heldShown.status + '|' + heldShown.city"), "Meeting|Bern")
    check("claims: retracted - status back to Ben's value", e("afterRetract.status"), "New")
    check("claims: retracted - a field only Anna set is gone", e("'city' in afterRetract"), False)
    check("claims: retracted - Ben's later note stays", e("afterRetract.note"), "ben-2")
    check("claims: retracted - only Ben's overwritten note is left as a lost value",
          e("JSON.stringify(lostAfterRetract.map(function (x) { return x.field + '=' + x.v; }))"), '["note=ben-1"]')
    check("claims: applying the kept-aside edits later wins again", e("afterApply.status + '|' + afterApply.city"), "Meeting|Bern")
    # A held delete is retracted too.
    e("""
      var D = newState();
      applyChange(D, {t: st2(T0, 0, 'ben'), e: 'contact', id: 'x:acme ag::ann', op: 'set', f: {title: 'CEO'}});
      var hd = [{t: st2(T0 + 1000, 0, 'anna'), e: 'contact', id: 'x:acme ag::ann', op: 'delete'}];
      var pd = {'contact|x:acme ag::ann': priorOf(D, hd[0])};
      applyChange(D, hd[0]);
      var deletedMeanwhile = entityView(D, 'contact', 'x:acme ag::ann').exists;
      retractChanges(D, hd, pd);
    """)
    check("claims: a held delete hides the row meanwhile", e("deletedMeanwhile"), False)
    check("claims: ... and retracting it brings the row back", e("entityView(D, 'contact', 'x:acme ag::ann').exists"), True)

    # Step 5 - assignments (design 7): who has it, a race, off-limits, the pages' summary.
    e("""
      var ACTX = {me: 'anna', now: T0 + 20000, lastSeen: {ben: T0 + 15000}, readUpTo: {ben: T0 + 12000}, activeMembers: ['ben'], idleMs: 300000};
      var A = newState();
      applyChange(A, {t: st2(T0 + 10000, 0, 'anna'), e: 'account', id: claimIdFor('acme ag'), op: 'assign'});
      var A2 = JSON.parse(JSON.stringify(A));
      applyChange(A2, {t: st2(T0 + 9000, 0, 'ben'), e: 'account', id: claimIdFor('acme ag'), op: 'assign'});
      var A3 = JSON.parse(JSON.stringify(A2));
      applyChange(A3, {t: st2(T0 + 11000, 0, 'anna'), e: 'account', id: claimIdFor('acme ag'), op: 'unassign'});
      var B = newState();
      applyChange(B, {t: st2(T0 + 10000, 0, 'ben'), e: 'account', id: claimIdFor('beta sa'), op: 'claim'});
      applyChange(B, {t: st2(T0 + 10000, 1, 'anna'), e: 'account', id: claimIdFor('gamma ag'), op: 'assign', member: 'cleo'});
      applyChange(B, {t: st2(T0 + 10000, 2, 'anna'), e: 'account', id: claimIdFor('delta ag'), op: 'claim'});
      function av(s, k, c) { var v = assignmentView(s, k, c || ACTX); return [v.assignee && v.assignee.member, v.mine, v.confirmed, v.lostTo]; }
    """)
    check("assign: Anna's own, confirmed once Ben wrote after it", e("JSON.stringify(av(A, 'acme ag'))"), '["anna",true,true,null]')
    check("assign: ... checking while Ben has not",
          e("JSON.stringify(av(A, 'acme ag', Object.assign({}, ACTX, {readUpTo: {ben: T0 + 9000}})))"), '["anna",true,false,null]')
    check("assign: Ben assigned earlier - his; Anna lost to him", e("JSON.stringify(av(A2, 'acme ag'))"), '["ben",false,false,"ben"]')
    check("assign: Anna's withdrawn assignment is no longer a lost one", e("JSON.stringify(av(A3, 'acme ag'))"), '["ben",false,false,null]')
    check("assign: unassigned account", e("JSON.stringify(av(newState(), 'acme ag'))"), '[null,false,false,null]')
    check("off-limits: a colleague's assigned account", e("JSON.stringify(offLimitsFor(A2, 'acme ag', ACTX))"),
          json.dumps({"reason": "assigned", "member": "ben", "sinceWall": 1759480009000}, separators=(",", ":")))
    check("off-limits: my own assigned account is not", e("offLimitsFor(A, 'acme ag', ACTX)"), None)
    check("off-limits: a colleague updating it", e("offLimitsFor(B, 'beta sa', ACTX).reason"), "held")
    check("off-limits: assigned by the admin to someone else", e("offLimitsFor(B, 'gamma ag', ACTX).member"), "cleo")
    check("summary: assignments and claims, nothing else",
          e("JSON.stringify(teamAccountSummary(B, ACTX))"),
          json.dumps({"beta sa": {"h": "ben", "hs": 1759480010000}, "gamma ag": {"a": "cleo", "as": 1759480010000},
                      "delta ag": {"h": "anna", "hs": 1759480010000}}, separators=(",", ":")))
    check("summary: my unconfirmed assignment is flagged",
          e("JSON.stringify(teamAccountSummary(A, Object.assign({}, ACTX, {readUpTo: {ben: 0}})))"),
          json.dumps({"acme ag": {"a": "anna", "as": 1759480010000, "ac": False}}, separators=(",", ":")))
    check("summary off-limits: mine / colleague's / held / my own claim",
          e("JSON.stringify([summaryOffLimits({a: 'anna'}, 'anna'), summaryOffLimits({a: 'ben', as: 5}, 'anna').reason, summaryOffLimits({h: 'ben'}, 'anna').reason, summaryOffLimits({h: 'anna'}, 'anna'), summaryOffLimits(null, 'anna')])"),
          '[null,"assigned","held",null,null]')


def test_team_log_and_join(ctx):
    """1.2.2 step 6: the team log built from change records (R3.11); the join overlap and add-back (R6.7)."""
    e = lambda x: ctx.eval(x)
    e("""
      var T6 = 1759480000000;
      var n6 = function (n) { return String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
      var LS = newState();
      applyChanges(LS, [{t: formatStamp(T6, 0, 'anna'), e: 'account', id: 'wb:c-1', op: 'set', f: {companyId: 'c-1', company: 'Acme AG'}}]);
      var LOG = teamLogEntries([
        {t: formatStamp(T6 + 1, 0, 'anna'), e: 'account', id: 'x:acme ag', op: 'set', f: {nextActionDueAt: 1, notes: 'x'}},
        {t: formatStamp(T6 + 2, 0, 'anna'), e: 'account', id: 'wb:c-1', op: 'set', f: {status: 'Won', notes: 'y'}},
        {t: formatStamp(T6 + 3, 0, 'anna'), e: 'contact', id: 'x:acme ag::ann', op: 'set', f: {deletedAt: 5}},
        {t: formatStamp(T6 + 4, 0, 'anna'), e: 'account', id: '@acme ag', op: 'claim'},
        {t: formatStamp(T6 + 5, 0, 'boaz'), e: 'account', id: '@acme ag', op: 'assign', member: 'anna'},
        {t: formatStamp(T6 + 6, 0, 'boaz'), e: 'setting', id: 'negativeTopics', op: 'set', f: {$v: []}},
      ], LS, n6);
      var txt = function (x) { return teamLogText(x, function (k) { return k === 'acme ag' ? 'Acme AG' : k; }, function (m) { return m; }); };
    """)
    check("team log: one line per member, change and account; claims left out", e("LOG.length"), 4)
    e("""
      var REC = {t: formatStamp(T6 + 7, 0, 'anna'), e: 'account', id: 'wb:c-1', op: 'set', f: {company: 'Acme Group'}};
      var PRI = new Map([[REC, priorOf(LS, REC)]]);
      var VL = teamLogEntries([REC], LS, n6, PRI)[0];
    """)
    check("team log: previous and new value of a field", e("JSON.stringify([VL.before, VL.after])"), '[{"company":"Acme AG"},{"company":"Acme Group"}]')
    check("team log: fields of one account's rows together, in words", e("txt(LOG[0])"), "changed Acme AG: Follow-up date, Notes, Status")
    check("team log: a field's own time stamp is left out", e("JSON.stringify(shownFields(['manualStatus', 'manualStatusAt', 'reviewedAt']).map(fieldName))"), '["Status","Reviewed at"]')
    check("team log: a contact removed", e("txt(LOG[1])"), "removed Acme AG (a contact)")
    check("team log: assigned by the admin", e("txt(LOG[2])"), "assigned Acme AG to anna")
    check("team log: a setting", e("txt(LOG[3])"), "changed the setting negativeTopics")
    check("team log: kept to the newest TEAM_LOG_KEPT, old ones out",
          e("appendTeamLog([{at: 1}, {at: T6}], [{at: T6 + 9}], T6 + 10).map(function (x) { return x.at; }).join(',')"), "%d,%d" % (1759480000000, 1759480000009))

    e("""
      var LOCAL = {
        targetAccounts: {'acme ag': {company: 'Acme AG'}, 'beta sa': {company: 'Beta SA', linkedinCompanyId: '77'}, 'gamma': {company: 'Gamma'}, 'gone': {company: 'Gone'}},
        targetAccountExtras: {'gone': {deletedAt: 1}, 'gamma': {nextActionDueAt: 3}},
        targetContactExtras: {'gamma::eve': {mentorHistory: [1]}},
        targetAccountsWorkbook: {companies: [{companyId: 'C1', company: 'Acme AG'}, {companyId: 'C2', company: 'Gamma'}],
          contacts: [{contactId: 'P1', companyId: 'C2', company: 'Gamma', fullName: 'Eve'}]},
        results: {L1: {company: 'Beta SA', status: 'Contacted'}, L2: {company: 'Gamma', status: 'New'}, L3: {company: 'Acme AG', status: 'New'}},
      };
      var TEAM = {
        targetAccounts: {'beta': {company: 'Beta', linkedinCompanyId: '77'}, 'acme ag': {company: 'Acme AG'}},
        targetAccountsWorkbook: {companies: [{companyId: 'C2', company: 'Beta'}], contacts: [{contactId: 'P1', company: 'Beta', fullName: 'Bo'}]},
        results: {},
      };
      var OV = joinOverlap(LOCAL, TEAM, n6);
      var BACK = addBackValues(LOCAL, TEAM, ['gamma'], OV.shared.map(function (s) { return s.localKey; }), n6, 'm1');
    """)
    check("join: only-mine accounts listed (removed ones not)", e("OV.localOnly.map(function (a) { return a.key; }).join(',')"), "gamma")
    check("join: what was done on it", e("OV.localOnly[0].worked.join('; ')"), "a follow-up date; a Sales Mentor conversation")
    check("join: shared + worked, matched by LinkedIn id -> the team's key", e("JSON.stringify(OV.shared.map(function (s) { return [s.key, s.localKey]; }))"), '[["beta","beta sa"]]')
    check("join: shared but not worked is no proposal", e("OV.shared.some(function (s) { return s.key === 'acme ag'; })"), False)
    check("join: brought account back in targetAccounts, team's kept", e("Object.keys(BACK.targetAccounts).sort().join(',')"), "acme ag,beta,gamma")
    check("join: clashing company id renamed, contact follows", e("JSON.stringify(BACK.targetAccountsWorkbook.contacts[1])"),
          '{"contactId":"P1-m1","companyId":"C2-m1","company":"Gamma","fullName":"Eve"}')
    check("join: team's workbook rows untouched", e("BACK.targetAccountsWorkbook.companies[0].company + '|' + BACK.targetAccountsWorkbook.companies[1].companyId"), "Beta|C2-m1")
    check("join: contact extras of a brought account come along", e("'gamma::eve' in BACK.targetContactExtras"), True)
    check("join: leads - brought account's and contacted ones of shared accounts", e("Object.keys(BACK.results).sort().join(',')"), "L1,L2")
    e("""
      var REJOIN = joinOverlap(
        {targetAccounts: {'roche': {company: 'Roche'}, 'ubs': {company: 'UBS'}}, results: {R1: {company: 'Roche', status: 'Contacted'}, U1: {company: 'UBS', status: 'Contacted'}}},
        {targetAccounts: {'roche': {company: 'Roche'}, 'ubs': {company: 'UBS'}}, results: {R1: {company: 'Roche', status: 'New'}, U1: {company: 'UBS', status: 'Contacted'}}}, n6);
    """)
    check("join: a lead the team has as New gets the member's Contacted",
          e("JSON.stringify(addBackValues({results: {R1: {company: 'Roche', status: 'Contacted', contactedBy: 'Annick'}}}, {results: {R1: {company: 'Roche', status: 'New', author: 'Pia'}}}, [], ['roche'], n6, 'm2').results.R1)"),
          '{"company":"Roche","status":"Contacted","author":"Pia","contactedBy":"Annick"}')
    check("join: work the team already has does not count (rejoining member)", e("JSON.stringify(REJOIN.shared.map(function (s) { return [s.key, s.worked]; }))"), '[["roche",["1 lead contacted"]]]')
    e("""
      var CL = {targetAccounts: {'roche': {company: 'Roche'}}, targetContactExtras: {'roche::ann': {manualStatus: 'Contacted', manualStatusAt: 5}}};
      var CT = {targetAccounts: {'roche': {company: 'Roche'}}, targetContactExtras: {'roche::ann': {manualStatus: 'Not contacted'}}};
      var COV = joinOverlap(CL, CT, n6);
      var CB = addBackValues(CL, CT, [], [{localKey: 'roche', key: 'roche'}], n6, 'm3');
    """)
    check("join: a contact set to Contacted counts as work", e("JSON.stringify(COV.shared.map(function (s) { return s.worked; }))"), '[["1 contact marked Contacted"]]')
    check("join: ... and its status is carried over", e("CB.targetContactExtras['roche::ann'].manualStatus"), "Contacted")
    check("join: proposals keyed per member and account",
          e("JSON.stringify(Object.keys(joinProposals(OV.shared, {memberId: 'm1', memberName: 'Eve', at: 1, assigneeOf: function () { return 'boaz'; }})))"), '["m1~beta"]')

def test_team_groups(ctx):
    """1.2.3 step 0 (TEAM_ADVANCED_MODE_DESIGN.md 3, 4.2, 5, 8.3, D9, D13): the Team Lead chain and account groups."""
    e = lambda x: ctx.eval(x)

    # Regions (geo-regions.js) - the six regions, an unknown country is never guessed.
    check("region: Switzerland", e("regionOfCountry('Switzerland')"), "europe")
    check("region: case and spaces", e("regionOfCountry('  united states ')"), "northAmerica")
    check("region: Japan is South-East Asia (D4)", e("regionOfCountry('Japan')"), "southEastAsia")
    check("region: unknown country", e("regionOfCountry('Atlantis')"), None)
    check("region: no country", e("regionOfCountry(null)"), None)

    # Size: storage.js's resolveSizeBucket now IS sizeBucketKey - same buckets, same edges, same loose numbers.
    e("""var BUCKETS = [
      { key: 'S', min: 0, max: 200 }, { key: 'M', min: 201, max: 500 }, { key: 'L', min: 501, max: 1000 },
      { key: 'XL', min: 1001, max: 5000 }, { key: 'XXL', min: 5001, max: Infinity }];
      function oldResolve(v) { var n = parseLooseNumber(v); if (n === null) return null;
        var b = BUCKETS.find(function (x) { return n >= x.min && n <= x.max; }); return b ? b.key : null; }""")
    same = e("""JSON.stringify([200, 201, 500, 501, 1000, 1001, 5000, 5001, '6,500+', '>5,000', '1.5k', null, 'n/a', 0, '']
      .filter(function (v) { return sizeBucketKey(v, BUCKETS) !== oldResolve(v); }))""")
    check("size: sizeBucketKey gives resolveSizeBucket's bucket for every edge", same, "[]")

    # Facts and filters.
    e("""var VIEW = { globalHqCountry: 'Switzerland', globalEmployees: '6,500+', targetCountryRelationship: 'Local company',
        industry: 'Banking', companyType: 'Private', salesTeamPriority: 'P1', relationship: ['customer'] };
      var F = groupFacts(VIEW, { buckets: BUCKETS });""")
    check("facts: all fields", e("JSON.stringify(F)"),
          '{"region":"europe","country":"Switzerland","size":"XXL","scope":"local","industry":"Banking","companyType":"Private","priority":"P1","relationship":["customer"]}')
    check("facts: an empty view is all unknown", e("JSON.stringify(groupFacts({}, { buckets: BUCKETS }))"),
          '{"region":null,"country":null,"size":null,"scope":null,"industry":null,"companyType":null,"priority":null,"relationship":[]}')
    check("filter: any of a field's values", e("matchesFilter(F, { size: ['XL', 'XXL'] })"), True)
    check("filter: all fields together", e("matchesFilter(F, { size: ['XXL'], region: ['africa'] })"), False)
    check("filter: case-insensitive values", e("matchesFilter(F, { industry: ['banking'] })"), True)
    check("filter: an empty field is no condition", e("matchesFilter(F, { size: [], region: ['europe'] })"), True)
    check("filter: an unknown fact never matches (R2.5)", e("matchesFilter(groupFacts({ globalEmployees: 300 }, { buckets: BUCKETS }), { region: ['europe'] })"), False)
    check("filter: relationship customer", e("matchesFilter(F, { relationship: ['customer'] })"), True)
    check("filter: relationship none", e("matchesFilter(groupFacts({}, {}), { relationship: ['none'] })"), True)
    check("filter: relationship none vs a customer", e("matchesFilter(F, { relationship: ['none'] })"), False)
    check("save check: a filter with no condition is refused", e("groupProblem({ name: 'All', kind: 'filter', filter: {} })"),
          "Add at least one condition - or use All accounts.")
    check("save check: a named group is fine", e("groupProblem({ name: 'VIP', kind: 'named', accounts: [] })"), "")

    # Groups, Other, pins, members (D9).
    e("""var GROUPS = {
        'g-swiss': { name: 'Swiss', kind: 'filter', filter: { country: ['Switzerland'] }, members: ['anna', 'luc', 'gone'] },
        'g-vip':   { name: 'VIP', kind: 'named', accounts: ['roche', 'ubs'], members: ['boaz'] },
        'g-old':   { name: 'Old', kind: 'filter', filter: { country: ['Switzerland'] }, members: ['fay'], deleted: true },
        'g-empty': { name: 'Broken', kind: 'filter', filter: {}, members: ['luc'] },
        other:     { members: [] } };
      var TEAM = ['boaz', 'anna', 'luc', 'fay'];
      var IX = groupIndex(GROUPS, TEAM);
      var LEADS = { lead: 'boaz', deputy: null };
      var SWISS = groupFacts({ globalHqCountry: 'Switzerland' }, {});
      var US = groupFacts({ globalHqCountry: 'United States' }, {});""")
    check("groups: filter + named list", e("JSON.stringify(groupsOf('roche', SWISS, IX))"), '["g-swiss","g-vip"]')
    check("groups: no match -> Other", e("JSON.stringify(groupsOf('acme', US, IX))"), '["other"]')
    check("groups: a deleted group catches nothing", e("IX.live.some(function (g) { return g.id === 'g-old'; })"), False)
    check("groups: a filter with no conditions catches nothing", e("JSON.stringify(groupsOf('x', US, IX))"), '["other"]')
    check("groups: a pin holds the old groups", e("JSON.stringify(groupsOf('roche', SWISS, IX, { roche: { groups: ['other'] } }))"), '["other"]')
    check("groups: a pin to a deleted group falls back", e("JSON.stringify(groupsOf('roche', SWISS, IX, { roche: { groups: ['g-old'] } }))"), '["g-swiss","g-vip"]')
    check("groups: on as soon as one live group exists", e("groupsOn(GROUPS) && !groupsOn({ other: { members: [] } })"), True)
    check("members: a former member is not counted", e("JSON.stringify(membersOf('g-swiss', IX))"), '["anna","luc"]')
    check("members: in no live group -> Other (D9)", e("JSON.stringify(membersOf('other', IX))"), '["fay"]')
    check("members: a member's groups", e("JSON.stringify(memberGroups('anna', IX))"), '["g-swiss"]')

    # Access and void assignments (D6).
    check("access: Team Lead sees everything", e("mayAccess('boaz', ['other'], IX, LEADS)"), True)
    check("access: deputy sees everything", e("mayAccess('fay', ['g-swiss'], IX, { lead: 'boaz', deputy: 'fay' })"), True)
    check("access: member in the group", e("mayAccess('anna', ['g-swiss', 'g-vip'], IX, LEADS)"), True)
    check("access: member not in the group", e("mayAccess('fay', ['g-swiss'], IX, LEADS)"), False)
    check("access: no groups = 1.2.2, everyone sees all", e("mayAccess('fay', ['g-x'], groupIndex({}, TEAM), LEADS)"), True)
    check("access: who", e("JSON.stringify(accessOf(['g-swiss'], IX, LEADS))"), '["anna","boaz","luc"]')
    check("void: assignee left without access",
          e("JSON.stringify(voidAssignments({ roche: 'anna', acme: 'anna', ubs: 'boaz', nestle: 'luc' }, { roche: ['g-swiss'], acme: ['other'], ubs: ['g-vip'], nestle: ['g-swiss'] }, IX, LEADS))"),
          '[{"key":"acme","member":"anna"}]')
    check("void: nothing in basic mode", e("voidAssignments({ a: 'x' }, { a: ['other'] }, groupIndex({}, TEAM), LEADS).length"), 0)
    check("counts", e("JSON.stringify(groupCounts({ roche: ['g-swiss', 'g-vip'], ubs: ['g-vip'], acme: ['other'] }, IX, { assignments: { roche: 'anna' }, ready: { ubs: true, acme: true } }))"),
          '{"g-empty":{"accounts":0,"assigned":0,"unassigned":0,"ready":0},"g-swiss":{"accounts":1,"assigned":1,"unassigned":0,"ready":0},"g-vip":{"accounts":2,"assigned":1,"unassigned":1,"ready":1},"other":{"accounts":1,"assigned":0,"unassigned":1,"ready":1}}')

    # The Team Lead chain (3.1, 3.4, D13).
    e("""var D = 24 * 3600 * 1000, T0 = 1759480000000;
      function st2(wall, member) { return formatStamp(wall, 0, member); }
      function lr(wall, author, id, member) { return { t: st2(wall, author), id: id, member: member === undefined ? null : member }; }
      var never = function () { return false; }, always = function () { return true; };""")
    check("lead: the creator", e("teamLeadOf('boaz', []).lead"), "boaz")
    check("lead: unknown creator -> nobody", e("teamLeadOf(null, [lr(T0, 'boaz', 'lead', 'anna')]).lead"), None)
    check("lead: hand-over", e("teamLeadOf('boaz', [lr(T0, 'boaz', 'lead', 'anna')]).lead"), "anna")
    check("lead: a hand-over by a member is ignored", e("teamLeadOf('boaz', [lr(T0, 'luc', 'lead', 'luc')]).lead"), "boaz")
    check("lead: hand-over and back", e("teamLeadOf('boaz', [lr(T0, 'boaz', 'lead', 'anna'), lr(T0 + 5, 'anna', 'lead', 'boaz')]).lead"), "boaz")
    check("lead: the old lead cannot hand over again", e("teamLeadOf('boaz', [lr(T0, 'boaz', 'lead', 'anna'), lr(T0 + 5, 'boaz', 'lead', 'luc')]).lead"), "anna")
    check("deputy: made by the lead", e("teamLeadOf('boaz', [lr(T0, 'boaz', 'deputy', 'fay')]).deputy"), "fay")
    check("deputy: made by a member is ignored", e("teamLeadOf('boaz', [lr(T0, 'fay', 'deputy', 'fay')]).deputy"), None)
    check("deputy: a deputy cannot appoint another", e("teamLeadOf('boaz', [lr(T0, 'boaz', 'deputy', 'fay'), lr(T0 + 1, 'fay', 'deputy', 'luc')]).deputy"), "fay")
    check("deputy: a deputy cannot hand over the lead", e("teamLeadOf('boaz', [lr(T0, 'boaz', 'deputy', 'fay'), lr(T0 + 1, 'fay', 'lead', 'fay')]).lead"), "boaz")
    check("deputy: ended by the lead", e("teamLeadOf('boaz', [lr(T0, 'boaz', 'deputy', 'fay'), lr(T0 + 1, 'boaz', 'deputy', null)]).deputy"), None)
    check("deputy: ends with a hand-over", e("teamLeadOf('boaz', [lr(T0, 'boaz', 'deputy', 'fay'), lr(T0 + 1, 'boaz', 'lead', 'anna')]).deputy"), None)
    check("takeover: lead quiet, no deputy -> anyone",
          e("teamLeadOf('boaz', [lr(T0 + 40 * D, 'luc', 'takeover', 'luc')], { activeWithin: never }).lead"), "luc")
    check("takeover: lead still active -> ignored",
          e("teamLeadOf('boaz', [lr(T0 + 40 * D, 'luc', 'takeover', 'luc')], { activeWithin: always }).lead"), "boaz")
    check("takeover: without an activity check -> ignored",
          e("teamLeadOf('boaz', [lr(T0 + 40 * D, 'luc', 'takeover', 'luc')]).lead"), "boaz")
    check("takeover: with a deputy, only the deputy",
          e("teamLeadOf('boaz', [lr(T0, 'boaz', 'deputy', 'fay'), lr(T0 + 40 * D, 'luc', 'takeover', 'luc')], { activeWithin: never }).lead"), "boaz")
    check("takeover: the deputy takes over",
          e("JSON.stringify((function (c) { return [c.lead, c.deputy]; })(teamLeadOf('boaz', [lr(T0, 'boaz', 'deputy', 'fay'), lr(T0 + 40 * D, 'fay', 'takeover', 'fay')], { activeWithin: never })))"), '["fay",null]')
    check("takeover: the first one wins",
          e("teamLeadOf('boaz', [lr(T0 + 40 * D + 9, 'anna', 'takeover', 'anna'), lr(T0 + 40 * D, 'luc', 'takeover', 'luc')], { activeWithin: function (m) { return m !== 'boaz'; } }).lead"), "luc")
    check("rights at a stamp: before and after a hand-over",
          e("""(function () { var c = teamLeadOf('boaz', [lr(T0, 'boaz', 'lead', 'anna')]);
                return [leadRightsAt(c, 'boaz', st2(T0 - 1, 'boaz')), leadRightsAt(c, 'boaz', st2(T0 + 1, 'boaz')), leadRightsAt(c, 'anna', st2(T0 + 1, 'anna'))].join(); })()"""),
          "true,false,true")

    # The merge: only the Team Lead's (or deputy's) group records count - in any order of arrival (4.2).
    e("""var GR = [
        { t: st2(T0 + 1, 'boaz'), e: 'setting', id: 'teamGroups:g-1', op: 'set', f: { name: 'EMEA', kind: 'filter', members: ['anna'] } },
        { t: st2(T0 + 2, 'anna'), e: 'setting', id: 'teamGroups:g-1', op: 'set', f: { name: 'Anna was here' } },
        { t: st2(T0 + 3, 'luc'),  e: 'setting', id: 'teamGroups:g-2', op: 'set', f: { name: 'Luc only', kind: 'named' } },
        { t: st2(T0 + 10, 'boaz'), e: 'team', id: 'lead', op: 'set', f: { member: 'anna' } },
        { t: st2(T0 + 11, 'anna'), e: 'setting', id: 'teamGroups:g-1', op: 'set', f: { name: 'EMEA (Anna)' } },
        { t: st2(T0 + 12, 'boaz'), e: 'setting', id: 'teamGroups:g-1', op: 'set', f: { members: ['boaz'] } },
        { t: st2(T0 + 13, 'anna'), e: 'team', id: 'deputy', op: 'set', f: { member: 'fay' } },
        { t: st2(T0 + 14, 'fay'),  e: 'setting', id: 'teamGroups:g-3', op: 'set', f: { name: 'Fay as deputy', kind: 'named' } },
        { t: st2(T0 + 15, 'anna'), e: 'team', id: 'deputy', op: 'set', f: { member: null } },
        { t: st2(T0 + 16, 'fay'),  e: 'setting', id: 'teamGroups:g-3', op: 'set', f: { name: 'Fay after' } },
        { t: st2(T0 + 20, 'luc'),  e: 'account', id: 'wb:c-1', op: 'set', f: { company: 'Roche' } },
      ];
      function groupPicture(s) {
        return JSON.stringify(['teamGroups:g-1', 'teamGroups:g-2', 'teamGroups:g-3', 'wb:c-1'].map(function (id) {
          var v = entityView(s, id === 'wb:c-1' ? 'account' : 'setting', id); return v && v.exists ? v.values : null; })
          .concat([leadChain(s).lead, leadChain(s).deputy, ignoredGated(s).length]));
      }
      var GS = newState(); setTeamCreator(GS, 'boaz'); applyChanges(GS, GR);
      var GREF = groupPicture(GS);""")
    check("merge: only valid group records count", e("GREF"),
          '[{"kind":"filter","members":["anna"],"name":"EMEA (Anna)"},null,{"kind":"named","name":"Fay as deputy"},{"company":"Roche"},"anna",null,4]')
    order_free = e("""(function () {
        for (var seed = 1; seed <= 40; seed++) {
          var s = newState();
          if (seed % 2) setTeamCreator(s, 'boaz');
          applyChanges(s, shuffled(GR, seed));
          if (!(seed % 2)) setTeamCreator(s, 'boaz');       // the creator read after the records
          applyChanges(s, shuffled(GR, seed + 50));
          if (groupPicture(s) !== GREF) return seed;
        }
        return 0;
      })()""")
    check("merge: 40 shuffled orders (lead records late or early, creator before or after) give the same groups", order_free, 0)
    check("merge: without a known creator no group record counts", e("""(function () {
        var s = newState(); applyChanges(s, GR); var v = entityView(s, 'setting', 'teamGroups:g-1'); return Boolean(v && v.exists); })()"""), False)
    check("merge: an old state (before 1.2.3) gains the new parts", e("""(function () {
        var s = { entities: {}, lost: {}, seen: {} }; s.seen[st2(T0, 'boaz') + '|account|wb:c-9'] = true;
        setTeamCreator(s, 'boaz'); applyChanges(s, GR); return groupPicture(s) === GREF && Boolean(s.days.boaz); })()"""), True)

    # Compaction keeps the chain and the group records whole, and one record per day (D13 is snapshot-proof).
    e("""var OWN = [
        { t: st2(T0, 'boaz'), e: 'account', id: 'wb:c-1', op: 'set', f: { status: 'New' } },
        { t: st2(T0 + 2 * D, 'boaz'), e: 'account', id: 'wb:c-1', op: 'set', f: { status: 'Met' } },
        { t: st2(T0 + 1, 'boaz'), e: 'setting', id: 'teamGroups:g-1', op: 'set', f: { name: 'A' } },
        { t: st2(T0 + 2, 'boaz'), e: 'setting', id: 'teamGroups:g-1', op: 'set', f: { name: 'B' } },
        { t: st2(T0 + 3, 'boaz'), e: 'team', id: 'deputy', op: 'set', f: { member: 'fay' } },
        { t: st2(T0 + 4, 'boaz'), e: 'team', id: 'deputy', op: 'set', f: { member: null } },
      ];
      var CO = compactChanges(OWN);""")
    check("compaction: group and team records all kept", e("CO.filter(function (r) { return r.e === 'team' || r.id === 'teamGroups:g-1'; }).length"), 4)
    check("compaction: a superseded day keeps an empty marker", e("JSON.stringify(CO.filter(function (r) { return r.id === 'wb:c-1'; }).map(function (r) { return r.f; }))"),
          '[{"status":"Met"}]')
    e("""var OWN2 = [
        { t: st2(T0, 'boaz'), e: 'account', id: 'wb:c-1', op: 'set', f: { status: 'New' } },
        { t: st2(T0 + 2 * D, 'boaz'), e: 'account', id: 'wb:c-1', op: 'set', f: { status: 'Met' } }];
      var CO2 = compactChanges(OWN2);""")
    check("compaction: the first day survives as an empty record", e("JSON.stringify(CO2.map(function (r) { return r.f; }))"), '[{},{"status":"Met"}]')
    check("compaction: same activity days from the snapshot", e("""(function () {
        var a = newState(); applyChanges(a, OWN2); var b = newState(); applyChanges(b, CO2);
        return JSON.stringify(a.days) === JSON.stringify(b.days) && JSON.stringify(entityView(a, 'account', 'wb:c-1').values) === JSON.stringify(entityView(b, 'account', 'wb:c-1').values); })()"""), True)


def main():
    ctx = MiniRacer()
    load_modules(ctx)
    test_parse_loose_number(ctx)
    test_currency(ctx)
    test_arbitration(ctx)
    test_currency_pair(ctx)
    test_local_revenue_currency(ctx)
    test_currency_follows_global_only(ctx)
    test_implausible_briefing_is_discarded(ctx)
    test_revenue_in_millions_is_named(ctx)
    test_listing_revenue_in_millions(ctx)
    test_employee_contradiction_does_not_taint_other_fields(ctx)
    test_currency_is_never_put_to_the_user(ctx)
    test_converted_comparison_is_judged_more_loosely(ctx)
    test_rule9_global_is_a_copy_of_local(ctx)
    test_rule10_weakly_sourced_current_value(ctx)
    test_rule11_group_hq_over_local_entity(ctx)
    test_patch_shape(ctx)
    test_readiness(ctx)
    test_pipeline_plan(ctx)
    test_auto_run_blocker(ctx)
    test_web_lane(ctx)
    test_decision_rules(ctx)
    test_rate_limit_backoff(ctx)
    test_extras_merge(ctx)
    test_company_identity(ctx)
    test_per_field_research(ctx)
    test_web_usable(ctx)
    test_user_retry_first(ctx)
    test_web_lane_step2(ctx)
    test_profile_search_matching(ctx)
    test_discovery_filter(ctx)
    test_linkedin_after_web(ctx)
    test_setup_proposals(ctx)
    test_targets_and_estimate(ctx)
    test_same_brand_domain(ctx)
    test_title_brackets(ctx)
    test_login_wall(ctx)
    test_team_merge(ctx)
    test_team_rows(ctx)
    test_team_list_rows(ctx)
    test_team_claims(ctx)
    test_team_log_and_join(ctx)
    test_team_groups(ctx)
    test_relationships(ctx)

    print()
    for f in _failures:
        print("FAIL  %s" % f)
    print()
    if _failures:
        print("%d passed, %d FAILED" % (_passes, len(_failures)))
        return 1
    print("%d checks passed." % _passes)
    return 0


if __name__ == "__main__":
    sys.exit(main())
