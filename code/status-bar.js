// The ONE place for "something is running or waiting" messages (1.2.0.2). Boaz, live test 2026-09-29: messages
// appeared at the top, at the bottom and as pop-ups, and were pale - "the user does not know where to look".
// The rule since then: anything running or waiting is shown here, in a strong bar across the top of the window;
// a pop-up only asks a question or reports a job the user started that has finished; the automatic pipeline
// stays quiet in its own Pipeline status box. Do not add another floating note or toast - use this.
//
// The bar is a manual popover, so it sits in the browser's top layer: above an open modal <dialog> and its grey
// backdrop (a note in <body> was hidden behind one - Start looked dead for up to 2.5 minutes). An in-flow spacer
// of the same height keeps it from covering the top of the page. Safe to import from the background worker:
// nothing touches the DOM until a message is set.

const TONES = {
  info: { background: "#0a3d7a", color: "#fff" },
  error: { background: "#b3261e", color: "#fff" },
};

const messages = new Map(); // id -> { text, tone, action: { label, disabled, onClick } | null }
let barEl = null;
let spacerEl = null;
let shownKey = "";

function ensureBar() {
  if (barEl) return barEl;
  spacerEl = document.createElement("div");
  spacerEl.id = "status-bar-spacer";
  spacerEl.style.cssText = "display:none;";
  barEl = document.createElement("div");
  barEl.id = "status-bar";
  barEl.setAttribute("role", "status");
  barEl.setAttribute("aria-live", "polite");
  if ("popover" in HTMLElement.prototype) barEl.setAttribute("popover", "manual");
  barEl.style.cssText = "position:fixed;inset:0 0 auto 0;margin:0;width:100%;max-width:none;box-sizing:border-box;border:0;" +
    "z-index:2147483001;display:none;gap:16px;align-items:center;justify-content:space-between;padding:10px 20px;" +
    "font:600 14px/1.4 system-ui,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.25);overflow:visible;";
  const text = document.createElement("span");
  text.id = "status-bar-text";
  const btn = document.createElement("button");
  btn.id = "status-bar-action";
  btn.type = "button";
  btn.style.cssText = "flex-shrink:0;background:#fff;color:#1a1a1a;border:0;border-radius:6px;padding:5px 14px;" +
    "font:600 13px system-ui,sans-serif;cursor:pointer;";
  btn.addEventListener("click", () => {
    const current = [...messages.values()].pop();
    if (current && current.action && !current.action.disabled) current.action.onClick();
  });
  barEl.append(text, btn);
  document.body.prepend(spacerEl);
  document.body.append(barEl);
  return barEl;
}

function render() {
  if (typeof document === "undefined" || !document.body) return;
  const current = [...messages.values()].pop(); // the latest message set wins
  if (!current) {
    if (barEl) {
      barEl.style.display = "none";
      spacerEl.style.display = "none";
      if (barEl.matches(":popover-open")) barEl.hidePopover();
    }
    shownKey = "";
    return;
  }
  const bar = ensureBar();
  const tone = TONES[current.tone] || TONES.info;
  bar.style.background = tone.background;
  bar.style.color = tone.color;
  bar.querySelector("#status-bar-text").textContent = current.text;
  const btn = bar.querySelector("#status-bar-action");
  btn.hidden = !current.action;
  if (current.action) {
    btn.textContent = current.action.label;
    btn.disabled = Boolean(current.action.disabled);
    btn.style.opacity = current.action.disabled ? "0.6" : "1";
  }
  bar.style.display = "flex";
  // Re-raised when the message changes, so it comes above a dialog opened since it was first shown.
  const key = `${current.tone}|${current.text}`;
  if (bar.hasAttribute("popover") && (key !== shownKey || !bar.matches(":popover-open"))) {
    if (bar.matches(":popover-open")) bar.hidePopover();
    bar.showPopover();
  }
  shownKey = key;
  spacerEl.style.height = `${bar.offsetHeight}px`;
  spacerEl.style.display = "block";
}

// Shows (or updates) a message. `tone`: "info" (dark blue) or "error" (red). `action`: an optional button.
// An update keeps the message's place; a new message goes on top of the ones already shown.
export function setStatusMessage(id, { text, tone = "info", action = null }) {
  messages.set(id, { text, tone, action });
  render();
}

export function clearStatusMessage(id) {
  if (!messages.delete(id)) return;
  render();
}
