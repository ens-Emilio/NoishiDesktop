// Noishi extension service worker.
//
// Two entry points, one path: the toolbar action sends the current tab, the
// context menu sends the tab plus whatever text the user selected. Both go to
// the native host over nativeMessaging; the host forwards them to the app.
//
// All errors surface as a badge, because a silent no-op while the desktop app
// is closed is the worst possible outcome here.

const HOST = "com.noishi.desktop";

chrome.runtime.onInstalled.addListener(() => {
	chrome.contextMenus.create({ id: "noishi-share-selection", title: "Enviar seleção para Noishi", contexts: ["selection"] });
	chrome.contextMenus.create({ id: "noishi-share-page", title: "Enviar página para Noishi", contexts: ["page"] });
});

function sendToHost(payload) {
	return new Promise((resolve) => {
		try {
			chrome.runtime.sendNativeMessage(HOST, payload, (response) => {
				const err = chrome.runtime.lastError;
				if (err) return resolve({ ok: false, error: err.message });
				resolve(response ?? { ok: false, error: "sem resposta do host" });
			});
		} catch (e) {
			resolve({ ok: false, error: String(e) });
		}
	});
}

let badgeTimer;
function flash(tabId, ok, message) {
	chrome.action.setBadgeBackgroundColor({ color: ok ? "#3f9e76" : "#c25c53" });
	chrome.action.setBadgeText({ text: ok ? "✓" : "!", tabId });
	clearTimeout(badgeTimer);
	badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }), 4000);
	if (!ok) console.warn("[noishi]", message);
}

async function share(tab, kind, selection) {
	const res = await sendToHost({ kind, url: tab?.url ?? "", title: tab?.title ?? "", selection: selection ?? "" });
	flash(tab?.id, res?.ok === true, res?.error ?? "");
}

chrome.action.onClicked.addListener((tab) => void share(tab, "share-page", ""));

chrome.contextMenus.onClicked.addListener((info, tab) => {
	if (info.menuItemId === "noishi-share-selection") void share(tab, "share-selection", info.selectionText ?? "");
	else if (info.menuItemId === "noishi-share-page") void share(tab, "share-page", "");
});
