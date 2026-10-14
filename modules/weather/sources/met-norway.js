// modules/weather/sources/met-norway.js
// MET Norway, the Norwegian Meteorological Institute: forecasts and
// warnings (MetAlerts), for places in Norway. No key.
//
// MET Norway's forecast actually covers the whole world. This module
// offers it for Norway only, where its warnings apply and where it knows
// the weather best; Open-Meteo is the choice everywhere else. Whether a
// place is in Norway is worked out from an outline kept in this module
// (data/norway.json), so it takes no network call.
//
// MET Norway's rules (api.met.no/doc/TermsOfService): say who's asking
// (a User-Agent naming the app), at most four decimals in coordinates,
// and don't ask for warnings more than once every 10 minutes.

const { coordinate, inNorway, SEVERITY } = require("../common");

const USER_AGENT = "Omnia-Weather (+https://github.com/tanzim2000/Omnia-Essentials)";
const LEAST_CACHE_SECONDS = 10 * 60;

// MET Norway names conditions with codes like "lightrainshowers_day".
// The time of day is dropped; the rest is put into words.
const PLAIN = {
	clearsky: "Clear",
	fair: "Fair",
	partlycloudy: "Partly cloudy",
	cloudy: "Cloudy",
	fog: "Fog"
};

function describe(code) {
	if (!code) return undefined;

	const name = String(code).replace(/_(day|night|polartwilight)$/, "");

	if (PLAIN[name]) {
		return PLAIN[name];
	}

	// light/heavy, then rain/sleet/snow, then showers, then thunder.
	// ("lights" is a spelling MET Norway really uses in two codes.)
	const parts = /^(lights?|heavy)?(rain|sleet|snow)(showers)?(andthunder)?$/.exec(name);

	if (!parts) {
		return undefined;
	}

	const words = [];
	if (parts[1]) words.push(parts[1].startsWith("light") ? "light" : "heavy");
	words.push(parts[2]);
	if (parts[3]) words.push("showers");

	const text = words.join(" ") + (parts[4] ? " and thunder" : "");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

// Metres per second, as MET Norway reports wind, into km/h
function kmh(metresPerSecond) {
	return typeof metresPerSecond === "number" ? metresPerSecond * 3.6 : undefined;
}

function options(ctx) {
	return {
		cacheSeconds: Math.max(ctx.cacheSeconds, LEAST_CACHE_SECONDS),
		headers: { "User-Agent": USER_AGENT }
	};
}

async function read(ctx) {
	if (!inNorway(ctx.lat, ctx.lon)) {
		return { problem: "Norway only" };
	}

	const url =
		"https://api.met.no/weatherapi/locationforecast/2.0/complete" +
		"?lat=" + coordinate(ctx.lat) + "&lon=" + coordinate(ctx.lon);

	const { data, stale, status } = await ctx.omni.fetch(url, options(ctx));
	const series = data && data.properties && data.properties.timeseries;

	if (!Array.isArray(series) || !series.length) {
		return { problem: "Not reachable", status };
	}

	const first = series[0].data || {};
	const now = (first.instant && first.instant.details) || {};
	const soon = first.next_1_hours || first.next_6_hours || {};
	const later = first.next_12_hours || first.next_6_hours || {};

	// The highest and lowest temperature over the next 24 hours
	const start = Date.parse(series[0].time);
	const day = series
		.filter((entry) => Date.parse(entry.time) - start < 24 * 60 * 60 * 1000)
		.map((entry) => entry.data && entry.data.instant && entry.data.instant.details.air_temperature)
		.filter((value) => typeof value === "number");

	return {
		stale,
		readings: {
			temperature: now.air_temperature,
			condition: describe(soon.summary && soon.summary.symbol_code),
			feelsLike: now.apparent_air_temperature,
			high: day.length ? Math.max(...day) : undefined,
			low: day.length ? Math.min(...day) : undefined,
			humidity: now.relative_humidity,
			wind: kmh(now.wind_speed),
			windDirection: now.wind_from_direction,
			gust: kmh(now.wind_speed_of_gust),
			pressure: now.air_pressure_at_sea_level,
			dewPoint: now.dew_point_temperature,
			uv: now.ultraviolet_index_clear_sky,
			precipChance: later.details && later.details.probability_of_precipitation
		}
	};
}

// MetAlerts' colours: yellow, orange, red
const COLOURS = { yellow: SEVERITY.moderate, orange: SEVERITY.severe, red: SEVERITY.extreme };

async function alerts(ctx) {
	if (!inNorway(ctx.lat, ctx.lon)) {
		return { problem: "Norway only" };
	}

	const url =
		"https://api.met.no/weatherapi/metalerts/2.0/current.json?lang=en" +
		"&lat=" + coordinate(ctx.lat) + "&lon=" + coordinate(ctx.lon);

	const { data, status } = await ctx.omni.fetch(url, options(ctx));

	if (!data || !Array.isArray(data.features)) {
		return { problem: "Not reachable", status };
	}

	const list = data.features.map((feature) => {
		const alert = feature.properties || {};
		const colour = String(alert.riskMatrixColor || "").toLowerCase();
		const name = alert.eventAwarenessName || alert.event || "Weather warning";

		return {
			id: alert.id || alert.title,
			// "Gale Force", with its colour: "Yellow: Gale Force"
			title: (colour ? colour.charAt(0).toUpperCase() + colour.slice(1) + ": " : "") + name,
			severity: COLOURS[colour] || SEVERITY[String(alert.severity).toLowerCase()] || SEVERITY.minor,
			expires: feature.when && Array.isArray(feature.when.interval) ? feature.when.interval[1] : undefined,
			details: [alert.description, alert.instruction].filter(Boolean).join("\n\n"),
			// MET Norway's own page link comes padded with spaces and new lines
			link: String(alert.web || "").trim(),
			cancelled: alert.type === "Cancel"
		};
	});

	return { alerts: list };
}

module.exports = {
	name: "MET Norway",
	credit: "Weather data from MET Norway",
	short: "MET Norway",
	fields: [
		"Temperature",
		"Condition",
		"Alert",
		"Feels like",
		"High / low",
		"Humidity",
		"Wind",
		"Wind gusts",
		"Pressure",
		"Dew point",
		"Precipitation chance",
		"UV index"
	],
	covers: (lat, lon) => (inNorway(lat, lon) ? "" : "Norway only"),
	read,
	alerts,
	describe
};
