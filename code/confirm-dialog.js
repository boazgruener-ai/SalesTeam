// An in-page replacement for the browser's confirm(): the browser can silently suppress native dialogs ("prevent this
// page from creating additional dialogs", or when a page is shown inside another one), which made buttons look dead
// after the first Cancel (reported 2026-09-21). This one always appears, and its buttons say what they do.
//
//   if (!(await askConfirm("Clear this conversation?", { okLabel: "Clear conversation", cancelLabel: "Keep it", danger: true }))) return;

let dialogEl = null;
let pendingFinish = null; // the open askConfirm's answer: settled as "Cancel" when another one replaces it
let noticeEl = null;
let hideProgress = false; // the user closed a "Working…" pop-up: keep quiet until the final result
let styleAdded = false;

function ensureStyle() {
  if (styleAdded) return;
  styleAdded = true;
  const style = document.createElement("style");
  style.textContent = `
    .save-confirm { display: inline-block; background: #e6f4ea; color: #137333; border: 1px solid #81c995; border-radius: 6px;
      padding: 4px 10px; font-weight: 700; font-size: 13px; }
    #salesteam-confirm-dialog { border: none; border-radius: 10px; padding: 20px 24px; width: 480px; max-width: 90vw;
      box-shadow: 0 8px 30px rgba(0,0,0,.25); font-family: inherit; }
    #salesteam-confirm-dialog::backdrop { background: rgba(0,0,0,.5); }
    #salesteam-confirm-dialog .sc-title { margin: 0 0 10px; font-size: 15px; font-weight: 700; color: #1f2933; }
    #salesteam-confirm-dialog .sc-title[hidden] { display: none; }
    #salesteam-confirm-dialog .sc-message { white-space: pre-wrap; font-size: 13px; line-height: 1.5; margin: 0 0 16px; color: #1f2933; }
    #salesteam-confirm-dialog .sc-details { margin: -6px 0 16px; font-size: 13px; color: #1f2933; }
    #salesteam-confirm-dialog .sc-details[hidden] { display: none; }
    #salesteam-confirm-dialog .sc-details summary { cursor: pointer; font-weight: 600; }
    #salesteam-confirm-dialog .sc-details ul { margin: 6px 0 0; padding-left: 18px; max-height: 220px; overflow-y: auto; }
    #salesteam-confirm-dialog .sc-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    #salesteam-confirm-dialog button { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; }
    #salesteam-confirm-dialog .sc-ok { background: #0a66c2; color: #fff; }
    #salesteam-confirm-dialog .sc-ok.sc-danger { background: #b3261e; }
    #salesteam-confirm-dialog .sc-cancel { background: #f0f0f0; color: #1f2933; }
    #salesteam-confirm-dialog .sc-cancel[hidden] { display: none; }
    #salesteam-notice-dialog { border: none; border-radius: 10px; padding: 20px 24px; width: 480px; max-width: 90vw;
      box-shadow: 0 8px 30px rgba(0,0,0,.25); font-family: inherit; }
    #salesteam-notice-dialog::backdrop { background: rgba(0,0,0,.5); }
    #salesteam-notice-dialog .sn-head { display: flex; align-items: center; gap: 10px; margin: 0 0 10px; font-size: 15px; font-weight: 700; color: #1f2933; }
    #salesteam-notice-dialog.sn-error .sn-head { color: #b3261e; }
    #salesteam-notice-dialog .sn-spinner { width: 16px; height: 16px; border: 2px solid #cfd8e3; border-top-color: #0a66c2; border-radius: 50%; animation: sn-spin .8s linear infinite; }
    #salesteam-notice-dialog .sn-spinner[hidden] { display: none; }
    @keyframes sn-spin { to { transform: rotate(360deg); } }
    #salesteam-notice-dialog .sn-message { white-space: pre-wrap; font-size: 13px; line-height: 1.5; margin: 0 0 16px; color: #1f2933; }
    #salesteam-notice-dialog .sn-actions { display: flex; justify-content: flex-end; }
    #salesteam-notice-dialog .sn-ok { padding: 8px 20px; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; background: #0a66c2; color: #fff; }
    @media (prefers-reduced-motion: reduce) { #salesteam-notice-dialog .sn-spinner { animation: none; } }
  `;
  document.head.appendChild(style);
}

function ensureDialog() {
  if (dialogEl) return dialogEl;
  ensureStyle();
  dialogEl = document.createElement("dialog");
  dialogEl.id = "salesteam-confirm-dialog";
  dialogEl.innerHTML = '<h3 class="sc-title" hidden></h3><p class="sc-message"></p><details class="sc-details" hidden><summary></summary><ul></ul></details><div class="sc-actions"><button type="button" class="sc-cancel"></button><button type="button" class="sc-ok"></button></div>';
  document.body.appendChild(dialogEl);
  return dialogEl;
}

// `cancelLabel: null`: a message with one OK only (1.2.2.8, Boaz: "OK" next to "Close" said the same thing twice).
// `title`: an optional heading - "Advanced tools → Re-score All Priorities" (1.2.2.8, Boaz: each tool its own pop-up).
// `details`: an optional fold-out list under the message - { summary: "Details", lines: ["...", ...] } (1.2.3: the
// import's check-first summary lists the new accounts and the differences for Decisions).
export function askConfirm(message, { okLabel = "OK", cancelLabel = "Cancel", danger = false, title = "", details = null } = {}) {
  return new Promise((resolve) => {
    const dialog = ensureDialog();
    // 1.2.2.7 (Annick's Join button stayed disabled): a second askConfirm used to take over the dialog before the first
    // had its answer - the first caller then waited for ever. It now gets "Cancel" first.
    if (pendingFinish) pendingFinish(false);
    if (dialog.open) dialog.close();
    dialog.querySelector(".sc-title").textContent = title;
    dialog.querySelector(".sc-title").hidden = !title;
    dialog.querySelector(".sc-message").textContent = message;
    const detailsEl = dialog.querySelector(".sc-details");
    detailsEl.hidden = !(details && details.lines && details.lines.length);
    detailsEl.open = false;
    detailsEl.querySelector("summary").textContent = (details && details.summary) || "Details";
    detailsEl.querySelector("ul").replaceChildren(...((details && details.lines) || []).map((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      return li;
    }));
    const okBtn = dialog.querySelector(".sc-ok");
    const cancelBtn = dialog.querySelector(".sc-cancel");
    okBtn.textContent = okLabel;
    cancelBtn.textContent = cancelLabel || "";
    cancelBtn.hidden = cancelLabel === null;
    okBtn.classList.toggle("sc-danger", danger);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (pendingFinish === finish) pendingFinish = null;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      dialog.onclose = null;
      if (dialog.open) dialog.close();
      resolve(value);
    };
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    dialog.onclose = () => finish(false); // Escape
    pendingFinish = finish;
    dialog.showModal();
    (cancelLabel === null ? okBtn : cancelBtn).focus();
  });
}

// A question with more than two answers: one button per choice, plus Cancel. Resolves to the chosen value, or null
// for Cancel / Escape. The first choice is the highlighted one.
//
//   const scope = await askChoice("Export which rows?", [{ value: "all", label: "All 900" }, { value: "shown", label: "The 12 shown" }]);
export function askChoice(message, choices, { cancelLabel = "Cancel" } = {}) {
  return new Promise((resolve) => {
    ensureStyle();
    const dialog = document.createElement("dialog");
    dialog.id = "salesteam-confirm-dialog";
    const text = document.createElement("p");
    text.className = "sc-message";
    text.textContent = message;
    const actions = document.createElement("div");
    actions.className = "sc-actions";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "sc-cancel";
    cancelBtn.textContent = cancelLabel;
    cancelBtn.onclick = () => finish(null);
    actions.appendChild(cancelBtn);
    [...choices].reverse().forEach((choice, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = i === choices.length - 1 ? "sc-ok" : "sc-cancel";
      btn.textContent = choice.label;
      // A label never wraps; a "\n" in it starts a second line ("Anna" / "(3 of 4)").
      btn.style.whiteSpace = "pre";
      btn.onclick = () => finish(choice.value);
      actions.appendChild(btn);
    });
    dialog.append(text, actions);
    dialog.onclose = () => finish(null); // Escape
    document.body.appendChild(dialog);
    dialog.showModal();
    cancelBtn.focus();
  });
}

// 1.2.2.5 (Boaz: "did not get any feedback on the Save"): a Save's confirmation used to be small grey text gone after
// 2.5 s. Now a clear green "Saved" next to the buttons that stays until the next change on the page.
export function markSaved(el, text = "✓ Saved") {
  if (!el) return;
  ensureStyle();
  el.textContent = text;
  el.classList.add("save-confirm");
  const clear = () => {
    el.classList.remove("save-confirm");
    if (el.textContent === text) el.textContent = "";
  };
  document.addEventListener("input", clear, { once: true, capture: false });
}

// A result / progress pop-up with a single OK (or Close, while the action is still running) button - used instead of a
// small line of text somewhere on the page, which was easy to miss (reported 2026-09-21).
export function showNotice(message, { working = false, error = false } = {}) {
  ensureStyle();
  if (working && hideProgress) return;
  if (!working) hideProgress = false;
  if (!noticeEl) {
    noticeEl = document.createElement("dialog");
    noticeEl.id = "salesteam-notice-dialog";
    noticeEl.innerHTML = '<div class="sn-head"><span class="sn-spinner"></span><span class="sn-title"></span></div>' +
      '<p class="sn-message"></p><div class="sn-actions"><button type="button" class="sn-ok"></button></div>';
    document.body.appendChild(noticeEl);
    noticeEl.querySelector(".sn-ok").addEventListener("click", () => {
      if (!noticeEl.querySelector(".sn-spinner").hidden) hideProgress = true;
      noticeEl.close();
    });
  }
  noticeEl.classList.toggle("sn-error", error);
  noticeEl.querySelector(".sn-spinner").hidden = !working;
  noticeEl.querySelector(".sn-title").textContent = working ? "Working…" : error ? "Something went wrong" : /^Nothing to do/i.test(message) ? "Nothing to do" : "Done";
  noticeEl.querySelector(".sn-message").textContent = working
    ? `${message}\n\nStill working - you can close this window; the work keeps running and its result appears when it is done.`
    : message;
  noticeEl.querySelector(".sn-ok").textContent = working ? "Close (it keeps running)" : "OK";
  if (!noticeEl.open) noticeEl.showModal();
}

// Mirrors the text an action writes into its status element(s) into a pop-up, so every action's progress and result is
// shown the same way. Empty text (a status being cleared) shows nothing.
export function mirrorStatusToPopup(ids) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    new MutationObserver(() => {
      const text = el.textContent.trim();
      if (!text) return;
      const working = /…$|\.\.\.$/.test(text) || /^(Researching|Searching|Working|Importing|Reading)\b/i.test(text);
      const error = /^Something went wrong|^Add an Anthropic|^Import failed|^Merge failed|^Couldn't|failed\b/i.test(text);
      showNotice(text, { working, error });
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }
}
