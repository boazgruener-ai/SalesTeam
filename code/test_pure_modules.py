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
import sys

try:
    from py_mini_racer import MiniRacer
except ImportError:
    sys.exit("Missing JS engine. Run:  python -m pip install py_mini_racer")

CODE_DIR = os.path.dirname(os.path.abspath(__file__))

PURE_MODULES = ["value-normalize.js", "web-research-apply.js", "web-findings-arbitration.js", "readiness.js", "pipeline-plan.js"]

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
    check("an implausible STORED value still asks", ctx.eval("storedBad.action"), "review")
    check("...by rule 2", ctx.eval("storedBad.rule"), 2)


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
    check("the implausible stored amount is still escalated", ctx.eval("amount.action"), "review")
    check("but the currency never is", ctx.eval("currency.action"), "dismiss")


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
    test_employee_contradiction_does_not_taint_other_fields(ctx)
    test_currency_is_never_put_to_the_user(ctx)
    test_converted_comparison_is_judged_more_loosely(ctx)
    test_rule9_global_is_a_copy_of_local(ctx)
    test_rule10_weakly_sourced_current_value(ctx)
    test_rule11_group_hq_over_local_entity(ctx)
    test_patch_shape(ctx)
    test_readiness(ctx)
    test_pipeline_plan(ctx)

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
