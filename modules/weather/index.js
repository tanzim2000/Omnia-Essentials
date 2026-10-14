// modules/weather/index.js
// The weather for one place, from the source you pick, and its weather
// alerts as notifications where the source has them.
//
// HOW IT'S PUT TOGETHER
//
//   sources/   one small file per source. Each one asks its service and
//              hands back the same named readings (temperature,
//              condition, wind...) in the same metric units, whatever
//              the service sent. Some also hand back alerts.
//   common.js  what every source shares: units, wind directions, and
//              working out whether a place is in Canada or Norway.
//   this file  turns readings into the tile, in the user's units and
//              order, and runs alerts in the background.
//
// So the tile never knows where its numbers came from, and adding a
// source means adding one file and one line to SOURCES below.
//
// RICHNESS
//
// Each source has its own "Info order" setting, because each can show a
// different set of things (only some have alerts, or a dew point). The
// user drags it into the order they care about, and the tile shows the
// top of it: one piece on the smallest tile, more as it gets bigger, and
// all of them when a theme asks for everything (richness 100). Anything
// a source can't give right now (no alert in force, a station that
// didn't report wind) is skipped without taking a slot.
//
// ALERTS
//
// A tile only runs when a screen asks for it, which is no place to raise
// a notification: it would be raised again on every refresh. So alerts
// are watched in the background (`start`, below), and each one is
// announced once. What's been announced is saved, so restarting OmniCore
// doesn't announce it again. The tile reads the same alerts to show the
// most serious one; both ask through omni.fetch with the same address,
// so that's one call to the service, not two.

const common = require("./common");

const SOURCES = [
	require("./sources/open-meteo"),
	require("./sources/environment-canada"),
	require("./sources/met-norway"),
	require("./sources/nws"),
	require("./sources/openweathermap"),
	require("./sources/google")
];

// Each source's Info order setting. Open-Meteo keeps the original key,
// so a Weather widget set up before sources existed keeps its order.
const ORDER_KEYS = {
	"Open-Meteo": "fieldOrder",
	"Environment Canada": "ecOrder",
	"MET Norway": "metOrder",
	"US National Weather Service": "nwsOrder",
	"OpenWeatherMap": "owmOrder",
	"Google Weather": "googleOrder"
};

// Weather services ask not to be asked about warnings more often than
// every 10 minutes (MET Norway says so outright)
const LEAST_ALERT_SECONDS = 10 * 60;

// How many announced alerts to remember, so the saved list can't grow
// without end in a stormy season
const REMEMBER = 200;

function sourceOf(config) {
	return SOURCES.find((source) => source.name === config.source) || SOURCES[0];
}

// Everything a source needs to make its calls
function contextOf(config, omni, source) {
	const cacheSeconds = Math.max(1, Number(config.refreshMinutes) || 10) * 60;

	return {
		lat: config.location.latitude,
		lon: config.location.longitude,
		omni,
		key: source.keySetting ? String(config[source.keySetting] || "").trim() : "",
		cacheSeconds,
		alertCacheSeconds: Math.max(cacheSeconds, LEAST_ALERT_SECONDS)
	};
}

// The widget's suggested name: the place, "Regina" from "Regina,
// Saskatchewan, Canada". OmniCore uses it until the user types their own.
function label(config) {
	const place = config.location && config.location.label;
	return place ? String(place).split(",")[0].trim() : "";
}

// A tile that says why it has no weather, rather than an empty one
function problem(title, reason, source) {
	const envelope = {
		title,
		content: [
			{ type: "text", emphasis: "primary", value: "No weather" },
			{ type: "text", emphasis: "secondary", value: reason }
		],
		updated: new Date().toISOString()
	};

	if (source) envelope["data-source"] = source.credit;
	return envelope;
}

// "Covers Canada only" and the like, said the same way for every source
function outside(region) {
	return "Covers " + region;
}

// Alerts still in force, most serious first
function inForce(list) {
	const now = Date.now();

	return (list || [])
		.filter((alert) => !alert.cancelled)
		.filter((alert) => !alert.expires || !(Date.parse(alert.expires) < now))
		.sort((a, b) => b.severity - a.severity);
}

// Every piece the tile could show, by its name in the Info order, in the
// user's units. A piece the source didn't give is left undefined, and
// the tile skips it.
function piecesOf(readings, units, alerts) {
	const r = readings;
	const direction = typeof r.windDirection === "string" ? r.windDirection : common.compass(r.windDirection);
	const wind = common.speed(r.wind, units);

	return {
		"Temperature": common.temperature(r.temperature, units),
		"Condition": r.condition || undefined,
		"Alert": alerts.length
			? alerts[0].title + (alerts.length > 1 ? ` (+${alerts.length - 1} more)` : "")
			: undefined,
		"Feels like": common.temperature(r.feelsLike, units),
		"High / low":
			common.isNumber(r.high) && common.isNumber(r.low)
				? common.temperature(r.high, units) + " / " + common.temperature(r.low, units)
				: undefined,
		"Humidity": common.percent(r.humidity),
		"Wind": wind === undefined ? undefined : (wind + " " + direction).trim(),
		"Wind gusts": common.speed(r.gust, units),
		"Pressure": common.pressure(r.pressure, units),
		"Dew point": common.temperature(r.dewPoint, units),
		"Visibility": common.distance(r.visibility, units),
		"Precipitation chance": common.percent(r.precipChance),
		"UV index": common.isNumber(r.uv) ? String(Math.round(r.uv)) : undefined
	};
}

module.exports = async function weather(config, richness, omni) {
	const title = label(config) || "Weather";

	// OmniCore resolves the location before this runs. Null means there's
	// none: location services are off, or nothing could be worked out.
	if (!config.location) {
		return problem(title, "No location");
	}

	const source = sourceOf(config);
	const region = source.covers(config.location.latitude, config.location.longitude);

	if (region) {
		return problem(title, outside(region), source);
	}

	const ctx = contextOf(config, omni, source);
	const result = await source.read(ctx);

	if (result.problem) {
		return problem(title, result.problem.endsWith(" only") ? outside(result.problem) : result.problem, source);
	}

	// Alerts are read the same way the background does, from the same
	// cached answer. A failed read just means no alert on the tile.
	let alerts = [];

	if (source.alerts) {
		const found = await source.alerts(ctx);
		alerts = found.alerts ? inForce(found.alerts) : [];
	}

	const pieces = piecesOf(result.readings, common.unitsOf(config), alerts);

	// The user's order for this source, minus anything not there right
	// now, then as many as the tile has room for
	const order = (config[ORDER_KEYS[source.name]] || source.fields).filter((name) => pieces[name] !== undefined);
	const room = omni.share(order.length, richness);

	const content = order.slice(0, room).map((name, position) => {
		// Always the name and the value, separately: a theme decides
		// whether to show the name. Position in the user's order is
		// importance, so the first is the one to read from across a room.
		const block = { type: "pair", label: name, value: pieces[name] };
		if (position === 0) block.emphasis = "primary";
		return block;
	});

	// An older reading is marked as one, outside the order, so it never
	// takes a piece's place. A pair, like everything else, so a theme
	// that lays pairs out its own way doesn't change shape when the
	// network hiccups.
	if (result.stale) {
		content.push({ type: "pair", label: "Reading", value: "last known" });
	}

	return {
		title,
		content,
		updated: new Date().toISOString(),
		"data-source": source.credit
	};
};

// ---- Alerts in the background ----------------------------------------

// The names an alert is known by: its own number, the numbers it
// replaces (an update), and its source and title together. The last one
// is what stops a service that reissues the same warning under a new
// number every hour from announcing it every hour.
function namesOf(alert, source) {
	return [alert.id, ...(alert.replaces || []), source.name + "|" + String(alert.title).toLowerCase()]
		.filter(Boolean)
		.map(String);
}

// "Mon 8:07 AM", in this machine's time zone
function when(instant, timezone) {
	const date = new Date(instant);
	if (Number.isNaN(date.getTime())) return "";

	try {
		return new Intl.DateTimeFormat("en-US", {
			weekday: "short",
			hour: "numeric",
			minute: "2-digit",
			timeZone: timezone
		}).format(date);
	} catch (error) {
		return "";
	}
}

// What a notification says under its title: the place and how long,
// then the service's own words, kept short enough to read from a sofa
function describeAlert(alert, place, timezone) {
	const until = alert.expires ? when(alert.expires, timezone) : "";
	const first = (place ? "For " + place : "In force") + (until ? ", until " + until : "") + ".";
	// Some services wrap their text at a fixed width ("Most flood\ndeaths
	// occur..."). A single line break is joined back up; a blank line
	// between paragraphs stays.
	const details = String(alert.details || "")
		.replace(/\r/g, "")
		.replace(/([^\n])\n(?!\n)/g, "$1 ")
		.trim();
	const short = details.length > 400 ? details.slice(0, 397).trimEnd() + "..." : details;

	return short ? first + "\n\n" + short : first;
}

// One look at the source's alerts: announce what's new, remember it all
async function checkAlerts(config, omni, source, ctx) {
	const result = await source.alerts(ctx);

	// Couldn't ask. Keep what's remembered as it is, and try next time.
	if (!result.alerts) {
		return;
	}

	const saved = omni.storage.read() || {};
	const announced = new Set(saved.announced || []);
	const keep = [];
	const from = common.notifyFrom(config);
	const place = label(config);
	const timezone = omni.time().timezone;

	for (const alert of inForce(result.alerts)) {
		const names = namesOf(alert, source);
		const known = names.some((name) => announced.has(name));

		if (!known && alert.severity >= from) {
			omni.notify({
				source: source.short + (alert.issuer ? " (" + alert.issuer + ")" : ""),
				title: alert.title,
				description: describeAlert(alert, place, timezone),
				// Severity 1 to 4 becomes priority 2 to 5: the more serious,
				// the longer it stays on screen
				priority: alert.severity + 1,
				link: alert.link || undefined
			});
		}

		// Remembered once announced. One too minor to announce isn't, so
		// lowering "Notify me about" later still announces it.
		if (known || alert.severity >= from) {
			keep.push(...names);
		}
	}

	// Only what's still in force is kept: an alert that ends and later
	// comes back is news again
	omni.storage.write({ ...saved, announced: [...new Set(keep)].slice(-REMEMBER) });
}

module.exports.start = async function start(config, omni) {
	const source = sourceOf(config);

	// Nothing to watch: no location, a source without alerts, alerts
	// switched off, or a place the source doesn't cover
	if (
		!config.location ||
		!source.alerts ||
		common.notifyFrom(config) === Infinity ||
		source.covers(config.location.latitude, config.location.longitude)
	) {
		return null;
	}

	const ctx = contextOf(config, omni, source);

	if (source.keySetting && !ctx.key) {
		return null;
	}

	// Errors are caught here: one from a timer would otherwise stop all
	// of OmniCore, not just this widget
	const look = () =>
		checkAlerts(config, omni, source, ctx).catch((error) => {
			console.log(`Weather: couldn't check alerts (${error.message})`);
		});

	// The first look a little after starting, at a random moment, so a
	// house full of widgets starting together doesn't ask all at once.
	// Then just after each cached answer runs out.
	const handle = {};
	handle.first = setTimeout(look, 5000 + Math.floor(Math.random() * 25000));
	handle.every = setInterval(look, ctx.alertCacheSeconds * 1000 + 5000);

	return handle;
};

module.exports.stop = async function stop(handle) {
	if (!handle) return;
	clearTimeout(handle.first);
	clearInterval(handle.every);
};

// One look at the alerts straight away, the same as the background's
// timer does. For the tests (test/weather.test.js); OmniCore never
// calls it.
module.exports.checkAlertsNow = function (config, omni) {
	const source = sourceOf(config);
	return checkAlerts(config, omni, source, contextOf(config, omni, source));
};

// Hung on the main function, where OmniCore looks for them
module.exports.label = label;
module.exports.SOURCES = SOURCES;
