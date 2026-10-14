// modules/weather/sources/google.js
// Google Weather (part of Google Maps Platform): most of the world, with
// your own API key. Includes public weather alerts from each country's
// official weather service, where Google has them.
//
// Three calls: the current weather, today's forecast (for the high and
// low), and alerts. The key goes in the address, which is how Google's
// own examples send it. It never leaves OmniCore.
//
// Google's rules ask for the line "Source: Includes weather data from
// Google" next to its data, which is this source's credit.

const { coordinate, SEVERITY } = require("../common");

const BASE = "https://weather.googleapis.com/v1/";

function url(ctx, path, extra) {
	return (
		BASE + path +
		"?key=" + encodeURIComponent(ctx.key) +
		"&location.latitude=" + coordinate(ctx.lat) +
		"&location.longitude=" + coordinate(ctx.lon) +
		(extra || "")
	);
}

// A wrong key comes back as 400 from Google, as well as 401 and 403
function problemFor(status) {
	return status === 400 || status === 401 || status === 403 ? "Invalid API key" : "Not reachable";
}

// { degrees, unit } in Celsius. Metric is Google's default; Fahrenheit
// is handled in case that ever changes.
function celsius(field) {
	if (!field || typeof field.degrees !== "number") return undefined;
	return field.unit === "FAHRENHEIT" ? ((field.degrees - 32) * 5) / 9 : field.degrees;
}

function kmh(field) {
	if (!field || typeof field.value !== "number") return undefined;
	return field.unit === "MILES_PER_HOUR" ? field.value * 1.609344 : field.value;
}

async function read(ctx) {
	if (!ctx.key) {
		return { problem: "No API key" };
	}

	const current = await ctx.omni.fetch(url(ctx, "currentConditions:lookup"), { cacheSeconds: ctx.cacheSeconds });
	const now = current.data;

	if (!now || !now.temperature) {
		return { problem: problemFor(current.status), status: current.status };
	}

	const days = await ctx.omni.fetch(url(ctx, "forecast/days:lookup", "&days=1"), { cacheSeconds: ctx.cacheSeconds });
	const today = (days.data && days.data.forecastDays && days.data.forecastDays[0]) || {};

	// Without today's forecast, the last 24 hours' high and low
	const history = now.currentConditionsHistory || {};
	const wind = now.wind || {};
	const visibility = now.visibility || {};
	const rain = (now.precipitation && now.precipitation.probability) || {};

	return {
		stale: current.stale,
		readings: {
			temperature: celsius(now.temperature),
			condition: now.weatherCondition && now.weatherCondition.description && now.weatherCondition.description.text,
			feelsLike: celsius(now.feelsLikeTemperature),
			high: celsius(today.maxTemperature) ?? celsius(history.maxTemperature),
			low: celsius(today.minTemperature) ?? celsius(history.minTemperature),
			humidity: now.relativeHumidity,
			wind: kmh(wind.speed),
			windDirection: wind.direction && wind.direction.degrees,
			gust: kmh(wind.gust),
			pressure: now.airPressure && now.airPressure.meanSeaLevelMillibars,
			dewPoint: celsius(now.dewPoint),
			uv: now.uvIndex,
			precipChance: rain.percent,
			visibility:
				typeof visibility.distance === "number"
					? visibility.unit === "MILES" ? visibility.distance * 1.609344 : visibility.distance
					: undefined
		}
	};
}

async function alerts(ctx) {
	if (!ctx.key) {
		return { problem: "No API key" };
	}

	const { data, status } = await ctx.omni.fetch(url(ctx, "publicAlerts:lookup"), { cacheSeconds: ctx.alertCacheSeconds });

	if (!data) {
		return { problem: problemFor(status), status };
	}

	const list = (data.weatherAlerts || []).map((alert) => {
		const from = alert.dataSource || {};
		const instruction = [].concat(alert.instruction || [])[0];

		return {
			id: alert.alertId,
			title: (alert.alertTitle && alert.alertTitle.text) || "Weather alert",
			severity: SEVERITY[String(alert.severity || "").toLowerCase()] || SEVERITY.minor,
			expires: alert.expirationTime,
			details: [alert.areaName, instruction].filter(Boolean).join("\n\n"),
			// Google doesn't link each alert; the weather service that
			// issued it is the next best place to read it
			link: from.authorityUri || "",
			// "NOAA" and the like: who actually issued it
			issuer: from.name || from.publisher || ""
		};
	});

	return { alerts: list };
}

module.exports = {
	name: "Google Weather",
	credit: "Source: Includes weather data from Google",
	short: "Google Weather",
	keySetting: "googleKey",
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
		"UV index",
		"Visibility",
		"Precipitation chance"
	],
	covers: () => "",
	read,
	alerts
};
