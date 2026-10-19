# Omnia Essentials

The modules and themes made by Tanzim Ahmed for
[OmniCore](https://github.com/tanzim2000/Omnia-OmniCore). Install them
from inside OmniCore: open the admin face and go to **Marketplace**.

## What's here

| Folder                   | What it is                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `modules/weather`        | The weather where you are, from the service you trust, with alerts when it turns bad |
| `modules/disk-space`     | Free space on a filesystem                                                           |
| `modules/system-stats`   | CPU, memory and uptime of the machine running OmniCore                               |
| `modules/calendar`       | Events from an ICS feed                                                              |
| `modules/docker-status`  | Which containers are running                                                         |
| `modules/ntfy`           | Notifications from an ntfy topic, and how many came in                               |
| `modules/prayer-times`   | Daily prayer times from Aladhan                                                      |
| `modules/bing-wallpaper` | Bing's picture of the day                                                            |
| `modules/world-clock`    | The time here, somewhere else, or in up to four places at once                       |
| `themes/windows8`        | Asymmetric tile grid with live tiles and flip animations                             |

## Licence

Free to copy, change, use and sell, for any purpose, with no conditions:
everything in this repository is under the [0BSD licence](LICENSE)
unless listed below. That includes every earlier commit of it. Take a
module apart, build your own on it, ship it under your own name and your
own licence. No credit needed (it's always welcome).

These modules and themes are their own works, not part of OmniCore, so
OmniCore's AGPL doesn't reach them (see OmniCore's
[LICENSING.md](https://github.com/tanzim2000/Omnia-OmniCore/blob/main/LICENSING.md)).

### Not covered by 0BSD

Some files hold data that came from someone else. They keep their own
terms:

- **`modules/weather/data/ec-places.json`**: Environment Canada's list of
  city pages, from api.weather.gc.ca. Based on Environment and Climate
  Change Canada data, under ECCC's own terms for its data.
- **`test/weather-samples/`**: real answers from the weather services,
  kept to test the weather module against. Each is under the terms of
  the service it came from: MET Norway (`met-*`), the US National
  Weather Service (`nws-*`), Open-Meteo (`open-meteo-*`), Environment
  Canada (`ec-*`) and Google (`google-*`).

`modules/weather/data/norway.json` is Norway's outline from Natural
Earth, which is in the public domain, so it's 0BSD like the rest.

### Names

0BSD covers the code, not names. The weather services, Bing, Docker,
ntfy and Windows named in these modules and themes belong to their
owners. Omnia, OmniCore and the project's other names are covered by
OmniCore's
[TRADEMARKS.md](https://github.com/tanzim2000/Omnia-OmniCore/blob/main/TRADEMARKS.md):
build on these modules freely, but don't call your version "official".
