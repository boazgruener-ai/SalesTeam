// Onboarding research (ONBOARDING_RESEARCH_DESIGN.md 3.5): how a wizard step shows what the seller research
// proposes. One banner per step - its sources as links (R5.1), "Nothing found" when the research had nothing for it
// (R5.2), and "Research again" with an optional hint (R4.4) - and one checklist for proposed lists: a checkbox per
// item, the text editable, a rank where order matters, and Add (R3.1.5). Built as DOM nodes, never innerHTML, so
// nothing a web page said can become markup.
import { sourceLabel } from "./setup-proposals.js";

function node(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "className") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c) n.append(c);
  return n;
}

function sourceLinks(urls) {
  const out = [];
  (urls || []).slice(0, 4).forEach((url, i) => {
    if (i) out.push(", ");
    out.push(node("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: sourceLabel(url) }));
  });
  return out;
}

// slot: the step's .proposal-slot element. opts: {
//   proposal (the step's, or undefined), site ("acme.ch"), completedBefore (R4.5: proposals sit beside the current
//   setting instead of replacing it), notes: [string], onUse (completedBefore only: puts the proposal into the
//   form), useLabel, onResearchAgain(hint) -> Promise (re-runs this step's part), againCostText }
export function renderProposalBanner(slot, opts) {
  slot.innerHTML = "";
  const p = opts.proposal;
  if (!p) { slot.hidden = true; return; }
  slot.hidden = false;
  const box = node("div", { className: "proposal-banner" + (p.found ? "" : " proposal-banner-empty") });
  if (p.found) {
    // Three wordings: a setup completed before (the proposal sits beside the current setting, R4.5), a first setup
    // before Next (R3.1.2: visibly a proposal), and a first setup after Next (taken; the sources stay visible).
    const lead = opts.completedBefore ? "Research proposal" : opts.accepted ? "Based on the research" : "Proposed";
    const tail = opts.completedBefore
      ? " - the current setting stays as it is unless you use the proposal."
      : opts.accepted ? "." : " - keep it, change it or clear it. Next accepts what is on screen.";
    const head = node("p", { className: "proposal-banner-head" }, [
      node("strong", { text: lead }),
      p.sources && p.sources.length ? " from " : " of your company's website",
      ...sourceLinks(p.sources),
      tail,
    ]);
    box.append(head);
  } else {
    box.append(node("p", { className: "proposal-banner-head" }, [
      `Nothing found on ${opts.site || "your website"} for this. Enter it yourself, or Research again with a hint.`,
    ]));
  }
  for (const note of opts.notes || []) if (note) box.append(node("p", { className: "proposal-banner-note", text: note }));

  const actions = node("div", { className: "proposal-banner-actions" });
  if (p.found && (opts.completedBefore || opts.accepted) && opts.onUse) {
    actions.append(node("button", { type: "button", className: "step-inline-btn", text: opts.useLabel || "Use proposal", onClick: () => opts.onUse() }));
  }
  if (opts.onResearchAgain) {
    const form = node("div", { className: "proposal-again-form" });
    form.hidden = true;
    const hint = node("input", { type: "text", className: "proposal-again-hint", placeholder: "Optional hint, e.g. \"focus on our consulting services, not the software\"" });
    const status = node("span", { className: "status-text", role: "status" });
    const go = node("button", { type: "button", className: "step-inline-btn", text: `Research again${opts.againCostText ? ` (${opts.againCostText})` : ""}` });
    go.addEventListener("click", async () => {
      go.disabled = true;
      hint.disabled = true;
      status.textContent = "Researching… this takes about a minute.";
      try {
        await opts.onResearchAgain(hint.value.trim());
      } catch (err) {
        status.textContent = `Could not research again: ${err.message || err}`;
        go.disabled = false;
        hint.disabled = false;
      }
    });
    form.append(hint, go, status);
    actions.append(node("button", {
      type: "button", className: "step-inline-btn proposal-again-toggle", text: "Research again…",
      onClick: () => { form.hidden = !form.hidden; if (!form.hidden) hint.focus(); },
    }));
    box.append(actions, form);
  } else {
    box.append(actions);
  }
  slot.append(box);
}

// container: where the list goes. items: [{ text, checked, sourceUrl?, meta? }]. opts: { title, rankable, addPlaceholder,
// onChange }. Returns { getItems() -> [{ text, checked, sourceUrl, meta }] } in the order on screen.
export function mountChecklist(container, items, opts = {}) {
  container.innerHTML = "";
  const state = (items || []).map((i) => ({ ...i }));
  const wrap = node("div", { className: "proposal-checklist" });
  if (opts.title) wrap.append(node("p", { className: "proposal-checklist-title", text: opts.title }));
  const rows = node("div", { className: "proposal-checklist-rows" });
  wrap.append(rows);
  const changed = () => { if (opts.onChange) opts.onChange(); };

  const render = () => {
    rows.innerHTML = "";
    state.forEach((item, index) => {
      const box = node("input", { type: "checkbox" });
      box.checked = !!item.checked;
      box.addEventListener("change", () => { item.checked = box.checked; row.classList.toggle("priority-item-unchecked", !box.checked); });
      const text = node("input", { type: "text", className: "proposal-checklist-text" });
      text.value = item.text;
      text.addEventListener("input", () => { item.text = text.value; });
      const row = node("div", { className: "proposal-checklist-row" + (item.checked ? "" : " priority-item-unchecked") });
      if (opts.rankable) row.append(node("span", { className: "proposal-checklist-rank", text: `${index + 1}.` }));
      row.append(box, text);
      if (item.label) row.append(node("span", { className: "proposal-checklist-label", text: item.label }));
      if (item.sourceUrl) row.append(node("a", { href: item.sourceUrl, target: "_blank", rel: "noopener noreferrer", className: "proposal-checklist-source", text: "source" }));
      if (opts.rankable) {
        const move = (delta) => {
          const to = index + delta;
          if (to < 0 || to >= state.length) return;
          [state[index], state[to]] = [state[to], state[index]];
          render();
          changed();
        };
        const up = node("button", { type: "button", className: "proposal-rank-btn", title: "Move up", text: "↑", onClick: () => move(-1) });
        const down = node("button", { type: "button", className: "proposal-rank-btn", title: "Move down", text: "↓", onClick: () => move(1) });
        up.disabled = index === 0;
        down.disabled = index === state.length - 1;
        row.append(up, down);
      }
      rows.append(row);
    });
  };
  render();

  const addInput = node("input", { type: "text", className: "proposal-checklist-text", placeholder: opts.addPlaceholder || "Add another" });
  const add = () => {
    const text = addInput.value.trim();
    if (!text) return;
    state.push({ text, checked: true });
    addInput.value = "";
    render();
    changed();
  };
  addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  wrap.append(node("div", { className: "proposal-checklist-add" }, [addInput, node("button", { type: "button", className: "step-inline-btn", text: "Add", onClick: add })]));
  container.append(wrap);
  container.hidden = false;

  return {
    getItems: () => state.map((i) => ({ ...i, text: String(i.text || "").trim() })).filter((i) => i.text),
    setAllChecked: (checked) => { state.forEach((i) => { i.checked = !!checked; }); render(); },
  };
}
