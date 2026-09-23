// An in-page replacement for the browser's confirm(): the browser can silently suppress native dialogs ("prevent this
// page from creating additional dialogs", or when a page is shown inside another one), which made buttons look dead
// after the first Cancel (reported 2026-09-21). This one always appears, and its buttons say what they do.
//
//   if (!(await askConfirm("Clear this conversation?", { okLabel: "Clear conversation", cancelLabel: "Keep it", danger: true }))) return;

let dialogEl = null;
let noticeEl = null;
let hideProgress = false; // the user closed a "Working…" pop-up: keep quiet until the final result
let styleAdded = false;

function ensureStyle() {
  if (styleAdded) return;
  styleAdded = true;
  const style = document.createElement("style");
  style.textContent = `
    #salesteam-confirm-dialog { border: none; border-radius: 10px; padding: 20px 24px; width: 480px; max-width: 90vw;
      box-shadow: 0 8px 30px rgba(0,0,0,.25); font-family: inherit; }
    #salesteam-confirm-dialog::backdrop { background: rgba(0,0,0,.5); }
    #salesteam-confirm-dialog .sc-message { white-space: pre-wrap; font-size: 13px; line-height: 1.5; margin: 0 0 16px; color: #1f2933; }
    #salesteam-confirm-dialog .sc-actions { display: flex; gap: 8px; justify-content: flex-end; }
    #salesteam-confirm-dialog button { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; }
    #salesteam-confirm-dialog .sc-ok { background: #0a66c2; color: #fff; }
    #salesteam-confirm-dialog .sc-ok.sc-danger { background: #b3261e; }
    #salesteam-confirm-dialog .sc-cancel { background: #f0f0f0; color: #1f2933; }
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
  dialogEl.innerHTML = '<p class="sc-message"></p><div class="sc-actions"><button type="button" class="sc-cancel"></button><button type="button" class="sc-ok"></button></div>';
  document.body.appendChild(dialogEl);
  return dialogEl;
}

export function askConfirm(message, { okLabel = "OK", cancelLabel = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    const dialog = ensureDialog();
    if (dialog.open) dialog.close();
    dialog.querySelector(".sc-message").textContent = message;
    const okBtn = dialog.querySelector(".sc-ok");
    const cancelBtn = dialog.querySelector(".sc-cancel");
    okBtn.textContent = okLabel;
    cancelBtn.textContent = cancelLabel;
    okBtn.classList.toggle("sc-danger", danger);
    const finish = (value) => {
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      dialog.onclose = null;
      if (dialog.open) dialog.close();
      resolve(value);
    };
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    dialog.onclose = () => finish(false); // Escape
    dialog.showModal();
    cancelBtn.focus();
  });
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
