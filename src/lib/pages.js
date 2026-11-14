// HTML pages. Every value is escaped; the only inline script is the
// screenshot shrinker, allowed by its CSP hash (docs/SDD.md, "Security").
import { escapeHtml as e, htmlResponse } from "./http.js";

/** Shrinks chosen screenshots to 1,600 px on the longest side before upload (re-encoding drops EXIF). */
export const SHRINK_JS =
  "document.querySelectorAll('input[type=file][data-shrink]').forEach(function(inp){inp.addEventListener('change',async function(){if(!window.DataTransfer||!window.createImageBitmap)return;var dt=new DataTransfer();for(const f of inp.files){try{var b=await createImageBitmap(f);var s=Math.min(1,1600/Math.max(b.width,b.height));var c=document.createElement('canvas');c.width=Math.round(b.width*s);c.height=Math.round(b.height*s);c.getContext('2d').drawImage(b,0,0,c.width,c.height);var blob=await new Promise(function(r){c.toBlob(r,'image/jpeg',0.85)});dt.items.add(new File([blob],f.name.replace(/\\.\\w+$/,'')+'.jpg',{type:'image/jpeg'}))}catch(x){dt.items.add(f)}}inp.files=dt.files})});";

let shrinkHash = null;
export async function shrinkHashCsp() {
  if (!shrinkHash) {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SHRINK_JS)));
    shrinkHash = `sha256-${btoa(String.fromCharCode(...bytes))}`;
  }
  return shrinkHash;
}

const STYLE =
  "body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;color:#1c1c1c;background:#fff}" +
  "@media (prefers-color-scheme:dark){body{color:#eee;background:#151515}input,textarea,select{background:#222;color:#eee}}" +
  "label{display:block;margin:.8rem 0 .2rem;font-weight:600}input[type=text],input[type=email],input[type=number],textarea,select{width:100%;box-sizing:border-box;padding:.4rem}" +
  ".terms{white-space:pre-wrap;border:1px solid #8884;padding:1rem;max-height:24rem;overflow:auto}.hp{position:absolute;left:-10000px}" +
  ".err{color:#b00020}.muted{opacity:.75;font-size:.9rem}table{border-collapse:collapse}td,th{padding:.2rem .5rem;text-align:left}button{margin-top:1rem;padding:.5rem 1rem}";

export function layout(title, body, head = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)}</title><style>${STYLE}</style>${head}</head><body>${body}</body></html>`;
}

export function page(title, body, status = 200, opts = {}, extraHeaders = {}) {
  const head = opts.turnstile ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : "";
  return htmlResponse(layout(title, body, head), status, opts, extraHeaders);
}

export function message(title, text, status = 200, extraHeaders = {}) {
  return page(title, `<h1>${e(title)}</h1><p>${e(text)}</p>`, status, {}, extraHeaders);
}

// ---- The uniform answers (one each; same status, body and headers whatever happened) ----

export const THANKS_TEXT = "Thanks, we'll be in touch. If you're chosen for the beta, you'll get an invite by email.";
export const NOT_OPEN_TEXT = "This beta isn't taking applications right now.";
export const INVITE_DEAD_TEXT = "This invite link doesn't work any more. If you were invited, sign in or ask for a new link.";
export const DOWNLOAD_DENIED_TEXT = "This download link has expired or isn't yours. Open your tester page for a fresh one.";
export const SIGNIN_SENT_TEXT = "If that address belongs to a tester of this beta, a sign-in link is on its way. It works once, for 30 minutes. If it hasn't arrived in a few minutes, try again later.";
export const SIGNIN_DEAD_TEXT = "This sign-in link doesn't work any more. Ask for a new one.";

export function thanksPage(asJson) {
  if (asJson) return new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
  return message("Thanks", THANKS_TEXT, 200);
}

export function inviteDeadPage() {
  return page("Invite link", `<h1>Invite link</h1><p>${e(INVITE_DEAD_TEXT)}</p><p><a href="/signin">Sign in</a></p>`, 200);
}

export function downloadDenied() {
  return message("Download", DOWNLOAD_DENIED_TEXT, 403);
}

// ---- Forms ----

export function questionFields(questions, values = {}) {
  return questions
    .map((q) => {
      const req = q.required ? " required" : "";
      const label = `<label for="q_${e(q.id)}">${e(q.label)}${q.required ? " *" : ""}</label>`;
      const v = values[q.id];
      switch (q.type) {
        case "text":
          return `${label}<input type="text" id="q_${e(q.id)}" name="${e(q.id)}" maxlength="${q.max}" value="${e(v ?? "")}"${req}>`;
        case "longtext":
          return `${label}<textarea id="q_${e(q.id)}" name="${e(q.id)}" maxlength="${q.max}" rows="5"${req}>${e(v ?? "")}</textarea>`;
        case "number":
          return `${label}<input type="number" id="q_${e(q.id)}" name="${e(q.id)}" value="${e(v ?? "")}"${req}>`;
        case "checkbox":
          return `<label><input type="checkbox" name="${e(q.id)}" value="1"${v ? " checked" : ""}${req}> ${e(q.label)}</label>`;
        case "choice":
          return `${label}<select id="q_${e(q.id)}" name="${e(q.id)}"${req}><option value=""></option>${q.options.map((o) => `<option${v === o ? " selected" : ""}>${e(o)}</option>`).join("")}</select>`;
        case "multi":
          return `${label}${q.options.map((o) => `<label style="font-weight:400"><input type="checkbox" name="${e(q.id)}" value="${e(o)}"${Array.isArray(v) && v.includes(o) ? " checked" : ""}> ${e(o)}</label>`).join("")}`;
        case "rating":
          return `${label}<select id="q_${e(q.id)}" name="${e(q.id)}"${req}><option value=""></option>${[1, 2, 3, 4, 5].map((n) => `<option${v === n ? " selected" : ""}>${n}</option>`).join("")}</select>`;
        default:
          return "";
      }
    })
    .join("\n");
}

export function errorList(errors) {
  return errors.length ? `<ul class="err">${errors.map((x) => `<li>${e(x)}</li>`).join("")}</ul>` : "";
}
