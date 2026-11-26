// Small DOM helpers shared by the popup and the options page.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

/** Avatar and login. Avatars come from GitHub's public profile picture URL. */
export function accountLabel(login) {
  const img = el("img", {
    class: "avatar",
    alt: "",
    src: `https://github.com/${encodeURIComponent(login)}.png?size=40`,
  });
  img.addEventListener("error", () => img.replaceWith(el("span", { class: "avatar" })), { once: true });
  return el("span", { class: "account" }, img, login);
}

export function statusTag(session) {
  return session.stale
    ? el("span", { class: "tag bad", title: "GitHub ended this sign-in. Sign in to the account again." }, "Signed out")
    : el("span", { class: "tag ok" }, "Ready");
}

export async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response?.result;
}

const GITHUB_ACCESS = { origins: ["https://github.com/*"] };

/**
 * Shows `banner` while the extension lacks access to github.com. Firefox before 127 does not grant
 * host permissions at install, and every browser lets the user withdraw them.
 */
export async function watchGithubAccess(banner, button) {
  const update = async () => {
    banner.hidden = await chrome.permissions.contains(GITHUB_ACCESS).catch(() => true);
  };
  button.addEventListener("click", () => chrome.permissions.request(GITHUB_ACCESS).then(update, update));
  chrome.permissions.onAdded?.addListener(update);
  chrome.permissions.onRemoved?.addListener(update);
  await update();
}
