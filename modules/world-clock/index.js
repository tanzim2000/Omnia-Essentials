// modules/world-clock/index.js
// The current time: this machine's own, or the time somewhere else. One
// widget can show one clock, two, or up to four, depending on the widget
// type picked on its page (see "widgets" in module.json):
//
//   single-clock   one clock
//   dual-clock     two clocks, each with its place's name
//   multi-clock    up to four clocks, each with its place's name
//
// No format decisions here (12 or 24 hour, seconds, a date): that's the
// theme's call. This module only answers one question per clock: what
// instant is it, and in which time zone should it be read.

// What a clock on this machine is called, where a clock needs a name
const MACHINE_NAME = "Local time";

// What a widget with three or four clocks is called. A name made of four
// places would be too long to read as a title.
const MULTI_NAME = "Clock";

// A place's time zone essentially never changes, so the lookup below is
// cached for a day. That's cautious, not greedy.
const TIMEZONE_CACHE_SECONDS = 24 * 60 * 60;

// The settings behind each clock, in order. Clock 1 uses the original
// key names, so a World Clock set up before widget types existed keeps
// its place when it becomes a "Single clock".
const CLOCK_KEYS = [
	{ source: "zoneSource", location: "location" },
	{ source: "zoneSource2", location: "location2" },
	{ source: "zoneSource3", location: "location3" },
	{ source: "zoneSource4", location: "location4" }
];

// How many clocks each widget type has room for
const MOST_CLOCKS = {
	"single-clock": 1,
	"dual-clock": 2,
	"multi-clock": 4
};

// Which widget type this is. OmniCore always says (since 1.18.0); an
// older one doesn't, and that means the first type, a single clock.
function widgetTypeOf(config) {
	return MOST_CLOCKS[config.widgetType] ? config.widgetType : "single-clock";
}

// The clocks this widget shows, as { source, location } in order. A clock
// switched "Off" (only clocks 3 and 4 can be) is left out.
function clocksOf(config) {
	const count = MOST_CLOCKS[widgetTypeOf(config)];

	return CLOCK_KEYS.slice(0, count)
		.map((keys) => ({
			source: config[keys.source] || "This machine",
			location: config[keys.location] || null
		}))
		.filter((clock) => clock.source !== "Off");
}

// A clock's name: the place's name, or "Local time" for this machine.
// Empty when a location has no name (coordinates typed in by hand
// without one) or no location is set yet.
function clockName(clock) {
	if (clock.source !== "A location") {
		return MACHINE_NAME;
	}

	return clock.location && clock.location.label ? clock.location.label : "";
}

// What the widget is called when nobody has typed a label for it.
// OmniCore asks for this (since 1.19.7) and shows it as the tile's title
// and on the widget's page; the label you type there always wins.
//
//   single  the place: "Dhaka", or "Local time"
//   dual    both places: "Regina | Dhaka"
//   multi   "Clock"
//
// Returns "" when there's nothing good to say (a place without a name),
// and OmniCore then uses the module's name, "World Clock".
function label(config) {
	const type = widgetTypeOf(config);
	const clocks = clocksOf(config);

	if (type === "multi-clock") {
		return MULTI_NAME;
	}

	const names = clocks.map(clockName);

	// Every clock needs a name for the whole to be a good one
	if (names.length === 0 || names.some((name) => !name)) {
		return "";
	}

	return names.join(" | ");
}

// Same free, keyless service the weather module already uses, asked for
// the one thing a clock needs: which time zone (an IANA name such as
// "Asia/Dhaka") a place is in. `current=temperature_2m` is only there
// because Open-Meteo wants at least one reading per request; it's thrown
// away and only the response's own `timezone` is read.
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

// One clock's time zone, or why there isn't one:
// { timezone } or { problem: "No location set" / "Not reachable" }
async function timezoneOf(clock, machineZone, omni) {
	if (clock.source !== "A location") {
		return { timezone: machineZone };
	}

	// OmniCore turns the location setting into coordinates before this
	// runs. Null means there's nothing to work with: location services
	// are off, or no place was ever set.
	if (!clock.location) {
		return { problem: "No location set" };
	}

	const timezone = await resolveLocationTimezone(clock.location, omni);
	return timezone ? { timezone } : { problem: "Not reachable" };
}

// How many clocks fit at this richness. A dual or multi clock asked for
// very little room still shows its first clock rather than squeezing in
// all of them; more room shows more, one step per quarter.
function clocksThatFit(total, richness) {
	const room = Math.ceil((Number(richness) || 50) / 25);
	return Math.max(1, Math.min(total, room));
}

module.exports = async function worldClock(config, richness, omni) {
	// OmniCore's own reading of "now", never Date() called directly: one
	// place decides what instant it is. This machine's own time zone
	// comes back with it.
	const now = omni.time();
	const type = widgetTypeOf(config);
	const clocks = clocksOf(config);
	const title = label(config) || "World Clock";

	// A single clock: one block, exactly as before. The title already
	// says which place it is, so the clock itself needs no name.
	if (type === "single-clock") {
		const result = await timezoneOf(clocks[0], now.timezone, omni);

		if (result.problem) {
			return {
				title,
				content: [
					{ type: "text", emphasis: "primary", value: "No time" },
					{ type: "text", emphasis: "secondary", value: result.problem }
				],
				updated: new Date().toISOString()
			};
		}

		return {
			title,
			// `timestamp` is the instant omni.time() gave; a theme ticks it
			// forward on its own rather than this module being asked every
			// second
			content: [{ type: "time", kind: "clock", timestamp: now.timestamp, timezone: result.timezone }],
			updated: new Date().toISOString()
		};
	}

	// Two or more: each clock is its place's name, then its time. A clock
	// that can't be shown says why in place of its time, and the others
	// still show.
	const shown = clocks.slice(0, clocksThatFit(clocks.length, richness));
	const results = await Promise.all(
		shown.map((clock) => timezoneOf(clock, now.timezone, omni))
	);

	const content = [];

	shown.forEach((clock, index) => {
		const result = results[index];

		content.push({
			type: "text",
			emphasis: "secondary",
			value: clockName(clock) || `Clock ${index + 1}`
		});

		content.push(
			result.problem
				? { type: "text", emphasis: "secondary", value: result.problem }
				: { type: "time", kind: "clock", timestamp: now.timestamp, timezone: result.timezone }
		);
	});

	return { title, content, updated: new Date().toISOString() };
};

// Hung on the main function, where OmniCore looks for it
module.exports.label = label;