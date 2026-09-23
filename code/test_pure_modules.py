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

PURE_MODULES = ["value-normalize.js", "web-research-apply.js", "web-findings-arbitration.js"]

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

    # Rule 2: 0 employees at a company that has revenue.
    ctx.eval("""
      var zero = arbitrateFinding(
        { key: "globalEmployees", label: "Employees (global)", found: 0, current: 4000, state: "different" },
        ctxFor({ hasRevenue: true }), {});
    """)
    check("zero employees with revenue is asked", ctx.eval("zero.action"), "review")
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


def main():
    ctx = MiniRacer()
    load_modules(ctx)
    test_parse_loose_number(ctx)
    test_currency(ctx)
    test_arbitration(ctx)
    test_currency_pair(ctx)
    test_local_revenue_currency(ctx)
    test_currency_follows_global_only(ctx)
    test_patch_shape(ctx)

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
