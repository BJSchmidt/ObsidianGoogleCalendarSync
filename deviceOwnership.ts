// Single-device sync ownership.
//
// Obsidian Sync can propagate the plugin's data.json between machines, so any
// settings stored there are shared — unsuitable for "is sync enabled on THIS
// device". Instead, we store the per-device opt-in and the generated device id
// in window.localStorage, which is strictly local to each machine.
//
// Flow:
//   - Every machine gets a stable deviceId the first time the plugin loads.
//   - On a new install `syncEnabledOnDevice` is false; the user has to flip it
//     on from settings. This prevents a second machine from silently racing
//     the first one the moment the plugin is installed there.
//   - Each successful sync stamps the vault-level `lastSyncDeviceId` +
//     `lastSyncDeviceName` + `lastSyncAt` settings. If another device sees
//     its own id differ from those and the timestamp is fresh, it warns the
//     user that two devices are syncing.

const LS_DEVICE_ID = 'google-calendar-sync.deviceId';
const LS_DEVICE_NAME = 'google-calendar-sync.deviceName';
const LS_ENABLED = 'google-calendar-sync.syncEnabledOnDevice';

function uuid(): string {
	// Prefer crypto.randomUUID when present, fall back to Math.random
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}

export function getDeviceId(): string {
	let id = window.localStorage.getItem(LS_DEVICE_ID);
	if (!id) {
		id = uuid();
		window.localStorage.setItem(LS_DEVICE_ID, id);
	}
	return id;
}

export function getDeviceName(): string {
	const cached = window.localStorage.getItem(LS_DEVICE_NAME);
	if (cached) return cached;
	// Best-effort guess from platform; user can override in settings.
	const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
	let name = 'This device';
	if (/Macintosh/i.test(ua)) name = 'Mac';
	else if (/Windows/i.test(ua)) name = 'Windows PC';
	else if (/Linux/i.test(ua)) name = 'Linux PC';
	window.localStorage.setItem(LS_DEVICE_NAME, name);
	return name;
}

export function setDeviceName(name: string): void {
	window.localStorage.setItem(LS_DEVICE_NAME, name);
}

export function isSyncEnabledOnDevice(): boolean {
	return window.localStorage.getItem(LS_ENABLED) === 'true';
}

/** Returns true when the device-sync setting has never been set — used by
 *  the upgrade path to opt-in the existing primary machine automatically
 *  (rather than silently disabling a user who was already syncing). */
export function isSyncEnabledOnDeviceUnset(): boolean {
	return window.localStorage.getItem(LS_ENABLED) === null;
}

export function setSyncEnabledOnDevice(enabled: boolean): void {
	window.localStorage.setItem(LS_ENABLED, enabled ? 'true' : 'false');
}

/** Consider another device "active" if it synced within this window. */
export const OTHER_DEVICE_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

export interface OtherDeviceWarning {
	deviceId: string;
	deviceName: string;
	lastSyncAt: string;
	ageMs: number;
}

/** Returns a warning if another device has synced this vault recently. */
export function detectOtherActiveDevice(
	lastSyncDeviceId: string,
	lastSyncDeviceName: string,
	lastSyncAt: string,
): OtherDeviceWarning | null {
	if (!lastSyncDeviceId || !lastSyncAt) return null;
	if (lastSyncDeviceId === getDeviceId()) return null;
	const ageMs = Date.now() - new Date(lastSyncAt).getTime();
	if (!Number.isFinite(ageMs) || ageMs < 0) return null;
	if (ageMs > OTHER_DEVICE_ACTIVE_WINDOW_MS) return null;
	return {
		deviceId: lastSyncDeviceId,
		deviceName: lastSyncDeviceName || 'another device',
		lastSyncAt,
		ageMs,
	};
}

export function formatAge(ageMs: number): string {
	const mins = Math.floor(ageMs / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins} min ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	const days = Math.floor(hrs / 24);
	return `${days}d ago`;
}
