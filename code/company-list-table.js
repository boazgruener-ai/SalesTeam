// One Setup company list as a table (1.2.3, EXCLUSIONS_RELATIONSHIPS_DESIGN.md 9.2): Company, LinkedIn page, Website;
// sorted A-Z, a search box, a count, "+ Add", and a ⋮ per row with Edit, Remove and Move to... another list.
//
// The tables edit one draft shared by both Setup steps ("Companies to exclude" and "Customers and partners"): an array of
// { category, name?, slug?, domain?, source?, sourceUrl? } read and written through `store`. Nothing is saved here - the
// wizard's Save writes the draft (explicit Save, design 9.3).

import { parseCompanyListEntry, sameCompanyEntry } from "./company-identity.js";

const node = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") n.textContent = v;
    else if (k === "className") n.className = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c) n.append(c);
  return n;
};

const displayName = (e) => e.name || e.slug || e.domain || "";

let openMenu = null;
function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
}
document.addEventListener("click", (event) => {
  if (openMenu && !openMenu.contains(event.target)) closeMenu();
});

// el: container. opts: { category, label, hint, lists: [[category, label]] (every list, for Move to...),
//   store: { get(), set(array) }, readOnly, flagFor(entry) -> text | null, onChange() }
// Returns { render() } - call render() when the draft changed elsewhere (another table, a proposal tick).
export function mountCompanyListTable(el, opts) {
  const { category, label, hint, lists, store, flagFor, onChange } = opts;
  let query = "";
  let editing = null; // { entry (null = new row), error }
  el.innerHTML = "";
  el.classList.add("company-list");

  const heading = node("h3", { className: "company-list-heading" });
  const search = node("input", { type: "search", className: "company-list-search", placeholder: "Search by name" });
  search.addEventListener("input", () => { query = search.value.trim().toLowerCase(); render(); });
  const addBtn = node("button", { type: "button", className: "step-inline-btn company-list-add", text: "+ Add" });
  addBtn.addEventListener("click", () => { editing = { entry: null, error: null }; render(); });
  const head = node("div", { className: "company-list-head" }, [heading, search, addBtn]);
  const hintEl = hint ? node("p", { className: "field-hint", text: hint }) : null;
  const tbody = node("tbody");
  const table = node("table", { className: "company-list-table" }, [
    node("thead", {}, [node("tr", {}, ["Company", "LinkedIn page", "Website", ""].map((t) => node("th", { text: t })))]),
    tbody,
  ]);
  const empty = node("p", { className: "company-list-empty" });
  el.append(head, ...(hintEl ? [hintEl] : []), table, empty);

  const entries = () => store.get().filter((e) => e && e.category === category);
  const replace = (from, to) => {
    store.set(store.get().map((e) => (e === from ? to : e)).filter(Boolean));
    onChange();
  };

  function editRow(entry) {
    const nameIn = node("input", { type: "text", placeholder: "Company name" });
    const linkIn = node("input", { type: "text", placeholder: "https://www.linkedin.com/company/..." });
    const webIn = node("input", { type: "text", placeholder: "acme.ch" });
    nameIn.value = entry?.name || "";
    linkIn.value = entry?.slug ? `https://www.linkedin.com/company/${entry.slug}/` : "";
    webIn.value = entry?.domain || "";
    const ok = node("button", { type: "button", className: "company-list-row-save", text: "OK" });
    const cancel = node("button", { type: "button", className: "company-list-row-cancel", text: "Cancel" });
    const commit = () => {
      const { entry: parsed, error } = parseCompanyListEntry({ name: nameIn.value, linkedin: linkIn.value, website: webIn.value });
      if (error) { editing.error = error; render(); return; }
      const dup = entries().find((e) => e !== entry && sameCompanyEntry(e, parsed));
      if (dup) { editing.error = `${displayName(dup)} is already on this list.`; render(); return; }
      const next = { ...(entry || {}), category };
      delete next.name; delete next.slug; delete next.domain;
      Object.assign(next, parsed);
      if (!entry) next.source = "user";
      editing = null;
      if (entry) replace(entry, next);
      else { store.set([...store.get(), next]); onChange(); }
    };
    ok.addEventListener("click", commit);
    cancel.addEventListener("click", () => { editing = null; render(); });
    for (const input of [nameIn, linkIn, webIn]) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); commit(); }
        if (event.key === "Escape") { editing = null; render(); }
      });
    }
    const tr = node("tr", { className: "company-list-editing" }, [
      node("td", {}, [nameIn]), node("td", {}, [linkIn]), node("td", {}, [webIn]),
      node("td", { className: "company-list-row-actions" }, [ok, cancel]),
    ]);
    const rows = [tr];
    if (editing.error) rows.push(node("tr", { className: "company-list-error-row" }, [node("td", { colspan: "4", text: editing.error })]));
    setTimeout(() => nameIn.focus(), 0);
    return rows;
  }

  function menuFor(entry, anchor) {
    closeMenu();
    const menu = node("div", { className: "company-list-menu" });
    const item = (text, fn, cls) => {
      const b = node("button", { type: "button", className: `company-list-menu-item${cls ? ` ${cls}` : ""}`, text });
      b.addEventListener("click", (event) => { event.stopPropagation(); closeMenu(); fn(); });
      menu.append(b);
    };
    item("Edit", () => { editing = { entry, error: null }; render(); });
    item("Remove", () => replace(entry, null), "danger");
    menu.append(node("div", { className: "company-list-menu-label", text: "Move to" }));
    for (const [cat, catLabel] of lists) {
      if (cat === category) continue;
      item(catLabel, () => replace(entry, { ...entry, category: cat }), "indent");
    }
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + window.scrollY + 2}px`;
    menu.style.left = `${Math.max(8, r.right + window.scrollX - menu.offsetWidth)}px`;
    openMenu = menu;
  }

  function render() {
    const all = entries();
    heading.textContent = `${label} - ${all.length}`;
    addBtn.hidden = !!opts.readOnly;
    const shown = all
      .filter((e) => !query || displayName(e).toLowerCase().includes(query))
      .sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { sensitivity: "base" }));
    tbody.innerHTML = "";
    if (editing && !editing.entry) tbody.append(...editRow(null));
    for (const e of shown) {
      if (editing && editing.entry === e) { tbody.append(...editRow(e)); continue; }
      // No name (an entry added by its LinkedIn page or website only): its slug or domain, greyed.
      const nameTd = node("td", {}, [e.name
        ? node("span", { text: e.name })
        : node("span", { className: "company-list-none", text: e.slug || e.domain || "—", title: "No name given - matched by its LinkedIn page or website" })]);
      if (e.source === "research" && e.sourceUrl) {
        nameTd.append(" ", node("a", { href: e.sourceUrl, target: "_blank", rel: "noopener noreferrer", className: "company-list-source", text: "found by research" }));
      }
      const flag = flagFor ? flagFor(e) : null;
      if (flag) nameTd.append(node("div", { className: "company-list-flag", text: flag }));
      const linkTd = node("td", {}, [e.slug
        ? node("a", { href: `https://www.linkedin.com/company/${e.slug}/`, target: "_blank", rel: "noopener noreferrer", text: e.slug })
        : node("span", { className: "company-list-none", text: "—" })]);
      const webTd = node("td", {}, [e.domain
        ? node("a", { href: `https://${e.domain}`, target: "_blank", rel: "noopener noreferrer", text: e.domain })
        : node("span", { className: "company-list-none", text: "—" })]);
      const actTd = node("td", { className: "company-list-row-actions" });
      if (!opts.readOnly) {
        const kebab = node("button", { type: "button", className: "company-list-kebab", title: "Actions", text: "⋮" });
        kebab.addEventListener("click", (event) => { event.stopPropagation(); menuFor(e, kebab); });
        actTd.append(kebab);
      }
      tbody.append(node("tr", flag ? { className: "company-list-flagged" } : {}, [nameTd, linkTd, webTd, actTd]));
    }
    empty.hidden = shown.length > 0 || !!(editing && !editing.entry);
    empty.textContent = all.length ? "No company matches the search." : "None yet.";
  }

  render();
  return { render, isEditing: () => !!editing };
}
