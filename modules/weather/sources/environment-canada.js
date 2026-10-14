// modules/weather/sources/environment-canada.js
// Environment and Climate Change Canada: the government's own forecasts
// and warnings, for places in Canada. No key.
//
// Environment Canada doesn't forecast for any point on a map. It has a
// "city page" for each of about 850 places, and each page has the latest
// reading from a nearby station, the forecast for the next few days, and
// any warnings in force. So the first job is finding the place nearest
// the widget's location. The list of places is kept in this module
// (data/ec-places.json), so that takes no network call; then only that
// one place's page is fetched.
//
// That same list is how "in Canada" is decided: a location more than
// 100 km from every one of those places isn't one Environment Canada
// forecasts for.
//
// Everything Environment Canada sends comes in English and French, as
// { en, fr }. Only the English is used.

const { nearestEcPlaces, SEVERITY } = require("../common");

const COVERAGE_KM = 100;

// One place's city page. The standard address for one item first; if the
// service ever answers that with "not found", the same page is asked for
// by a tiny box around the place instead, which is how the samples this
// was built from were fetched.
async function cityPage(ctx, id) {
	const base = "https://api.weather.gc.ca/collections/citypageweather-realtime/items";
	const options = { cacheSeconds: ctx.cacheSeconds };

	const answer = await ctx.omni.fetch(`${base}/${encodeURIComponent(id)}?f=json&lang=en`, options);
	const page = pageOf(answer.data);

	if (page) {
		return { page, stale: answer.stale };
	}

	if (answer.status === 400 || answer.status === 404) {
		const place = require("../data/ec-places.json").places.find((entry) => entry[0] === id);

		if (place) {
			const [, lat, lon] = place;
			const box = [lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05].map((n) => n.toFixed(2)).join(",");
			const second = await ctx.omni.fetch(`${base}?f=json&lang=en&limit=5&bbox=${box}`, options);
			const found = pageOf(second.data, id);

			if (found) {
				return { page: found, stale: second.stale };
			}
		}
	}

	return { problem: "Not reachable", status: answer.status };
}

// The page's properties, from either a single item or a list of them
function pageOf(data, id) {
	if (!data) return null;
	if (data.properties) return data.properties;

	if (Array.isArray(data.features)) {
		const feature = data.features.find((entry) => !id || entry.id === id) || data.features[0];
		return feature ? feature.properties : null;
	}

	return null;
}

// The English half of a bilingual value, or the value itself
function en(value) {
	return value && typeof value === "object" && "en" in value ? value.en : value;
}

// A number from a { value: { en, fr } } reading, or undefined
function reading(field) {
	if (!field) return undefined;

	const raw = en(field.value);
	if (raw === null || raw === undefined || raw === "") return undefined;

	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

// The next high and the next low from the forecast periods ("Tonight:
// low minus 1", "Monday: high 3"), whichever come first
function highAndLow(page) {
	const periods = (page.forecastGroup && page.forecastGroup.forecasts) || [];
	let high;
	let low;

	for (const period of periods) {
		const temperatures = (period.temperatures && period.temperatures.temperature) || [];

		for (const entry of [].concat(temperatures)) {
			const kind = en(entry.class);
			const value = reading(entry);

			if (kind === "high" && high === undefined) high = value;
			if (kind === "low" && low === undefined) low = value;
		}

		if (high !== undefined && low !== undefined) break;
	}

	return { high, low };
}

async function read(ctx) {
	const places = nearestEcPlaces(ctx.lat, ctx.lon, 3, COVERAGE_KM);

	if (!places.length) {
		return { problem: covers(ctx.lat, ctx.lon) };
	}

	const nearest = await cityPage(ctx, places[0].id);

	if (nearest.problem) {
		return nearest;
	}

	// A few places have a forecast but no station reading of their own.
	// For those, the reading comes from the next nearest place that has
	// one; the forecast and warnings stay the nearest place's.
	let observed = nearest.page;

	for (const place of places.slice(1)) {
		if (reading((observed.currentConditions || {}).temperature) !== undefined) break;

		const next = await cityPage(ctx, place.id);
		if (next.page) observed = next.page;
	}

	const now = observed.currentConditions || {};
	const wind = now.wind || {};
	const hourly = ((nearest.page.hourlyForecastGroup || {}).hourlyForecasts || [])[0] || {};
	const firstPeriod = ((nearest.page.forecastGroup || {}).forecasts || [])[0] || {};
	const temperature = reading(now.temperature);

	// Environment Canada only gives a "feels like" when it matters: wind
	// chill in the cold, humidex in the heat. Otherwise it feels like
	// the temperature, which is what it says on its own site.
	const feelsLike = reading(now.windChill) ?? reading(now.humidex) ?? temperature;

	// Half the stations don't report a condition. The forecast for the
	// coming hour is the next best thing.
	const condition =
		en(now.condition) ||
		en(hourly.condition) ||
		en(((firstPeriod.abbreviatedForecast || {}).textSummary)) ||
		undefined;

	const pressure = reading(now.pressure);
	const { high, low } = highAndLow(nearest.page);

	return {
		stale: nearest.stale,
		readings: {
			temperature,
			condition,
			feelsLike,
			high,
			low,
			humidity: reading(now.relativeHumidity),
			wind: reading(wind.speed),
			windDirection: en((wind.direction || {}).value),
			gust: reading(wind.gust) || undefined,
			// kilopascals, the way Canada reads it, into hectopascals
			pressure: pressure === undefined ? undefined : pressure * 10,
			dewPoint: reading(now.dewpoint),
			precipChance: reading(hourly.lop)
		}
	};
}

// "YELLOW WARNING - SNOWFALL" -> "Yellow warning - snowfall"
function sentence(text) {
	const lower = String(text || "").toLowerCase();
	return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Environment Canada's colours (yellow, orange, red) where an alert has
// one. Older-style alerts have only a type.
const COLOURS = { yellow: SEVERITY.moderate, orange: SEVERITY.severe, red: SEVERITY.extreme };
const TYPES = {
	warning: SEVERITY.severe,
	watch: SEVERITY.moderate,
	advisory: SEVERITY.minor,
	statement: SEVERITY.minor
};

async function alerts(ctx) {
	const places = nearestEcPlaces(ctx.lat, ctx.lon, 1, COVERAGE_KM);

	if (!places.length) {
		return { problem: covers(ctx.lat, ctx.lon) };
	}

	// The same page read() fetches, so this costs no extra call
	const found = await cityPage(ctx, places[0].id);

	if (found.problem) {
		return found;
	}

	const list = (found.page.warnings || []).map((warning) => {
		const type = String(en(warning.type) || "").toLowerCase();
		const colour = String(en(warning.alertColourLevel) || "").toLowerCase();
		const title = sentence(en(warning.description));
		const link = en(warning.url) || "";

		return {
			// The page link carries the alert's own number after the #
			id: link || `${title}|${en(warning.eventIssue)}`,
			title,
			severity: COLOURS[colour] || TYPES[type] || SEVERITY.minor,
			expires: en(warning.expiryTime),
			link,
			// "ended" is Environment Canada saying a warning is over
			cancelled: type === "ended"
		};
	});

	return { alerts: list };
}

function covers(lat, lon) {
	return nearestEcPlaces(lat, lon, 1, COVERAGE_KM).length ? "" : "Canada only";
}

module.exports = {
	name: "Environment Canada",
	credit: "Based on Environment and Climate Change Canada data",
	short: "Environment Canada",
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
		"Precipitation chance"
	],
	covers,
	read,
	alerts
};
