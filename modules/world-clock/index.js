// modules/world-clock/index.js
// The current time — either this machine's own, or a place you choose,
// independently per instance. Run two instances side by side to track
// two different timezones at once.
//
// No format decisions here (12/24-hour, seconds, whether to show a date)
// — that's entirely the theme's call. This module only ever answers one
// question: what instant is it, and in which timezone should it be read.
//
// RICHNESS
//
// Accepted, per the module contract, but genuinely unused below. There
// is exactly one fact this module has — the current time — and no
// amount of extra room changes that. A deliberate one-step scale, not
// an oversight: contrast with `weather`, which has six distinct fields
// and genuinely more to say at higher richness.

// What the tile calls itself when nobody's set an instance label. Core
// only ever falls back to this when the user hasn't typed their own
// label — so a title that already says "Dhaka" rather than the generic
// "World Clock" means most people never have to touch the label field
// at all just to tell two instances apart.
function defaultTitle(config) {
	if (config.zoneSource === "A location" && config.location && config.location.label) {
		return config.location.label;
	}

	if (config.zoneSource !== "A location") {
		return "Local Machine";
	}

	// Location mode, but nothing nameable yet — either nothing is set at
	// all, or manual coordinates were typed in with no label given them.
	return "World Clock";
}

// Every failure returns a real envelope rather than throwing. A tile
// that says why it's empty is more useful than one that vanishes.
function problem(config, reason) {
	return {
		title: defaultTitle(config),
		content: [
			{ type: "text", emphasis: "primary", value: "—" },
			{ type: "text", emphasis: "secondary", value: reason }
		],
		updated: new Date().toISOString()
	};
}

// A place's timezone essentially never changes, so this is cached far
// longer than a weather reading would be — a day is conservative, not
// aggressive.
const TIMEZONE_CACHE_SECONDS = 24 * 60 * 60;

// Same free, keyless dependency `weather` already uses for geocoding,
// asked for the one field weather never needed: which IANA zone a
// coordinate falls in. `current=temperature_2m` is a throwaway —
// Open-Meteo requires at least one output variable per request — the
// actual reading is discarded; only the response's own `timezone` field
// is read.
async function resolveLocationTimezone(location, omni) {
	const url =
		"https://api.open-meteo.com/v1/forecast" +
		"?latitude=" + encodeURIComponent(location.latitude) +
		"&longitude=" + encodeURIComponent(location.longitude) +
		"&current=temperature_2m&timezone=auto";

	const { data } = await omni.fetch(url, {
		cacheSeconds: TIMEZONE_CACHE_SECONDS
	});

	return data && typeof data.timezone === "string" ? data.timezone : null;
}

module.exports = async function worldClock(config, richness, omni) {
	// core's own system-time read, never Date() called directly — one
	// place establishing what instant "now" actually is. This machine's
	// own resolved zone comes back as part of the same call, and is what
	// we use unless a location says otherwise below.
	const now = omni.time();
	let timezone = now.timezone;

	if (config.zoneSource === "A location") {
		// OmniCore resolves the location setting before this ever runs.
		// Null means there's nothing to work with — location services
		// are off, or nothing was ever set.
		if (!config.location) {
			return problem(config, "No location set");
		}

		const resolved = await resolveLocationTimezone(config.location, omni);

		if (!resolved) {
			// The location itself is known even though the timezone
			// lookup failed — the tile can still say "Dhaka", just not
			// yet show a time for it.
			return problem(config, "Not reachable");
		}

		timezone = resolved;
	}

	// Exactly one block, regardless of richness — see the note above.
	// `timestamp` is the raw instant `omni.time()` just gave us; a theme
	// ticks it forward locally rather than this module being polled
	// every second (see docs/Architecture.md §5c and docs/Building
	// theme.md's note on `time` blocks).
	return {
		title: defaultTitle(config),
		content: [{ type: "time", kind: "clock", timestamp: now.timestamp, timezone }],
		updated: new Date().toISOString()
	};
};