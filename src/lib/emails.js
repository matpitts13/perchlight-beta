// Tester email wording (docs/SDD.md, "Email"). Every tester email has a plain
// text part, the beta's name, and how to stop reminders. Transactional, to
// people who applied; never marketing.
import { escapeHtml as e } from "./http.js";

function wrap(beta, lines, link, linkText, base, footer = true) {
  const stop = footer ? `\n\nTo stop reminders, open your tester page (${base}/t) and turn them off under Settings.` : "";
  const text = `${lines.join("\n\n")}${link ? `\n\n${link}` : ""}\n\n-- ${beta.name}${stop}`;
  const html =
    `<div style="font:15px/1.5 system-ui,sans-serif;max-width:36rem">${lines.map((l) => `<p>${e(l)}</p>`).join("")}` +
    (link ? `<p><a href="${e(link)}">${e(linkText)}</a></p><p style="font-size:12px;color:#666">${e(link)}</p>` : "") +
    `<p style="font-size:12px;color:#666">${e(beta.name)}${footer ? ` &middot; To stop reminders, turn them off on <a href="${e(base)}/t">your tester page</a>.` : ""}</p></div>`;
  return { text, html };
}

/**
 * @param {string} kind  delivery kind
 * @param {{ beta: any, base: string, name?: string|null, link?: string, build?: string, days?: number, endsAt?: number|null }} c
 * @returns {{ subject: string, text: string, html: string }}
 */
export function compose(kind, c) {
  const hi = c.name ? `Hi ${c.name},` : "Hi,";
  const b = c.beta;
  switch (kind) {
    case "invite":
      return {
        subject: `You're invited: ${b.name}`,
        ...wrap(b, [hi, `You're in! Open this link to read and accept the terms and get access. It works once and expires in ${c.days} days. Your invite is personal: please don't forward it.`], c.link, "Accept your invite", c.base, false),
      };
    case "reminder_invite":
      return {
        subject: `Reminder: your invite to ${b.name}`,
        ...wrap(b, [hi, "Your invite hasn't been used yet. Open the link in your original invite email to join, or sign in to ask for a new link."], `${c.base}/signin`, "Sign in", c.base),
      };
    case "signin":
      return {
        subject: `Sign in to ${b.name}`,
        ...wrap(b, [hi, "Here's your sign-in link. It works once, for 30 minutes. If you didn't ask for it, ignore this email."], c.link, "Sign in", c.base, false),
      };
    case "new_build":
      return { subject: `${c.build} is ready: ${b.name}`, ...wrap(b, [hi, `${c.build} is ready to download from your tester page.`], `${c.base}/t/${b.id}`, "Open your tester page", c.base) };
    case "reminder_survey":
      return { subject: `How was ${c.build}? ${b.name}`, ...wrap(b, [hi, `You downloaded ${c.build} a few days ago. A short survey is waiting on your tester page; it takes a couple of minutes.`], `${c.base}/t/${b.id}`, "Answer the survey", c.base) };
    case "reminder_ending":
      return {
        subject: `${b.name} ends soon`,
        ...wrap(b, [hi, `The beta ends on ${c.endsAt ? new Date(c.endsAt).toISOString().slice(0, 10) : "soon"}. If you have feedback or bugs to report, now's the time.`], `${c.base}/t/${b.id}`, "Open your tester page", c.base),
      };
    default:
      return { subject: b.name, ...wrap(b, [hi], null, "", c.base) };
  }
}
