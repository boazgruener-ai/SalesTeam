// 1.2.4.20 (DATA_PROTECTION_REQUIREMENTS.md R5): what SalesTeam holds about one person, as a page to print to PDF.
// The report comes from Settings → Data protection (storage.js findPerson) in session storage and is removed as soon
// as it is read, so a reload does not show it again. Everything is put in as text (textContent), never as HTML.

const root = document.getElementById("report");

function el(tag, text, cls) {
  const x = document.createElement(tag);
  if (text != null) x.textContent = text;
  if (cls) x.className = cls;
  return x;
}

const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "");

// The fields of a record worth showing, by label - empty ones left out.
function fields(pairs) {
  const dl = el("dl");
  for (const [label, value] of pairs) {
    if (value === null || value === undefined || String(value).trim() === "") continue;
    dl.append(el("dt", label), el("dd", String(value)));
  }
  return dl;
}

function section(title, items, render) {
  root.appendChild(el("h2", title));
  if (!items.length) { root.appendChild(el("p", "Nothing stored.", "none")); return; }
  for (const x of items) {
    const box = el("div", null, "item");
    render(x, box);
    root.appendChild(box);
  }
}

function render(r) {
  root.textContent = "";
  root.appendChild(el("h1", "Personal data held in SalesTeam"));
  const meta = el("table", null, "meta");
  const row = (a, b) => { const tr = el("tr"); tr.append(el("td", a), el("td", b)); meta.appendChild(tr); };
  row("Date", when(r.madeAt));
  if (r.madeBy) row("Made by", r.seller ? `${r.madeBy}, ${r.seller}` : r.madeBy);
  else if (r.seller) row("Made by", r.seller);
  row("Searched for", r.query);
  row("Where the data came from", r.sources.length ? r.sources.join("; ") : "-");
  root.appendChild(meta);
  root.appendChild(el("p", "SalesTeam is a browser extension. This data is stored in the browser of the person named above (and, in a team, in the team's shared folder); it is not sent to a SalesTeam server.", "hint"));

  const contacts = r.people.flatMap((p) => p.contacts);
  section("Contact", contacts, (c, box) => {
    box.appendChild(el("h3", `${c.fullName}${c.company ? ` - ${c.company}` : ""}`));
    box.appendChild(fields([
      ["Job title", c.jobTitle], ["Seniority", c.seniorityLevel], ["LinkedIn profile", c.lastVerified2 || c.linkedinUrl],
      ["E-mail", c.email], ["Phone", c.phone], ["Location", c.location || c.country], ["Source", c.source],
      ["Last checked", c.lastVerified],
    ]));
  });
  for (const d of r.discovered) {
    const box = el("div", null, "item");
    box.appendChild(el("h3", `${d.name}${d.companyName ? ` - ${d.companyName}` : ""} (found by contact discovery, not added)`));
    box.appendChild(fields([["Headline", d.headlineText], ["LinkedIn profile", d.slug ? `https://www.linkedin.com/in/${d.slug}/` : ""], ["Found", day(d.discoveredAt)]]));
    root.appendChild(box);
  }

  const leads = r.people.flatMap((p) => p.leads);
  section("Leads (LinkedIn posts)", leads, (l, box) => {
    box.appendChild(el("h3", `Post by ${l.author}${l.company ? ` - ${l.company}` : ""}`));
    box.appendChild(fields([
      ["Headline", l.headline], ["LinkedIn profile", l.profileUrl], ["Post", l.postUrl], ["Posted", day(l.postedAt)],
      ["Found by SalesTeam", day(l.firstSeenAt)], ["Text", l.snippet], ["Status", l.status], ["Priority", l.priority],
      ["Draft message", l.draftMessage],
    ]));
  });

  section("Notes", r.notes, (n, box) => {
    box.appendChild(el("h3", `Note on ${n.on === "account" ? `the account ${n.key}` : `a ${n.on}`}, ${day(n.at)}${n.deleted ? " (marked deleted)" : ""}`));
    box.appendChild(el("div", n.text, "msg"));
  });

  section("Conversations", r.conversations, (c, box) => {
    box.appendChild(el("h3", `${c.kind} - ${c.where}`));
    for (const m of c.messages) {
      const p = el("div", null, "msg");
      p.append(el("b", m.role), document.createTextNode(m.text));
      box.appendChild(p);
    }
  });

  section("Activity log", r.logLines, (x, box) => {
    box.appendChild(el("div", `${when(x.at)} - ${x.text}${x.team ? " (team log)" : ""}`));
  });
  // The title is the PDF's file name: whose data it is, then the date (a link search: the name found, else the link).
  const names = [...new Set(r.people.map((p) => p.name).filter(Boolean))];
  const who = (names.length ? names.join(", ") : r.query).replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  document.title = `${who} - personal data held in SalesTeam - ${day(r.madeAt)}`;
}

document.getElementById("print-btn").addEventListener("click", () => window.print());

(async () => {
  const got = await chrome.storage.session.get("personReport");
  const r = got.personReport;
  if (!r) {
    root.textContent = "";
    root.appendChild(el("p", "This report is no longer here. Open it again from SalesTeam Settings → Data protection → Find a person.", "none"));
    return;
  }
  await chrome.storage.session.remove("personReport");
  render(r);
  setTimeout(() => window.print(), 300);
})();
