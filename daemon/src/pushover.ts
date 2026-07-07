import { PushoverConfig } from "./config";
import { log } from "./logger";

export interface Notification {
	title: string;
	message: string;
	url?: string;
	urlTitle?: string;
	timestamp?: number; // epoch seconds
}

const ENDPOINT = "https://api.pushover.net/1/messages.json";

// Sends a single Pushover notification, retrying transient failures.
export async function sendPushover(
	cfg: PushoverConfig,
	n: Notification,
	attempts = 3
): Promise<boolean> {
	const body = new URLSearchParams();
	body.set("token", cfg.token);
	body.set("user", cfg.user);
	body.set("title", n.title);
	body.set("message", n.message);
	if (cfg.device) body.set("device", cfg.device);
	if (typeof cfg.priority === "number") body.set("priority", String(cfg.priority));
	if (n.url) body.set("url", n.url);
	if (n.urlTitle) body.set("url_title", n.urlTitle);
	if (n.timestamp) body.set("timestamp", String(n.timestamp));

	for (let i = 1; i <= attempts; i++) {
		try {
			const res = await fetch(ENDPOINT, { method: "POST", body });
			if (res.ok) return true;
			// 4xx (bad token/user) will not improve on retry.
			if (res.status >= 400 && res.status < 500) {
				const text = await res.text().catch(() => "");
				log.error(`Pushover rejected request (${res.status}): ${text}`);
				return false;
			}
			log.warn(`Pushover HTTP ${res.status} (attempt ${i}/${attempts})`);
		} catch (e) {
			log.warn(`Pushover request failed (attempt ${i}/${attempts}):`, e);
		}
		if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i));
	}
	return false;
}
