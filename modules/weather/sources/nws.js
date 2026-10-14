// modules/weather/sources/nws.js
// The US National Weather Service (api.weather.gov): forecasts, station
// readings and alerts, for places in the United States and its
// territories. No key.
//
// A place goes through three steps:
//
//   1. /points/{lat},{lon} says which forecast covers it and which
//      weather stations are nearby. This never changes for a place, so
//      it's kept for a day. Outside the US it answers 404, and that's
//      how this source knows a place isn't one it covers.
//   2. The nearest station's latest reading is the current weather (up
//      to about an hour old; stations report on their own schedule). A
//      station that sent an empty reading is skipped for the next one.
//   3. The forecast gives today's high and low.
//
// The service wants to know who's asking (a User-Agent), and it
// sometimes answers 500 for a moment; the last good answer covers that.

const { coordinate, SEVERITY } = require("../common");

const USER_AGENT = "Omnia-Weather (+https://github.com/tanzim2000/Omnia-Essentials)";
const DAY_SECONDS = 24 * 60 * 60;

function get(ctx, url, cacheSeconds) {
	return ctx.omni.fetch(url, {
		cacheSeconds,
		headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" }
	});
}

function pointUrl(ctx) {
	return `https://api.weather.gov/points/${coordinate(ctx.lat)},${coordinate(ctx.lon)}`;
}

// A measurement as the service sends it, { value, unitCode }, in this
// module's own units. Readings are metric already; the conversions are
// there in case a station ever sends something else.
function measure(field) {
	if (!field || typeof field.value !== "number") return undefined;

	const unit = String(field.unitCode || "");
	const value = field.value;

	if (unit.endsWith("degF")) return ((value - 32) * 5) / 9;
	if (unit.endsWith("m_s-1")) return value * 3.6;
	if (unit.endsWith(":Pa")) return value / 100;
	if (unit.endsWith(":m")) return value / 1000;
	return value;
}

async function read(ctx) {
	const point = await get(ctx, pointUrl(ctx), DAY_SECONDS);

	if (!point.data || !point.data.properties) {
		return { problem: point.status === 404 ? "the US only" : "Not reachable", status: point.status };
	}

	const where = point.data.properties;

	// Step 2: the nearest station with a temperature in its latest reading
	let now = null;
	let stale = false;
	const stations = where.observationStations ? await get(ctx, where.observationStations, DAY_SECONDS) : {};
	const ids = ((stations.data && stations.data.features) || [])
		.slice(0, 3)
		.map((station) => station.properties && station.properties.stationIdentifier)
		.filter(Boolean);

	for (const id of ids) {
		const latest = await get(ctx, `https://api.weather.gov/stations/${encodeURIComponent(id)}/observations/latest`, ctx.cacheSeconds);
		const properties = latest.data && latest.data.properties;

		if (properties && measure(properties.temperature) !== undefined) {
			now = properties;
			stale = latest.stale;
			break;
		}
	}

	// Step 3: the forecast, for the high and low
	const forecast = where.forecast ? await get(ctx, where.forecast, ctx.cacheSeconds) : {};
	const periods = (forecast.data && forecast.data.properties && forecast.data.properties.periods) || [];

	if (!now && !periods.length) {
		return { problem: "Not reachable", status: forecast.status };
	}

	// Forecast temperatures are in Fahrenheit
	const celsius = (period) =>
		period && typeof period.temperature === "number"
			? period.temperatureUnit === "F"
				? ((period.temperature - 32) * 5) / 9
				: period.temperature
			: undefined;

	const reading = now || {};
	const temperature = measure(reading.temperature);
	const first = periods[0] || {};

	return {
		stale,
		readings: {
			temperature,
			condition: reading.textDescription || first.shortForecast || undefined,
			// Wind chill in the cold, heat index in the heat, otherwise
			// it feels like the temperature
			feelsLike: measure(reading.windChill) ?? measure(reading.heatIndex) ?? temperature,
			high: celsius(periods.find((period) => period.isDaytime)),
			low: celsius(periods.find((period) => !period.isDaytime)),
			humidity: measure(reading.relativeHumidity),
			wind: measure(reading.windSpeed),
			windDirection: measure(reading.windDirection),
			gust: measure(reading.windGust),
			pressure: measure(reading.seaLevelPressure) ?? measure(reading.barometricPressure),
			dewPoint: measure(reading.dewpoint),
			visibility: measure(reading.visibility),
			precipChance: first.probabilityOfPrecipitation ? first.probabilityOfPrecipitation.value ?? undefined : undefined
		}
	};
}

// CAP's levels, which the service uses as they are
const LEVELS = {
	Minor: SEVERITY.minor,
	Moderate: SEVERITY.moderate,
	Severe: SEVERITY.severe,
	Extreme: SEVERITY.extreme
};

async function alerts(ctx) {
	const url = `https://api.weather.gov/alerts/active?point=${coordinate(ctx.lat)},${coordinate(ctx.lon)}`;
	const { data, status } = await get(ctx, url, ctx.alertCacheSeconds);

	if (!data || !Array.isArray(data.features)) {
		return { problem: status === 404 || status === 400 ? "the US only" : "Not reachable", status };
	}

	// The service's own forecast page for the place lists every alert
	// in force there, in full
	const page = `https://forecast.weather.gov/MapClick.php?lat=${coordinate(ctx.lat)}&lon=${coordinate(ctx.lon)}`;

	const list = data.features.map((feature) => {
		const alert = feature.properties || {};

		return {
			id: alert.id || feature.id,
			// An update names the alerts it replaces, so one already
			// announced isn't announced again under its new number
			replaces: (alert.references || []).map((reference) => reference.identifier).filter(Boolean),
			title: alert.event || "Weather alert",
			severity: LEVELS[alert.severity] || SEVERITY.minor,
			expires: alert.ends || alert.expires,
			details: [alert.headline, alert.instruction].filter(Boolean).join("\n\n"),
			link: page,
			cancelled: alert.messageType === "Cancel"
		};
	});

	return { alerts: list };
}

module.exports = {
	name: "US National Weather Service",
	credit: "Data from the US National Weather Service",
	short: "National Weather Service",
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
		"Visibility",
		"Precipitation chance"
	],
	// Only the service itself can say (step 1), so nothing is ruled out
	// before asking it
	covers: () => "",
	read,
	alerts
};
